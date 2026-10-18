/* eslint-disable no-console */

import { SearchResult } from '@/lib/types';

import { getSearchKV } from './kv';

/**
 * P1: 详情 KV 缓存。热门剧集详情被反复请求，缓存 30 分钟。
 * 复用 SEARCH_KV namespace（与搜索缓存共用）。
 */

const CACHE_KEY_VERSION = 'v1';
const TTL_DETAIL = 1800; // 30 分钟
const MAX_CACHE_VALUE_BYTES = 1024 * 1024; // 1MB

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
  const kv = getSearchKV();
  if (!kv) return null;
  try {
    const data = (await kv.get(cacheKey, { type: 'json' })) as
      | CachedDetail
      | null;
    if (!data || !data.result || typeof data.result.id === 'undefined') {
      return null;
    }
    return data.result;
  } catch (err) {
    console.error('[detailCache] KV get 失败，降级为无缓存:', err);
    return null;
  }
}

export async function setCachedDetail(
  cacheKey: string,
  result: SearchResult
): Promise<void> {
  const kv = getSearchKV();
  if (!kv) return;
  try {
    const value = JSON.stringify({
      result,
      cachedAt: Date.now(),
    } satisfies CachedDetail);
    if (new TextEncoder().encode(value).byteLength > MAX_CACHE_VALUE_BYTES) {
      return;
    }
    await kv.put(cacheKey, value, { expirationTtl: TTL_DETAIL });
  } catch (err) {
    console.error('[detailCache] KV put 失败:', err);
  }
}

// single-flight 防击穿
const inflight = new Map<string, Promise<SearchResult | null>>();

export function getDetailInflight(cacheKey: string) {
  return inflight.get(cacheKey);
}

export function setDetailInflight(
  cacheKey: string,
  p: Promise<SearchResult | null>
) {
  inflight.set(cacheKey, p);
  const cleanup = () => {
    if (inflight.get(cacheKey) === p) inflight.delete(cacheKey);
  };
  p.then(cleanup, cleanup);
}
