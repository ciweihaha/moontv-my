/* eslint-disable no-console */

/**
 * R2-A1: 通用 KV 缓存层。
 *
 * 合并 searchCache.ts / detailCache.ts / doubanCache.ts 的重复逻辑
 * （三文件共 271 行，大量重复：key 版本、1MB 上限、try-catch 降级、single-flight）。
 *
 * 特性：
 * - TTL 抖动（±10%）：防缓存雪崩（大量 key 同时过期）
 * - 1MB value 上限：超限不写，防止大 value 拖慢 KV 读写
 * - single-flight：同一 isolate 内并发同 key 只回源一次（防击穿）
 * - 优雅降级：KV 未绑定或读写失败时返回 null / 静默跳过，不影响主流程
 */

import { getSearchKV } from './kv';

// 缓存 key 版本前缀：value 结构变化时 bump，旧缓存天然失效
export const CACHE_KEY_VERSION = 'v1';

// 单个缓存 value 上限
export const MAX_CACHE_VALUE_BYTES = 1024 * 1024; // 1MB

const TTL_JITTER_RATIO = 0.1; // ±10% 抖动

/** 带抖动的 TTL：base 秒 ±10% */
export function ttlWithJitter(baseSeconds: number): number {
  const jitter = 1 + (Math.random() * 2 - 1) * TTL_JITTER_RATIO;
  return Math.round(baseSeconds * jitter);
}

/**
 * 通用 KV 读取。失败或未命中返回 null（调用方降级走回源）。
 * 注：value 直接存业务对象（与旧版三缓存文件格式兼容，不包 {data} 壳）。
 */
export async function cacheGet<T>(cacheKey: string): Promise<T | null> {
  const kv = getSearchKV();
  if (!kv) return null;
  try {
    const data = (await kv.get(cacheKey, { type: 'json' })) as T | null;
    if (!data) return null;
    return data;
  } catch (err) {
    console.error(`[cache] KV get 失败 ${cacheKey.slice(0, 40)}，降级为无缓存:`, err);
    return null;
  }
}

/**
 * 通用 KV 写入。超 1MB 不写；失败静默（不影响主流程）。
 * @param ttlSeconds 过期秒数（已含抖动由调用方决定，或传原始值）
 */
export async function cacheSet<T>(
  cacheKey: string,
  data: T,
  ttlSeconds: number
): Promise<void> {
  const kv = getSearchKV();
  if (!kv) return;
  try {
    const value = JSON.stringify(data);
    if (new TextEncoder().encode(value).byteLength > MAX_CACHE_VALUE_BYTES) {
      return; // 超限不缓存
    }
    await kv.put(cacheKey, value, { expirationTtl: ttlSeconds });
  } catch (err) {
    console.error(`[cache] KV put 失败 ${cacheKey.slice(0, 40)}:`, err);
  }
}

// ---- single-flight：防缓存击穿 ----
// 每个 key 独立 Map，避免三类缓存互相干扰；value 类型擦除为 unknown/Promise<unknown>

const inflightMaps = new Map<string, Map<string, Promise<unknown>>>();

function inflightFor(namespace: string): Map<string, Promise<unknown>> {
  let m = inflightMaps.get(namespace);
  if (!m) {
    m = new Map();
    inflightMaps.set(namespace, m);
  }
  return m;
}

export function getInflight<T>(namespace: string, cacheKey: string): Promise<T> | undefined {
  return inflightFor(namespace).get(cacheKey) as Promise<T> | undefined;
}

export function setInflight<T>(
  namespace: string,
  cacheKey: string,
  p: Promise<T>
): void {
  const m = inflightFor(namespace);
  m.set(cacheKey, p as Promise<unknown>);
  const cleanup = () => {
    if (m.get(cacheKey) === (p as Promise<unknown>)) m.delete(cacheKey);
  };
  p.then(cleanup, cleanup);
}
