import { NextResponse } from 'next/server';

/**
 * QUALITY-R3: 带 CDN 缓存头的 JSON 响应助手。
 * 6 个 API 路由重复拼写同一组缓存头，集中一处避免漂移。
 *
 * R2-P4: 加 stale-while-revalidate，CDN 在后台更新时先返回旧缓存，
 * 体感速度更快（尤其搜索/详情这类 KV 缓存 miss 时）。
 */
export function jsonWithCache<T>(
  data: T,
  cacheTime: number,
  status = 200,
  // KV-CACHE: 可选额外响应头（如 X-Search-Cache: HIT/MISS），向后兼容
  extraHeaders?: Record<string, string>
): NextResponse {
  const swr = Math.min(60, Math.max(10, Math.round(cacheTime / 10))); // 10~60s
  return NextResponse.json(data, {
    status,
    headers: {
      'Cache-Control': `public, max-age=${cacheTime}, s-maxage=${cacheTime}, stale-while-revalidate=${swr}`,
      'CDN-Cache-Control': `public, s-maxage=${cacheTime}, stale-while-revalidate=${swr}`,
      'Vercel-CDN-Cache-Control': `public, s-maxage=${cacheTime}, stale-while-revalidate=${swr}`,
      ...extraHeaders,
    },
  });
}
