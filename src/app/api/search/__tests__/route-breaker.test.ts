/**
 * @jest-environment node
 */
/**
 * 搜索熔断三方处理回归（repo-hardening 第 5/12 项；main 合并时改指新结构）。
 *
 * 原测试在硬化分支的内联版搜索路由上验证：路由按 downstream 的
 * searchFromApiWithOutcome 三态记录熔断。合并到 main 后，搜索主流程已
 * 下沉到 @/lib/upstreamSearch（HARDENING-001 Round-1 结构），熔断记录由
 * upstreamSearch 依据 searchFromApi 的 M-02 抛错契约完成：
 * - resolve（含合法零结果）→ 记成功；
 * - 抛 SearchUpstreamError → 记失败，连续 3 次熔断打开、后续不再调用上游；
 * - 整体超时取消（signal abort 后抛错）→ 不记成功也不记失败，永不熔断；
 * - 成功清零既有失败计数。
 * 本测试改指该结构：downstream 被替换为可控的 searchFromApi mock，
 * circuitBreaker 用真实实现，断言点与原测试一一对应。
 * 每个用例用互不相同的 api 地址隔离熔断器状态。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---- 可控 mock（jest.mock 工厂只能引用 mock* 前缀变量）----
const mockSearch = jest.fn();

jest.mock('@/lib/downstream', () => ({
  searchFromApi: (...args: any[]) => mockSearch(...args),
  SearchUpstreamError: class SearchUpstreamError extends Error {
    readonly status?: number;
    constructor(message: string, status?: number) {
      super(message);
      this.name = 'SearchUpstreamError';
      this.status = status;
    }
  },
}));

jest.mock('@/lib/config', () => ({
  getConfig: async () => ({ SourceConfig: [], SiteConfig: {} }),
}));

import { shouldSkipUpstream } from '@/lib/circuitBreaker';
import { SearchUpstreamError } from '@/lib/downstream';
import { doUpstreamSearch } from '@/lib/upstreamSearch';

function sitesByApi(api: string) {
  const site: any = { key: 'k-' + api, api, name: '站点' };
  return new Map<string, any[]>([[api, [site]]]);
}

async function searchOnce(api: string, totalTimeoutMs?: number): Promise<void> {
  await doUpstreamSearch(sitesByApi(api), 'test', 1, true, totalTimeoutMs);
}

beforeEach(() => {
  mockSearch.mockReset();
});

describe('upstreamSearch 熔断三方处理（原 route-breaker 改指）', () => {
  test('failed 连续 3 次 → 熔断打开，第 4 次不再调用上游', async () => {
    const api = 'https://fail.example/api.php';
    mockSearch.mockRejectedValue(new SearchUpstreamError('搜索上游请求失败'));

    await searchOnce(api);
    await searchOnce(api);
    await searchOnce(api);
    expect(mockSearch.mock.calls.length).toBe(3);
    expect(shouldSkipUpstream(api)).toBe(true);

    await searchOnce(api);
    expect(mockSearch.mock.calls.length).toBe(3);
  });

  test('ok（合法零结果）反复出现 → 永不熔断，每次都调用上游', async () => {
    const api = 'https://empty.example/api.php';
    mockSearch.mockResolvedValue([]);

    for (let i = 0; i < 5; i++) await searchOnce(api);
    expect(mockSearch.mock.calls.length).toBe(5);
    expect(shouldSkipUpstream(api)).toBe(false);
  });

  test('cancelled 反复出现 → 不记失败，永不熔断', async () => {
    const api = 'https://cancel.example/api.php';
    // 模拟整体超时取消：请求挂起，直到 upstreamSearch 的 signal abort 才抛错
    mockSearch.mockImplementation(
      (_site: any, _q: any, _pages: any, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(
              Object.assign(new Error('The operation was aborted'), {
                name: 'AbortError',
              })
            );
          });
        })
    );

    for (let i = 0; i < 5; i++) await searchOnce(api, 50);
    expect(mockSearch.mock.calls.length).toBe(5);
    expect(shouldSkipUpstream(api)).toBe(false);
  });

  test('成功清零失败计数：2 失败 + 1 成功 + 2 失败仍不熔断，再 1 失败才熔断', async () => {
    const api = 'https://mixed.example/api.php';
    mockSearch
      .mockRejectedValueOnce(new SearchUpstreamError('搜索上游请求失败'))
      .mockRejectedValueOnce(new SearchUpstreamError('搜索上游请求失败'))
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new SearchUpstreamError('搜索上游请求失败'))
      .mockRejectedValueOnce(new SearchUpstreamError('搜索上游请求失败'));

    for (let i = 0; i < 5; i++) await searchOnce(api);
    expect(shouldSkipUpstream(api)).toBe(false);

    mockSearch.mockRejectedValue(new SearchUpstreamError('搜索上游请求失败'));
    await searchOnce(api);
    expect(shouldSkipUpstream(api)).toBe(true);
  });
});
