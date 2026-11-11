/**
 * @jest-environment node
 */
/**
 * 深查第 6 轮（2026-11-10）：src/lib/douban.client.ts 的 fetchWithTimeout
 * 响应体读取超时与大小上限回归测试。
 *
 * 旧实现缺陷（与第 2/3/5 轮修掉的服务端三处同形态，是该类的最后一处）：
 * 10 秒定时器在 fetch 返回（仅收到响应头）后立即 clearTimeout，随后的
 * response.json() 不再受任何超时约束、也无字节上限——代理响应体停滞时
 * 豆瓣页永远转圈，超大响应整块读入内存。仅配置了豆瓣代理的用户走此
 * 路径（shouldUseDoubanClient() 为真时才调 fetchDoubanCategories /
 * fetchDoubanList；未配代理走同源 /api/douban*，服务端已有超时与限长）。
 *
 * 新行为：超时覆盖“请求头＋读体”全过程（读完/超限/取消后才清定时器），
 * 复用 version.ts 的客户端版流式限长读取 readTextWithLimit（1MB 上限，
 * 与服务端 /api/douban 口径一致）；非 200 先 cancel 响应体再抛错。
 * mock fetch 的停滞流需模拟真实 fetch 的 abort 语义——signal abort
 * 时让流 error，否则 reader.read() 永远等不到信号（真实网络流 abort
 * 时 reader.read() 会 reject，此处如实模拟；与 version.test.ts 同法）。
 */

import {
  fetchDoubanCategories,
  fetchDoubanList,
} from '@/lib/douban.client';

jest.setTimeout(10000);

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

/** 最小的 Response 形状：新实现只用 .ok/.status/.body，旧实现用 .json() */
interface MockResponse {
  ok: boolean;
  status: number;
  body: ReadableStream<Uint8Array> | null;
  json: () => Promise<unknown>;
}

function makeJsonResponse(
  payload: unknown,
  ok = true,
  status = 200
): MockResponse {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return {
    ok,
    status,
    body: stream,
    json: async () => payload,
  };
}

/** 用指定字节块构造 mock Response（超大体用例） */
function makeBytesResponse(chunks: Uint8Array[]): MockResponse {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return {
    ok: true,
    status: 200,
    body: stream,
    json: async () => JSON.parse(new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))))),
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
    // 旧实现走 response.json()：停滞体上它也永远不 resolve
    json: () => new Promise<unknown>(() => {}),
  };
}

const CATEGORY_PAYLOAD = {
  total: 1,
  items: [
    {
      id: '1',
      title: '测试剧',
      card_subtitle: '2026 / 大陆 / 剧情',
      pic: { large: 'https://example.com/l.jpg', normal: 'https://example.com/n.jpg' },
      rating: { value: 8.5 },
    },
  ],
};

const LIST_PAYLOAD = {
  total: 1,
  items: [
    {
      id: '2',
      title: '测试片',
      card_subtitle: '2025 / 美国 / 动作',
      pic: { large: 'https://example.com/l2.jpg', normal: 'https://example.com/n2.jpg' },
      rating: { value: 9.0 },
    },
  ],
};

describe('fetchDoubanCategories（客户端代理路径）', () => {
  it('正常小 JSON：返回映射后的列表', async () => {
    global.fetch = jest.fn(async () =>
      makeJsonResponse(CATEGORY_PAYLOAD)
    ) as unknown as typeof fetch;

    await expect(
      fetchDoubanCategories({ kind: 'tv', category: 'tv', type: 'tv' })
    ).resolves.toEqual({
      code: 200,
      message: '获取成功',
      list: [
        {
          id: '1',
          title: '测试剧',
          poster: 'https://example.com/n.jpg',
          rate: '8.5',
          year: '2026',
        },
      ],
    });
  });

  it(
    '响应体停滞：超时内 reject，不无限挂起（旧实现会在此用例上超时失败）',
    async () => {
      global.fetch = jest.fn(async (_url: string, init?: RequestInit) =>
        makeStalledResponse(init?.signal as AbortSignal)
      ) as unknown as typeof fetch;

      const start = Date.now();
      await expect(
        fetchDoubanCategories({
          kind: 'tv',
          category: 'tv',
          type: 'tv',
          timeoutMs: 200,
        })
      ).rejects.toThrow('获取豆瓣分类数据失败');
      const elapsed = Date.now() - start;
      // 200ms 超时触发 + 容差：必须远小于 jest 用例超时
      expect(elapsed).toBeLessThan(5000);
    },
    8000
  );

  it('响应体超 1MB：reject，不整块读入大响应', async () => {
    // 1MB + 1 字节的合法 JSON 载荷（旧实现会整块读入并正常返回）
    const big = new Uint8Array(1 * 1024 * 1024 + 1).fill(0x61);
    global.fetch = jest.fn(async () =>
      makeBytesResponse([big])
    ) as unknown as typeof fetch;

    await expect(
      fetchDoubanCategories({ kind: 'tv', category: 'tv', type: 'tv' })
    ).rejects.toThrow('豆瓣响应体过大');
  });

  it('非 200：reject，文案与旧实现一致', async () => {
    global.fetch = jest.fn(async () =>
      makeJsonResponse({}, false, 500)
    ) as unknown as typeof fetch;

    await expect(
      fetchDoubanCategories({ kind: 'tv', category: 'tv', type: 'tv' })
    ).rejects.toThrow('HTTP error! Status: 500');
  });
});

describe('fetchDoubanList（客户端代理路径）', () => {
  it('正常小 JSON：返回映射后的列表', async () => {
    global.fetch = jest.fn(async () =>
      makeJsonResponse(LIST_PAYLOAD)
    ) as unknown as typeof fetch;

    await expect(
      fetchDoubanList({ tag: '热门', type: 'movie' })
    ).resolves.toEqual({
      code: 200,
      message: '获取成功',
      list: [
        {
          id: '2',
          title: '测试片',
          poster: 'https://example.com/n2.jpg',
          rate: '9.0',
          year: '2025',
        },
      ],
    });
  });

  it(
    '响应体停滞：超时内 reject，不无限挂起',
    async () => {
      global.fetch = jest.fn(async (_url: string, init?: RequestInit) =>
        makeStalledResponse(init?.signal as AbortSignal)
      ) as unknown as typeof fetch;

      const start = Date.now();
      await expect(
        fetchDoubanList({ tag: '热门', type: 'movie', timeoutMs: 200 })
      ).rejects.toThrow('获取豆瓣分类数据失败');
      expect(Date.now() - start).toBeLessThan(5000);
    },
    8000
  );
});

describe('无 items 数组按空结果处理（深查第 15 轮）', () => {
  it('fetchDoubanCategories：代理回 200 但无 items → 200 空列表，不抛错', async () => {
    global.fetch = jest.fn(async () =>
      makeJsonResponse({ total: 0 })
    ) as unknown as typeof fetch;

    await expect(
      fetchDoubanCategories({ kind: 'tv', category: 'tv', type: 'tv' })
    ).resolves.toEqual({ code: 200, message: '获取成功', list: [] });
  });

  it('fetchDoubanList：代理回 200 但无 items → 200 空列表，不抛错', async () => {
    global.fetch = jest.fn(async () =>
      makeJsonResponse({ subjects: [] })
    ) as unknown as typeof fetch;

    await expect(
      fetchDoubanList({ tag: '热门', type: 'movie' })
    ).resolves.toEqual({ code: 200, message: '获取成功', list: [] });
  });
});
