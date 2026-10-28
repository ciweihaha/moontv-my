import { NextResponse } from 'next/server';
import type { LookupFunction } from 'node:net';

export const runtime = 'edge';

// OrionTV 兼容接口（从旧 MoonTV 移植，已修复 SSRF）
// 用途：代理豆瓣等图床的图片，解决防盗链导致的海报黑屏

// SSRF 防护：禁止的主机名（精确匹配）
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '0.0.0.0',
  '169.254.169.254', // 云元数据
]);
// round2 F1: edge allowlist
// Initial list: hostnames of api fields in config.json api_site, deduplicated.
// Non-listed hostname returns 403 before any fetch.
// 2026-10-25 OrionTV 海报回归，豆瓣封面来自 img*.doubanio.com，不在 api 域名表里导致全 403，只放行 doubanio 公共图床后缀，仍走后面的 DNS 校验与内网拦截。
const ALLOWED_IMAGE_HOSTNAME_SUFFIXES = ['.doubanio.com'];
function isAllowedImageHostname(hostname: string): boolean {
    const h = hostname.toLowerCase();
    if (ALLOWED_IMAGE_HOSTNAMES.has(h)) return true;
    return ALLOWED_IMAGE_HOSTNAME_SUFFIXES.some((suffix) => h.endsWith(suffix));
}
const ALLOWED_IMAGE_HOSTNAMES = new Set([
  'api.guangsuapi.com',
  'api.xinlangapi.com',
  'api.wujinapi.me',
  'api.wujinapi.net',
  'api.1080zyku.com',
  'www.huyaapi.com',
  'hhzyapi.com',
  'subocaiji.com',
  'cj.lziapi.com',
  'jinyingzy.com',
  'jyzyapi.com',
  'cj.ffzyapi.com',
  'caiji.moduapi.cc',
  'www.mdzyapi.com',
  'api.ffzyapi.com',
  'jszyapi.com',
  'www.hongniuzy3.com',
  'api.ukuapi88.com',
  'api.wujinapi.cc',
  '360zy.com',
  'api.ukuapi.com',
  'ikunzyapi.com',
  'cj.rycjapi.com',
  'api.wujinapi.com',
  'bfzyapi.com',
  'zuidazy.me',
  'm3u8.apiyhzy.com',
  'caiji.dyttzyapi.com',
  'www.hongniuzy2.com',
  'www.moduzy.com',]);


/** IPv4 内网/特殊段检查（输入应为规范点分十进制） */
function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => parseInt(p, 10));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = nums;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 127) return true; // 127.0.0.0/8 回环
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 链路本地
  if (a === 0) return true; // 0.0.0.0/8
  // AUDIT-R6：补齐 IANA 特殊用途地址段（默认仅公网可路由地址才可能放行）
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 共享地址空间（CGNAT）
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF 协议分配
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 文档示例（TEST-NET-1）
  if (a === 198 && b >= 18 && b <= 19) return true; // 198.18.0.0/15 基准测试
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 文档示例（TEST-NET-2）
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 文档示例（TEST-NET-3）
  if (a >= 224 && a <= 239) return true; // 224.0.0.0/4 组播
  if (a >= 240) return true; // 240.0.0.0/4 保留（含 255.255.255.255 有限广播）
  // 注：192.31.196.0/24（AS112）、192.52.193.0/24（AMT）、192.88.99.0/24
  // （已废弃的 6to4 中继，IANA 2015 年回收）不属非公网可路由，故不拦截。
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
 * 覆盖三种形式：
 *  1. IPv4-mapped ::ffff:0:0/96（如 ::ffff:192.168.1.1 或 ::ffff:c0a8:101）
 *  2. IPv4-compatible ::/96（已废弃，但仍检查）
 *  3. NAT64（RFC 6052 / RFC 8219）：64:ff9b::/96（well-known）与
 *     64:ff9b:1::/48（local-use），内嵌 IPv4 为末 32 位
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
  // AUDIT-R6：NAT64 前缀的内嵌 IPv4 为末 32 位（groups[6], groups[7]）
  const isNat64WellKnown =
    groups[0] === 0x64 &&
    groups[1] === 0xff9b &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0;
  const isNat64LocalUse =
    groups[0] === 0x64 && groups[1] === 0xff9b && groups[2] === 0x1;
  if (!isMapped && !isCompatible && !isNat64WellKnown && !isNat64LocalUse)
    return null;
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

  // repo-hardening 第 10 项：补齐 IANA 特殊用途段，向「仅全球可路由」收敛。
  // 2001:0002::/48 基准测试（RFC 5180）
  if (first === 0x2001 && groups[1] === 0x0002) return true;
  // 2001:0010::/28 ORCHID（RFC 4843）与 2001:0020::/28 ORCHIDv2（RFC 7343）
  if (first === 0x2001 && (groups[1] & 0xfff0) === 0x0010) return true;
  if (first === 0x2001 && (groups[1] & 0xfff0) === 0x0020) return true;
  // 2002::/16 6to4：协议已废弃（RFC 7526），经中继可回指任意内嵌 IPv4，
  // 且正规图床不使用 6to4 地址——整段拦截（内嵌公网也不放行，决定已由测试固定）
  if (first === 0x2002) return true;
  // fec0::/10 站点本地（已废弃，RFC 3879）
  if (first >= 0xfec0 && first <= 0xfeff) return true;
  // 收敛规则：全球单播空间仅 2000::/3，其余未明确放行的一律拦截
  //（覆盖 100::/64 discard-only、未分配段等；内嵌 IPv4 类已在前面优先处理）
  if (first < 0x2000 || first > 0x3fff) return true;

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
const MAX_REDIRECTS = 5; /* ROUND2 F5: per-isolate concurrency, edge memory is not shared */ const MAX_CONCURRENT_IMAGE_PROXY = 50; let activeImageProxyRequests = 0;

