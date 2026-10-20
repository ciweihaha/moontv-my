/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * M-01 回归测试：播放页已知 source+id 时不应先全量搜索扇出。
 *
 * 组件级测试：mock next/navigation、Artplayer、hls.js、db.client 与
 * PageLayout/EpisodeSelector，只保留 PlayPageClient 的初始化编排逻辑；
 * 用 global.fetch mock 记录 /api/detail 与 /api/search 的调用顺序与次数。
 *
 * 渲染说明：仓内 @testing-library/react 的 peer @testing-library/dom
 * 未实际安装，故用 React 自带 act + react-dom/client createRoot 渲染，
 * 不新增依赖；断言层级与组件测试等价。
 *
 * 断言口径（按审计 M-01 与任务书）：
 * - 带 source+id：第一个请求必须是 /api/detail（detail=1），/api/search
 *   只能在进入可播放状态后作为后台补齐发起，且不阻塞可播放状态
 *   （用例 1 让 search 永不 resolve，页面仍须进入可播放状态）。
 * - 无 id：仍走 /api/search 全量搜索，detail 不调用。
 * - detail 失败 / 无可播剧集：回退原「先搜索后详情」流程。
 * - sessionStorage 缓存命中：detail 与 search 均不调用（原路径不变）。
 */

import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

import { SearchResult } from '@/lib/types';

import PlayPage from '../page';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
  useSearchParams: () =>
    new URLSearchParams((globalThis as any).__mockPlaySearchParams || ''),
}));

jest.mock('artplayer', () => {
  const MockArtplayer = jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    destroy: jest.fn(),
    video: null,
  }));
  return { __esModule: true, default: MockArtplayer };
});

jest.mock('hls.js', () => {
  class MockHls {}
  (MockHls as any).DefaultConfig = { loader: class {} };
  (MockHls as any).Events = { ERROR: 'hlsError' };
  (MockHls as any).ErrorTypes = {
    NETWORK_ERROR: 'networkError',
    MEDIA_ERROR: 'mediaError',
  };
  return { __esModule: true, default: MockHls };
});

jest.mock('@/lib/db.client', () => ({
  deleteFavorite: jest.fn(async () => undefined),
  deletePlayRecord: jest.fn(async () => undefined),
  deleteSkipConfig: jest.fn(async () => undefined),
  generateStorageKey: (source: string, id: string) => `${source}+${id}`,
  getAllPlayRecords: jest.fn(async () => ({})),
  getSkipConfig: jest.fn(async () => null),
  isFavorited: jest.fn(async () => false),
  saveFavorite: jest.fn(async () => undefined),
  savePlayRecord: jest.fn(async () => undefined),
  saveSkipConfig: jest.fn(async () => undefined),
  subscribeToDataUpdates: jest.fn(() => () => undefined),
}));

jest.mock('@/lib/utils', () => ({
  processImageUrl: (url: string) => url,
  getVideoResolutionFromM3u8: jest.fn(async () => ({
    quality: '1080p',
    loadSpeed: '1 MB/s',
    pingTime: 10,
  })),
}));

jest.mock('@/components/PageLayout', () => {
  const React = jest.requireActual('react');
  return {
    __esModule: true,
    default: ({ children }: any) => React.createElement('div', null, children),
  };
});

jest.mock('@/components/EpisodeSelector', () => {
  const React = jest.requireActual('react');
  return {
    __esModule: true,
    default: (props: any) =>
      React.createElement('div', {
        'data-testid': 'episode-selector',
        'data-sources': (props.availableSources || [])
          .map((s: SearchResult) => `${s.source}:${s.id}`)
          .join(','),
      }),
  };
});

const targetResult: SearchResult = {
  id: '42',
  title: 'Test Movie',
  poster: '',
  episodes: ['https://cdn.example/e1.m3u8', 'https://cdn.example/e2.m3u8'],
  source: 'srcA',
  source_name: 'Source A',
  year: '2024',
};

const otherResult: SearchResult = {
  ...targetResult,
  id: '77',
  source: 'srcB',
  source_name: 'Source B',
};

let fetchCalls: string[];
let detailShouldFail: boolean;
let detailPayload: SearchResult;
let searchResults: SearchResult[];
let searchNeverResolves: boolean;

let container: HTMLDivElement;
let root: Root | null;

const countCalls = (fragment: string) =>
  fetchCalls.filter((url) => url.includes(fragment)).length;

