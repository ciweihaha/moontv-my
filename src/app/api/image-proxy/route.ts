import { NextResponse } from 'next/server';

export const runtime = 'edge';

// OrionTV 兼容接口（从旧 MoonTV 移植，已修复 SSRF）
// 用途：代理豆瓣等图床的图片，解决防盗链导致的海报黑屏

// SSRF 防护：禁止的主机名（精确匹配）
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '0.0.0.0',
  '169.254.169.254', // 云元数据
]);

/** IPv4 内网/特殊段检查（输入应为规范点分十进制） */
function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => parseInt(p, 10));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const [a, b] = nums;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 127) return true; // 127.0.0.0/8 回环
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 链路本地
  if (a === 0) return true; // 0.0.0.0/8
  return false;
}

/**
 * AUDIT-R4 P1-2: 将 IPv6 地址展开为 8 个 16 位组（hextet）的数字数组。
 * 处理 :: 压缩、首尾 ::、IPv4 尾段（如 ::ffff:192.168.1.1）等形式。
 * 无法解析时返回 null。
 */
function expandIPv6(ip: string): number[] | null {
  let addr = ip.toLowerCase().trim();
  // 去括号
  if (addr.startsWith('[') && addr.endsWith(']')) {
    addr = addr.slice(1, -1);
  }
  // 处理 zone id（fe80::1%eth0）
  const pctIdx = addr.indexOf('%');
  if (pctIdx !== -1) {
    addr = addr.slice(0, pctIdx);
  }

  // 拆分 :: 压缩
  const dblColon = addr.split('::');
  if (dblColon.length > 2) return null; // 多个 :: 非法

  const parsePart = (part: string): number[] | null => {
    if (part === '') return [];
    const groups = part.split(':');
    const out: number[] = [];
    for (const g of groups) {
      // IPv4 尾段（如 ::ffff:192.168.1.1 中的 192.168.1.1）
      if (g.includes('.')) {
        const octets = g.split('.');
        if (octets.length !== 4) return null;
        const nums = octets.map((o) => parseInt(o, 10));
        if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
        out.push((nums[0] << 8) | nums[1], (nums[2] << 8) | nums[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
        out.push(parseInt(g, 16));
      }
    }
    return out;
  };

  if (dblColon.length === 1) {
    // 无压缩，必须正好 8 组
    const groups = parsePart(dblColon[0]);
    if (!groups || groups.length !== 8) return null;
    return groups;
  }

  // 有 :: 压缩：左右两部分相加不足 8 组，中间补 0
  const left = parsePart(dblColon[0]);
  const right = parsePart(dblColon[1]);
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null; // :: 至少压缩一组
  return [...left, ...new Array(missing).fill(0), ...right];
}

/**
 * AUDIT-R4 P1-2: 从展开的 IPv6 中提取内嵌 IPv4。
 * 覆盖两种形式：
 *  1. IPv4-mapped ::ffff:0:0/96（如 ::ffff:192.168.1.1 或 ::ffff:c0a8:101）
 *  2. IPv4-compatible ::/96（已废弃，但仍检查）
 * 返回点分十进制字符串，无内嵌 IPv4 时返回 null。
 */
function extractEmbeddedIPv4(groups: number[]): string | null {
  // ::ffff:0:0/96: 前 80 位为 0，第 81-96 位为 0xffff
  const isMapped =
    groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  // ::/96（兼容地址，已废弃）：前 96 位为 0，且不全为 0（::1 除外由上层处理）
  const isCompatible =
    groups.slice(0, 6).every((g) => g === 0) &&
    !(groups[6] === 0 && groups[7] <= 1);
  if (!isMapped && !isCompatible) return null;
  const a = (groups[6] >> 8) & 0xff;
  const b = groups[6] & 0xff;
  const c = (groups[7] >> 8) & 0xff;
  const d = groups[7] & 0xff;
  return `${a}.${b}.${c}.${d}`;
}

/** IPv6 特殊段检查（输入为去括号小写形式） */
function isBlockedIPv6(ip: string): boolean {
  const groups = expandIPv6(ip);
  if (!groups) {
    // 无法解析的按可疑处理：保守起见拦截
    return true;
  }

  // 1. 内嵌 IPv4（映射/兼容地址）：转交 IPv4 检查
  //    覆盖 ::ffff:192.168.1.1（点分）与 ::ffff:c0a8:101（十六进制压缩）等形式
  const embedded = extractEmbeddedIPv4(groups);
  if (embedded) {
    return isBlockedIPv4(embedded);
  }

  // 2. ::1 回环 / :: 未指定
  if (groups.every((g) => g === 0)) return true; // ::
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1

  const first = groups[0];
  // fe80::/10 链路本地
  if (first >= 0xfe80 && first <= 0xfebf) return true;
  // fc00::/7 唯一本地
  if (first >= 0xfc00 && first <= 0xfdff) return true;
  // 2001:db8::/32 文档地址
  if (first === 0x2001 && groups[1] === 0x0db8) return true;
  // 2001::/23 特殊用途（Teredo 等），保守拦截
  if (first === 0x2001 && (groups[1] & 0xff00) === 0x0000) {
    // 仅拦截 2001:0::/32（Teredo）
    if (groups[1] === 0x0000) return true;
  }
  // ff00::/8 组播（出站代理请求组播无意义，拦截）
  if (first >= 0xff00 && first <= 0xffff) return true;

  return false;
}

function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().trim();
  if (BLOCKED_HOSTNAMES.has(h)) return true;

  // 去括号取裸 IPv6
  const bare = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
  if (bare !== h && BLOCKED_HOSTNAMES.has(bare)) return true;

  // IPv6（含 IPv4 映射）
  if (bare.includes(':')) {
    return isBlockedIPv6(bare);
  }

  // IPv4：WHATWG URL 已把十六进制/八进制写法规范为点分十进制，
  // 这里再做一次防御性检查
  if (/^\d+\.\d+\.\d+\.\d+$/.test(bare)) {
    return isBlockedIPv4(bare);
  }
  // 十六进制/八进制 IP 绕过（如 0x7f000001）
  if (/^0x[0-9a-f]+$/i.test(bare.replace(/\./g, ''))) return true;

  return false;
}

// 允许的图片 Content-Type
const ALLOWED_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
];

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB
// AUDIT-R2: 总超时覆盖「建连 + 响应头 + 完整响应体读取」
const TOTAL_TIMEOUT_MS = 20000;
// AUDIT-R3 P0-C: 最大重定向跳数
const MAX_REDIRECTS = 5;

