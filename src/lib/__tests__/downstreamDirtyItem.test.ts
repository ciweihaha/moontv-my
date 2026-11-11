/**
 * @jest-environment node
 */
/**
 * 深查第 8 轮：上游搜索条目字段类型错位时只跳过单条，不拖垮整源。
 * 旧 mapSearchItem 只守卫 vod_id/vod_name 为空；上游 JSON 字段类型错位
 *（如 vod_name 为数字）在 .trim()/.match()/cleanHtmlTags 内抛错，
 * 第一页 .map 在 searchFromApiWithOutcome 外层 try 内，单条脏数据导致
 * 整个源记 failed（甚至触发熔断），其余干净条目一并丢失。
 * 用 mock global.fetch 驱动真实 downstream + fetchRetry（与
 * searchOutcome.test.ts 同一写法）。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Response as UndiciResponse } from 'undici';

import { ApiSite } from '../config';
import {
  mapSearchItem,
  searchFromApiWithOutcome,
} from '../downstream';

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

const GOOD = {
  vod_id: '100',
  vod_name: '  好片名  ',
  vod_pic: 'https://img.example.com/p.jpg',
  vod_play_url: '第1集$https://cdn.example.com/1.m3u8',
  vod_class: '剧情',
  vod_year: '2024-05-01',
  vod_content: '<p>简介</p>',
  type_name: '电影',
  vod_douban_id: 123,
};

describe('mapSearchItem 字段类型守卫', () => {
  const asItem = (v: unknown) => v as any;

  it('正常条目字段逐字映射（回归基线）', () => {
    const r = mapSearchItem(asItem(GOOD), 'site-a', '站点A', true);
    expect(r).toMatchObject({
      id: '100',
      title: '好片名',
      poster: 'https://img.example.com/p.jpg',
      episodes: ['https://cdn.example.com/1.m3u8'],
      class: '剧情',
      year: '2024',
      desc: '简介',
      type_name: '电影',
      douban_id: 123,
    });
  });

  it('vod_name 为数字 → 跳过单条（旧实现在 .trim() 抛错）', () => {
    expect(
      mapSearchItem(asItem({ ...GOOD, vod_name: 12345 }), 'site-a', '站点A', true)
    ).toBeNull();
  });

  it('vod_id 为对象 → 跳过单条（不产出 "[object Object]"）', () => {
    expect(
      mapSearchItem(asItem({ ...GOOD, vod_id: { x: 1 } }), 'site-a', '站点A', true)
    ).toBeNull();
  });

  it('vod_id 为数字 → 归一为字符串 id', () => {
    const r = mapSearchItem(asItem({ ...GOOD, vod_id: 123 }), 'site-a', '站点A', true);
    expect(r?.id).toBe('123');
  });

  it('vod_content 为数字 → desc 为空串，条目保留', () => {
    const r = mapSearchItem(asItem({ ...GOOD, vod_content: 42 }), 'site-a', '站点A', true);
    expect(r?.desc).toBe('');
    expect(r?.title).toBe('好片名');
  });

  it('vod_year 为数字 → 归一为年份字符串', () => {
    const r = mapSearchItem(asItem({ ...GOOD, vod_year: 2024 }), 'site-a', '站点A', true);
    expect(r?.year).toBe('2024');
  });

  it('vod_year 为空串 → 仍为 unknown（旧语义不变）', () => {
    const r = mapSearchItem(asItem({ ...GOOD, vod_year: '' }), 'site-a', '站点A', true);
    expect(r?.year).toBe('unknown');
  });

  it('vod_pic / vod_play_url / vod_class / type_name / douban_id 类型错位 → 退化为空值，条目保留', () => {
    const r = mapSearchItem(
      asItem({
        ...GOOD,
        vod_pic: 7,
        vod_play_url: 7,
        vod_class: 7,
        type_name: 7,
        vod_douban_id: '123',
      }),
      'site-a',
      '站点A',
      true
    );
    expect(r).toMatchObject({
      poster: '',
      episodes: [],
      class: undefined,
      type_name: undefined,
      douban_id: undefined,
    });
  });
});

describe('searchFromApiWithOutcome 脏条目隔离（端到端）', () => {
  it('列表混有一条数字标题脏数据 → 其余条目照常返回，整体 ok 而非 failed', async () => {
    const dirty = { ...GOOD, vod_id: '101', vod_name: 12345 };
    const dirtyContent = {
      ...GOOD,
      vod_id: '102',
      vod_name: '内容脏片',
      vod_content: 42,
      vod_year: 2023,
    };
    const good2 = { ...GOOD, vod_id: '103', vod_name: '第二部' };
    fetchMock.mockImplementation(async () =>
      makeResponse(
        200,
        JSON.stringify({ list: [GOOD, dirty, dirtyContent, good2], pagecount: 1 })
      )
    );
    const outcome = await searchFromApiWithOutcome(site, '片名', 1);
    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') {
      expect(outcome.results.map((r) => r.id)).toEqual(['100', '102', '103']);
      expect(outcome.results.find((r) => r.id === '102')?.desc).toBe('');
      expect(outcome.results.find((r) => r.id === '102')?.year).toBe('2023');
    }
  });

  it('列表只有一条脏数据 → 合法零结果 ok（不记 failed、不触发熔断）', async () => {
    fetchMock.mockImplementation(async () =>
      makeResponse(
        200,
        JSON.stringify({
          list: [{ ...GOOD, vod_name: 12345 }],
          pagecount: 1,
        })
      )
    );
    const outcome = await searchFromApiWithOutcome(site, '片名', 1);
    expect(outcome).toEqual({ status: 'ok', results: [] });
  });
});
