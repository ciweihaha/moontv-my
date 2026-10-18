/**
 * @jest-environment node
 */
/**
 * AUDIT-R5 P2: readBodyWithLimit 流式硬限制单元测试。
 * 覆盖：正常流、超限单块、分块超限、无响应体降级、读取中途取消、上游异常。
 *
 * 注意：用轻量 mock Response（仅实现 readBodyWithLimit 用到的 .body/.arrayBuffer），
 * 不依赖全局 Response（jest 27 的 node 环境未暴露 fetch 全局变量）。
 */
import { readBodyWithLimit } from '../downstream';

/** 最小的 Response 形状：readBodyWithLimit 只用 .body 和 .arrayBuffer() */
interface MockResponse {
  body: ReadableStream<Uint8Array> | null;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

/** 用指定的字节块构造 mock Response */
function makeStreamResponse(chunks: Uint8Array[]): MockResponse {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return {
    body: stream,
    arrayBuffer: async () => {
      const all = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength);
    },
  };
}

/** 构造一个会在读取时抛错的 mock Response */
function makeErrorResponse(message: string): MockResponse {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error(message));
    },
  });
  return {
    body: stream,
    arrayBuffer: async () => {
      throw new Error(message);
    },
  };
}

/** 构造一个可手动控制的 mock Response（用于测试中途取消） */
function makeControllableResponse() {
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
    },
  });
  return {
    response: {
      body: stream,
      arrayBuffer: async () => new ArrayBuffer(0),
    } as MockResponse,
    enqueue: (chunk: Uint8Array) => controllerRef?.enqueue(chunk),
    close: () => controllerRef?.close(),
  };
}

describe('readBodyWithLimit', () => {
  test('正常流：未超限时返回完整内容', async () => {
    const data = new TextEncoder().encode('hello world');
    const resp = makeStreamResponse([data]);
    const buf = await readBodyWithLimit(resp as unknown as Response, 1024);
    expect(buf).not.toBeNull();
    expect(new TextDecoder().decode(buf!)).toBe('hello world');
  });

  test('正常流：多块累计未超限', async () => {
    const chunks = [
      new TextEncoder().encode('aaa'),
      new TextEncoder().encode('bbb'),
      new TextEncoder().encode('ccc'),
    ];
    const resp = makeStreamResponse(chunks);
    const buf = await readBodyWithLimit(resp as unknown as Response, 1024);
    expect(buf).not.toBeNull();
    expect(new TextDecoder().decode(buf!)).toBe('aaabbbccc');
  });

  test('超限单块：单个块超过上限时返回 null', async () => {
    const big = new Uint8Array(2048).fill(0x41);
    const resp = makeStreamResponse([big]);
    const buf = await readBodyWithLimit(resp as unknown as Response, 1024);
    expect(buf).toBeNull();
  });

  test('分块超限：累计超过上限时返回 null（不读完整个流）', async () => {
    const chunks = [
      new Uint8Array(600).fill(0x41),
      new Uint8Array(600).fill(0x42), // 累计 1200 > 1024
      new Uint8Array(600).fill(0x43), // 不应被读取
    ];
    const resp = makeStreamResponse(chunks);
    const buf = await readBodyWithLimit(resp as unknown as Response, 1024);
    expect(buf).toBeNull();
  });

  test('边界：恰好等于上限时通过', async () => {
    const data = new Uint8Array(1024).fill(0x41);
    const resp = makeStreamResponse([data]);
    const buf = await readBodyWithLimit(resp as unknown as Response, 1024);
    expect(buf).not.toBeNull();
    expect(buf!.byteLength).toBe(1024);
  });

  test('边界：超过上限 1 字节时拒绝', async () => {
    const data = new Uint8Array(1025).fill(0x41);
    const resp = makeStreamResponse([data]);
    const buf = await readBodyWithLimit(resp as unknown as Response, 1024);
    expect(buf).toBeNull();
  });

  test('无响应体降级：body 为 null 时走 arrayBuffer 分支', async () => {
    const data = new TextEncoder().encode('small body');
    const resp: MockResponse = {
      body: null,
      arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    };
    const buf = await readBodyWithLimit(resp as unknown as Response, 1024);
    expect(buf).not.toBeNull();
    expect(new TextDecoder().decode(buf!)).toBe('small body');
  });

  test('无响应体降级：超限时返回 null', async () => {
    const big = new Uint8Array(2048).fill(0x78);
    const resp: MockResponse = {
      body: null,
      arrayBuffer: async () => big.buffer.slice(big.byteOffset, big.byteOffset + big.byteLength),
    };
    const buf = await readBodyWithLimit(resp as unknown as Response, 1024);
    expect(buf).toBeNull();
  });

  test('读取中途取消：signal 已 abort 时抛 AbortError', async () => {
    const { response, enqueue } = makeControllableResponse();
    const controller = new AbortController();
    const promise = readBodyWithLimit(response as unknown as Response, 1024 * 1024, controller.signal);
    enqueue(new Uint8Array(10).fill(0x41));
    controller.abort();
    await expect(promise).rejects.toThrow();
  });

  test('上游异常：流读取抛错时向上传播', async () => {
    const resp = makeErrorResponse('upstream failed');
    await expect(
      readBodyWithLimit(resp as unknown as Response, 1024)
    ).rejects.toThrow('upstream failed');
  });

  test('空流：返回空 buffer 而非 null', async () => {
    const resp = makeStreamResponse([]);
    const buf = await readBodyWithLimit(resp as unknown as Response, 1024);
    expect(buf).not.toBeNull();
    expect(buf!.byteLength).toBe(0);
  });
});
