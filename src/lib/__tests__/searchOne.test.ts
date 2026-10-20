/**
 * @jest-environment node
 */
/**
 * M-04 回归测试：/api/search/one 保护层（src/lib/searchOne.ts）。
 *
 * 旧行为（路由直调 searchFromApi）：无缓存、无 single-flight、无熔断、
 * 无总超时、无 AbortSignal——以下用例在旧实现下均不成立：
 * ① 同参数连发两次 → 上游被打两次；② 上游 hang → 无限等待。
 *
 * mock 策略：
 * - @/lib/downstream 的 searchFromApi 用 jest.fn 替代（计数/行为可控）
 * - SEARCH_KV 注入内存 fake KV，让通用缓存层（src/lib/cache.ts）真实运行
 * - 熔断器用真实实例，各用例使用互不重复的上游 api 地址隔离状态
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { ApiSite } from '@/lib/config';
import { searchFromApi } from '@/lib/downstream';
import { fetchSearchOneResults } from '@/lib/searchOne';
import type { SearchResult } from '@/lib/types';

jest.mock('@/lib/downstream', () => ({
  searchFromApi: jest.fn(),
}));

// 内存 fake KV：cache 层通过 getSearchKV 取绑定，此处直接替换该模块
// （process.env 注入对象在 Node 下会被转成字符串，故不用 env 方式）
jest.mock('@/lib/kv', () => {
  const store = new Map<string, string>();
  const fakeKV = {
    get: async (key: string, options?: { type?: string }) => {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return options?.type === 'json' ? JSON.parse(raw) : raw;
    },
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async () => ({ keys: [], list_complete: true }),
  };
  return { getSearchKV: () => fakeKV, __kvStore: store };
});

const mockSearchFromApi = searchFromApi as jest.Mock;

// jest 27 node 环境可能缺少 WebCrypto / TextEncoder 全局（searchOne 的
// SHA-256 key 构建与 jest.setup.js 的垫片范围之外），缺失时补齐
if (typeof (globalThis as any).crypto?.subtle === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  (globalThis as any).crypto = require('crypto').webcrypto;
}
if (typeof (globalThis as any).TextEncoder === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const util = require('util');
  (globalThis as any).TextEncoder = util.TextEncoder;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const kvStore: Map<string, string> = require('@/lib/kv').__kvStore;

function makeSite(api: string): ApiSite {
  return { key: `site-${api}`, api, name: '测试源' };
}

function makeResult(title: string): SearchResult {
  return {
    id: '1',
    title,
    poster: '',
    episodes: [],
    source: 'test',
    source_name: '测试源',
    year: '2024',
  };
}

beforeEach(() => {
  mockSearchFromApi.mockReset();
  kvStore.clear();
});

describe('fetchSearchOneResults（M-04 保护层）', () => {
  test('① 同参数连发两次：第二次命中缓存，上游只被请求一次', async () => {
    const site = makeSite('https://upstream-cache.example.com/api');
    mockSearchFromApi.mockResolvedValue([makeResult('测试片')]);

    const first = await fetchSearchOneResults(site, '测试片', 2);
    const second = await fetchSearchOneResults(site, '测试片', 2);

    expect(mockSearchFromApi).toHaveBeenCalledTimes(1);
    expect(first.cacheStatus).toBe('MISS');
    expect(second.cacheStatus).toBe('HIT');
    expect(second.results).toHaveLength(1);
    expect(second.results[0].title).toBe('测试片');
  });

  test('①b 并发同参数：single-flight 合并，上游只被请求一次', async () => {
    const site = makeSite('https://upstream-singleflight.example.com/api');
    let resolveUpstream: (v: SearchResult[]) => void = () => undefined;
    mockSearchFromApi.mockImplementation(
      () =>
        new Promise<SearchResult[]>((resolve) => {
          resolveUpstream = resolve;
        })
    );

    const p1 = fetchSearchOneResults(site, '并发片', 2);
    const p2 = fetchSearchOneResults(site, '并发片', 2);
    // 等两个调用都进入保护层后再放行上游
    await new Promise((r) => setTimeout(r, 20));
    resolveUpstream([makeResult('并发片')]);
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(mockSearchFromApi).toHaveBeenCalledTimes(1);
    expect(r1.results).toHaveLength(1);
    expect(r2.results).toHaveLength(1);
    expect([r1.cacheStatus, r2.cacheStatus]).toContain('HIT-SHARED');
  });

  test('② 上游 hang 住不响应：总耗时有上限（总预算+余量内返回空结果）', async () => {
    const site = makeSite('https://upstream-hang.example.com/api');
    // hang：永不 resolve 且忽略 AbortSignal，模拟最坏上游
    mockSearchFromApi.mockImplementation(() => new Promise<SearchResult[]>(() => undefined));

    const timeoutMs = 300;
    const start = Date.now();
    const outcome = await fetchSearchOneResults(site, '挂死片', 2, { timeoutMs });
    const elapsed = Date.now() - start;

    expect(outcome.results).toEqual([]);
    // 总预算 300ms，留足余量也必须远小于「无限等」；上限取预算的 10 倍内
    expect(elapsed).toBeLessThan(timeoutMs + 2000);
    // signal 已透传给上游（旧实现未传第四参）
    expect(mockSearchFromApi.mock.calls[0][3]).toBeInstanceOf(AbortSignal);
  });

  test('③ 上游抛错（新失败契约）：不崩溃，返回空结果且连续失败触发熔断跳过', async () => {
    const site = makeSite('https://upstream-error.example.com/api');
    mockSearchFromApi.mockRejectedValue(new Error('upstream boom'));

    // 抛错被 try/catch 收口为失败＋空结果，不向上崩溃
    const first = await fetchSearchOneResults(site, '报错片', 2);
    expect(first.results).toEqual([]);

    // 熔断阈值 3 次连续失败（与主搜索同一实例/口径）
    await fetchSearchOneResults(site, '报错片', 2);
    await fetchSearchOneResults(site, '报错片', 2);
    expect(mockSearchFromApi).toHaveBeenCalledTimes(3);

    // 第 4 次：熔断中，直接跳过，不再打上游
    const skipped = await fetchSearchOneResults(site, '报错片', 2);
    expect(skipped.cacheStatus).toBe('SKIPPED');
    expect(skipped.results).toEqual([]);
    expect(mockSearchFromApi).toHaveBeenCalledTimes(3);
  });
});
