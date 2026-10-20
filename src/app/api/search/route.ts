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

/**
 * HARDENING-001 M-03: doUpstreamSearch 的返回契约。
 * partial=true 表示总超时截断（或异常兜底），results 可能不完整，
 * 调用方不得按完整结果缓存/呈现为完整结果。
 */
export interface UpstreamSearchOutcome {
  results: SearchResult[];
  partial: boolean;
}

/** M-03: 部分结果写 KV 的短 TTL（秒） */
export const SEARCH_PARTIAL_CACHE_TTL_SECONDS = 60;

/** 搜索总超时默认值（毫秒） */
const SEARCH_TOTAL_TIMEOUT_MS = 10000;

/** 原搜索主流程下沉为函数：44 上游并行 → 黄词过滤，便于缓存层复用
 * M-03: 导出供回归测试；totalTimeoutMs 可注入（默认 10s，生产行为不变），
 * 返回 {results, partial}，partial 表示总超时截断、结果可能不完整。 */
export async function doUpstreamSearch(
  sitesByApi: Map<string, ApiSiteEntry[]>,
  query: string,
  maxSearchPages: number,
  disableYellowFilter: boolean | undefined,
  totalTimeoutMs: number = SEARCH_TOTAL_TIMEOUT_MS
): Promise<UpstreamSearchOutcome> {
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
      // M-02: searchFromApi 新契约——失败（重试耗尽/5xx/网络等）抛
      // SearchUpstreamError，只有 HTTP 200（含空列表）才 resolve，
      // 因此 resolve 记 success、reject 记 failure，熔断不再被吞错架空
      const results = await searchFromApi(sites[0], query, maxSearchPages, abortController.signal);
      recordUpstreamSuccess(apiKey);
      // 结果展开回组内每个站点，保留各自的 source key 和 source_name
      const expanded = sites.flatMap((site) =>
        results.map((r) => ({ ...r, source: site.key, source_name: site.name }))
      );
      completedChunks.push(expanded);
    } catch {
      // 总超时 abort 取消的在途请求不是上游失败，不计入熔断
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

  // M-03: 总超时是否先于全部上游完成触发（决定 partial 标记）
  let timedOut = false;
  try {
    // P2-5/AUDIT-R2: 总超时 10s；超时后返回已完成的部分结果，不再等最慢上游，
    // 也不丢弃已拿到的数据（修复原来超时返回空数组与注释不一致的问题）
    // AUDIT-R3 P1: 超时后 abort，取消所有后台上游请求，不再消耗资源
    const allDone = runWithConcurrencyLimit();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        abortController.abort();
        resolve();
      }, totalTimeoutMs);
    });
    await Promise.race([allDone, timeout]);
    // 全部完成先到时清掉定时器，避免悬挂的 10s 定时器拖住进程/测试
    if (timer) clearTimeout(timer);

    const flattenedResults: SearchResult[] = completedChunks.flat();
    if (flattenedResults.length === 0) {
      return { results: [], partial: timedOut };
    }
    if (disableYellowFilter) {
      return { results: flattenedResults, partial: timedOut };
    }
    return {
      results: flattenedResults.filter((result) => {
        // 与详情接口对齐：同时检查 title + type_name，并转小写做大小写归一化
        // PERF-R1: 预编译正则一次匹配，替代逐词 includes
        const checkText = (
          (result.title || '') + (result.type_name || '')
        ).toLowerCase();
        return !yellowRegex.test(checkText);
      }),
      partial: timedOut,
    };
  } catch {
    // 异常兜底：返回已收集的部分结果，并保守按 partial 处理（不写长 TTL）
    return { results: completedChunks.flat(), partial: true };
  }
}
