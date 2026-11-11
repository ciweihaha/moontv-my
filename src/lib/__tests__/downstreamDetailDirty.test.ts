/**
 * @jest-environment node
 */
/**
 * 深查第 9 轮：详情单条目字段类型错位时归一化，不让整个详情请求抛错。
 * 旧 getDetailFromApi 直接对上游字段 .split/.match/cleanHtmlTags，
 * 类型错位（数字/对象）时抛错，详情页整体失败；搜索路径第 8 轮已做
 * 同类守卫（跳过单条），详情是单条目、无可跳过，只能逐字段归一化。
 * 用 mock global.fetch 驱动真实 downstream + fetchRetry（与
 * searchOutcome.test.ts 同一写法）。
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

const GOOD_DETAIL = {
  vod_id: '100',
  vod_name: '好片名',
  vod_pic: 'https://img.example.com/p.jpg',
  vod_play_url: '第1集$https://cdn.example.com/1.m3u8#第2集$https://cdn.example.com/2.m3u8',
  vod_class: '剧情',
  vod_year: '2024-05-01',
  vod_content: '<p>简介</p>',
  type_name: '电影',
  vod_douban_id: 123,
};

async function fetchDetail(detail: unknown) {
  fetchMock.mockImplementation(async () =>
    makeResponse(200, JSON.stringify({ list: [detail] }))
  );
  return getDetailFromApi(site, '100');
}

describe('getDetailFromApi 字段类型归一化（深查第 9 轮）', () => {
  it('正常详情字段逐字映射（回归基线）', async () => {
    const r = await fetchDetail(GOOD_DETAIL);
    expect(r).toMatchObject({
      id: '100',
      title: '好片名',
      poster: 'https://img.example.com/p.jpg',
      episodes: [
        'https://cdn.example.com/1.m3u8',
        'https://cdn.example.com/2.m3u8',
      ],
      class: '剧情',
      year: '2024',
      desc: '简介',
      type_name: '电影',
      douban_id: 123,
    });
  });

  it('全字段类型错位 → 归一化返回，不抛错', async () => {
    const r = await fetchDetail({
      ...GOOD_DETAIL,
      vod_name: 12345,
      vod_pic: 7,
      vod_play_url: 7,
      vod_class: 7,
      vod_year: 2024,
      vod_content: 42,
      type_name: 7,
      vod_douban_id: '123',
    });
    expect(r).toMatchObject({
      id: '100',
      title: '12345',
      poster: '',
      episodes: [],
      class: undefined,
      year: '2024',
      desc: '',
      type_name: undefined,
      douban_id: undefined,
    });
  });

  it('vod_content 为字符串且含 m3u8、播放源为空 → 仍从内容解析剧集', async () => {
    const r = await fetchDetail({
      ...GOOD_DETAIL,
      vod_play_url: '',
      vod_content: '正片$https://cdn.example.com/x.m3u8',
    });
    expect(r.episodes).toEqual(['https://cdn.example.com/x.m3u8']);
  });

  it('vod_name 为 null → 标题为空串，不抛错', async () => {
    const r = await fetchDetail({ ...GOOD_DETAIL, vod_name: null });
    expect(r.title).toBe('');
  });
});
