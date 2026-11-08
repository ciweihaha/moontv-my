/**
 * @jest-environment node
 */
/**
 * 深查第 4 轮（2026-11-06）：豆瓣两路由分页参数 NaN 校验回归测试。
 *
 * 旧实现缺陷（基线 422256e）：/api/douban 与 /api/douban/categories
 * 用裸 parseInt 解析分页参数，NaN 输入通过比较校验后流进上游 URL
 * 与缓存 key（基线复现见 /tmp/deep4-repro-baseline.js）。
 * 修复：两路由改用 src/lib/pageParams.parsePageInt，非数字回 400，
 * 缺参仍回默认值；本文件在 GET 层验证该行为，上游一律 mock，
 * 不发真实豆瓣请求。
 *
 * 环境说明：本仓 jest 27 的 vm 上下文没有 fetch API 全局量
 * （Request），真实 next/server 在此环境下 import 即失败
 * （Request is not defined）。路由 GET 只读 request.url，且
 * jsonWithCache 只用 NextResponse.json，故 mock next/server 为最小
 * 桩、request 传 { url } plain 对象；校验目标（400/200 状态与是否
 * 触达上游 mock）不受影响。
 */

 

jest.mock('next/server', () => ({
  NextResponse: {
    json: (
      data: unknown,
      init?: { status?: number; headers?: Record<string, string> }
    ) => ({
      status: init?.status ?? 200,
      headers: init?.headers ?? {},
      json: async () => data,
    }),
  },
}));

jest.mock('@/lib/config', () => ({
  getCacheTime: jest.fn(async () => 3600),
  getConfig: jest.fn(async () => ({
    SourceConfig: [],
    SiteConfig: { SearchDownstreamMaxPage: 1, DisableYellowFilter: false },
  })),
}));

jest.mock('@/lib/doubanCategories', () => ({
  fetchDoubanData: jest.fn(),
}));

jest.mock('@/lib/doubanCache', () => ({
  buildDoubanCacheKey: jest.fn(
    (type: string, tag: string, pageSize: number, pageStart: number) =>
      `k:${type}:${tag}:${pageSize}:${pageStart}`
  ),
  getCachedDouban: jest.fn(),
  setCachedDouban: jest.fn(async () => undefined),
}));

jest.mock('@/lib/doubanTop250', () => ({
  fetchTop250: jest.fn(),
}));

jest.mock('@/lib/errorReport', () => ({
  reportError: jest.fn(),
}));

jest.mock('@/lib/fetchRetry', () => ({
  fetchWithRetry: jest.fn(),
}));

jest.mock('@/lib/upstreamSearch', () => ({
  doUpstreamSearch: jest.fn(async () => ({ results: [] })),
}));

import { getCachedDouban } from '@/lib/doubanCache';
import { fetchDoubanData } from '@/lib/doubanCategories';
import { fetchTop250 } from '@/lib/doubanTop250';
import { fetchWithRetry } from '@/lib/fetchRetry';
import { doUpstreamSearch } from '@/lib/upstreamSearch';

import { GET as getCategories } from '@/app/api/douban/categories/route';
import { GET as getDouban } from '@/app/api/douban/route';

const mockedGetCachedDouban = getCachedDouban as jest.Mock;
const mockedFetchDoubanData = fetchDoubanData as jest.Mock;
const mockedFetchTop250 = fetchTop250 as jest.Mock;
const mockedFetchWithRetry = fetchWithRetry as jest.Mock;
const mockedDoUpstreamSearch = doUpstreamSearch as jest.Mock;

function req(url: string): Request {
  return { url } as unknown as Request;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedGetCachedDouban.mockResolvedValue(null);
  mockedFetchDoubanData.mockResolvedValue({ total: 0, items: [] });
  mockedFetchTop250.mockResolvedValue([]);
  mockedDoUpstreamSearch.mockResolvedValue({ results: [] });
});

