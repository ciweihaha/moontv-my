/**
 * @jest-environment node
 */
/**
 * image-proxy 客户端断开联动回归（2026-10-24 诊断缺口 P2）。
 *
 * 旧行为：GET 全程不读 request.signal，内部 AbortController 只挂 20s
 * 总超时；客户端中途断开后，上游请求与响应体读取仍跑满 20s 才收尾，
 * 白白占用连接与缓冲（被总超时封顶，属资源浪费型缺口）。
 *
 * 新行为：request.signal 并入内部 controller 的触发源——客户端断开
 * 立即中止上游 fetch/读取，GET 随即落定；正常完整响应路径不受影响。
 *
 * 手法与同目录 ssrf 套件/诊断探针一致：mock global.fetch 驱动 GET；
 * AbortController 用环境原生实现，真实验证 signal 贯穿。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---- WHATWG 垫片（同 ssrf 套件；AbortController 除外，用原生实现） ----
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
  readonly signal?: AbortSignal;
  constructor(url: string, signal?: AbortSignal) {
    this.url = url;
    this.signal = signal;
  }
}
const g = globalThis as any;
if (typeof g.Request === 'undefined') g.Request = ShimRequest;
if (typeof g.Response === 'undefined') g.Response = ShimResponse;
if (typeof g.Headers === 'undefined') g.Headers = ShimHeaders;

// undici mock 仅为隔离（edge 模式不会真正 import undici，同 ssrf 套件）
jest.mock('undici', () => ({
  Agent: jest.fn().mockImplementation(() => ({
    destroy: jest.fn(async () => undefined),
    close: jest.fn(async () => undefined),
  })),
  fetch: jest.fn(async () => {
    throw new Error('undici fetch must not be used in edge mode');
  }),
}));

let GET: (request: Request) => Promise<Response>;
beforeAll(async () => {
  const mod = (await import('../route')) as typeof import('../route');
  GET = mod.GET;
});

function fakeImageResponse(body: any): any {
  return {
    status: 200,
    ok: true,
    statusText: 'OK',
    headers: {
      get: (name: string) => {
        const n = name.toLowerCase();
        if (n === 'content-type') return 'image/jpeg';
        if (n === 'content-length') return null;
        return null;
      },
    },
    body,
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}
const DOH_OK = {
  ok: true,
  json: async () => ({
    Status: 0,
    Answer: [{ type: 1, data: '93.184.216.34' }],
  }),
};
function installGlobalFetch(target: (url: string, opts: any) => Promise<any>) {
  g.fetch = jest.fn(async (url: string, opts: any) => {
    if (String(url).startsWith('https://cloudflare-dns.com/')) return DOH_OK;
    return target(String(url), opts);
  });
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const abortErr = () =>
  Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });

jest.setTimeout(30000);

describe('image-proxy 客户端断开联动', () => {
  test('客户端中途断开 → 上游 signal 立即中止，GET 随即落定（不跑满 20s）', async () => {
    const client = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    let settled = false;
    // 上游响应体：首块及时返回，第二块挂起，直到 signal 中止才拒绝
    const body = {
      getReader: () => {
        let idx = 0;
        return {
          read: () => {
            const i = idx++;
            if (i === 0)
              return sleep(50).then(() => ({
                done: false,
                value: new Uint8Array(512),
              }));
            return new Promise((_res, reject) => {
              const s = capturedSignal;
              if (!s) return;
              if (s.aborted) return reject(abortErr());
              s.addEventListener('abort', () => reject(abortErr()), {
                once: true,
              });
            });
          },
          cancel: async () => undefined,
          releaseLock: () => undefined,
        };
      },
    };
    installGlobalFetch(async (_url, opts) => {
      capturedSignal = opts.signal;
      return fakeImageResponse(body);
    });

    const t0 = Date.now();
    const promise = GET(
      new ShimRequest(
        'http://localhost/api/image-proxy?url=' +
          encodeURIComponent('https://api.guangsuapi.com/pic.jpg'),
        client.signal
      ) as any
    ).then((r: any) => {
      settled = true;
      return r;
    });

    await sleep(300);
    client.abort(); // 客户端断开
    await sleep(500);
    // 快照断言（旧实现下三项全不成立：GET 未落定、上游未中止）
    expect(capturedSignal?.aborted).toBe(true);
    expect(settled).toBe(true);

    const res: any = await promise;
    expect(res.status).toBe(504); // 中止沿用既有 AbortError → 504 收尾
    expect(Date.now() - t0).toBeLessThan(10000); // 远未跑满 20s 总超时
  });

  test('客户端信号全程不断开 → 正常完整响应 200 不受影响', async () => {
    const client = new AbortController();
    const payload = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const body = {
      getReader: () => {
        let idx = 0;
        return {
          read: async () =>
            idx++ === 0
              ? { done: false, value: payload }
              : { done: true, value: undefined },
          cancel: async () => undefined,
          releaseLock: () => undefined,
        };
      },
    };
    installGlobalFetch(async () => fakeImageResponse(body));
    const res: any = await GET(
      new ShimRequest(
        'http://localhost/api/image-proxy?url=' +
          encodeURIComponent('https://api.xinlangapi.com/pic.jpg'),
        client.signal
      ) as any
    );
    expect(res.status).toBe(200);
    expect(client.signal.aborted).toBe(false);
  });

  test('请求到达时客户端信号已中止 → 立即中止上游，不发起完整抓取', async () => {
    const client = new AbortController();
    client.abort(); // 到达前已断开
    let targetCalls = 0;
    let capturedSignal: AbortSignal | undefined;
    installGlobalFetch(async (_url, opts) => {
      targetCalls += 1;
      capturedSignal = opts.signal;
      // 模拟真实 fetch：signal 已中止立即拒绝
      if (opts.signal?.aborted) throw abortErr();
      return fakeImageResponse({
        getReader: () => ({
          read: async () => ({ done: true, value: undefined }),
          cancel: async () => undefined,
          releaseLock: () => undefined,
        }),
      });
    });
    const res: any = await GET(
      new ShimRequest(
        'http://localhost/api/image-proxy?url=' +
          encodeURIComponent('https://api.wujinapi.me/pic.jpg'),
        client.signal
      ) as any
    );
    expect(res.status).toBe(504);
    expect(capturedSignal?.aborted).toBe(true);
    expect(targetCalls).toBe(1);
  });
});
