/**
 * @jest-environment node
 */
/**
 * 外部审查遗留项 2（a/b/c）：缓存层边界验证。
 *
 * a. KV 返回格式异常时调用方安全降级：getCachedSearch 对 results 非数组 /
 *    非对象 / KV 读抛错 / KV 未绑定一律返回 null（回源），不得抛错或返回脏数据。
 * b. single-flight：同 key 请求失败（reject）后 in-flight 记录被清除，
 *    后续同 key 可以重新回源；成功后同样清除。
 * c. TTL 策略：调用方显式指定 ttlSeconds（如 partial 的 60s）时原样透传
 *    不叠加抖动；未指定时完整结果走 3600s±抖动、空结果 300s。
 *    （partial 在路由层只传短 TTL 的决策已由 M-03 集成测试覆盖，
 *    此处钉住 searchCache/cacheSet 这一环的透传契约。）
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const mockKvGet = jest.fn();
const mockKvPut = jest.fn(async () => undefined);
let mockKvImpl: any = null;

jest.mock('@/lib/kv', () => ({
  getSearchKV: () => mockKvImpl,
}));

import { cacheGet } from '../cache';
import {
  getCachedSearch,
  getInflight,
  setCachedSearch,
  setInflight,
} from '../searchCache';

function bindKv(): void {
  mockKvImpl = {
    get: mockKvGet,
    put: mockKvPut,
    delete: async () => undefined,
    list: async () => ({ keys: [], list_complete: true }),
  };
}

beforeEach(() => {
  mockKvGet.mockReset();
  mockKvPut.mockClear();
  bindKv();
});

describe('a. KV 返回格式异常 → 安全降级为未命中', () => {
  test('results 不是数组（字符串）→ null', async () => {
    mockKvGet.mockResolvedValue({ results: 'not-an-array', cachedAt: 1, query: 'q' });
    await expect(getCachedSearch('k-a1')).resolves.toBeNull();
  });

  test('顶层是数字 / 数组 / null → null', async () => {
    mockKvGet.mockResolvedValue(42);
    await expect(getCachedSearch('k-a2')).resolves.toBeNull();
    mockKvGet.mockResolvedValue([{ results: [] }]);
    await expect(getCachedSearch('k-a3')).resolves.toBeNull();
    mockKvGet.mockResolvedValue(null);
    await expect(getCachedSearch('k-a4')).resolves.toBeNull();
  });

  test('KV get 抛错（如存量值 JSON 损坏）→ null，不向上抛', async () => {
    mockKvGet.mockRejectedValue(new Error('JSON parse failed'));
    await expect(getCachedSearch('k-a5')).resolves.toBeNull();
    await expect(cacheGet('k-a5')).resolves.toBeNull();
  });

  test('KV 未绑定 → null', async () => {
    mockKvImpl = null;
    await expect(getCachedSearch('k-a6')).resolves.toBeNull();
  });

  test('结构合法 → 原样返回（含空 results 数组）', async () => {
    const good = { results: [], cachedAt: 123, query: 'q' };
    mockKvGet.mockResolvedValue(good);
    await expect(getCachedSearch('k-a7')).resolves.toEqual(good);
  });
});

describe('b. single-flight 失败后 in-flight 被清除', () => {
  test('promise reject 后记录清除，后续同 key 可重新设置并共享', async () => {
    const failing = Promise.reject(new Error('upstream boom'));
    setInflight('cache-boundary-ns-fail', failing);
    expect(getInflight('cache-boundary-ns-fail')).toBe(failing);
    await expect(failing).rejects.toThrow('upstream boom');
    // cleanup 在 settle 的微任务中执行，再等一拍
    await new Promise((r) => setTimeout(r, 0));
    expect(getInflight('cache-boundary-ns-fail')).toBeUndefined();

    // 同 key 后续请求可以重新回源（新 promise 被登记且可共享）
    const retry = Promise.resolve({ results: [], partial: false });
    setInflight('cache-boundary-ns-fail', retry);
    expect(getInflight('cache-boundary-ns-fail')).toBe(retry);
    await retry;
    await new Promise((r) => setTimeout(r, 0));
    expect(getInflight('cache-boundary-ns-fail')).toBeUndefined();
  });

  test('promise 成功后记录同样清除', async () => {
    const ok = Promise.resolve(1);
    setInflight('cache-boundary-ns-ok', ok);
    await ok;
    await new Promise((r) => setTimeout(r, 0));
    expect(getInflight('cache-boundary-ns-ok')).toBeUndefined();
  });

  test('未 settle 前同 key 返回同一 promise（只回源一次）', async () => {
    let resolveIt: (v: number) => void = () => undefined;
    const pending = new Promise<number>((r) => {
      resolveIt = r;
    });
    setInflight('cache-boundary-ns-pending', pending);
    expect(getInflight('cache-boundary-ns-pending')).toBe(pending);
    resolveIt(7);
    await pending;
  });
});

describe('c. setCachedSearch 的 TTL 契约', () => {
  function putTtl(): number {
    expect(mockKvPut.mock.calls).toHaveLength(1);
    return (mockKvPut.mock.calls[0][2] as { expirationTtl: number })
      .expirationTtl;
  }

  test('显式 ttlSeconds（partial 短 TTL）原样透传，不叠加抖动', async () => {
    await setCachedSearch('k-c1', 'q', [{ id: '1' } as any], { ttlSeconds: 60 });
    expect(putTtl()).toBe(60);
  });

  test('未指定且有结果 → 3600s ±10% 抖动区间', async () => {
    await setCachedSearch('k-c2', 'q', [{ id: '1' } as any]);
    const ttl = putTtl();
    expect(ttl).toBeGreaterThanOrEqual(3240);
    expect(ttl).toBeLessThanOrEqual(3960);
  });

  test('未指定且空结果 → 300s（防穿透）', async () => {
    await setCachedSearch('k-c3', 'q', []);
    expect(putTtl()).toBe(300);
  });
});
