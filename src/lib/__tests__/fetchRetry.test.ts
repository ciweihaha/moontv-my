/**
 * @jest-environment node
 */
/**
 * fetchWithRetry 超时覆盖响应体 + 5xx 重试释放（repo-hardening 第 8 项）。
 *
 * 旧实现两个缺口：
 * 1. 单次超时计时器在 fetch() 返回响应头后立即 clearTimeout——上游若
 *    「响应头及时、响应体永不结束」，读取会无限挂住，超时形同虚设。
 * 2. 5xx 准备重试时不取消上一响应 body，连接/句柄被白白占用。
 *
 * 新行为：返回成功响应时，把计时器与外部取消监听的生命周期绑定到
 * 响应体读完/被取消；超时在体读取阶段触发时真正 abort 底层 fetch，
 * 挂住的 read() 随之 reject。5xx 重试前先 cancel 上一响应体。
 *
 * 环境：jest 27 node 环境无 Response 全局，用仓库已依赖的 undici 实现补齐
 * （仅测试内赋值，不影响生产代码）。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Response as UndiciResponse } from 'undici';

const g = globalThis as any;
if (typeof g.Response === 'undefined') g.Response = UndiciResponse;

let fetchWithRetry: typeof import('../fetchRetry').fetchWithRetry;
beforeAll(async () => {
  const mod = await import('../fetchRetry');
  fetchWithRetry = mod.fetchWithRetry;
});

const fetchMock = jest.fn();
g.fetch = fetchMock;

beforeEach(() => {
  fetchMock.mockReset();
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('fetchWithRetry 超时覆盖响应体读取', () => {
  test('响应头及时返回但响应体永不结束 → 超时后底层 fetch 被 abort，挂住的 read 被拒绝', async () => {
    let capturedSignal: AbortSignal | undefined;
    fetchMock.mockImplementation(async (_url: string, init: any) => {
      capturedSignal = init.signal;
      // 永不 enqueue、永不 close 的流；仅在 fetch 被 abort 时像真实 fetch 那样 error
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init.signal.addEventListener('abort', () => {
            controller.error(new Error('aborted'));
          });
        },
      });
      return new UndiciResponse(stream as any, { status: 200 });
    });

    const resp = await fetchWithRetry(
      'https://upstream.example/slow-body',
      {},
      { timeoutMs: 120, retries: 0 }
    );
    expect(resp.ok).toBe(true);

    const reader = resp.body!.getReader();
    const readOutcome = await Promise.race([
      reader.read().then(
        () => 'read-resolved',
        () => 'read-rejected'
      ),
      sleep(2500).then(() => 'still-pending'),
    ]);
    // 旧实现：计时器已在响应头后清除 → read 永远 pending（still-pending）
    expect(readOutcome).toBe('read-rejected');
    expect(capturedSignal!.aborted).toBe(true);
  }, 10000);

  test('正常响应：体可完整读出，信号未被 abort', async () => {
    let capturedSignal: AbortSignal | undefined;
    fetchMock.mockImplementation(async (_url: string, init: any) => {
      capturedSignal = init.signal;
      return new UndiciResponse('hello-body', { status: 200 });
    });
    const resp = await fetchWithRetry(
      'https://upstream.example/ok',
      {},
      { timeoutMs: 1000, retries: 0 }
    );
    const text = await resp.text();
    expect(text).toBe('hello-body');
    expect(capturedSignal!.aborted).toBe(false);
  });
});

describe('fetchWithRetry 5xx 重试释放上一响应体', () => {
  test('第一次 500 → 重试前 cancel 第一次的响应体', async () => {
    const cancelSpy = jest.fn();
    let call = 0;
    fetchMock.mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('server error'));
            controller.close();
          },
          cancel: cancelSpy,
        });
        return new UndiciResponse(stream as any, { status: 500 });
      }
      return new UndiciResponse('recovered', { status: 200 });
    });

    const resp = await fetchWithRetry(
      'https://upstream.example/flaky',
      {},
      { timeoutMs: 1000, retries: 1, backoffMs: 10 }
    );
    expect(resp.ok).toBe(true);
    expect(cancelSpy).toHaveBeenCalled();
  });
});
