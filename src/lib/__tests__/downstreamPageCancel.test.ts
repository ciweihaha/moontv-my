/**
 * @jest-environment node
 */
/**
 * 外部审查遗留项 1：搜索分页提前返回分支的响应体取消。
 *
 * 第一页在 Content-Length 超限 / 非 2xx 时都会先 cancel 响应体再返回，
 * 分页（第 2 页起）的两个提前返回分支此前直接 return []，未取消响应体，
 * 未消费的响应体可能继续占用连接/缓冲。本轮补齐至一致，并顺带核查
 * 第一页非 2xx 分支（此前同样缺失，一并补齐）。
 *
 * 断言口径：通过 mock fetch 返回带 cancel 探针的 ReadableStream，
 * 经真实 fetchWithRetry 的跟踪流传导后，观察底层流 cancel 是否被调用；
 * 同时断言结果语义不变（该页按 [] 处理、其他页照常合并）。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Headers as UndiciHeaders, Response as UndiciResponse } from 'undici';

import { ApiSite } from '../config';
import { searchFromApiWithOutcome } from '../downstream';

// jest 27 node 环境无 Response 全局；fetchWithRetry 会重构 Response，需 undici 实现
if (typeof (globalThis as any).Response === 'undefined') {
  (globalThis as any).Response = UndiciResponse;
}

const site: ApiSite = {
  key: 'site-pg',
  name: '分页站',
  api: 'https://pg.example/api.php',
};

const BIG_CONTENT_LENGTH = String(6 * 1024 * 1024); // 6MB > 5MB 上限

interface Instrumented {
  response: any;
  cancelCalls: () => number;
}

/**
 * 带 cancel 探针的流式响应。
 * closeBody=false 时流保持未结束（模拟响应体尚未到齐/超大响应正在传输）：
 * 这正是 cancel 要处理的对象——已读完并关闭的流按 Streams 规范 cancel
 * 不再回调源 cancel（资源已释放），探针也就观测不到，故被丢弃的响应体
 * 必须用未结束的流建模。contentLength 给定时用真实 Headers 实例，
 * 保证该头能穿过 fetchWithRetry 的 Response 重构被下游读到。
 */
function instrumentedResponse(
  status: number,
  bodyText: string,
  opts?: { contentLength?: string; closeBody?: boolean }
): Instrumented {
  const bytes = new TextEncoder().encode(bodyText);
  let cancels = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      if (opts?.closeBody !== false) controller.close();
    },
    cancel() {
      cancels++;
    },
  });
  const headers = opts?.contentLength
    ? new UndiciHeaders({ 'content-length': opts.contentLength })
    : {
        get: (name: string) =>
          name.toLowerCase() === 'content-length'
            ? opts?.contentLength ?? null
            : null,
      };
  return {
    response: {
      ok: status >= 200 && status < 300,
      status,
      headers,
      body: stream,
      arrayBuffer: async () =>
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength
        ),
    },
    cancelCalls: () => cancels,
  };
}

function pageJson(ids: string[], pagecount: number): string {
  return JSON.stringify({
    list: ids.map((id) => ({
      vod_id: id,
      vod_name: `片${id}`,
      vod_pic: '',
      vod_play_url: '',
    })),
    pagecount,
  });
}

const fetchMock = jest.fn();
(globalThis as any).fetch = fetchMock;

beforeEach(() => {
  fetchMock.mockReset();
});

describe('分页提前返回的响应体取消（审查遗留项 1）', () => {
  test('分页 Content-Length 超限：该页被取消且按空页处理，其他页照常合并', async () => {
    const page2 = instrumentedResponse(200, 'x', {
      contentLength: BIG_CONTENT_LENGTH,
      closeBody: false, // 超大响应体尚未传输完，下游应 cancel 而非读取
    });
    const page3 = instrumentedResponse(200, pageJson(['p3'], 3));
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('pg=2')) return page2.response;
      if (url.includes('pg=3')) return page3.response;
      return instrumentedResponse(200, pageJson(['p1'], 3)).response;
    });

    const outcome = await searchFromApiWithOutcome(site, '片', 3);
    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') {
      // p2 超限页被丢弃，p1 + p3 照常合并（语义不变）
      expect(outcome.results.map((r) => r.id)).toEqual(['p1', 'p3']);
    }
    // 分页超限分支必须取消该页响应体
    expect(page2.cancelCalls()).toBeGreaterThanOrEqual(1);
  });

  test('分页 404（非 2xx）：该页响应体被取消且按空页处理', async () => {
    const page2 = instrumentedResponse(404, 'not found', { closeBody: false });
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('pg=2')) return page2.response;
      return instrumentedResponse(200, pageJson(['p1'], 2)).response;
    });

    const outcome = await searchFromApiWithOutcome(site, '片', 2);
    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') {
      expect(outcome.results.map((r) => r.id)).toEqual(['p1']);
    }
    expect(page2.cancelCalls()).toBeGreaterThanOrEqual(1);
  });

  test('分页 5xx（重试耗尽）：该页被排除，底层流被取消，结果语义不变', async () => {
    const page2Attempts: Instrumented[] = [];
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('pg=2')) {
        const inst = instrumentedResponse(500, 'server error');
        page2Attempts.push(inst);
        return inst.response;
      }
      return instrumentedResponse(200, pageJson(['p1'], 2)).response;
    });

    const outcome = await searchFromApiWithOutcome(site, '片', 2);
    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') {
      expect(outcome.results.map((r) => r.id)).toEqual(['p1']);
    }
    // 5xx 由 fetchWithRetry 重试 1 次（共 2 次尝试），每次响应体都被取消释放
    expect(page2Attempts.length).toBe(2);
    for (const inst of page2Attempts) {
      expect(inst.cancelCalls()).toBeGreaterThanOrEqual(1);
    }
  }, 30000);

  test('分页进行中整体被外部取消：整体记 cancelled（语义不变）', async () => {
    fetchMock.mockImplementation(async (url: string, init: any) => {
      if (url.includes('pg=2')) {
        // 分页请求 hang 住，直到外部信号 abort 才拒绝
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(
              Object.assign(new Error('The operation was aborted'), {
                name: 'AbortError',
              })
            );
          });
        });
      }
      return instrumentedResponse(200, pageJson(['p1'], 2)).response;
    });

    const controller = new AbortController();
    const promise = searchFromApiWithOutcome(site, '片', 2, controller.signal);
    setTimeout(() => controller.abort(), 50);
    const outcome = await promise;
    expect(outcome.status).toBe('cancelled');
  });

  test('第一页非 2xx：响应体被取消且记 failed（与超限分支一致）', async () => {
    const page1 = instrumentedResponse(404, 'not found', { closeBody: false });
    fetchMock.mockImplementation(async () => page1.response);

    const outcome = await searchFromApiWithOutcome(site, '片', 1);
    expect(outcome.status).toBe('failed');
    expect(page1.cancelCalls()).toBeGreaterThanOrEqual(1);
  });
});
