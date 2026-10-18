import { NextResponse } from 'next/server';

export const runtime = 'edge';

// OrionTV 兼容接口（从旧 MoonTV 移植，已修复 SSRF）
// 用途：代理豆瓣等图床的图片，解决防盗链导致的海报黑屏

// SSRF 防护：禁止的 IP 段和主机名
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '[::1]',
  '169.254.169.254', // 云元数据
]);

function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  // 内网段：10.x, 172.16-31.x, 192.168.x
  if (/^10\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  // 十六进制/八进制 IP 绕过
  if (/^0x[0-9a-f]+$/i.test(h.replace(/\./g, ''))) return true;
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

  // 2. 主机校验：禁内网/元数据
  if (isBlockedHost(parsed.hostname)) {
    return NextResponse.json({ error: 'Blocked host' }, { status: 403 });
  }

  // 3. 长度上限
  if (imageUrl.length > 2048) {
    return NextResponse.json({ error: 'URL too long' }, { status: 400 });
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const imageResponse = await fetch(imageUrl, {
      headers: {
        Referer: 'https://movie.douban.com/',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timeoutId);

    // R8-S1: 校验重定向后的最终 URL，防重定向绕过 SSRF 检查
    try {
      const finalUrl = new URL(imageResponse.url);
      if (finalUrl.protocol !== 'http:' && finalUrl.protocol !== 'https:') {
        return NextResponse.json({ error: 'Redirect to non-http(s)' }, { status: 400 });
      }
      if (isBlockedHost(finalUrl.hostname)) {
        return NextResponse.json({ error: 'Redirect to blocked host' }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ error: 'Invalid redirect URL' }, { status: 400 });
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

    // 5. 大小上限
    const contentLength = imageResponse.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_IMAGE_BYTES) {
      return NextResponse.json({ error: 'Image too large' }, { status: 400 });
    }

    if (!imageResponse.body) {
      return NextResponse.json(
        { error: 'Image response has no body' },
        { status: 500 }
      );
    }

    const headers = new Headers();
    headers.set('Content-Type', contentType);
    headers.set('Cache-Control', 'public, max-age=15720000, s-maxage=15720000');
    headers.set('CDN-Cache-Control', 'public, s-maxage=15720000');

    return new Response(imageResponse.body, { status: 200, headers });
  } catch {
    return NextResponse.json({ error: 'Error fetching image' }, { status: 500 });
  }
}
