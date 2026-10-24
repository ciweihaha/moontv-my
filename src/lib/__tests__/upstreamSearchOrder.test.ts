/**
 * @jest-environment node
 */
/**
 * 外部审查遗留项 3：搜索结果组的合并顺序确定性。
 *
 * 旧实现把已完成的结果组按「完成时序」push 进 completedChunks，
 * 各上游响应快慢不同 → 同一查询的来源排列随网络时延漂移。
 * 新实现保留每组的源分组索引、汇总时按索引升序展开：
 * 无论完成时序如何，结果顺序恒等于源顺序。
 *
 * 用 mock searchFromApi 控制各组完成时序，真实 doUpstreamSearch 驱动。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

jest.mock('@/lib/downstream', () => ({
  searchFromApi: jest.fn(),
}));

import { searchFromApi } from '@/lib/downstream';
import { doUpstreamSearch } from '@/lib/upstreamSearch';

const searchMock = searchFromApi as jest.Mock;

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

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const A: SiteLike = { key: 'ord-a', api: 'https://ord-a.example/api', name: 'A站' };
const B: SiteLike = { key: 'ord-b', api: 'https://ord-b.example/api', name: 'B站' };
const C: SiteLike = { key: 'ord-c', api: 'https://ord-c.example/api', name: 'C站' };

/** 按 key 配置各组延迟，模拟不同的完成时序 */
function mockDelays(delays: Record<string, number>): void {
  searchMock.mockImplementation(async (site: SiteLike) => {
    await delay(delays[site.key] ?? 0);
    return [
      {
        id: `${site.key}-1`,
        title: `${site.key}的片`,
        poster: '',
        episodes: [],
        source: site.key,
        source_name: site.name,
      },
    ];
  });
}

beforeEach(() => {
  searchMock.mockReset();
});

describe('doUpstreamSearch 结果顺序确定性（审查遗留项 3）', () => {
  test('完成时序为 B→C→A 时，结果仍按源顺序 A→B→C', async () => {
    mockDelays({ 'ord-a': 80, 'ord-b': 10, 'ord-c': 40 });
    const outcome = await doUpstreamSearch(
      sitesMapOf([A, B, C]),
      '顺序',
      1,
      true,
      5000
    );
    expect(outcome.partial).toBe(false);
    expect(outcome.results.map((r) => r.source)).toEqual([
      'ord-a',
      'ord-b',
      'ord-c',
    ]);
  }, 30000);

  test('完成时序换成 C→A→B，两次结果顺序完全一致且等于源顺序', async () => {
    mockDelays({ 'ord-a': 30, 'ord-b': 70, 'ord-c': 5 });
    const first = await doUpstreamSearch(
      sitesMapOf([A, B, C]),
      '顺序2',
      1,
      true,
      5000
    );
    mockDelays({ 'ord-a': 5, 'ord-b': 20, 'ord-c': 90 });
    const second = await doUpstreamSearch(
      sitesMapOf([A, B, C]),
      '顺序2',
      1,
      true,
      5000
    );
    const order1 = first.results.map((r) => r.source);
    const order2 = second.results.map((r) => r.source);
    expect(order1).toEqual(['ord-a', 'ord-b', 'ord-c']);
    expect(order2).toEqual(order1);
  }, 30000);

  test('某组失败时其余组仍按源顺序排列（失败组不占位）', async () => {
    searchMock.mockImplementation(async (site: SiteLike) => {
      if (site.key === 'ord-b') {
        await delay(10);
        throw new Error('upstream down');
      }
      await delay(site.key === 'ord-a' ? 60 : 20);
      return [
        {
          id: `${site.key}-1`,
          title: `${site.key}的片`,
          poster: '',
          episodes: [],
          source: site.key,
          source_name: site.name,
        },
      ];
    });
    const outcome = await doUpstreamSearch(
      sitesMapOf([A, B, C]),
      '顺序3',
      1,
      true,
      5000
    );
    expect(outcome.results.map((r) => r.source)).toEqual(['ord-a', 'ord-c']);
  }, 30000);
});
