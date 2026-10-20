/* eslint-disable no-console */

/**
 * M-04: /api/search/one 专用保护层。
 *
 * 该接口（OrionTV 兼容）原先直调 searchFromApi，绕过主搜索
 * （src/app/api/search/route.ts）的全部聚合保护。本模块把单源调用
 * 接入与主搜索同一口径的保护层：
 * - 熔断：同一 circuitBreaker 实例，key = 上游 api 地址（与主搜索一致）
 * - 总超时＋取消：总预算 10s（与主搜索 TOTAL_TIMEOUT_MS 对齐），
 *   AbortController 的 signal 透传给 searchFromApi，超时后 abort
 *   并返回有界空结果，不再无限等待
 * - 缓存＋single-flight：复用通用缓存层（src/lib/cache.ts），
 *   key 含站点 key＋站点 api 指纹＋归一化搜索词哈希；单源短 TTL
 *
 * 失败契约兼容：searchFromApi 当前「吞错返回 []」，未来可能改为抛错。
 * 本模块一律 try/catch 包裹：抛错按失败处理（记熔断失败＋返回空结果），
 * 两种契约下都不会未捕获崩溃。
 */

import {
  recordUpstreamFailure,
  recordUpstreamSuccess,
  shouldSkipUpstream,
} from '@/lib/circuitBreaker';
import type { ApiSite } from '@/lib/config';
import { searchFromApi } from '@/lib/downstream';
import { SearchResult } from '@/lib/types';

import {
  CACHE_KEY_VERSION,
  cacheGet,
  cacheSet,
  getInflight,
  setInflight,
  ttlWithJitter,
} from './cache';
import { normalizeQuery } from './searchCache';

// 与主搜索总超时对齐（src/app/api/search/route.ts TOTAL_TIMEOUT_MS = 10000）
export const SEARCH_ONE_TOTAL_TIMEOUT_MS = 10_000;

// 单源短 TTL：主搜索聚合缓存为有结果 3600s / 空结果 300s；
// 单源切片失效面小、OrionTV 逐源轮询频率高，取更短的
// 有结果 600s（±10% 抖动）/ 空结果 120s，既摊薄上游压力又避免长尾陈旧。
const TTL_ONE_HIT_BASE = 600;
const TTL_ONE_EMPTY = 120;

const INFLIGHT_NS = 'search-one';

interface CachedSearchOne {
  results: SearchResult[];
  cachedAt: number;
}

export type SearchOneCacheStatus = 'HIT' | 'HIT-SHARED' | 'MISS' | 'SKIPPED';

export interface SearchOneOutcome {
  results: SearchResult[];
  cacheStatus: SearchOneCacheStatus;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(input)
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 单源缓存 key：版本 + search-one + 站点 key + 站点 api 短哈希 + 归一化搜索词哈希。
 * api 地址变更 → 哈希变化 → 旧缓存自然失效（与主搜索站点指纹同思路）。
 */
export async function buildSearchOneCacheKey(
  site: ApiSite,
  query: string
): Promise<string> {
  const apiHash = (await sha256Hex(site.api)).slice(0, 12);
  const qHash = (await sha256Hex(normalizeQuery(query))).slice(0, 32);
  return `${CACHE_KEY_VERSION}:search-one:${site.key}:${apiHash}:${qHash}`;
}

/**
 * 带保护层的单源搜索：缓存 → single-flight → 熔断 → 总超时/取消 → 上游。
 * 上游失败/超时/熔断跳过时返回空结果（与该接口现状「空结果 → 404」兼容），
 * 不向上抛错；配置/缓存层自身的异常由调用方（路由）兜底。
 */
export async function fetchSearchOneResults(
  site: ApiSite,
  query: string,
  maxSearchPages: number,
  options?: { timeoutMs?: number }
): Promise<SearchOneOutcome> {
  const timeoutMs = options?.timeoutMs ?? SEARCH_ONE_TOTAL_TIMEOUT_MS;
  const cacheKey = await buildSearchOneCacheKey(site, query);

  // 1. 缓存命中（KV 未绑定时 cacheGet 返回 null，自动降级）
  const cached = await cacheGet<CachedSearchOne>(cacheKey);
  if (cached && Array.isArray(cached.results)) {
    return { results: cached.results, cacheStatus: 'HIT' };
  }

  // 2. single-flight：同 isolate 内并发同参数只打一次上游
  const inflight = getInflight<SearchOneOutcome>(INFLIGHT_NS, cacheKey);
  if (inflight) {
    const shared = await inflight;
    return { ...shared, cacheStatus: 'HIT-SHARED' };
  }

  const promise = doFetchSearchOne(site, query, maxSearchPages, timeoutMs, cacheKey);
  setInflight(INFLIGHT_NS, cacheKey, promise);
  return promise;
}

async function doFetchSearchOne(
  site: ApiSite,
  query: string,
  maxSearchPages: number,
  timeoutMs: number,
  cacheKey: string
): Promise<SearchOneOutcome> {
  const apiKey = site.api;

  // 3. 熔断：与主搜索同一实例/口径，熔断中直接跳过（不记缓存，避免把
  //    瞬时跳过固化成空结果）
  if (shouldSkipUpstream(apiKey)) {
    return { results: [], cacheStatus: 'SKIPPED' };
  }

  // 4. 总超时＋取消：超时 abort 上游并返回有界空结果
  const abortController = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  type RaceResult =
    | { kind: 'ok'; results: SearchResult[] }
    | { kind: 'error' }
    | { kind: 'timeout' };

  const upstreamPromise: Promise<RaceResult> = (async () => {
    try {
      const results = await searchFromApi(
        site,
        query,
        maxSearchPages,
        abortController.signal
      );
      // 超时已按失败记账，迟到的成功不再重复记账
      if (!timedOut) recordUpstreamSuccess(apiKey);
      return { kind: 'ok', results };
    } catch {
      // searchFromApi 未来改为抛错契约时在此收口；超时引发的 abort
      // 抛错已在超时分支记过失败，避免一次请求重复记账
      if (!timedOut) recordUpstreamFailure(apiKey);
      return { kind: 'error' };
    }
  })();

  const timeoutPromise = new Promise<RaceResult>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      abortController.abort();
      resolve({ kind: 'timeout' });
    }, timeoutMs);
  });

  const race = await Promise.race([upstreamPromise, timeoutPromise]);
  if (timer) clearTimeout(timer);

  if (race.kind === 'timeout') {
    recordUpstreamFailure(apiKey);
    console.warn(
      `[search-one] ${apiKey.slice(0, 60)} 总超时 ${timeoutMs}ms，已取消上游请求`
    );
    return { results: [], cacheStatus: 'MISS' };
  }
  if (race.kind === 'error') {
    return { results: [], cacheStatus: 'MISS' };
  }

  // 5. 写回缓存（失败静默，不影响响应；空结果短 TTL 防穿透）
  await cacheSet(
    cacheKey,
    { results: race.results, cachedAt: Date.now() } satisfies CachedSearchOne,
    race.results.length > 0 ? ttlWithJitter(TTL_ONE_HIT_BASE) : TTL_ONE_EMPTY
  );
  return { results: race.results, cacheStatus: 'MISS' };
}
