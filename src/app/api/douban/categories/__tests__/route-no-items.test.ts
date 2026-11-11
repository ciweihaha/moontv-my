/**
 * @jest-environment node
 */
/**
 * 深查第 14 轮：豆瓣分类路由上游回 200 但无 items 数组时按空结果处理。
 * 旧实现直接 doubanData.items.map，豆瓣被拦回 200 无 items（与
 * /api/douban 的 subjects 同形态）时抛 TypeError → 500；新行为回
 * 200 空列表，与列表接口“空结果不算失败”一致。
 * 路由级测试：mock doubanCategories 的 fetchDoubanData 与 config
 *（mock 写法沿用 detail/__tests__/route-timeout-abort.test.ts）。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

class ShimRequest {
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
}

const mockFetchDoubanData = jest.fn();

jest.mock('@/lib/config', () => ({
  getCacheTime: async () => 300,
}));

jest.mock('@/lib/doubanCategories', () => ({
  fetchDoubanData: (...args: any[]) => mockFetchDoubanData(...args),
}));

let GET: (request: Request) => Promise<Response>;
beforeAll(async () => {
  const mod = (await import('../route')) as typeof import('../route');
  GET = mod.GET;
});

beforeEach(() => {
  mockFetchDoubanData.mockReset();
});

const URL =
  'http://localhost/api/douban/categories?kind=movie&category=热门&type=剧情&limit=20&start=0';

describe('douban 分类路由无 items 按空结果处理（深查第 14 轮）', () => {
  test('上游 200 但无 items 字段 → 200 空列表（旧实现 500）', async () => {
    mockFetchDoubanData.mockResolvedValue({ total: 0 });
    const res = await GET(new ShimRequest(URL) as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.list).toEqual([]);
  });

  test('上游回 null → 200 空列表，不抛错', async () => {
    mockFetchDoubanData.mockResolvedValue(null);
    const res = await GET(new ShimRequest(URL) as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.list).toEqual([]);
  });

  test('正常 items 逐字映射（回归基线）', async () => {
    mockFetchDoubanData.mockResolvedValue({
      total: 1,
      items: [
        {
          id: '1',
          title: '好片',
          card_subtitle: '2024 / 剧情',
          pic: { normal: 'https://img.example.com/n.jpg', large: 'https://img.example.com/l.jpg' },
          rating: { value: 8.5 },
        },
      ],
    });
    const res = await GET(new ShimRequest(URL) as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.list).toEqual([
      {
        id: '1',
        title: '好片',
        poster: 'https://img.example.com/n.jpg',
        rate: '8.5',
        year: '2024',
      },
    ]);
  });

  test('上游抛错 → 仍回 500（旧失败语义不变）', async () => {
    mockFetchDoubanData.mockRejectedValue(new Error('HTTP error! Status: 403'));
    const res = await GET(new ShimRequest(URL) as any);
    expect(res.status).toBe(500);
  });
});
