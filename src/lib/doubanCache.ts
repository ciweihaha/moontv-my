/* eslint-disable no-console */

import { DoubanResult } from '@/lib/types';

import { CACHE_KEY_VERSION, cacheGet, cacheSet, ttlWithJitter } from './cache';

/**
 * R2-A1: 豆瓣 KV 缓存。榜单/分类变化慢，缓存 6 小时（+抖动）。
 * 已收敛到通用缓存层，复用 SEARCH_KV namespace。
 */

const TTL_DOUBAN = 21600; // 6 小时

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
  const data = await cacheGet<CachedDouban>(cacheKey);
  if (!data || !data.result || !Array.isArray(data.result.list)) {
    return null;
  }
  return data.result;
}

export async function setCachedDouban(
  cacheKey: string,
  result: DoubanResult
): Promise<void> {
  await cacheSet(
    cacheKey,
    { result, cachedAt: Date.now() } satisfies CachedDouban,
    ttlWithJitter(TTL_DOUBAN)
  );
}
