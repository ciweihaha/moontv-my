/**
 * @jest-environment node
 */
/**
 * 搜索熔断语义修复（repo-hardening 第 5/12 项）：searchFromApiWithOutcome 结果分类测试。
 *
 * 背景：旧 searchFromApi 把上游异常 / 非 2xx / 解析失败全部吞成 []，
 * 与「合法零结果」无法区分，search 路由在 Promise resolve 后一律
 * recordUpstreamSuccess，导致故障源永不熔断。
 *
 * 新语义三分：ok（成功，含合法零结果）/ failed（上游故障）/ cancelled
 * （整体超时等外部取消——不得记失败，避免把全局超时算到单个上游头上）。
 *
 * 用 mock global.fetch 驱动真实 downstream + fetchRetry。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { ApiSite } from '../config';
import { searchFromApi, searchFromApiWithOutcome } from '../downstream';

const site: ApiSite = {
  key: 'site-a',
  name: '站点A',
  api: 'https://upstream.example/api.php',
};

/** 构造 fetch 用响应：body 为字符串，走真实 ReadableStream 供 readBodyWithLimit 读取 */
function makeResponse(status: number, bodyText: string) {
  const bytes = new TextEncoder().encode(bodyText);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    body: stream,
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

const fetchMock = jest.fn();
(globalThis as any).fetch = fetchMock;

beforeEach(() => {
  fetchMock.mockReset();
});

describe('searchFromApiWithOutcome 结果分类', () => {
  test('HTTP 500（重试后仍失败）→ failed', async () => {
    fetchMock.mockImplementation(async () => makeResponse(500, 'err'));
    const outcome = await searchFromApiWithOutcome(site, '片名', 1);
    expect(outcome.status).toBe('failed');
    // fetchWithRetry 对 5xx 重试 1 次，共 2 次尝试
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  test('网络异常（fetch 抛错）→ failed', async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error('ECONNRESET');
    });
    const outcome = await searchFromApiWithOutcome(site, '片名', 1);
    expect(outcome.status).toBe('failed');
  });

  test('合法零结果（200 + 空 list）→ ok 且 results 为空', async () => {
    fetchMock.mockImplementation(async () =>
      makeResponse(200, JSON.stringify({ list: [], pagecount: 1 }))
    );
    const outcome = await searchFromApiWithOutcome(site, '不存在的片', 1);
    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') {
      expect(outcome.results).toEqual([]);
    }
  });

  test('正常结果 → ok 且带映射后的条目', async () => {
    fetchMock.mockImplementation(async () =>
      makeResponse(
        200,
        JSON.stringify({
          list: [
            {
              vod_id: 42,
              vod_name: '测试片',
              vod_pic: 'https://img.example/p.jpg',
              vod_play_url: '$https://cdn.example/v.m3u8',
            },
          ],
          pagecount: 1,
        })
      )
    );
    const outcome = await searchFromApiWithOutcome(site, '测试片', 1);
    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') {
      expect(outcome.results).toHaveLength(1);
      expect(outcome.results[0].title).toBe('测试片');
      expect(outcome.results[0].source).toBe('site-a');
    }
  });

  test('响应体不是合法 JSON → failed（解析失败不再冒充成功）', async () => {
    fetchMock.mockImplementation(async () => makeResponse(200, 'not-json{'));
    const outcome = await searchFromApiWithOutcome(site, '片名', 1);
    expect(outcome.status).toBe('failed');
  });

  test('响应 JSON 结构异常（无 list 数组）→ failed', async () => {
    fetchMock.mockImplementation(async () =>
      makeResponse(200, JSON.stringify({ code: 0, msg: 'upstream broken' }))
    );
    const outcome = await searchFromApiWithOutcome(site, '片名', 1);
    expect(outcome.status).toBe('failed');
  });

  test('请求被外部取消（进行中 abort）→ cancelled', async () => {
    fetchMock.mockImplementation(
      (_url: string, init: any) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(
              Object.assign(new Error('The operation was aborted'), {
                name: 'AbortError',
              })
            );
          });
        })
    );
    const controller = new AbortController();
    const promise = searchFromApiWithOutcome(site, '片名', 1, controller.signal);
    setTimeout(() => controller.abort(), 30);
    const outcome = await promise;
    expect(outcome.status).toBe('cancelled');
  });

  test('信号在发起前已取消 → cancelled 且不发请求', async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await searchFromApiWithOutcome(
      site,
      '片名',
      1,
      controller.signal
    );
    expect(outcome.status).toBe('cancelled');
    expect(fetchMock.mock.calls.length).toBe(0);
  });
});

describe('searchFromApi 兼容包装（旧签名不变）', () => {
  test('失败与合法零结果都返回 []（记录旧歧义，兼容行为保留）', async () => {
    fetchMock.mockImplementation(async () => makeResponse(500, 'err'));
    await expect(searchFromApi(site, '片名', 1)).resolves.toEqual([]);

    fetchMock.mockReset();
    fetchMock.mockImplementation(async () =>
      makeResponse(200, JSON.stringify({ list: [], pagecount: 1 }))
    );
    await expect(searchFromApi(site, '片名', 1)).resolves.toEqual([]);
  });
});
