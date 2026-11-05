/**
 * @jest-environment node
 */
/**
 * 深查第 3 轮（2026-11-05）：/api/douban 的 handleTop250
 * 响应体读取超时与大小上限回归测试。
 *
 * 旧实现缺陷（src/app/api/douban/route.ts handleTop250）：
 * 10s 定时器在 fetch 返回（仅收到响应头）后立即 clearTimeout，随后的
 * response.text() 不再受超时约束——响应体停滞时请求无限挂起；且无大小
 * 上限，超大 HTML 会整块读入内存。形态与第 2 轮修掉的分类接口
 * fetchDoubanData 完全相同，是豆瓣 API 面剩余的裸 fetch 路径（同文件
 * 的 fetchDoubanData 已用 fetchWithRetry + 流式 1MB 限长）。
 *
 * 新行为：取数与解析抽到 src/lib/doubanTop250.ts（fetchTop250），流式
 * 限长读取（readBodyWithLimit，1MB 上限），超时信号透传进读取循环，
 * 读完/超限/取消后才清定时器；路由层 handleTop250 只剩薄包装。
 *
 * 注意：mock fetch 的停滞流需模拟真实 fetch 的 abort 语义——signal
 * abort 时让流 error，否则 reader.read() 永远等不到信号（真实网络流
 * abort 时 reader.read() 会 reject，此处如实模拟）。
 * fetchTop250 放在 src/lib/doubanTop250.ts（不在路由文件里，
 * 否则 next build 路由类型校验会报错），测试直接导入该模块，不经过
 * next/server，因此不需要 WHATWG 垫片。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { fetchTop250 } from '@/lib/doubanTop250';

jest.setTimeout(10000);

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
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

/** 两条 Top250 条目（与旧 handleTop250 的正则逐字对应） */
const SAMPLE_HTML = `
<div class="item">
  <div class="pic"><a href="https://movie.douban.com/subject/1292052/"><img alt="肖申克的救赎" src="http://img.example.com/s1292052.jpg"></a></div>
  <div class="info"><span class="rating_num">9.7</span></div>
</div>
<div class="item">
  <div class="pic"><a href="https://movie.douban.com/subject/1291546/"><img alt="霸王别姬" src="https://img.example.com/s1291546.jpg"></a></div>
  <div class="info"><span class="rating_num"></span></div>
</div>
`;

describe('fetchTop250（豆瓣 Top250）', () => {
  it('正常小 HTML：解析出条目，http 封面转 https，空评分为空串', async () => {
    const bytes = new TextEncoder().encode(SAMPLE_HTML);
    let seenUrl = '';
    global.fetch = jest.fn(async (url: string) => {
      seenUrl = url;
      return makeStreamResponse([bytes]);
    }) as unknown as typeof fetch;

    const movies = await fetchTop250(25);
    expect(seenUrl).toContain('movie.douban.com/top250?start=25');
    expect(movies).toHaveLength(2);
    expect(movies[0]).toEqual({
      id: '1292052',
      title: '肖申克的救赎',
      poster: 'https://img.example.com/s1292052.jpg',
      rate: '9.7',
      year: '',
    });
    expect(movies[1].id).toBe('1291546');
    expect(movies[1].poster).toBe('https://img.example.com/s1291546.jpg');
    expect(movies[1].rate).toBe('');
  });

  it('无影片 HTML：返回空数组（零结果仍成功）', async () => {
    const bytes = new TextEncoder().encode('<html><body>no items</body></html>');
    global.fetch = jest.fn(async () =>
      makeStreamResponse([bytes])
    ) as unknown as typeof fetch;

    await expect(fetchTop250(0)).resolves.toEqual([]);
  });

  it('响应体停滞：超时内拒绝，不无限挂起（旧实现会在此用例上超时失败）', async () => {
    global.fetch = jest.fn(async (_url: string, init?: RequestInit) =>
      makeStalledResponse(init?.signal as AbortSignal)
    ) as unknown as typeof fetch;

    const start = Date.now();
    await expect(
      fetchTop250(0, { timeoutMs: 200 })
    ).rejects.toThrow();
    const elapsed = Date.now() - start;
    // 200ms 超时触发 + 容差：必须远小于 jest 用例超时（10s）
    expect(elapsed).toBeLessThan(5000);
  });

  it('响应体超 1MB：拒绝且不解析整块大 HTML', async () => {
    const big = new Uint8Array(256 * 1024).fill(0x61); // 256KB × 5 = 1280KB
    global.fetch = jest.fn(async () =>
      makeStreamResponse([big, big, big, big, big])
    ) as unknown as typeof fetch;

    await expect(fetchTop250(0)).rejects.toThrow('豆瓣响应体过大');
  });

  it('非 200：抛 HTTP 错误（旧语义不变）', async () => {
    global.fetch = jest.fn(async () =>
      makeStreamResponse([], false, 500)
    ) as unknown as typeof fetch;

    await expect(fetchTop250(0)).rejects.toThrow('HTTP error! Status: 500');
  });
});
