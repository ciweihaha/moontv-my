/* eslint-disable no-console */

import { NextResponse } from 'next/server';

import { getCacheTime, getConfig } from '@/lib/config';
import { reportError } from '@/lib/errorReport';
import { jsonWithCache } from '@/lib/http';
import {
  buildSearchCacheKey,
  getCachedSearch,
  getInflight,
  setCachedSearch,
  setInflight,
  sitesFingerprint,
} from '@/lib/searchCache';
import {
  doUpstreamSearch,
  SEARCH_PARTIAL_CACHE_TTL_SECONDS,
  UpstreamSearchOutcome,
} from '@/lib/upstreamSearch';

export const runtime = 'edge';

export async function GET(request: Request) {
  try {
    return await doSearch(request);
  } catch (error) {
    console.error('[search] 搜索失败:', error);
    reportError('api/search', error);
    return NextResponse.json({ error: '搜索失败' }, { status: 500 });
  }
}

async function doSearch(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');

  // SEC-R2: 关键词长度上限，防超长输入耗尽上游/内存
  const MAX_QUERY_LENGTH = 100;
  if (query && query.length > MAX_QUERY_LENGTH) {
    return NextResponse.json({ error: '搜索关键词过长' }, { status: 400 });
  }

  if (!query) {
    const cacheTime = await getCacheTime();
    // QUALITY-R3: 缓存头拼写收敛到 jsonWithCache
    return jsonWithCache({ results: [] }, cacheTime);
  }

  const config = await getConfig();
  const apiSites = config.SourceConfig.filter((site) => !site.disabled);

  // R1: 按上游 api 地址去重，相同地址只请求一次（9 组重复地址 → 44 个唯一地址）
  const sitesByApi = new Map<string, typeof apiSites>();
  for (const site of apiSites) {
    // R1: 跳过 api 为空/undefined 的站点，防止被错误合并到同一组
    if (!site.api) continue;
    const group = sitesByApi.get(site.api);
    if (group) {
      group.push(site);
    } else {
      sitesByApi.set(site.api, [site]);
    }
  }

  // KV-CACHE: 缓存 key = 版本 + 站点指纹 + 归一化搜索词哈希
  // 指纹覆盖全部来源的 key/name/api/启用状态（含被禁用源）：
  // 管理员改名、改 key、增删或禁用源 → 指纹变化 → 旧缓存自然失效。
  // 注意不能只喂去重后的 api 地址——同址多源的 key/name 差异正是要防的串缓存。
  const fingerprint = await sitesFingerprint(config.SourceConfig);
  const cacheKey = await buildSearchCacheKey(query, fingerprint);

  // KV-CACHE: 先查缓存（未绑定 KV 时 getCachedSearch 直接返回 null）
  const cached = await getCachedSearch(cacheKey);
  if (cached) {
    const cacheTime = await getCacheTime();
    return jsonWithCache({ results: cached.results }, cacheTime, 200, {
      'X-Search-Cache': 'HIT',
    });
  }

  // KV-CACHE: single-flight，同一 isolate 内并发同 query 只打一次上游（防击穿）
  const inflight = getInflight<UpstreamSearchOutcome>(cacheKey);
  if (inflight) {
    const shared = await inflight;
    const cacheTime = await getCacheTime();
    return jsonWithCache({ results: shared.results }, cacheTime, 200, {
      'X-Search-Cache': 'HIT-SHARED',
      // M-03: 共享的若是部分结果，标注同样透传
      ...(shared.partial ? { 'X-Search-Partial': '1' } : {}),
    });
  }

  const upstreamPromise = doUpstreamSearch(
    sitesByApi,
    query,
    config.SiteConfig.SearchDownstreamMaxPage,
    config.SiteConfig.DisableYellowFilter
  );
  setInflight(cacheKey, upstreamPromise);

  const upstream = await upstreamPromise;
  const flattenedResults = upstream.results;

  // KV-CACHE: 写回（失败不影响响应；空结果短 TTL 防穿透）
  // M-03: 部分结果只写短 TTL（60s），不按完整结果的 3600s 污染缓存；
  // 选短 TTL 而非不写的理由：慢源期间同词重复搜索仍能摊薄上游压力，
  // 且残缺结果最迟 60s 后自然过期、由后续搜索补齐慢源。
  await setCachedSearch(
    cacheKey,
    query,
    flattenedResults,
    upstream.partial
      ? { ttlSeconds: SEARCH_PARTIAL_CACHE_TTL_SECONDS }
      : undefined
  );

  const cacheTime = await getCacheTime();

  // QUALITY-R3: 缓存头拼写收敛到 jsonWithCache
  return jsonWithCache({ results: flattenedResults }, cacheTime, 200, {
    'X-Search-Cache': 'MISS',
    ...(upstream.partial ? { 'X-Search-Partial': '1' } : {}),
  });
}
