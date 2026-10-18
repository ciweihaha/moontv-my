import { NextResponse } from 'next/server';

/**
 * QUALITY-R3: 带 CDN 缓存头的 JSON 响应助手。
 * 6 个 API 路由重复拼写同一组缓存头，集中一处避免漂移。
 */
export function jsonWithCache<T>(
  data: T,
  cacheTime: number,
  status = 200,
  // KV-CACHE: 可选额外响应头（如 X-Search-Cache: HIT/MISS），向后兼容
  extraHeaders?: Record<string, string>
): NextResponse {
  return NextResponse.json(data, {
    status,
    headers: {
      'Cache-Control': `public, max-age=${cacheTime}, s-maxage=${cacheTime}`,
      'CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
      'Vercel-CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
      ...extraHeaders,
    },
  });
}
