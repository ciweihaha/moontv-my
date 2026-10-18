/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

import { SearchResult } from '@/lib/types';

import { getSearchKV } from './kv';

// 缓存 key 版本前缀：value 结构变化时 bump，天然失效旧缓存
const CACHE_KEY_VERSION = 'v1';

// TTL 策略
const TTL_HIT_BASE = 3600; // 有结果：1 小时（热门搜索）
const TTL_EMPTY = 300; // 无结果：5 分钟（防缓存穿透，不宜过长）
const TTL_JITTER_RATIO = 0.1; // ±10% 抖动，防雪崩（避免同时过期）

// 单个缓存 value 上限：超限不写 KV，防止大 value 拖慢读写
const MAX_CACHE_VALUE_BYTES = 1024 * 1024; // 1MB

interface CachedSearch {
  results: SearchResult[];
  cachedAt: number;
  query: string;
}

/** 搜索词归一化：去首尾空格、压缩空白、ASCII 转小写 */
export function normalizeQuery(query: string): string {
  return query
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[A-Z]/g, (c) => c.toLowerCase());
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
 * 从启用的上游站点算指纹：管理员增删/禁用源后指纹变化，
 * 缓存 key 随之变化，旧缓存自然失效，无需手动清。
 */
export async function sitesFingerprint(apiUrls: string[]): Promise<string> {
  const sorted = Array.from(new Set(apiUrls)).sort().join('|');
  return (await sha256Hex(sorted)).slice(0, 12);
}

export async function buildSearchCacheKey(
  query: string,
  fingerprint: string
): Promise<string> {
  const qHash = (await sha256Hex(normalizeQuery(query))).slice(0, 32);
  return `${CACHE_KEY_VERSION}:search:${fingerprint}:${qHash}`;
}

function ttlForResults(count: number): number {
  if (count === 0) return TTL_EMPTY;
  // ±10% 抖动
  const jitter = 1 + (Math.random() * 2 - 1) * TTL_JITTER_RATIO;
  return Math.round(TTL_HIT_BASE * jitter);
}

export async function getCachedSearch(
  cacheKey: string
): Promise<CachedSearch | null> {
  const kv = getSearchKV();
  if (!kv) return null;
  try {
    const data = (await kv.get(cacheKey, { type: 'json' })) as
      | CachedSearch
      | null;
    if (!data || !Array.isArray(data.results)) return null;
    return data;
  } catch (err) {
    console.error('[searchCache] KV get 失败，降级为无缓存:', err);
    return null;
  }
}

export async function setCachedSearch(
  cacheKey: string,
  query: string,
  results: SearchResult[]
): Promise<void> {
  const kv = getSearchKV();
  if (!kv) return;
  try {
    const value = JSON.stringify({
      results,
      cachedAt: Date.now(),
      query: normalizeQuery(query),
    } satisfies CachedSearch);
    if (new TextEncoder().encode(value).byteLength > MAX_CACHE_VALUE_BYTES) {
      return; // 超限不缓存
    }
    await kv.put(cacheKey, value, {
      expirationTtl: ttlForResults(results.length),
    });
  } catch (err) {
    console.error('[searchCache] KV put 失败:', err);
  }
}

// ---- 单机 single-flight：同一 isolate 内并发同 query 只打一次上游 ----
// 防缓存击穿（热点 key 过期瞬间大量请求同时回源）
const inflight = new Map<string, Promise<SearchResult[]>>();

export function getInflight(cacheKey: string) {
  return inflight.get(cacheKey);
}

export function setInflight(cacheKey: string, p: Promise<SearchResult[]>) {
  inflight.set(cacheKey, p);
  const cleanup = () => {
    if (inflight.get(cacheKey) === p) inflight.delete(cacheKey);
  };
  p.then(cleanup, cleanup);
}
