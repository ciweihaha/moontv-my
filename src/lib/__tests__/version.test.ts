/**
 * @jest-environment node
 */
/**
 * 深查第 5 轮（2026-11-06）：src/lib/version.ts 的 fetchVersionFromUrl
 * 响应体读取超时与大小上限回归测试。
 *
 * 旧实现缺陷：
 * 5s 定时器在 fetch 返回（仅收到响应头）后立即 clearTimeout，随后的
 * response.text() 不再受任何超时约束、也无大小上限——响应体停滞时
 * checkForUpdates 的 promise 永远不 settle：登录页与 UserMenu 的
 * useEffect 里 setIsChecking(false) 只在 finally 中执行，界面永远停在
 * 检查中状态；顺序回退的备用 URL 也永远等不到（第一次 await 就挂住）。
 * 主站还是第三方代理 ghfast.top，可靠性低于 raw.githubusercontent.com。
 * 形态与第 2 轮修掉的分类接口、第 3 轮修掉的 Top250 完全相同，是客户
 * 端剩余的裸 fetch 路径（服务端三处已修完）。
 *
 * 新行为：超时覆盖读体全过程（读完/超限/取消后才清定时器），流式限长
 * 读取（VERSION.txt 只是 14 位时间戳，上限 4KB 已留足余量），非 200
 * 先 cancel 响应体再抛错；fetchVersionFromUrl 导出以便测试（与
 * downstream.ts / doubanTop250.ts 同例）。
 *
 * 注意：不能复用服务端已有的 readBodyWithLimit——它在 downstream.ts，
 * 而 downstream → config → db → d1.db 会把服务端存储代码拖进客户端
 * bundle；故本文件内用等价的本地流式读取（见 version.ts 内注释）。
 * mock fetch 的停滞流需模拟真实 fetch 的 abort 语义——signal abort
 * 时让流 error，否则 reader.read() 永远等不到信号（真实网络流 abort
 * 时 reader.read() 会 reject，此处如实模拟；与 doubanTop250.test.ts
 * 同法）。
 */

 

import {
  checkForUpdates,
  fetchVersionFromUrl,
  UpdateStatus,
} from '@/lib/version';

jest.setTimeout(10000);

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

/** 最小的 Response 形状：新实现只用 .body 与 .arrayBuffer()，旧实现用 .text() */
interface MockResponse {
  ok: boolean;
  status: number;
  body: ReadableStream<Uint8Array> | null;
  arrayBuffer: () => Promise<ArrayBuffer>;
  text: () => Promise<string>;
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
  const fullText = new TextDecoder().decode(
    Buffer.concat(chunks.map((c) => Buffer.from(c)))
  );
  return {
    ok,
    status,
    body: stream,
    arrayBuffer: async () => {
      const all = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      return bytesToArrayBuffer(new Uint8Array(all));
    },
    text: async () => fullText,
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
    // 旧实现走 response.text()：停滞体上它也永远不 resolve
    text: () => new Promise<string>(() => {}),
  };
}

const VERSION_URL = 'https://example.com/VERSION.txt';

describe('fetchVersionFromUrl（版本检查）', () => {
  it('正常小版本：返回 trim 后的版本号', async () => {
    const bytes = new TextEncoder().encode('20261102000000\n');
    global.fetch = jest.fn(async () =>
      makeStreamResponse([bytes])
    ) as unknown as typeof fetch;

    await expect(fetchVersionFromUrl(VERSION_URL)).resolves.toBe(
      '20261102000000'
    );
  });

  it(
    '响应体停滞：超时内返回 null，不无限挂起（旧实现会在此用例上超时失败）',
    async () => {
      global.fetch = jest.fn(async (_url: string, init?: RequestInit) =>
        makeStalledResponse(init?.signal as AbortSignal)
      ) as unknown as typeof fetch;

      const start = Date.now();
      await expect(
        fetchVersionFromUrl(VERSION_URL, { timeoutMs: 200 })
      ).resolves.toBeNull();
      const elapsed = Date.now() - start;
      // 200ms 超时触发 + 容差：必须远小于 jest 用例超时
      expect(elapsed).toBeLessThan(3000);
    },
    5000
  );

  it('响应体超 4KB：返回 null，不整块读入大响应', async () => {
    const big = new Uint8Array(8 * 1024).fill(0x61); // 8KB > 4KB 上限
    global.fetch = jest.fn(async () =>
      makeStreamResponse([big])
    ) as unknown as typeof fetch;

    await expect(fetchVersionFromUrl(VERSION_URL)).resolves.toBeNull();
  });

  it('非 200：返回 null（旧语义不变）', async () => {
    global.fetch = jest.fn(async () =>
      makeStreamResponse([], false, 500)
    ) as unknown as typeof fetch;

    await expect(fetchVersionFromUrl(VERSION_URL)).resolves.toBeNull();
  });

  it('无 body 流的降级路径：小响应正常返回，超大响应返回 null', async () => {
    const small = new TextEncoder().encode('20261102000000');
    const big = new Uint8Array(8 * 1024).fill(0x61);
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: null,
        arrayBuffer: async () => bytesToArrayBuffer(small),
        text: async () => '20261102000000',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: null,
        arrayBuffer: async () => bytesToArrayBuffer(big),
        text: async () => 'a'.repeat(8 * 1024),
      }) as unknown as typeof fetch;

    await expect(fetchVersionFromUrl(VERSION_URL)).resolves.toBe(
      '20261102000000'
    );
    await expect(fetchVersionFromUrl(VERSION_URL)).resolves.toBeNull();
  });
});

describe('checkForUpdates（主备回退）', () => {
  it(
    '主站响应体停滞：超时后回退备用站并返回其结果（旧实现会在此用例上超时失败）',
    async () => {
      global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes('ghfast')) {
          return makeStalledResponse(init?.signal as AbortSignal);
        }
        return makeStreamResponse([
          new TextEncoder().encode('20261201000000'),
        ]);
      }) as unknown as typeof fetch;

      const start = Date.now();
      await expect(
        checkForUpdates({ timeoutMs: 200 })
      ).resolves.toBe(UpdateStatus.HAS_UPDATE);
      expect(Date.now() - start).toBeLessThan(5000);
    },
    5000
  );

  it('主站返回旧版本：NO_UPDATE，不再请求备用站', async () => {
    let calls = 0;
    global.fetch = jest.fn(async () => {
      calls += 1;
      return makeStreamResponse([
        new TextEncoder().encode('20200101000000'),
      ]);
    }) as unknown as typeof fetch;

    await expect(checkForUpdates()).resolves.toBe(UpdateStatus.NO_UPDATE);
    expect(calls).toBe(1);
  });

  it('两站都失败：FETCH_FAILED', async () => {
    global.fetch = jest.fn(async () =>
      makeStreamResponse([], false, 404)
    ) as unknown as typeof fetch;

    await expect(checkForUpdates()).resolves.toBe(
      UpdateStatus.FETCH_FAILED
    );
  });
});
