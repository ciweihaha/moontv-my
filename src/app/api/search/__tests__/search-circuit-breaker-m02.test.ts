/**
 * @jest-environment node
 */
/**
 * HARDENING-001 M-02 回归测试：熔断器被 searchFromApi 吞错架空。
 *
 * 链路（全真实实现，只 mock 最外层 fetch 与 config）：
 *   GET /api/search → doUpstreamSearch.searchOneGroup → searchFromApi
 *     → fetchWithRetry（mock 上游）→ recordUpstream{Success,Failure}
 *     → circuitBreaker.shouldSkipUpstream
 *
 * 旧代码上：searchFromApi 的 catch 全吞返回 []，searchOneGroup 见 []
 * 即记 success，连续 500 永不熔断 → 本文件的 500 用例必失败；
 * 新代码上：失败抛 SearchUpstreamError → 记 failure → 3 次后跳过。
 *
 * WHATWG 垫片同 image-proxy 测试：jest 27 node 环境未暴露
 * Request/Response/Headers/AbortController，垫片就绪后动态 import 路由。
 * AbortController 垫片实现真实的 abort 事件语义（fetchRetry 依赖）。
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
  async arrayBuffer(): Promise<ArrayBuffer> {
    return new ArrayBuffer(0);
  }
}

class ShimRequest {
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
}

class ShimAbortSignal {
  aborted = false;
  private listeners = new Set<() => void>();
  addEventListener(_type: string, fn: () => void): void {
    this.listeners.add(fn);
  }
  removeEventListener(_type: string, fn: () => void): void {
    this.listeners.delete(fn);
  }
  fireAbort(): void {
    this.aborted = true;
    this.listeners.forEach((fn) => fn());
    this.listeners.clear();
  }
}

class ShimAbortController {
  readonly signal = new ShimAbortSignal();
  abort(): void {
    if (!this.signal.aborted) this.signal.fireAbort();
  }
}

// eslint-disable-next-line no-undef
const g = globalThis as any;
if (typeof g.Request === 'undefined') g.Request = ShimRequest;
if (typeof g.Response === 'undefined') g.Response = ShimResponse;
if (typeof g.Headers === 'undefined') g.Headers = ShimHeaders;
if (typeof g.AbortController === 'undefined')
  g.AbortController = ShimAbortController;
// jest 27 node 环境未暴露 WebCrypto（searchCache 的 SHA-256 指纹要用）
if (typeof g.crypto === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
  g.crypto = require('crypto').webcrypto;
}

// ---- config mock：站点列表可由用例改写（mock* 前缀满足 jest hoist 限制） ----
const mockSites: Array<{ key: string; api: string; name: string }> = [];
jest.mock('@/lib/config', () => ({
  API_CONFIG: {
    search: {
      path: '?ac=videolist&wd=',
      pagePath: '?ac=videolist&wd={query}&pg={page}',
      headers: {},
    },
    detail: { path: '?ac=videolist&ids=', headers: {} },
  },
  getConfig: async () => ({
    SourceConfig: mockSites,
    SiteConfig: { SearchDownstreamMaxPage: 1, DisableYellowFilter: true },
  }),
  getCacheTime: async () => 60,
}));

let GET: (request: Request) => Promise<Response>;
let shouldSkipUpstream: (key: string) => boolean;
beforeAll(async () => {
  const routeMod = (await import('../route')) as typeof import('../route');
  GET = routeMod.GET;
  const cbMod =
    (await import('@/lib/circuitBreaker')) as typeof import('@/lib/circuitBreaker');
  shouldSkipUpstream = cbMod.shouldSkipUpstream;
});

/** 最小上游响应：searchFromApi 只用 ok/status/headers.get/body/arrayBuffer */
function upstream500(): any {
  return {
    ok: false,
    status: 500,
    headers: { get: () => null },
    body: null,
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

function upstream200EmptyList(): any {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ list: [], pagecount: 1 })
  );
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: null,
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

async function callSearch(q: string): Promise<Response> {
  const req = {
    url: `http://localhost/api/search?q=${encodeURIComponent(q)}`,
  } as unknown as Request;
  return (await GET(req)) as unknown as Response;
}

describe('M-02 熔断感知底层失败', () => {
  const realFetch = g.fetch;
  let fetchCalls: string[];

  afterEach(() => {
    g.fetch = realFetch;
  });

  test('上游持续 500：连续失败达到阈值（3 次）后该源被 shouldSkipUpstream 跳过', async () => {
    const api = 'https://m02-fail.example/api';
    mockSites.length = 0;
    mockSites.push({ key: 'm02fail', api, name: 'M02 Fail Source' });
    fetchCalls = [];
    g.fetch = async (input: unknown) => {
      fetchCalls.push(String(input));
      return upstream500();
    };

    // 3 次搜索，每次真实走 fetchWithRetry（2 次尝试）后抛错并记 failure
    for (const q of ['m02-a', 'm02-b', 'm02-c']) {
      const res = await callSearch(q);
      expect(res.status).toBe(200); // 单源失败不拖垮整体，返回空结果
      expect(await (res as any).json()).toEqual({ results: [] });
    }
    const callsAfter3 = fetchCalls.length;
    expect(callsAfter3).toBeGreaterThan(0);
    expect(shouldSkipUpstream(api)).toBe(true);

    // 第 4 次：熔断跳过，不再打上游
    const res4 = await callSearch('m02-d');
    expect(res4.status).toBe(200);
    expect(fetchCalls.length).toBe(callsAfter3);
  }, 30000);

  test('上游 200 空列表：记成功不计失败，多次搜索后仍不熔断', async () => {
    const api = 'https://m02-empty.example/api';
    mockSites.length = 0;
    mockSites.push({ key: 'm02empty', api, name: 'M02 Empty Source' });
    fetchCalls = [];
    g.fetch = async (input: unknown) => {
      fetchCalls.push(String(input));
      return upstream200EmptyList();
    };

    // 连续 4 次（超过熔断阈值 3）空结果搜索
    for (const q of ['m02-e1', 'm02-e2', 'm02-e3', 'm02-e4']) {
      const res = await callSearch(q);
      expect(res.status).toBe(200);
      expect(await (res as any).json()).toEqual({ results: [] });
    }
    // 空结果是成功：不跳过，且每次都真实打了上游（无 single-flight/缓存串扰）
    expect(shouldSkipUpstream(api)).toBe(false);
    expect(fetchCalls.length).toBe(4);
  }, 30000);
});
