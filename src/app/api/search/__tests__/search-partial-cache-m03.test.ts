/**
 * @jest-environment node
 */
/**
 * HARDENING-001 M-03 回归测试：部分结果污染缓存。
 *
 * 两层覆盖：
 * 1. doUpstreamSearch（真实实现，总超时注入为 50ms）：慢源未完成时
 *    返回 { partial: true } 且只带已完成源的结果；全部完成时 partial=false。
 *    旧代码上 doUpstreamSearch 未导出且返回裸数组 → 本层必失败。
 * 2. GET 层缓存决策集成（真实 route + mock KV + mock fetch）：
 *    - partial（慢源 hang 住、真实 10s 总超时截断）：KV 写入 TTL ≤ 60s，
 *      且响应带 X-Search-Partial: 1；
 *    - 非 partial：仍按完整 TTL（3600s ± 抖动）写 KV，且无该响应头。
 *    旧代码上 partial 与完整走同一出口按 3600s 写、无标注头 → 本层必失败。
 *
 * WHATWG 垫片与 M-02 测试同套（jest 27 node 环境缺失这些全局量）。
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
if (typeof g.crypto === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
  g.crypto = require('crypto').webcrypto;
}

// ---- mock KV：在缓存层（@/lib/kv）注入，cache/searchCache 走真实实现 ----
// 注：不能用 process.env.SEARCH_KV 注入——Node 会把赋给 env 的对象转成字符串。
const mockKvPut = jest.fn(async () => undefined);
jest.mock('@/lib/kv', () => ({
  getSearchKV: () => ({
    get: async () => null,
    put: mockKvPut,
    delete: async () => undefined,
    list: async () => ({ keys: [], list_complete: true }),
  }),
}));

// ---- config mock ----
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
let doUpstreamSearch: any;
beforeAll(async () => {
  const routeMod = (await import('../route')) as any;
  GET = routeMod.GET;
  doUpstreamSearch = routeMod.doUpstreamSearch;
});

/** 200 且带一条结果的上游响应（body 走 arrayBuffer 降级路径） */
function upstream200WithItem(id: string, title: string): any {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      list: [
        {
          vod_id: id,
          vod_name: title,
          vod_pic: '',
          vod_play_url: 'ep$https://cdn.example/ep.m3u8',
        },
      ],
      pagecount: 1,
    })
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

function sitesMapOf(
  entries: Array<{ key: string; api: string; name: string }>
): Map<string, any[]> {
  const m = new Map<string, any[]>();
  for (const s of entries) m.set(s.api, [s]);
  return m;
}

async function callSearch(q: string): Promise<Response> {
  const req = {
    url: `http://localhost/api/search?q=${encodeURIComponent(q)}`,
  } as unknown as Request;
  return (await GET(req)) as unknown as Response;
}

/** 本次测试内 KV put 的全部 expirationTtl */
function putTtls(): number[] {
  return mockKvPut.mock.calls.map(
    (c: any[]) => (c[2] as { expirationTtl?: number })?.expirationTtl ?? -1
  );
}

describe('M-03 doUpstreamSearch partial 标记（注入短超时）', () => {
  const realFetch = g.fetch;
  afterEach(() => {
    g.fetch = realFetch;
  });

  test('总超时截断时 partial=true 且只含已完成源结果', async () => {
    const fast = { key: 'd-fast', api: 'https://m03-dfast.example/api', name: 'DFast' };
    const slow = { key: 'd-slow', api: 'https://m03-dslow.example/api', name: 'DSlow' };
    g.fetch = async (input: unknown) => {
      const url = String(input);
      if (url.startsWith(slow.api)) {
        await new Promise((r) => setTimeout(r, 300));
        return upstream200WithItem('2', 'Slow Film');
      }
      return upstream200WithItem('1', 'Fast Film');
    };

    const outcome = await doUpstreamSearch(
      sitesMapOf([fast, slow]),
      'm03-direct',
      1,
      true,
      50 // 注入 50ms 总超时：慢源（300ms）必然被截断
    );
    expect(outcome.partial).toBe(true);
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0].title).toBe('Fast Film');
  }, 30000);

  test('全部源在超时内完成时 partial=false', async () => {
    const a = { key: 'd-a', api: 'https://m03-da.example/api', name: 'DA' };
    const b = { key: 'd-b', api: 'https://m03-db.example/api', name: 'DB' };
    g.fetch = async (input: unknown) => {
      const url = String(input);
      return url.startsWith(a.api)
        ? upstream200WithItem('1', 'Film A')
        : upstream200WithItem('2', 'Film B');
    };

    const outcome = await doUpstreamSearch(
      sitesMapOf([a, b]),
      'm03-direct-full',
      1,
      true,
      5000
    );
    expect(outcome.partial).toBe(false);
    expect(outcome.results).toHaveLength(2);
  }, 30000);
});

describe('M-03 GET 层缓存决策（mock KV）', () => {
  const realFetch = g.fetch;
  afterEach(() => {
    g.fetch = realFetch;
  });
  beforeEach(() => {
    mockKvPut.mockClear();
  });

  test('非 partial：按完整 TTL（3600s±抖动）写 KV 且无 X-Search-Partial', async () => {
    mockSites.length = 0;
    mockSites.push({
      key: 'g-fast',
      api: 'https://m03-gfast.example/api',
      name: 'GFast',
    });
    g.fetch = async () => upstream200WithItem('1', 'Fast Film');

    const res = await callSearch('m03-full');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-search-partial')).toBeNull();
    const body = await (res as any).json();
    expect(body.results).toHaveLength(1);

    const ttls = putTtls();
    expect(ttls).toHaveLength(1);
    // 完整 TTL = ttlWithJitter(3600) ∈ [3240, 3960]
    expect(ttls[0]).toBeGreaterThanOrEqual(3240);
    expect(ttls[0]).toBeLessThanOrEqual(3960);
  }, 30000);

  test('partial：KV 写入 TTL ≤ 60s 且响应带 X-Search-Partial: 1', async () => {
    mockSites.length = 0;
    mockSites.push(
      { key: 'g-pfast', api: 'https://m03-gpfast.example/api', name: 'GPFast' },
      { key: 'g-pslow', api: 'https://m03-gpslow.example/api', name: 'GPSlow' }
    );
    g.fetch = async (input: unknown) => {
      const url = String(input);
      if (url.includes('m03-gpslow')) {
        // hang 住永不返回：只能等搜索总超时（真实 10s）截断
        return new Promise(() => undefined);
      }
      return upstream200WithItem('1', 'Fast Film');
    };

    const res = await callSearch('m03-partial');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-search-partial')).toBe('1');
    const body = await (res as any).json();
    // 只含快源结果，慢源被截断
    expect(body.results).toHaveLength(1);
    expect(body.results[0].title).toBe('Fast Film');

    const ttls = putTtls();
    expect(ttls).toHaveLength(1);
    expect(ttls[0]).toBeGreaterThan(0);
    expect(ttls[0]).toBeLessThanOrEqual(60);
  }, 40000);
});