// AUDIT-R5 P1: DNS-over-HTTPS 解析配置（防 DNS 重绑定）
// 仅对非 IP 字面量的主机名做 DoH 解析，验证其 A/AAAA 记录全部为公网 IP。
// 2026-10-19 方案 B（fail-closed）：DoH 查不到（NXDOMAIN/SERVFAIL/超时/空记录）
// 或解析出任一内网/特殊地址时都拒绝请求，仅全部记录为公网 IP 时放行。
const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const DOH_TIMEOUT_MS = 5000;
const DNS_CACHE_TTL_MS = 600 * 1000; // 2026-10-28 海报提速：60 秒 → 600 秒，减少每页海报重复 DoH 解析；SSRF 校验、allowlist、大小上限、重定向校验与总超时 20 秒均不动
const dnsCache = new Map<string, { ips: string[]; expires: number }>();

/**
 * AUDIT-R5 P1: 用 DNS-over-HTTPS 解析主机名的 A/AAAA 记录。
 * 返回去重后的 IP 列表；解析失败、超时、两族均无记录时返回 null（表示"未知"，
 * 调用方按 2026-10-19 方案 B（fail-closed）决策：未知直接拒绝，
 * 仅全部记录为公网 IP 时放行）。
 * AUDIT-R6：某地址族 Status=0 但无 Answer（NODATA）不视为失败，
 * 仅合法地继续查另一地址族；错误码（含 Status 缺失）则整体判未知。
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
  /* ROUND2 F6: expired eviction did not bring size down, clear cache */ if (dnsCache.size > 500) dnsCache.clear(); const timer = setTimeout(() => controller.abort(), DOH_TIMEOUT_MS);
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
      // AUDIT-R6：严格区分"查询失败"与"该地址族无记录"。
      // - Status 缺失或为错误码（SERVFAIL/FORMERR/REFUSED 等，含 NXDOMAIN=3）：
      //   DNS 解析服务本身不可信 → 整个主机名判为"未知"，按方案 B 直接拒绝。
      // - Status=0 但无 Answer（NODATA）：该地址族确实无记录，合法地继续查另一地址族。
      // 旧逻辑对非 3 的错误码继续查另一种记录，导致 A 查询 SERVFAIL、AAAA 返回公网
      // 时只凭 AAAA 放行——未经验证的错误被当作"无记录"跳过。
      const status = data.Status;
      if (status === undefined || status !== 0) {
        return null;
      }
      if (!data.Answer) {
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
 * 注意剩余风险（TOCTOU / DNS 重绑定）：DoH 查询与实际 fetch 之间存在时间窗口。
 * AUDIT-R7（2026-10-19 双运行时 IP 钉死）已封死该窗口在 nodejs 运行时（Docker
 * 自托管）下的利用：本函数返回的 ips 即本跳已校验的 IP 集合，调用方用它构造
 * 钉死 dispatcher（见 getPinnedFetchClient），连接目标被固定为该集合；
 * edge 运行时（Cloudflare Pages）因 workerd 无连接层可定制，保持现状
 * （edge 跑在 Cloudflare 机房，无用户内网可打，残余风险低）。
 * 钉死不改变的假设：DoH 本身仍是信任根；同一已校验 IP 上的内容替换超出 SSRF 范畴。
 */
async function validateHostnameDNS(
  hostname: string
): Promise<{ ok: boolean; reason?: string; ips?: string[] }> {
  const h = hostname.toLowerCase().trim();
  const bare = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;

  // IP 字面量：字符串检查已足够（URL 解析器已规范化十六进制/八进制写法）
  if (bare.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(bare)) {
    return { ok: true, ips: [bare] };
  }

  // 域名：DoH 解析并检查每条记录
  const ips = await resolveHostnameToIPs(bare);
  if (!ips) {
    // 方案 B（fail-closed）：DoH 未知（NXDOMAIN/SERVFAIL/超时/空记录）→ 拒绝
    return { ok: false, reason: 'DNS resolution failed or returned no records' };
  }
  for (const ip of ips) {
    if (isBlockedHost(ip)) {
      console.warn('[image-proxy] DNS resolves to blocked IP:', ip); return { ok: false, reason: 'blocked IP' };
    }
  }
  return { ok: true, ips };
}

// ---------------------------------------------------------------------------
// AUDIT-R7: 双运行时 IP 钉死（DNS 重绑定绑定）
//  - edge（Cloudflare Pages）：workerd 的 fetch 没有连接层可定制，保持全局
//    fetch 现状；edge 运行在 Cloudflare 机房，无用户内网可打。
//  - nodejs（Docker 自托管，构建期 sed 已把本文件 runtime 翻为 'nodejs'）：
//    用 undici 的 Agent 自定义 lookup，只连接本跳已校验的 IP 集合，封死
//    「DoH 检查 → 实际建连」之间的重绑定窗口；TLS 的 SNI/证书校验仍按 URL
//    主机名进行（undici 默认行为），未被绕过。
// ---------------------------------------------------------------------------

/** 钉死 lookup：忽略系统 DNS，只返回本跳已校验的 IP 集合（fail-closed）。 */
function buildPinnedLookup(validatedIps: string[]): LookupFunction {
  const pinned = validatedIps.map((ip) => ({
    address: ip,
    family: ip.includes(':') ? 6 : 4,
  }));
  const lookup = (
    _hostname: string,
    options: { all?: boolean },
    callback: (...args: unknown[]) => void
  ): void => {
    // Node 20+ 默认开启 autoSelectFamily，会以 { all: true } 调用 lookup，
    // 此时必须返回地址数组，否则抛 ERR_INVALID_IP_ADDRESS。
    if (options && options.all === true) {
      callback(
        null,
        pinned.map((p) => ({ address: p.address, family: p.family }))
      );
      return;
    }
    const first = pinned[0];
    if (!first) {
      // 已校验集合为空：fail-closed，绝不回退系统解析
      callback(new Error('pinned lookup: empty validated IP set'));
      return;
    }
    callback(null, first.address, first.family);
  };
  return lookup as unknown as LookupFunction;
}

interface PinnedFetchClient {
  fetch: typeof import('undici').fetch;
  dispatcher: import('undici').Dispatcher;
}

/**
 * 按运行时构造钉死抓取客户端；edge 下返回 null（调用方走全局 fetch 现状）。
 * undici 必须懒加载 + webpackIgnore：禁止打包器把它打进 edge 产物；
 * 且必须用 undici 自己的 fetch + Agent（与全局 fetch 混用会抛
 * invalid onRequestStart）。
 */
async function getPinnedFetchClient(
  validatedIps: string[]
): Promise<PinnedFetchClient | null> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return null;
  }
  const undici = await import(/* webpackIgnore: true */ 'undici');
  const dispatcher = new undici.Agent({
    connect: { lookup: buildPinnedLookup(validatedIps) },
  });
  return { fetch: undici.fetch, dispatcher };
}

