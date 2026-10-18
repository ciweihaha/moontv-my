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

/** IPv6 特殊段检查（输入为去括号小写形式） */
function isBlockedIPv6(ip: string): boolean {
  // ::ffff:a.b.c.d 形式的 IPv4 映射地址 → 检查内嵌 IPv4
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) {
    return isBlockedIPv4(mapped[1]);
  }
  // 6to4 / NAT64 等内嵌 IPv4 的形式，做尽力检查
  const embeddedV4 = ip.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (embeddedV4 && isBlockedIPv4(embeddedV4[1])) {
    return true;
  }

  const firstHextet = ip.split(':')[0];
  const first = parseInt(firstHextet, 16);
  if (Number.isNaN(first)) return false;

  if (ip === '::1' || ip === '::') return true; // 回环 / 未指定
  if (first >= 0xfe80 && first <= 0xfebf) return true; // fe80::/10 链路本地
  if (first >= 0xfc00 && first <= 0xfdff) return true; // fc00::/7 唯一本地
  if (first === 0x2001) {
    const second = parseInt(ip.split(':')[1] || '0', 16);
    if (second === 0xdb8) return true; // 2001:db8::/32 文档地址
  }
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

/**
 * AUDIT-R3 P0-C: 验证 URL 是否允许请求（协议 + 主机）。
 * 每一跳重定向前都要调用，禁止的请求在发出前就被拦截。
 */
function validateUrlForFetch(urlString: string): { ok: boolean; error?: string; status?: number } {
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

      const validation = validateUrlForFetch(currentUrl);
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
