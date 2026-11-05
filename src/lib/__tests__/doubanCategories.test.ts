/**
 * @jest-environment node
 */
/**
 * 深查第 2 轮（2026-11-05）：/api/douban/categories 的 fetchDoubanData
 * 响应体读取超时与大小上限回归测试。
 *
 * 旧实现缺陷（src/app/api/douban/categories/route.ts）：
 * 10s 定时器在 fetch 返回（仅收到响应头）后立即 clearTimeout，随后的
 * response.json() 不再受超时约束——响应体停滞时请求无限挂起；且无大小
 * 上限，超大响应整块读入内存。仓库内同类问题已在 fetchRetry（第 8 项）
 * 与详情路由（M-05）修过，此处是剩余的裸 fetch 路径。
 *
 * 新行为：流式限长读取（readBodyWithLimit，1MB 上限），超时信号透传进
 * 读取循环，读完/超限/取消后才清定时器。
 *
 * 注意：mock fetch 的停滞流需模拟真实 fetch 的 abort 语义——signal
 * abort 时让流 error，否则 reader.read() 永远等不到信号（真实网络流
 * abort 时 reader.read() 会 reject，此处如实模拟）。
 * WHATWG 垫片与动态导入沿用详情路由超时测试（route-timeout-abort.test.ts）
 * 的既有做法：jest node 环境不暴露 Request/Response/Headers，须先垫片
 * 再导入引用了 next/server 的路由模块。
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

jest.setTimeout(10000);

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

type FetchDoubanData = (
  url: string,
  options?: { timeoutMs?: number }
) => Promise<{
  total: number;
  items: Array<{
    id: string;
    title: string;
    card_subtitle: string;
    pic: { large: string; normal: string };
    rating: { value: number };
  }>;
}>;

let fetchDoubanData: FetchDoubanData;
beforeAll(async () => {
  const mod = (await import(
    '@/app/api/douban/categories/route'
  )) as typeof import('@/app/api/douban/categories/route');
  fetchDoubanData = mod.fetchDoubanData;
});

/** 最小的 Response 形状：readBodyWithLimit 只用 .body 与 .arrayBuffer() */
interface MockResponse {
  ok: boolean;
  status: number;
  body: ReadableStream<Uint8Array> | null;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
}

/** 用指定字节块构造 mock Response */
function makeStreamResponse(
  chunks: Uint8Array[],
  ok = true,
  status = 200
): MockResponse {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return {
    ok,
    status,
    body: stream,
    arrayBuffer: async () => {
      const all = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      return bytesToArrayBuffer(new Uint8Array(all));
    },
  };
}

function abortError(): Error {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}

/** 构造永不吐数据的 mock Response；signal abort 时流 error（模拟真实 fetch） */
function makeStalledResponse(signal: AbortSignal): MockResponse {
  let streamController: ReadableStreamDefaultController<Uint8Array> | null =
    null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
  });
  signal.addEventListener(
    'abort',
    () => {
      try {
        streamController?.error(abortError());
      } catch {
        /* 流已关闭时忽略 */
      }
    },
    { once: true }
  );
  return {
    ok: true,
    status: 200,
    body: stream,
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

const SAMPLE = {
  total: 1,
  items: [
    {
      id: '1292052',
      title: '肖申克的救赎',
      card_subtitle: '1994 / 美国 / 犯罪 剧情',
      pic: { large: 'https://example.com/large.jpg', normal: 'https://example.com/normal.jpg' },
      rating: { value: 9.7 },
    },
  ],
};

describe('fetchDoubanData（豆瓣分类）', () => {
  it('正常小 JSON：解析返回', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(SAMPLE));
    global.fetch = jest.fn(async () =>
      makeStreamResponse([bytes])
    ) as unknown as typeof fetch;

    const data = await fetchDoubanData('https://m.douban.com/rexxar/api/v2/test');
    expect(data.total).toBe(1);
    expect(data.items[0].title).toBe('肖申克的救赎');
    expect(data.items[0].rating.value).toBe(9.7);
  });

  it('响应体停滞：超时内拒绝，不无限挂起（旧实现会在此用例上超时失败）', async () => {
    global.fetch = jest.fn(async (_url: string, init?: RequestInit) =>
      makeStalledResponse(init?.signal as AbortSignal)
    ) as unknown as typeof fetch;

    const start = Date.now();
    await expect(
      fetchDoubanData('https://m.douban.com/rexxar/api/v2/test', {
        timeoutMs: 200,
      })
    ).rejects.toThrow();
    const elapsed = Date.now() - start;
    // 200ms 超时触发 + 容差：必须远小于 jest 用例超时（10s）
    expect(elapsed).toBeLessThan(5000);
  });

  it('响应体超 1MB：拒绝且不解析整块大 JSON', async () => {
    const big = new Uint8Array(256 * 1024).fill(0x61); // 256KB × 5 = 1280KB
    global.fetch = jest.fn(async () =>
      makeStreamResponse([big, big, big, big, big])
    ) as unknown as typeof fetch;

    await expect(
      fetchDoubanData('https://m.douban.com/rexxar/api/v2/test')
    ).rejects.toThrow('豆瓣响应体过大');
  });

  it('非 200：抛 HTTP 错误（旧语义不变）', async () => {
    global.fetch = jest.fn(async () =>
      makeStreamResponse([], false, 500)
    ) as unknown as typeof fetch;

    await expect(
      fetchDoubanData('https://m.douban.com/rexxar/api/v2/test')
    ).rejects.toThrow('HTTP error! Status: 500');
  });
});
