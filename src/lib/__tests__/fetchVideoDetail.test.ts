/**
 * @jest-environment node
 */
/**
 * fetchVideoDetail 15s 总超时定时器清理回归。
 *
 * 背景（2026-10-24 诊断续）：fetchVideoDetail 用 Promise.race + 真实
 * setTimeout(15000) 构造整体截止，旧实现竞速落定后从不 clearTimeout，
 * 与 detail/route 已修缺陷（1bfd8b4）同型——成功/失败路径每次调用都
 * 遗留一个最长 15s 的无用定时器（生产句柄占用；Jest worker 退出滞留
 * 的 src/lib 分区残余候选）。现有 cron 套件 mock 掉了本模块，故本文件
 * 直接驱动真实实现，依赖以 jest.mock 隔离。
 *
 * 断言手法沿用 detail 的句柄钉住法：监听全局 setTimeout/clearTimeout，
 * 钉住那只 15000ms 定时器的句柄，要求 Promise 落定后它已被 clear
 * （句柄级断言，不依赖墙钟）。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

jest.mock('@/lib/config', () => ({
  getAvailableApiSites: jest.fn(),
  getConfig: jest.fn(),
}));

jest.mock('../downstream', () => ({
  searchFromApi: jest.fn(),
  getDetailFromApi: jest.fn(),
}));

import { getAvailableApiSites, getConfig } from '@/lib/config';
import { SearchResult } from '@/lib/types';

import { getDetailFromApi, searchFromApi } from '../downstream';
import { fetchVideoDetail } from '../fetchVideoDetail';

const sitesMock = getAvailableApiSites as jest.Mock;
const configMock = getConfig as jest.Mock;
const searchMock = searchFromApi as jest.Mock;
const detailMock = getDetailFromApi as jest.Mock;

const site = { key: 'src1', name: '站1', api: 'https://a.example/api.php' };

function makeResult(id: string, source = 'src1'): SearchResult {
  return {
    id,
    title: '片名',
    poster: '',
    episodes: [],
    source,
    source_name: '站1',
    year: '2024',
  };
}

/** 在真实定时器下钉住 15000ms 句柄并断言已被 clearTimeout */
async function expectDeadlineTimerCleared(run: () => Promise<unknown>) {
  const setSpy = jest.spyOn(global, 'setTimeout');
  const clearSpy = jest.spyOn(global, 'clearTimeout');
  try {
    await run();
    const idx = setSpy.mock.calls.findIndex((c) => c[1] === 15000);
    expect(idx).toBeGreaterThanOrEqual(0);
    const handle = setSpy.mock.results[idx].value;
    expect(clearSpy).toHaveBeenCalledWith(handle);
  } finally {
    setSpy.mockRestore();
    clearSpy.mockRestore();
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  sitesMock.mockResolvedValue([site]);
  configMock.mockResolvedValue({
    SiteConfig: { SearchDownstreamMaxPage: 5 },
  });
});

describe('fetchVideoDetail 定时器清理（竞速落定后 clearTimeout）', () => {
  test('搜索命中路径：返回精确匹配且 15s 定时器已被清', async () => {
    const hit = makeResult('42');
    searchMock.mockResolvedValue([hit]);
    let returned: unknown;
    await expectDeadlineTimerCleared(async () => {
      returned = await fetchVideoDetail({
        source: 'src1',
        id: '42',
        fallbackTitle: '片名',
      });
    });
    expect(returned).toBe(hit);
    expect(detailMock).not.toHaveBeenCalled();
  });

  test('详情直查路径：返回详情且 15s 定时器已被清', async () => {
    const detail = makeResult('7');
    detailMock.mockResolvedValue(detail);
    let returned: unknown;
    await expectDeadlineTimerCleared(async () => {
      returned = await fetchVideoDetail({ source: 'src1', id: '7' });
    });
    expect(returned).toBe(detail);
    expect(searchMock).not.toHaveBeenCalled();
  });

  test('下游抛错路径：错误透传且 15s 定时器已被清', async () => {
    detailMock.mockRejectedValue(new Error('boom'));
    await expectDeadlineTimerCleared(async () => {
      await expect(
        fetchVideoDetail({ source: 'src1', id: '7' })
      ).rejects.toThrow('boom');
    });
  });

  test('无效来源路径：立即抛错且 15s 定时器已被清', async () => {
    sitesMock.mockResolvedValue([]);
    await expectDeadlineTimerCleared(async () => {
      await expect(
        fetchVideoDetail({ source: 'nope', id: '1' })
      ).rejects.toThrow('无效的API来源');
    });
  });
});

describe('fetchVideoDetail 超时语义（不变）', () => {
  test('下游永不落定：15s 后总超时 reject 且下游 signal 被 abort', async () => {
    // jest 27 默认 legacy fake timers 无 Async API，显式用 modern
    jest.useFakeTimers('modern');
    try {
      let seenSignal: AbortSignal | undefined;
      detailMock.mockImplementation(
        (_site: any, _id: any, signal: AbortSignal) => {
          seenSignal = signal;
          return new Promise(() => {
            /* 永不落定 */
          });
        }
      );
      const pending = fetchVideoDetail({ source: 'src1', id: '9' });
      const assertion = expect(pending).rejects.toThrow(
        'fetchVideoDetail 总超时'
      );
      // fake timers 不接管微任务：先手动 flush 微任务链，
      // 让 doFetch 跑到 getDetailFromApi 把 signal 记录下来
      for (let i = 0; i < 20 && !seenSignal; i++) {
        await Promise.resolve();
      }
      expect(seenSignal).toBeDefined();
      // jest 27 无 advanceTimersByTimeAsync：同步推进时钟后 await 断言
      // 即可让 reject 的微任务落定
      jest.advanceTimersByTime(15000);
      await assertion;
      expect(seenSignal?.aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
