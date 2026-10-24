/**
 * @jest-environment node
 */
/**
 * 详情缓存写入生命周期（repo-hardening 第 7 项）。
 *
 * 旧实现：setCachedDetail(cacheKey, result).catch(() => {}) 不 await、
 * 也不经 waitUntil——响应返回后写缓存的异步工作可能被运行时取消，
 * 详情缓存形同虚设（反复回源）。
 *
 * 新行为：返回前 await 写缓存完成（失败仍吞错，不影响响应）。
 * 本测试让写缓存人为延迟 40ms，断言 GET 返回时写入已经完成；
 * 旧实现下 GET 会先于写入完成返回，断言失败（先红后绿）。
 *
 * WHATWG 垫片沿用 image-proxy 测试的既有做法。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

class ShimHeaders {
  private map = new Map<string, string>();
  constructor(init?: Record<string, string> | ShimHeaders) {
    if (init instanceof ShimHeaders) {
      init.map.forEach((v, k) => this.map.set(k, v));
    } else if (init) {
      for (const k of Object.keys(init)) this.map.set(k.toLowerCase(), init[k]);
    }
  }
  set(name: string, value: string): void {
    this.map.set(name.toLowerCase(), value);
  }
  get(name: string): string | null {
    return this.map.get(name.toLowerCase()) ?? null;
  }
}

class ShimResponse {
  readonly status: number;
  readonly headers: ShimHeaders;
  private readonly body: unknown;
  static json(
    body: unknown,
    init?: { status?: number; headers?: Record<string, string> | ShimHeaders }
  ): ShimResponse {
    const headers =
      init?.headers instanceof ShimHeaders
        ? init.headers
        : new ShimHeaders(init?.headers);
    headers.set('content-type', 'application/json');
    return new ShimResponse(JSON.stringify(body), {
      status: init?.status ?? 200,
      headers,
    });
  }
  constructor(body?: unknown, init?: { status?: number; headers?: unknown }) {
    this.status = init?.status ?? 200;
    this.headers =
      init?.headers instanceof ShimHeaders
        ? init.headers
        : new ShimHeaders(init?.headers as Record<string, string> | undefined);
    this.body = body;
  }
  async json(): Promise<any> {
    return JSON.parse(String(this.body));
  }
}

class ShimRequest {
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
}

const g = globalThis as any;
if (typeof g.Request === 'undefined') g.Request = ShimRequest;
if (typeof g.Response === 'undefined') g.Response = ShimResponse;
if (typeof g.Headers === 'undefined') g.Headers = ShimHeaders;

// ---- 可控 mock ----
const mockState = {
  writeCompleted: false,
  writeCalls: 0,
};
const mockSetCachedDetail = jest.fn(async () => {
  mockState.writeCalls += 1;
  await new Promise((resolve) => setTimeout(resolve, 40));
  mockState.writeCompleted = true;
});

jest.mock('@/lib/config', () => ({
  getAvailableApiSites: async () => [
    { key: 'src1', name: '源1', api: 'https://a.example/api.php' },
  ],
  getCacheTime: async () => 300,
}));

jest.mock('@/lib/detailCache', () => ({
  buildDetailCacheKey: (source: string, id: string) => `dk:${source}:${id}`,
  getCachedDetail: async () => null,
  getDetailInflight: () => undefined,
  setDetailInflight: () => undefined,
  setCachedDetail: (...args: any[]) => mockSetCachedDetail(...args),
}));

jest.mock('@/lib/downstream', () => ({
  getDetailFromApi: async () => ({
    id: '123',
    title: '正常片名',
    poster: '',
    episodes: ['https://cdn.example/1.m3u8'],
    source: 'src1',
    source_name: '源1',
    class: '',
    year: '2024',
    desc: '',
    type_name: '电影',
  }),
}));

jest.mock('@/lib/errorReport', () => ({ reportError: () => undefined }));

let GET: (request: Request) => Promise<Response>;
beforeAll(async () => {
  const mod = (await import('../route')) as typeof import('../route');
  GET = mod.GET;
});

describe('detail route 缓存写入生命周期', () => {
  test('GET 返回前详情缓存写入必须已完成', async () => {
    const res = await GET(
      new ShimRequest('http://localhost/api/detail?id=123&source=src1') as any
    );
    expect(res.status).toBe(200);
    expect(mockState.writeCalls).toBe(1);
    // 核心断言：响应返回时写入已经落地，而不是悬空的后台 Promise
    expect(mockState.writeCompleted).toBe(true);
  });
});
