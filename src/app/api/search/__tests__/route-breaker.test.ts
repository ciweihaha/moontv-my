/**
 * @jest-environment node
 */
/**
 * 搜索熔断三方处理回归（repo-hardening 第 5/12 项）。
 *
 * downstream 被替换为可控的 searchFromApiWithOutcome mock，
 * config / searchCache 被打桩（始终缓存未命中），circuitBreaker 用真实实现，
 * 断言路由层对三种结果的记录行为：
 * - failed：连续 3 次后熔断打开，后续请求不再调用上游；
 * - ok（含合法零结果）：永不熔断，每次都调用上游；
 * - cancelled（整体超时取消）：不记成功也不记失败，永不熔断；
 * - 成功会清零既有失败计数。
 *
 * 每个用例用互不相同的 api 地址隔离熔断器状态。
 * WHATWG 垫片沿用 image-proxy 测试的既有做法（jest 27 node 环境缺全局变量）。
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

// ---- 可控 mock（jest.mock 工厂只能引用 mock* 前缀变量）----
const mockOutcome = jest.fn();
const mockSites: Array<{ key: string; api: string; name: string }> = [];

jest.mock('@/lib/downstream', () => ({
  searchFromApiWithOutcome: (...args: any[]) => mockOutcome(...args),
  searchFromApi: async () => [],
}));

jest.mock('@/lib/config', () => ({
  getConfig: async () => ({
    SourceConfig: mockSites,
    SiteConfig: { SearchDownstreamMaxPage: 1, DisableYellowFilter: true },
  }),
  getCacheTime: async () => 300,
}));

jest.mock('@/lib/searchCache', () => ({
  sitesFingerprint: async () => 'fp',
  buildSearchCacheKey: async () => 'ck',
  getCachedSearch: async () => null,
  getInflight: () => undefined,
  setInflight: () => undefined,
  setCachedSearch: async () => undefined,
}));

jest.mock('@/lib/errorReport', () => ({ reportError: () => undefined }));

import { shouldSkipUpstream } from '@/lib/circuitBreaker';

let GET: (request: Request) => Promise<Response>;
beforeAll(async () => {
  const mod = (await import('../route')) as typeof import('../route');
  GET = mod.GET;
});

function useSite(api: string) {
  mockSites.length = 0;
  mockSites.push({ key: 'k-' + api, api, name: '站点' });
}

async function doGet(): Promise<void> {
  await GET(new ShimRequest('http://localhost/api/search?q=test') as any);
}

beforeEach(() => {
  mockOutcome.mockReset();
});

describe('search route 熔断三方处理', () => {
  test('failed 连续 3 次 → 熔断打开，第 4 次不再调用上游', async () => {
    const api = 'https://fail.example/api.php';
    useSite(api);
    mockOutcome.mockResolvedValue({ status: 'failed' });

    await doGet();
    await doGet();
    await doGet();
    expect(mockOutcome.mock.calls.length).toBe(3);
    expect(shouldSkipUpstream(api)).toBe(true);

    await doGet();
    expect(mockOutcome.mock.calls.length).toBe(3);
  });

  test('ok（合法零结果）反复出现 → 永不熔断，每次都调用上游', async () => {
    const api = 'https://empty.example/api.php';
    useSite(api);
    mockOutcome.mockResolvedValue({ status: 'ok', results: [] });

    for (let i = 0; i < 5; i++) await doGet();
    expect(mockOutcome.mock.calls.length).toBe(5);
    expect(shouldSkipUpstream(api)).toBe(false);
  });

  test('cancelled 反复出现 → 不记失败，永不熔断', async () => {
    const api = 'https://cancel.example/api.php';
    useSite(api);
    mockOutcome.mockResolvedValue({ status: 'cancelled' });

    for (let i = 0; i < 5; i++) await doGet();
    expect(mockOutcome.mock.calls.length).toBe(5);
    expect(shouldSkipUpstream(api)).toBe(false);
  });

  test('成功清零失败计数：2 失败 + 1 成功 + 2 失败仍不熔断，再 1 失败才熔断', async () => {
    const api = 'https://mixed.example/api.php';
    useSite(api);
    mockOutcome
      .mockResolvedValueOnce({ status: 'failed' })
      .mockResolvedValueOnce({ status: 'failed' })
      .mockResolvedValueOnce({ status: 'ok', results: [] })
      .mockResolvedValueOnce({ status: 'failed' })
      .mockResolvedValueOnce({ status: 'failed' });

    for (let i = 0; i < 5; i++) await doGet();
    expect(shouldSkipUpstream(api)).toBe(false);

    mockOutcome.mockResolvedValue({ status: 'failed' });
    await doGet();
    expect(shouldSkipUpstream(api)).toBe(true);
  });
});