// AUDIT-R5 P1: DNS-over-HTTPS 解析配置（防 DNS 重绑定）
// 仅对非 IP 字面量的主机名做 DoH 解析，验证其 A/AAAA 记录全部为公网 IP。
// 2026-10-19 方案 B（fail-closed）：DoH 查不到（NXDOMAIN/SERVFAIL/超时/空记录）
// 或解析出任一内网/特殊地址时都拒绝请求，仅全部记录为公网 IP 时放行。
const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const DOH_TIMEOUT_MS = 5000;
const DNS_CACHE_TTL_MS = 60 * 1000; // 60 秒内存缓存，平衡安全与性能
const dnsCache = new Map<string, { ips: string[]; expires: number }>();

/**
 * AUDIT-R5 P1: 用 DNS-over-HTTPS 解析主机名的 A/AAAA 记录。
 * 返回去重后的 IP 列表；解析失败、超时、无记录时返回 null（表示"未知"，
 * 调用方按 2026-10-19 方案 B（fail-closed）决策：未知直接拒绝，
 * 仅全部记录为公网 IP 时放行）。
 */
async function resolveHostnameToIPs(hostname: string): Promise<string[] | null> {
  const now = Date.now();
  const cached = dnsCache.get(hostname);
  if (cached && cached.expires > now) {
    return cached.ips;
  }
  // 简单的缓存淘汰，防止无界增长
  if (dnsCache.size > 500) {
    const now2 = Date.now();
    const toDelete: string[] = [];
    dnsCache.forEach((v, k) => {
      if (v.expires <= now2) toDelete.push(k);
    });
    for (const k of toDelete) {
      dnsCache.delete(k);
      if (dnsCache.size <= 400) break;
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOH_TIMEOUT_MS);
  try {
    const ips = new Set<string>();
    for (const type of ['A', 'AAAA']) {
      const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${type}`;
      const resp = await fetch(url, {
        headers: { Accept: 'application/dns-json' },
        signal: controller.signal,
      });
      if (!resp.ok) return null;
      const data = (await resp.json()) as {
        Status?: number;
        Answer?: Array<{ type: number; data: string }>;
      };
      // Status 0 = NOERROR；3 = NXDOMAIN（域名不存在，直接拒绝）
      if (data.Status !== 0 || !data.Answer) {
        if (data.Status === 3) return null;
        continue;
      }
      for (const ans of data.Answer) {
        // type 1 = A, 28 = AAAA
        if (ans.type === 1 || ans.type === 28) {
          ips.add(ans.data.trim());
        }
      }
    }
    if (ips.size === 0) return null;
    const list = Array.from(ips);
    dnsCache.set(hostname, { ips: list, expires: now + DNS_CACHE_TTL_MS });
    return list;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * AUDIT-R5 P1: 验证主机名的 DNS 解析结果全部为公网 IP。
 * - IP 字面量：沿用 isBlockedHost 的字符串检查（WHATWG URL 已规范化）
 * - 域名：DoH 解析 A/AAAA，任一记录为内网/特殊地址时拒绝
 *
 * 2026-10-19 方案 B（fail-closed）：DoH 返回 NXDOMAIN / SERVFAIL / 超时 /
 * 空记录时视为"未知"并直接拒绝（403），仅当解析结果非空且全部为公网 IP
 * 时放行。已确认方案 A 的可用性顾虑（个别图床在公共 DoH 上 NXDOMAIN）服从
 * 安全需求：查不到解析结果的请求不放行。
 * 字符串层检查（isBlockedHost：IP 字面量、localhost、元数据地址等）不受影响，仍全量生效。
 *
 * 注意剩余风险（TOCTOU / DNS 重绑定）：DoH 查询与实际 fetch 之间存在时间窗口，
 * 攻击者若控制 DNS 且使用极短 TTL，仍可能在检查后切换解析结果。
 * 本检查显著缩小攻击窗口，但不能替代「在 fetch 时固定目标 IP」；
 * 后者在 fetch API 下会破坏 HTTPS 的 SNI/证书校验（edge runtime 下引入
 * undici 自定义 dispatcher 的改动面过大），故采用此折中方案。
 * 真正的 rebinding 绑定（连接固定到已校验 IP）尚未实现，留作后续工作。
 */
async function validateHostnameDNS(hostname: string): Promise<{ ok: boolean; reason?: string }> {
  const h = hostname.toLowerCase().trim();
  const bare = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;

  // IP 字面量：字符串检查已足够（URL 解析器已规范化十六进制/八进制写法）
  if (bare.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(bare)) {
    return { ok: true };
  }

  // 域名：DoH 解析并检查每条记录
  const ips = await resolveHostnameToIPs(bare);
  if (!ips) {
    // 方案 B（fail-closed）：DoH 未知（NXDOMAIN/SERVFAIL/超时/空记录）→ 拒绝
    return { ok: false, reason: 'DNS resolution failed or returned no records' };
  }
  for (const ip of ips) {
    if (isBlockedHost(ip)) {
      return { ok: false, reason: `DNS resolves to blocked IP: ${ip}` };
    }
  }
  return { ok: true };
}

/**
 * AUDIT-R3 P0-C: 验证 URL 是否允许请求（协议 + 主机 + DNS 解析）。
 * 每一跳重定向前都要调用，禁止的请求在发出前就被拦截。
 * AUDIT-R5 P1: 增加 DNS-over-HTTPS 解析检查，防 DNS 重绑定。
 * 2026-10-19 方案 B：DNS 未知或解析出内网 IP 时拦截，仅全公网记录放行。
 */
async function validateUrlForFetch(
  urlString: string
): Promise<{ ok: boolean; error?: string; status?: number }> {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return { ok: false, error: 'Invalid URL', status: 400 };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'Only http/https allowed', status: 400 };
  }
  if (isBlockedHost(parsed.hostname)) {
    return { ok: false, error: 'Blocked host', status: 403 };
  }
  // AUDIT-R5 P1: DNS 解析结果检查（2026-10-19 方案 B：未知拒绝，仅全公网记录放行）
  const dnsCheck = await validateHostnameDNS(parsed.hostname);
  if (!dnsCheck.ok) {
    return { ok: false, error: `DNS check failed: ${dnsCheck.reason || 'blocked'}`, status: 403 };
  }
  return { ok: true };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const imageUrl = searchParams.get('url');

  if (!imageUrl) {
    return NextResponse.json({ error: 'Missing image URL' }, { status: 400 });
  }

  // 1. 协议校验：只允许 http/https
  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return NextResponse.json({ error: 'Only http/https allowed' }, { status: 400 });
  }

  // 2. 主机校验：禁内网/元数据（含 IPv6 特殊段与 IPv4 映射）
  if (isBlockedHost(parsed.hostname)) {
    return NextResponse.json({ error: 'Blocked host' }, { status: 403 });
  }

  // 3. 长度上限
  if (imageUrl.length > 2048) {
    return NextResponse.json({ error: 'URL too long' }, { status: 400 });
  }

  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS);

  try {
    // AUDIT-R3 P0-C: 手动逐跳处理重定向，每一跳先验证再请求。
    // 禁止的目标在发出请求前就被拦截，不会先收到请求。
    let currentUrl = imageUrl;
    let imageResponse: Response | null = null;

    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
      if (Date.now() > deadline) {
        return NextResponse.json({ error: 'Image fetch timeout' }, { status: 504 });
      }

      const validation = await validateUrlForFetch(currentUrl);
      if (!validation.ok) {
        return NextResponse.json(
          { error: validation.error },
          { status: validation.status || 400 }
        );
      }

      const resp = await fetch(currentUrl, {
        headers: {
          Referer: 'https://movie.douban.com/',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        },
        signal: controller.signal,
        redirect: 'manual', // P0-C: 手动处理，不自动跟随
      });

      // 3xx 重定向：取 Location 头，下一跳继续验证
      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get('location');
        // 消费掉响应体避免泄漏
        await resp.arrayBuffer().catch(() => undefined);
        if (!location) {
          return NextResponse.json({ error: 'Redirect without location' }, { status: 502 });
        }
        if (redirectCount >= MAX_REDIRECTS) {
          return NextResponse.json({ error: 'Too many redirects' }, { status: 502 });
        }
        try {
          // 相对 Location 按当前 URL 解析
          currentUrl = new URL(location, currentUrl).toString();
        } catch {
          return NextResponse.json({ error: 'Invalid redirect URL' }, { status: 502 });
        }
        continue;
      }

      imageResponse = resp;
      break;
    }

    if (!imageResponse) {
      return NextResponse.json({ error: 'Too many redirects' }, { status: 502 });
    }

    if (!imageResponse.ok) {
      return NextResponse.json(
        { error: imageResponse.statusText },
        { status: imageResponse.status }
      );
    }

    // 4. Content-Type 必须是图片
    const contentType = imageResponse.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || '';
    if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
      return NextResponse.json({ error: 'Not an image' }, { status: 400 });
    }

    // 5a. 声明大小预检（有 Content-Length 时快速拒绝）
    const contentLength = imageResponse.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_IMAGE_BYTES) {
      return NextResponse.json({ error: 'Image too large' }, { status: 413 });
    }

    if (!imageResponse.body) {
      return NextResponse.json(
        { error: 'Image response has no body' },
        { status: 500 }
      );
    }

    // 5b. AUDIT-R2: 实际流式读取并累计字节数，分块传输无 Content-Length 时也能硬限制；
    // 超时覆盖整个响应体读取过程
    const reader = imageResponse.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      for (;;) {
        if (Date.now() > deadline) {
          await reader.cancel().catch(() => undefined);
          return NextResponse.json({ error: 'Image download timeout' }, { status: 504 });
        }
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_IMAGE_BYTES) {
          await reader.cancel().catch(() => undefined);
          return NextResponse.json({ error: 'Image too large' }, { status: 413 });
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    // 合并分块
    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const headers = new Headers();
    headers.set('Content-Type', contentType);
    headers.set('Cache-Control', 'public, max-age=15720000, s-maxage=15720000');
    headers.set('CDN-Cache-Control', 'public, s-maxage=15720000');

    return new Response(body, { status: 200, headers });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return NextResponse.json({ error: 'Image fetch timeout' }, { status: 504 });
    }
    return NextResponse.json({ error: 'Error fetching image' }, { status: 500 });
  } finally {
    clearTimeout(abortTimer);
  }
}