function installFetchMock() {
  (globalThis as any).fetch = jest.fn(async (input: any) => {
    const url = String(input);
    fetchCalls.push(url);
    if (url.startsWith('/api/detail')) {
      if (detailShouldFail) {
        return { ok: false, json: async () => ({}) };
      }
      return { ok: true, json: async () => detailPayload };
    }
    if (url.startsWith('/api/search')) {
      if (searchNeverResolves) {
        return new Promise(() => undefined);
      }
      return { ok: true, json: async () => ({ results: searchResults }) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

async function renderPage() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<PlayPage />);
  });
}

/** 轮询等待某个条件成立（每次轮询都用 act 冲刷 effect 与状态更新） */
async function waitForCondition(
  check: () => boolean,
  timeoutMs = 6000
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (check()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitForCondition 超时');
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  }
}

const selectorEl = () =>
  container.querySelector('[data-testid="episode-selector"]');

/** 进入可播放状态 = loading 结束、主界面（选集组件）已渲染 */
const expectPlayable = () => waitForCondition(() => selectorEl() !== null);

describe('M-01 播放页初始化编排', () => {
  beforeAll(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    fetchCalls = [];
    detailShouldFail = false;
    detailPayload = targetResult;
    searchResults = [targetResult, otherResult];
    searchNeverResolves = false;
    root = null;
    sessionStorage.clear();
    localStorage.clear();
    (globalThis as any).__mockPlaySearchParams =
      'source=srcA&id=42&title=Test%20Movie&year=2024';
    installFetchMock();
  });

  afterEach(async () => {
    if (root) {
      const r = root;
      await act(async () => {
        r.unmount();
      });
      root = null;
    }
    container?.remove();
    delete (globalThis as any).fetch;
  });

  test('带 source+id：detail 直查优先，search 不阻塞可播放状态', async () => {
    // 后台补齐的 search 永不返回：若 search 在关键路径上，页面永远进不了可播放状态
    searchNeverResolves = true;

    await renderPage();
    await expectPlayable();

    expect(fetchCalls[0]).toContain('/api/detail');
    expect(countCalls('/api/detail')).toBe(1);
    // search 只能在 detail 之后（作为后台补齐）发起
    const detailIdx = fetchCalls.findIndex((u) => u.includes('/api/detail'));
    const searchIdx = fetchCalls.findIndex((u) => u.includes('/api/search'));
    expect(searchIdx === -1 || searchIdx > detailIdx).toBe(true);
  });

  test('带 source+id：后台补齐把其他源并入换源列表且保留当前源在首位', async () => {
    await renderPage();
    await expectPlayable();

    await waitForCondition(
      () => selectorEl()?.getAttribute('data-sources') === 'srcA:42,srcB:77'
    );

    expect(countCalls('/api/detail')).toBe(1);
    expect(countCalls('/api/search')).toBe(1);
    expect(fetchCalls[0]).toContain('/api/detail');
    expect(fetchCalls[1]).toContain('/api/search');
  });

  test('无 id：仍走全量搜索，detail 不调用', async () => {
    (globalThis as any).__mockPlaySearchParams =
      'title=Test%20Movie&year=2024';

    await renderPage();
    await expectPlayable();

    expect(countCalls('/api/search')).toBe(1);
    expect(countCalls('/api/detail')).toBe(0);
    expect(fetchCalls[0]).toContain('/api/search');
  });

  test('带 source+id 但 detail 失败：回退先搜索后详情的原流程并可播放', async () => {
    detailShouldFail = true;

    await renderPage();
    await expectPlayable();

    // 先试 detail（失败）→ 回退 search，search 结果含目标源，不再重复调 detail
    expect(fetchCalls[0]).toContain('/api/detail');
    expect(fetchCalls[1]).toContain('/api/search');
    expect(countCalls('/api/detail')).toBe(1);
    expect(countCalls('/api/search')).toBe(1);
  });

  test('带 source+id 但 detail 无可播剧集：回退搜索流程', async () => {
    detailPayload = { ...targetResult, episodes: [] };

    await renderPage();
    await expectPlayable();

    expect(fetchCalls[0]).toContain('/api/detail');
    expect(fetchCalls[1]).toContain('/api/search');
    expect(countCalls('/api/search')).toBe(1);
  });

  test('sessionStorage 缓存命中：detail 与 search 均不调用', async () => {
    sessionStorage.setItem(
      'play_search_cache',
      JSON.stringify([targetResult, otherResult])
    );

    await renderPage();
    await expectPlayable();

    expect(countCalls('/api/detail')).toBe(0);
    expect(countCalls('/api/search')).toBe(0);
    expect(selectorEl()?.getAttribute('data-sources')).toBe('srcA:42,srcB:77');
  });
});
