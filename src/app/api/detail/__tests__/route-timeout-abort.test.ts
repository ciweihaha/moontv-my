/**
 * @jest-environment node
 */
/**
 * 详情整体超时真取消（repo-hardening 第 8 项 / 任务书 001 的 M-05）。
 *
 * 旧实现：25s Promise.race 超时只返回 504，上游请求不被取消、继续在
 * 后台读响应体。新行为：超时时 abort 贯穿下游的信号，getDetailFromApi
 * 收到的 signal 随即 aborted。
 *
 * downstream 被 mock 为「挂起直到 signal abort 才 reject」，用假定时器
 * 推进 25s 触发路由整体截止，然后断言状态码 504 且信号已中止。
 * WHATWG 垫片沿用既有做法。
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

// ---- 可控 mock：捕获传入 getDetailFromApi 的 signal ----
const mockState: { signal: AbortSignal | undefined; calls: number } = {
  signal: undefined,
  calls: 0,
};
const mockGetDetail = jest.fn(
  (_site: any, _id: string, signal?: AbortSignal) => {
    mockState.calls += 1;
    mockState.signal = signal;
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        reject(
          Object.assign(new Error('The operation was aborted'), {
            name: 'AbortError',
          })
        );
      });
    });
  }
);

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
  setCachedDetail: async () => undefined,
}));

jest.mock('@/lib/downstream', () => ({
  getDetailFromApi: (...args: any[]) => mockGetDetail(...args),
}));

jest.mock('@/lib/errorReport', () => ({ reportError: () => undefined }));

let GET: (request: Request) => Promise<Response>;
beforeAll(async () => {
  const mod = (await import('../route')) as typeof import('../route');
  GET = mod.GET;
});

/** 反复让出微任务队列，推进路由内部的 await 链 */
async function flushMicrotasks(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
}

describe('detail route 整体超时真取消（M-05）', () => {
  test('25s 截止到达 → 返回 504 且下游 signal 被 abort', async () => {
    jest.useFakeTimers();
    try {
      const promise = GET(
        new ShimRequest('http://localhost/api/detail?id=123&source=src1') as any
      );
      await flushMicrotasks();
      expect(mockState.calls).toBe(1);

      jest.advanceTimersByTime(25000);
      const res = await promise;

      expect(res.status).toBe(504);
      // 核心断言：路由把可用的 signal 传给了下游，并在超时时真正 abort
      expect(mockState.signal).toBeDefined();
      expect(mockState.signal!.aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
