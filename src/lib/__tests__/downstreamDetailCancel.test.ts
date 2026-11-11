/**
 * @jest-environment node
 */
/**
 * 深查第 10 轮：详情路径非 2xx 时丢弃响应体前必须 cancel。
 * fetchWithRetry 返回的响应体是跟踪流，计时器在体读完/取消前一直生效；
 * 旧 getDetailFromApi / handleSpecialSourceDetail 在 !ok 分支直接抛错、
 * 从不读体，计时器与连接悬到 10s 单次超时才释放，上游批量 4xx 时
 * 成批滞留。搜索路径、doubanCategories、version 等同类分支早已先
 * cancel 再抛错，详情两处是漏网。测试用带 cancel 探针的上游流验证：
 * 404（不可重试，无 fetchWithRetry 自身重试干扰）时探针必须被触发。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Response as UndiciResponse } from 'undici';

import { ApiSite } from '../config';
import { getDetailFromApi } from '../downstream';

if (typeof (globalThis as any).Response === 'undefined') {
  (globalThis as any).Response = UndiciResponse;
}

const site: ApiSite = {
  key: 'site-a',
  name: '站点A',
  api: 'https://upstream.example/api.php',
};

const specialSite: ApiSite = {
  ...site,
  key: 'ffzy',
  name: '非凡',
  detail: 'https://special.example',
};

/** 构造带 cancel 探针的上游响应：探针被调用即证明上游流已被释放 */
function makeProbedResponse(status: number) {
  const onCancel = jest.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('error body'));
    },
    cancel: () => {
      onCancel();
    },
  });
  return {
    response: {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'Not Found',
      headers: { get: () => null },
      body: stream,
    },
    onCancel,
  };
}

const fetchMock = jest.fn();
(globalThis as any).fetch = fetchMock;

beforeEach(() => {
  fetchMock.mockReset();
});

describe('详情非 2xx 丢弃响应体前 cancel（深查第 10 轮）', () => {
  it('getDetailFromApi 404 → 抛错且上游流被 cancel', async () => {
    const { response, onCancel } = makeProbedResponse(404);
    fetchMock.mockImplementation(async () => response);
    await expect(getDetailFromApi(site, '100')).rejects.toThrow(
      '详情请求失败: 404'
    );
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('handleSpecialSourceDetail 404 → 抛错且上游流被 cancel', async () => {
    const { response, onCancel } = makeProbedResponse(404);
    fetchMock.mockImplementation(async () => response);
    await expect(getDetailFromApi(specialSite, '100')).rejects.toThrow(
      '详情页请求失败: 404'
    );
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
