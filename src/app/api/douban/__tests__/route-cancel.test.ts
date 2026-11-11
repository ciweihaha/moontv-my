/**
 * @jest-environment node
 */
/**
 * 深查第 11 轮：豆瓣路由 fetchDoubanData 丢弃响应体前必须 cancel。
 * fetchWithRetry 返回的响应体是跟踪流，计时器在体读完/取消前一直生效；
 * 旧实现在 !ok 与 content-length 超限两处直接抛错、从不读体，计时器
 * 与连接悬到 10s 超时才释放；豆瓣 403/404 高发且 recommend/new_score
 * 各试一次，成批滞留。与详情路径（第 10 轮）同口径补 cancel。
 * 路由级测试：mock config/doubanCache/errorReport，用带 cancel 探针的
 * 上游流驱动真实路由 + 真实 fetchWithRetry（mock 写法沿用
 * detail/__tests__/route-timeout-abort.test.ts）。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Response as UndiciResponse } from 'undici';

if (typeof (globalThis as any).Response === 'undefined') {
  (globalThis as any).Response = UndiciResponse;
}

class ShimRequest {
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
}

jest.mock('@/lib/config', () => ({
  getConfig: async () => ({
    SourceConfig: [],
    SiteConfig: { DisableYellowFilter: false, SearchDownstreamMaxPage: 2 },
  }),
  getCacheTime: async () => 300,
}));

jest.mock('@/lib/doubanCache', () => ({
  buildDoubanCacheKey: () => 'dk:test',
  getCachedDouban: async () => null,
  setCachedDouban: async () => undefined,
}));

jest.mock('@/lib/doubanTop250', () => ({
  fetchTop250: async () => [],
}));

jest.mock('@/lib/errorReport', () => ({ reportError: () => undefined }));

let GET: (request: Request) => Promise<Response>;
beforeAll(async () => {
  const mod = (await import('../route')) as typeof import('../route');
  GET = mod.GET;
});

/** 带 cancel 探针的上游响应：headers 用真 Headers，content-length 才能穿过 fetchWithRetry 的跟踪响应 */
function makeProbedResponse(status: number, contentLength?: string) {
  const onCancel = jest.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('x'.repeat(64)));
    },
    cancel: () => {
      onCancel();
    },
  });
  const headers = new Headers();
  if (contentLength) headers.set('content-length', contentLength);
  return {
    response: {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Forbidden',
      headers,
      body: stream,
    },
    onCancel,
  };
}

const fetchMock = jest.fn();
(globalThis as any).fetch = fetchMock;

beforeEach(() => {
  fetchMock.mockReset();
});

describe('douban 路由丢弃响应体前 cancel（深查第 11 轮）', () => {
  test('豆瓣两次都 404 → 两次尝试的流都被 cancel，最终回 200 空列表', async () => {
    const probes: jest.Mock[] = [];
    fetchMock.mockImplementation(async () => {
      const { response, onCancel } = makeProbedResponse(404);
      probes.push(onCancel);
      return response;
    });
    const res = await GET(
      new ShimRequest(
        'http://localhost/api/douban?type=movie&tag=热门&pageSize=16&pageStart=0'
      ) as any
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.list).toEqual([]);
    // recommend + new_score 各一次，共两次丢弃、两次 cancel
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(probes).toHaveLength(2);
    probes.forEach((p) => expect(p).toHaveBeenCalledTimes(1));
  });

  test('content-length 超 1MB → 丢弃前 cancel，不读体', async () => {
    const probes: jest.Mock[] = [];
    fetchMock.mockImplementation(async () => {
      const { response, onCancel } = makeProbedResponse(200, String(2 * 1024 * 1024));
      probes.push(onCancel);
      return response;
    });
    const res = await GET(
      new ShimRequest(
        'http://localhost/api/douban?type=movie&tag=热门&pageSize=16&pageStart=0'
      ) as any
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.list).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(probes).toHaveLength(2);
    probes.forEach((p) => expect(p).toHaveBeenCalledTimes(1));
  });
});
