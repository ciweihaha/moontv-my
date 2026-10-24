/**
 * @jest-environment node
 */
/**
 * 基线机制问题修复回归：
 * 1. 熔断计入总超时取消（upstreamSearch）：总超时到达时仍在途的组
 *    应记熔断失败——否则永久挂起源每搜必试、每次拖满总超时。
 *    阈值 3 保护单次慢搜索不致误熔断；半开试探恢复机制保留。
 * 2. 重试判定改名判断（fetchRetry）：超时错误按名识别，不依赖
 *    instanceof——真实 fetch 的 abort 拒绝是 DOMException（任何 realm
 *    下 instanceof Error 均为 false），旧谓词从未拦住过它。
 *
 * 熔断器为进程内单例：各用例用不同 api 隔离状态。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

jest.mock('@/lib/downstream', () => ({
  searchFromApi: jest.fn(),
}));

import vm from 'node:vm';
import { Response as UndiciResponse } from 'undici';

import { shouldSkipUpstream } from '@/lib/circuitBreaker';
import { searchFromApi } from '@/lib/downstream';
import { fetchWithRetry } from '@/lib/fetchRetry';
import { doUpstreamSearch } from '@/lib/upstreamSearch';

const searchMock = searchFromApi as jest.Mock;

const g = globalThis as any;
if (typeof g.Response === 'undefined') g.Response = UndiciResponse;

interface SiteLike {
  key: string;
  api: string;
  name: string;
}

function sitesMapOf(entries: SiteLike[]): Map<string, any[]> {
  const m = new Map<string, any[]>();
  for (const s of entries) m.set(s.api, [s]);
  return m;
}

function oneResult(site: SiteLike): any[] {
  return [
    {
      id: `${site.key}-1`,
      title: `test-${site.key}`,
      poster: '',
      episodes: [],
      source: site.key,
      source_name: site.name,
    },
  ];
}

/** 后台 worker 的 catch 可能晚于 race 返回一个 microtask，冲刷后再断言熔断态 */
const flush = () => new Promise((r) => setTimeout(r, 10));

/** 信号感知的 mock：abort 时拒绝（模拟真实 fetch 被取消），否则按延迟 resolve */
function signalAwareMock(
  impl: (site: SiteLike) => Promise<any[]>
): (site: SiteLike, _q: string, _p: number, signal?: AbortSignal) => Promise<any[]> {
  return async (site, _q, _p, signal) => {
    if (signal?.aborted) {
      const e = new Error('Aborted');
      e.name = 'AbortError';
      throw e;
    }
    return impl(site);
  };
}