describe('GET /api/douban 分页参数', () => {
  it('pageSize=abc 回 400，且不上游请求', async () => {
    const res = await getDouban(
      req('http://localhost/api/douban?type=movie&tag=%E7%83%AD%E9%97%A8&pageSize=abc')
    );
    expect(res.status).toBe(400);
    expect(mockedFetchWithRetry).not.toHaveBeenCalled();
    expect(mockedDoUpstreamSearch).not.toHaveBeenCalled();
  });

  it('pageStart=abc 回 400，且不上游请求', async () => {
    const res = await getDouban(
      req('http://localhost/api/douban?type=movie&tag=%E7%83%AD%E9%97%A8&pageStart=abc')
    );
    expect(res.status).toBe(400);
    expect(mockedFetchWithRetry).not.toHaveBeenCalled();
  });

  it('top250 且 pageStart=abc 回 400，不进 fetchTop250', async () => {
    const res = await getDouban(
      req('http://localhost/api/douban?type=movie&tag=top250&pageStart=abc')
    );
    expect(res.status).toBe(400);
    expect(mockedFetchTop250).not.toHaveBeenCalled();
  });

  it('合法分页仍放行：命中缓存回 200', async () => {
    mockedGetCachedDouban.mockResolvedValue({
      code: 200,
      message: '获取成功',
      list: [{ id: '1', title: 't', poster: '', rate: '', year: '' }],
    });
    const res = await getDouban(
      req('http://localhost/api/douban?type=movie&tag=%E7%83%AD%E9%97%A8&pageSize=16&pageStart=0')
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.list).toHaveLength(1);
  });

  it('缺参仍用默认值放行（不误拦）', async () => {
    mockedGetCachedDouban.mockResolvedValue({
      code: 200,
      message: '获取成功',
      list: [{ id: '1', title: 't', poster: '', rate: '', year: '' }],
    });
    const res = await getDouban(
      req('http://localhost/api/douban?type=movie&tag=%E7%83%AD%E9%97%A8')
    );
    expect(res.status).toBe(200);
  });

  it('既有越界校验不变：pageSize=0 / 101 仍回 400', async () => {
    const res0 = await getDouban(
      req('http://localhost/api/douban?type=movie&tag=%E7%83%AD%E9%97%A8&pageSize=0')
    );
    expect(res0.status).toBe(400);
    const res101 = await getDouban(
      req('http://localhost/api/douban?type=movie&tag=%E7%83%AD%E9%97%A8&pageSize=101')
    );
    expect(res101.status).toBe(400);
  });
});

describe('GET /api/douban/categories 分页参数', () => {
  const base =
    'http://localhost/api/douban/categories?kind=movie&category=c&type=t';

  it('limit=abc 回 400，且不调豆瓣取数', async () => {
    const res = await getCategories(req(`${base}&limit=abc`));
    expect(res.status).toBe(400);
    expect(mockedFetchDoubanData).not.toHaveBeenCalled();
  });

  it('start=abc 回 400，且不调豆瓣取数', async () => {
    const res = await getCategories(req(`${base}&start=abc`));
    expect(res.status).toBe(400);
    expect(mockedFetchDoubanData).not.toHaveBeenCalled();
  });

  it('合法分页仍放行：取数回 200', async () => {
    mockedFetchDoubanData.mockResolvedValue({
      total: 1,
      items: [
        {
          id: '1292052',
          title: '肖申克的救赎',
          card_subtitle: '1994 / 美国 / 犯罪 剧情',
          pic: { large: 'https://example.com/l.jpg', normal: 'https://example.com/n.jpg' },
          rating: { value: 9.7 },
        },
      ],
    });
    const res = await getCategories(req(`${base}&limit=20&start=0`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.list).toHaveLength(1);
    expect(body.list[0].title).toBe('肖申克的救赎');
  });

  it('缺参仍用默认值放行（不误拦）', async () => {
    const res = await getCategories(req(base));
    expect(res.status).toBe(200);
  });
});