/**
 * AUDIT-R8：确定性释放钉死 dispatcher。
 * 每个 Agent 只服务一跳（见 GET 的逐跳构造），此前从不 close/destroy，
 * 只能等 undici 空闲超时（约 9s）回收：实测 FD 按请求线性累积（+2/次），
 * 突发高频下可能打满容器 FD 上限。响应体被调用方消费完（或请求已失败）
 * 后调用本函数立即拆掉底层 socket，不改变任何抓取/校验语义。
 * dispatcher 无 destroy/close（如测试 mock）或释放本身抛错时静默跳过——
 * 释放失败绝不能影响请求结果。
 */
async function releasePinnedDispatcher(
  dispatcher: import('undici').Dispatcher | null | undefined
): Promise<void> {
  if (!dispatcher) return;
  const d = dispatcher as { destroy?: unknown; close?: unknown };
  try {
    if (typeof d.destroy === 'function') {
      await (d.destroy as () => Promise<void>).call(dispatcher);
    } else if (typeof d.close === 'function') {
      await (d.close as () => Promise<void>).call(dispatcher);
    }
  } catch {
    // 释放失败不得影响请求本身
  }
}

/**
 * AUDIT-R3 P0-C: 验证 URL 是否允许请求（协议 + 主机 + DNS 解析）。
 * 每一跳重定向前都要调用，禁止的请求在发出前就被拦截。
 * AUDIT-R5 P1: 增加 DNS-over-HTTPS 解析检查，防 DNS 重绑定。
 * 2026-10-19 方案 B：DNS 未知或解析出内网 IP 时拦截，仅全公网记录放行。
 */
