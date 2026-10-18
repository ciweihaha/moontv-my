/* eslint-disable no-console */

import { SearchResult } from '@/lib/types';

import { CACHE_KEY_VERSION, cacheGet, cacheSet, getInflight as _getInflight, setInflight as _setInflight, ttlWithJitter } from './cache';

/**
 * R2-A1: 详情 KV 缓存。热门剧集详情被反复请求，缓存 30 分钟（+抖动）。
 * 已收敛到通用缓存层，复用 SEARCH_KV namespace（与搜索缓存共用）。
 */

const TTL_DETAIL = 1800; // 30 分钟
const INFLIGHT_NS = 'detail';

interface CachedDetail {
  result: SearchResult;
  cachedAt: number;
}

export function buildDetailCacheKey(source: string, id: string): string {
  // id 已在路由层做格式校验（^[\w-]+$），直接拼 key 安全
  return `${CACHE_KEY_VERSION}:detail:${source}:${id}`;
}

export async function getCachedDetail(
  cacheKey: string
): Promise<SearchResult | null> {
  const data = await cacheGet<CachedDetail>(cacheKey);
  if (!data || !data.result || typeof data.result.id === 'undefined') {
    return null;
  }
  return data.result;
}

export async function setCachedDetail(
  cacheKey: string,
  result: SearchResult
): Promise<void> {
  await cacheSet(
    cacheKey,
    { result, cachedAt: Date.now() } satisfies CachedDetail,
    ttlWithJitter(TTL_DETAIL)
  );
}

// single-flight 防击穿（命名空间隔离）
export function getDetailInflight(cacheKey: string) {
  return _getInflight<SearchResult | null>(INFLIGHT_NS, cacheKey);
}

export function setDetailInflight(
  cacheKey: string,
  p: Promise<SearchResult | null>
) {
  _setInflight<SearchResult | null>(INFLIGHT_NS, cacheKey, p);
}
