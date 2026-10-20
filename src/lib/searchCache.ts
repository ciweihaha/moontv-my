/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

import { SearchResult } from '@/lib/types';

import { CACHE_KEY_VERSION, cacheGet, cacheSet, getInflight as _getInflight, setInflight as _setInflight, ttlWithJitter } from './cache';

// R2-A1: 已收敛到通用缓存层（src/lib/cache.ts），本文件仅保留搜索特有的 key 构建与 TTL 策略。

// TTL 策略
const TTL_HIT_BASE = 3600; // 有结果：1 小时（热门搜索）
const TTL_EMPTY = 300; // 无结果：5 分钟（防缓存穿透，不宜过长）

const INFLIGHT_NS = 'search';

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
 *
 * R2-P3: 指纹 5 分钟内存缓存（站点配置变化不频繁，每次搜索都算 SHA-256 浪费）。
 */
const fingerprintCache = new Map<string, { fp: string; ts: number }>();
const FINGERPRINT_TTL_MS = 5 * 60 * 1000;

export async function sitesFingerprint(apiUrls: string[]): Promise<string> {
  const sorted = Array.from(new Set(apiUrls)).sort().join('|');
  const now = Date.now();
  const cached = fingerprintCache.get(sorted);
  if (cached && now - cached.ts < FINGERPRINT_TTL_MS) {
    return cached.fp;
  }
  const fp = (await sha256Hex(sorted)).slice(0, 12);
  fingerprintCache.set(sorted, { fp, ts: now });
  // 防内存泄漏：条目过多时清空
  if (fingerprintCache.size > 100) fingerprintCache.clear();
  return fp;
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
  return ttlWithJitter(TTL_HIT_BASE);
}

export async function getCachedSearch(
  cacheKey: string
): Promise<CachedSearch | null> {
  const data = await cacheGet<CachedSearch>(cacheKey);
  if (!data || !Array.isArray(data.results)) return null;
  return data;
}

export async function setCachedSearch(
  cacheKey: string,
  query: string,
  results: SearchResult[],
  // HARDENING-001 M-03: 调用方可显式指定 TTL（如部分结果的短 TTL），
  // 指定时原样使用（不再叠加抖动，保证不超过调用方给的上限）
  options?: { ttlSeconds?: number }
): Promise<void> {
  await cacheSet(
    cacheKey,
    {
      results,
      cachedAt: Date.now(),
      query: normalizeQuery(query),
    } satisfies CachedSearch,
    options?.ttlSeconds ?? ttlForResults(results.length)
  );
}

// ---- single-flight（命名空间隔离，防击穿） ----
export function getInflight<T = SearchResult[]>(
  cacheKey: string
): Promise<T> | undefined {
  return _getInflight<T>(INFLIGHT_NS, cacheKey);
}

export function setInflight<T = SearchResult[]>(
  cacheKey: string,
  p: Promise<T>
): void {
  _setInflight<T>(INFLIGHT_NS, cacheKey, p);
}