async function validateUrlForFetch(
  urlString: string
): Promise<{ ok: boolean; error?: string; status?: number; ips?: string[] }> {
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
  // round2 F1: edge allowlist, fail-closed, before DNS/fetch.
  if (!isAllowedImageHostname(parsed.hostname)) {
    return { ok: false, error: 'Host not allowed', status: 403 };
  }
  const dnsCheck = await validateHostnameDNS(parsed.hostname);
  if (!dnsCheck.ok) {
    return { ok: false, error: 'DNS check failed', status: 403 };
  }
  // AUDIT-R7：把本跳已校验的 IP 集合传出，供 nodejs 运行时构造钉死 dispatcher
  return { ok: true, ips: dnsCheck.ips };
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

  if (activeImageProxyRequests >= MAX_CONCURRENT_IMAGE_PROXY) { return NextResponse.json({ error: 'Too many concurrent image proxy requests' }, { status: 429 }); } activeImageProxyRequests++; const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS);
  // 客户端断开联动（2026-10-24 诊断缺口 P2）：此前 GET 全程不读
  // request.signal，客户端中途断开后上游请求与响应体读取仍跑满 20s
  // 总超时才收尾，白白占用连接与缓冲。把客户端信号并入内部 controller
  // 的触发源（任一触发即中止上游）；监听器在请求结束时于 finally 摘除，
  // 避免随请求累积。SSRF 校验、大小上限、逐跳复验与超时语义不变。
  const clientSignal = request.signal;
  const onClientAbort = () => controller.abort();
  if (clientSignal) {
    if (clientSignal.aborted) {
      controller.abort();
    } else if (typeof clientSignal.addEventListener === 'function') {
      clientSignal.addEventListener('abort', onClientAbort, { once: true });
    }
  }
  // AUDIT-R8：最终响应那一跳的钉死 dispatcher，响应体消费完成后在
  // finally 释放。必须声明在 try 外：try 内 let 对 finally 不可见。
  // edge 运行时恒为 null。
  let imageDispatcher: import('undici').Dispatcher | null = null;

  try {
    // AUDIT-R3 P0-C: 手动逐跳处理重定向，每一跳先验证再请求。
    // 禁止的目标在发出请求前就被拦截，不会先收到请求。
    let currentUrl = imageUrl;
    let imageResponse: Response | null = null;

    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
      if (Date.now() > deadline) {
        return NextResponse.json({ error: 'Image fetch timeout' }, { status: 504 });
      }

      const validation: Awaited<ReturnType<typeof validateUrlForFetch>> = await Promise.race([validateUrlForFetch(currentUrl), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Image fetch timeout')), Math.max(0, deadline - Date.now())))]).catch(() => ({ ok: false, error: 'Image fetch timeout', status: 504 }));
      if (!validation.ok) {
        return NextResponse.json(
          { error: validation.error },
          { status: validation.status || 400 }
        );
      }

      // AUDIT-R7 双运行时抓取：
      // - nodejs（Docker 自托管）：undici 钉死 dispatcher，只连接本跳已校验的 IP，
      //   封死 DoH 检查与实际建连之间的 DNS 重绑定窗口；
      // - edge（Cloudflare Pages）：getPinnedFetchClient 返回 null，走全局 fetch 现状。
      const fetchHeaders = {
        Referer: 'https://movie.douban.com/',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      };
      const pinnedClient = await getPinnedFetchClient(validation.ips ?? []);
      // AUDIT-R8：本跳 dispatcher 的所有权——重定向/校验失败/抛错时在本跳
      // 结束（finally）即释放；命中最终响应时所有权移交 imageDispatcher，
      // 由外层 finally 在响应体消费完成后统一释放。
      let hopOwnsDispatcher = pinnedClient !== null;
      try {
        const resp: Response = pinnedClient
          ? ((await pinnedClient.fetch(currentUrl, {
              headers: fetchHeaders,
              signal: controller.signal,
              redirect: 'manual',
              dispatcher: pinnedClient.dispatcher,
            })) as unknown as Response)
          : await fetch(currentUrl, {
              headers: fetchHeaders,
              signal: controller.signal,
              redirect: 'manual', // P0-C: 手动处理，不自动跟随
            });

        // 3xx 重定向：取 Location 头，下一跳继续验证
        if (resp.status >= 300 && resp.status < 400) {
          const location = resp.headers.get('location');
          // 消费掉响应体避免泄漏
          await resp.body?.cancel().catch(() => {});
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
        imageDispatcher = pinnedClient ? pinnedClient.dispatcher : null;
        hopOwnsDispatcher = false;
        break;
      } finally {
        if (hopOwnsDispatcher && pinnedClient) {
          await releasePinnedDispatcher(pinnedClient.dispatcher);
        }
      }
    }

    if (!imageResponse) {
      return NextResponse.json({ error: 'Too many redirects' }, { status: 502 });
    }

    if (!imageResponse.ok) { await imageResponse.body?.cancel().catch(() => {});
      return NextResponse.json(
        { error: imageResponse.statusText },
        { status: imageResponse.status }
      );
    }

    // 4. Content-Type 必须是图片
    const contentType = imageResponse.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || '';
    if (!ALLOWED_CONTENT_TYPES.includes(contentType)) { await imageResponse.body?.cancel().catch(() => {});
      return NextResponse.json({ error: 'Not an image' }, { status: 400 });
    }

    // 5a. 声明大小预检（有 Content-Length 时快速拒绝）
    const contentLength = imageResponse.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_IMAGE_BYTES) { await imageResponse.body?.cancel().catch(() => {});
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
    const reader = imageResponse.body.getReader(); let readTimedOut = false;
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      for (;;) {
        if (Date.now() > deadline) {
          await reader.cancel().catch(() => undefined);
          return NextResponse.json({ error: 'Image download timeout' }, { status: 504 });
        }
        const { done, value } = await Promise.race([reader.read(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Image download timeout')), Math.max(0, deadline - Date.now()))) ]).catch((err) => { if (err instanceof Error && err.message === 'Image download timeout') { readTimedOut = true; reader.cancel().catch(() => undefined); return { done: true, value: undefined } as ReadableStreamReadResult<Uint8Array>; } throw err; });
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

    if (readTimedOut) { return NextResponse.json({ error: 'Image download timeout' }, { status: 504 }); } // 合并分块
    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const headers = new Headers();
    headers.set('Content-Type', contentType);
    headers.set('X-Content-Type-Options', 'nosniff'); headers.set('Cache-Control', 'public, max-age=15720000, s-maxage=15720000');
    headers.set('CDN-Cache-Control', 'public, s-maxage=15720000');

    return new Response(body, { status: 200, headers });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return NextResponse.json({ error: 'Image fetch timeout' }, { status: 504 });
    }
    return NextResponse.json({ error: 'Error fetching image' }, { status: 500 });
  } finally {
    clearTimeout(abortTimer);
    // 摘除客户端断开监听（与 GET 开头并入 request.signal 对应），
    // 防止监听器随请求累积泄漏。
    if (clientSignal && typeof clientSignal.removeEventListener === 'function') {
      clientSignal.removeEventListener('abort', onClientAbort);
    }
    // AUDIT-R8：释放最终响应那一跳的钉死 dispatcher（走到这里时响应体
    // 已被完整缓冲，或请求已失败/提前返回）；edge 运行时恒为 null。
    activeImageProxyRequests--; await releasePinnedDispatcher(imageDispatcher);
  }
}
