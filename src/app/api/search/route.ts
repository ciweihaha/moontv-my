/* eslint-disable no-console */

import { NextResponse } from 'next/server';

import { recordUpstreamFailure, recordUpstreamSuccess, shouldSkipUpstream } from '@/lib/circuitBreaker';
import { getCacheTime, getConfig } from '@/lib/config';
import { searchFromApi } from '@/lib/downstream';
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
import { SearchResult } from '@/lib/types';
import { yellowRegex } from '@/lib/yellow';

export const runtime = 'edge';

type ApiSiteEntry = Awaited<ReturnType<typeof getConfig>>['SourceConfig'][number];

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
  // 站点增删/禁用 → 指纹变化 → 旧缓存自然失效
  const fingerprint = await sitesFingerprint(Array.from(sitesByApi.keys()));
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
  const inflight = getInflight(cacheKey);
  if (inflight) {
    const results = await inflight;
    const cacheTime = await getCacheTime();
    return jsonWithCache({ results }, cacheTime, 200, {
      'X-Search-Cache': 'HIT-SHARED',
    });
  }

  const upstreamPromise = doUpstreamSearch(
    sitesByApi,
    query,
    config.SiteConfig.SearchDownstreamMaxPage,
    config.SiteConfig.DisableYellowFilter
  );
  setInflight(cacheKey, upstreamPromise);

  const flattenedResults = await upstreamPromise;

  // KV-CACHE: 写回（失败不影响响应；空结果短 TTL 防穿透）
  await setCachedSearch(cacheKey, query, flattenedResults);

  const cacheTime = await getCacheTime();

  // QUALITY-R3: 缓存头拼写收敛到 jsonWithCache
  return jsonWithCache({ results: flattenedResults }, cacheTime, 200, {
    'X-Search-Cache': 'MISS',
  });
}

/** 原搜索主流程下沉为函数：44 上游并行 → 黄词过滤，便于缓存层复用 */
async function doUpstreamSearch(
  sitesByApi: Map<string, ApiSiteEntry[]>,
  query: string,
  maxSearchPages: number,
  disableYellowFilter: boolean | undefined
): Promise<SearchResult[]> {
  const searchPromises = Array.from(sitesByApi.values()).map(
    async (sites: ApiSiteEntry[]) => {
      // R2-S5: 熔断器——连续失败的上游短暂跳过，不拖慢整体
      const apiKey = sites[0].api;
      if (shouldSkipUpstream(apiKey)) {
        return [] as SearchResult[];
      }
      // 用组内第一个站点作为代表发起请求（PERF-R1: 页数一次传入，避免重复读配置）
      try {
        const results = await searchFromApi(sites[0], query, maxSearchPages);
        recordUpstreamSuccess(apiKey);
        // 结果展开回组内每个站点，保留各自的 source key 和 source_name
        return sites.flatMap((site) =>
          results.map((r) => ({ ...r, source: site.key, source_name: site.name }))
        );
      } catch (err) {
        recordUpstreamFailure(apiKey);
        throw err;
      }
    }
  );

  try {
    // P2-5: 总超时 10s，超时后返回已完成部分，不再等最慢上游
    const TOTAL_TIMEOUT_MS = 10000;
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('搜索总超时')), TOTAL_TIMEOUT_MS)
    );
    const results = await Promise.race([
      Promise.allSettled(searchPromises).then((settled) =>
        settled
          .filter(
            (s): s is PromiseFulfilledResult<SearchResult[]> =>
              s.status === 'fulfilled'
          )
          .map((s) => s.value)
      ),
      timeoutPromise,
    ]).catch(() => {
      // 超时：返回空（上游各自有 8s 单超时，此处为兜底）
      return [];
    });
    let flattenedResults: SearchResult[] = (
      results as SearchResult[][]
    ).flat();
    if (!disableYellowFilter) {
      flattenedResults = flattenedResults.filter((result) => {
        // 与详情接口对齐：同时检查 title + type_name，并转小写做大小写归一化
        // PERF-R1: 预编译正则一次匹配，替代逐词 includes
        const checkText = (
          (result.title || '') + (result.type_name || '')
        ).toLowerCase();
        return !yellowRegex.test(checkText);
      });
    }
    return flattenedResults;
  } catch {
    return [];
  }
}
