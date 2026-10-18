/* eslint-disable no-console */

import { DoubanResult } from '@/lib/types';

import { getSearchKV } from './kv';

/**
 * P2: 豆瓣 KV 缓存。榜单/分类变化慢，缓存 6 小时。
 * 复用 SEARCH_KV namespace。
 */

const CACHE_KEY_VERSION = 'v1';
const TTL_DOUBAN = 21600; // 6 小时
const MAX_CACHE_VALUE_BYTES = 1024 * 1024; // 1MB

interface CachedDouban {
  result: DoubanResult;
  cachedAt: number;
}

export function buildDoubanCacheKey(
  type: string,
  tag: string,
  pageSize: number,
  pageStart: number
): string {
  // tag 已在路由层做长度≤50 校验，直接拼 key 安全
  const safeTag = tag.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_').slice(0, 50);
  return `${CACHE_KEY_VERSION}:douban:${type}:${safeTag}:${pageSize}:${pageStart}`;
}

export async function getCachedDouban(
  cacheKey: string
): Promise<DoubanResult | null> {
  const kv = getSearchKV();
  if (!kv) return null;
  try {
    const data = (await kv.get(cacheKey, { type: 'json' })) as
      | CachedDouban
      | null;
    if (!data || !data.result || !Array.isArray(data.result.list)) {
      return null;
    }
    return data.result;
  } catch (err) {
    console.error('[doubanCache] KV get 失败，降级为无缓存:', err);
    return null;
  }
}

export async function setCachedDouban(
  cacheKey: string,
  result: DoubanResult
): Promise<void> {
  const kv = getSearchKV();
  if (!kv) return;
  try {
    const value = JSON.stringify({
      result,
      cachedAt: Date.now(),
    } satisfies CachedDouban);
    if (new TextEncoder().encode(value).byteLength > MAX_CACHE_VALUE_BYTES) {
      return;
    }
    await kv.put(cacheKey, value, { expirationTtl: TTL_DOUBAN });
  } catch (err) {
    console.error('[doubanCache] KV put 失败:', err);
  }
}