describe('熔断计入总超时取消', () => {
  beforeEach(() => {
    searchMock.mockReset();
  });

  test('挂死组连续 3 次被总超时截断 → 第 4 次搜索被熔断跳过，不再请求它', async () => {
    const hang: SiteLike = {
      key: 'hang-x',
      api: 'https://hang-x.example/api',
      name: 'Hang站',
    };
    // 永不自行返回，仅在信号 abort 时拒绝（模拟挂死上游）
    searchMock.mockImplementation(
      (_site: SiteLike, _q: string, _p: number, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          if (signal?.aborted) {
            const e = new Error('Aborted');
            e.name = 'AbortError';
            reject(e);
            return;
          }
          signal?.addEventListener(
            'abort',
            () => {
              const e = new Error('Aborted');
              e.name = 'AbortError';
              reject(e);
            },
            { once: true }
          );
        })
    );

    for (let i = 0; i < 3; i++) {
      const out = await doUpstreamSearch(sitesMapOf([hang]), 'q', 1, true, 60);
      expect(out.partial).toBe(true);
      await flush();
    }
    expect(searchMock).toHaveBeenCalledTimes(3);

    // 第 4 次：熔断中，组被跳过——mock 不再被调用，结果为空但不是超时截断
    const fourth = await doUpstreamSearch(sitesMapOf([hang]), 'q', 1, true, 60);
    expect(searchMock).toHaveBeenCalledTimes(3);
    expect(fourth.results).toEqual([]);
    expect(fourth.partial).toBe(false);
    expect(shouldSkipUpstream(hang.api)).toBe(true);
  }, 10000);

  test('单次搜索被总超时截断不致误熔断；随后成功即清零', async () => {
    const slow: SiteLike = {
      key: 'slow-y',
      api: 'https://slow-y.example/api',
      name: 'Slow站',
    };
    searchMock.mockImplementation(
      signalAwareMock(async (site) => {
        await new Promise((r) => setTimeout(r, 200));
        return oneResult(site);
      })
    );

    // 第 1 次：60ms 总超时截断（记 1 次失败，未达阈值 3）
    const cut = await doUpstreamSearch(sitesMapOf([slow]), 'q', 1, true, 60);
    expect(cut.partial).toBe(true);
    await flush();
    expect(shouldSkipUpstream(slow.api)).toBe(false);

    // 第 2 次：预算充足，200ms 返回成功 → 计数清零，仍不跳过
    const ok = await doUpstreamSearch(sitesMapOf([slow]), 'q', 1, true, 5000);
    expect(ok.partial).toBe(false);
    expect(ok.results.length).toBe(1);
    expect(shouldSkipUpstream(slow.api)).toBe(false);
    expect(searchMock).toHaveBeenCalledTimes(2);
  }, 10000);

  test('半开试探：熔断 60s 后放行，成功即关闭、失败即重熔断', async () => {
    const probeOk: SiteLike = {
      key: 'probe-ok',
      api: 'https://probe-ok.example/api',
      name: 'ProbeOk站',
    };
    const probeFail: SiteLike = {
      key: 'probe-fail',
      api: 'https://probe-fail.example/api',
      name: 'ProbeFail站',
    };
    const hangImpl = (
      _site: SiteLike,
      _q: string,
      _p: number,
      signal?: AbortSignal
    ) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => {
            const e = new Error('Aborted');
            e.name = 'AbortError';
            reject(e);
          },
          { once: true }
        );
      });

    // 先把两组都熔断（各 3 次截断）
    searchMock.mockImplementation(hangImpl);
    for (let i = 0; i < 3; i++) {
      await doUpstreamSearch(sitesMapOf([probeOk]), 'q', 1, true, 60);
      await doUpstreamSearch(sitesMapOf([probeFail]), 'q', 1, true, 60);
      await flush();
    }
    expect(shouldSkipUpstream(probeOk.api)).toBe(true);
    expect(shouldSkipUpstream(probeFail.api)).toBe(true);

    // 时间快进 61s（只 mock Date.now，真实定时器不受影响）
    const now = Date.now() + 61_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      // 成功试探 → 关闭熔断，下一次搜索不再跳过
      searchMock.mockImplementation(signalAwareMock(async (site) => oneResult(site)));
      const probe = await doUpstreamSearch(sitesMapOf([probeOk]), 'q', 1, true, 5000);
      expect(probe.results.length).toBe(1);
      expect(shouldSkipUpstream(probeOk.api)).toBe(false);
      const callsBefore = searchMock.mock.calls.length;
      await doUpstreamSearch(sitesMapOf([probeOk]), 'q', 1, true, 5000);
      expect(searchMock.mock.calls.length).toBe(callsBefore + 1);

      // 失败试探 → 重新熔断
      searchMock.mockImplementation(async () => {
        throw new Error('upstream fail');
      });
      await doUpstreamSearch(sitesMapOf([probeFail]), 'q', 1, true, 5000);
      await flush();
      expect(shouldSkipUpstream(probeFail.api)).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  }, 10000);
});

describe('重试判定按错误名（不依赖 instanceof）', () => {
  const fetchMock = jest.fn();
  beforeAll(() => {
    g.fetch = fetchMock;
  });
  beforeEach(() => {
    fetchMock.mockReset();
  });

  test('跨 realm AbortError 不重试（且先证前提：外 realm Error 的 instanceof 为 false）', async () => {
    // jest 27 沙箱无 DOMException 全局；以外 realm Error 复现跨 realm 本质：
    // 原型链断裂，但 name 仍为 AbortError，名判断必须与 realm 无关。
    const crossRealmAbort = vm.runInNewContext(
      `(() => { const e = new Error('aborted'); e.name = 'AbortError'; return e; })()`
    );
    expect(crossRealmAbort.name).toBe('AbortError');
    expect(crossRealmAbort instanceof Error).toBe(false);
    fetchMock.mockRejectedValue(crossRealmAbort);
    await expect(
      fetchWithRetry('https://up.example/x', {}, { timeoutMs: 5000, retries: 1, backoffMs: 1 })
    ).rejects.toBe(crossRealmAbort);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('非 Error 原型对象（仅 name=AbortError，模拟 DOMException 不继承 Error 的情形）不重试', async () => {
    const domLike = { name: 'AbortError', message: 'aborted' };
    expect(domLike instanceof Error).toBe(false);
    fetchMock.mockRejectedValue(domLike);
    await expect(
      fetchWithRetry('https://up.example/x', {}, { timeoutMs: 5000, retries: 1, backoffMs: 1 })
    ).rejects.toBe(domLike);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('TimeoutError 名的超时错误不重试', async () => {
    const te = new Error('timeout');
    te.name = 'TimeoutError';
    fetchMock.mockRejectedValue(te);
    await expect(
      fetchWithRetry('https://up.example/x', {}, { timeoutMs: 5000, retries: 1, backoffMs: 1 })
    ).rejects.toBe(te);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('网络错误仍重试（对照组）', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(
      fetchWithRetry('https://up.example/x', {}, { timeoutMs: 5000, retries: 1, backoffMs: 1 })
    ).rejects.toThrow('fetch failed');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('5xx 仍重试（对照组）', async () => {
    fetchMock.mockResolvedValue(new UndiciResponse('err', { status: 500 }));
    await expect(
      fetchWithRetry('https://up.example/x', {}, { timeoutMs: 5000, retries: 1, backoffMs: 1 })
    ).rejects.toThrow('upstream 500');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
