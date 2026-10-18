/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

/**
 * Cloudflare KV 绑定访问。
 * 约定与 d1.db.ts 一致：Pages 运行时把 binding 注入 process.env，
 * 绑定名 SEARCH_KV（namespace: moontv-search-cache）。
 * 未绑定（本地开发/旧部署）时返回 null，调用方静默降级为无缓存。
 */

export interface KVNamespaceLike {
  get(
    key: string,
    options?: { type: 'json' } | { type: 'text' } | { cacheTtl?: number }
  ): Promise<any>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number }
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

let kvInstance: KVNamespaceLike | null | undefined;

export function getSearchKV(): KVNamespaceLike | null {
  if (kvInstance !== undefined) {
    return kvInstance;
  }
  try {
    const kv = (process.env as any).SEARCH_KV as KVNamespaceLike | undefined;
    kvInstance = kv && typeof kv.get === 'function' ? kv : null;
  } catch {
    kvInstance = null;
  }
  return kvInstance;
}
