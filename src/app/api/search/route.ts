/* eslint-disable no-console */

import { NextResponse } from 'next/server';

import { recordUpstreamFailure, recordUpstreamSuccess, shouldSkipUpstream } from '@/lib/circuitBreaker';
import { getCacheTime, getConfig } from '@/lib/config';
import { searchFromApiWithOutcome } from '@/lib/downstream';
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
  // AUDIT-R2: 全局并发上限，避免首次搜索对数十个上游同时发起请求形成峰值
  const CONCURRENCY_LIMIT = 10;
  // AUDIT-R2: 增量收集已完成结果，总超时到达时返回部分结果而非空数组
  const completedChunks: SearchResult[][] = [];
  // AUDIT-R3 P1: 整体取消控制器，超时后取消所有后台上游请求
  const abortController = new AbortController();

  async function searchOneGroup(sites: ApiSiteEntry[]): Promise<void> {
    // 已取消则直接退出
    if (abortController.signal.aborted) return;
    // R2-S5: 熔断器——连续失败的上游短暂跳过，不拖慢整体
    const apiKey = sites[0].api;
    if (shouldSkipUpstream(apiKey)) {
      return;
    }
    // 用组内第一个站点作为代表发起请求（PERF-R1: 页数一次传入，避免重复读配置）
    try {
      // repo-hardening 第 5/12 项：三分语义记录熔断——
      // ok（含合法零结果）记成功；failed 记失败；cancelled（整体超时取消）
      // 既不记成功也不记失败，避免把全局超时算到单个上游头上。
      const outcome = await searchFromApiWithOutcome(
        sites[0],
        query,
        maxSearchPages,
        abortController.signal
      );
      if (outcome.status === 'cancelled') {
        return;
      }
      if (outcome.status === 'failed') {
        recordUpstreamFailure(apiKey);
        return;
      }
      recordUpstreamSuccess(apiKey);
      const results = outcome.results;
      // 结果展开回组内每个站点，保留各自的 source key 和 source_name
      const expanded = sites.flatMap((site) =>
        results.map((r) => ({ ...r, source: site.key, source_name: site.name }))
      );
      completedChunks.push(expanded);
    } catch {
      // 兜底：意外抛错时，外部已取消则不记失败，其余记失败
      if (!abortController.signal.aborted) {
        recordUpstreamFailure(apiKey);
      }
      // 单组失败不影响其他组（原 Promise.allSettled 语义）
    }
  }

  // 简单 worker 池：限制同时进行的上游请求数
  async function runWithConcurrencyLimit(): Promise<void> {
    const groups = Array.from(sitesByApi.values());
    let nextIndex = 0;
    async function worker(): Promise<void> {
      while (nextIndex < groups.length) {
        // 检查取消
        if (abortController.signal.aborted) break;
        const i = nextIndex++;
        await searchOneGroup(groups[i]);
      }
    }
    const workers = Array.from(
      { length: Math.min(CONCURRENCY_LIMIT, groups.length) },
      () => worker()
    );
    await Promise.all(workers);
  }

  try {
    // P2-5/AUDIT-R2: 总超时 10s；超时后返回已完成的部分结果，不再等最慢上游，
    // 也不丢弃已拿到的数据（修复原来超时返回空数组与注释不一致的问题）
    // AUDIT-R3 P1: 超时后 abort，取消所有后台上游请求，不再消耗资源
    const TOTAL_TIMEOUT_MS = 10000;
    const allDone = runWithConcurrencyLimit();
    const timeout = new Promise<void>((resolve) =>
      setTimeout(() => {
        abortController.abort();
        resolve();
      }, TOTAL_TIMEOUT_MS)
    );
    await Promise.race([allDone, timeout]);

    const flattenedResults: SearchResult[] = completedChunks.flat();
    if (flattenedResults.length === 0) {
      return [];
    }
    if (disableYellowFilter) {
      return flattenedResults;
    }
    return flattenedResults.filter((result) => {
      // 与详情接口对齐：同时检查 title + type_name，并转小写做大小写归一化
      // PERF-R1: 预编译正则一次匹配，替代逐词 includes
      const checkText = (
        (result.title || '') + (result.type_name || '')
      ).toLowerCase();
      return !yellowRegex.test(checkText);
    });
  } catch {
    // 异常兜底：返回已收集的部分结果
    return completedChunks.flat();
  }
}
