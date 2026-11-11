/**
 * @jest-environment node
 */
/**
 * 深查第 19 轮：播放记录清空分批删除（每批 5 并发）+ allSettled 汇总，
 * 与收藏清空（第 18 轮）同款修复：旧实现 Promise.all 无界扇出，
 * 任一失败即整单 500、局部已删被掩盖。
 * 路由级测试：mock db 与 auth。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

class ShimRequest {
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
}

const mockDb = {
  getAllPlayRecords: jest.fn(),
  deletePlayRecord: jest.fn(),
};

jest.mock('@/lib/db', () => ({ db: mockDb }));
jest.mock('@/lib/auth', () => ({
  getAuthInfoFromCookie: () => ({ username: 'alice' }),
}));

let DELETE: (request: any) => Promise<Response>;
beforeAll(async () => {
  const mod = (await import('../route')) as typeof import('../route');
  DELETE = mod.DELETE;
});

beforeEach(() => {
  mockDb.getAllPlayRecords.mockReset();
  mockDb.deletePlayRecord.mockReset();
});

describe('播放记录清空分批删除（深查第 19 轮）', () => {
  test('12 条记录分 3 批删完，单批并发不超 5', async () => {
    const keys = Array.from({ length: 12 }, (_, i) => `s${i}+${100 + i}`);
    const all: Record<string, unknown> = {};
    keys.forEach((k) => {
      all[k] = { title: 't' };
    });
    mockDb.getAllPlayRecords.mockResolvedValue(all);
    let active = 0;
    let maxActive = 0;
    mockDb.deletePlayRecord.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
    });

    const res = await DELETE(new ShimRequest('http://localhost/api/playrecords'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, deleted: 12, failed: 0 });
    expect(mockDb.deletePlayRecord).toHaveBeenCalledTimes(12);
    expect(maxActive).toBeLessThanOrEqual(5);
  });

  test('其中 1 条删除失败 → 仍回 200，其余照常删除并如实计数（旧实现整单 500）', async () => {
    const keys = ['s1+100', 's2+101', 's3+102'];
    const all: Record<string, unknown> = {};
    keys.forEach((k) => {
      all[k] = { title: 't' };
    });
    mockDb.getAllPlayRecords.mockResolvedValue(all);
    mockDb.deletePlayRecord.mockImplementation(async (_u: string, _s: string, id: string) => {
      if (id === '101') throw new Error('D1 transient error');
    });

    const res = await DELETE(new ShimRequest('http://localhost/api/playrecords'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, deleted: 2, failed: 1 });
    expect(mockDb.deletePlayRecord).toHaveBeenCalledTimes(3);
  });

  test('空记录 → 200，deleted/failed 均为 0', async () => {
    mockDb.getAllPlayRecords.mockResolvedValue({});
    const res = await DELETE(new ShimRequest('http://localhost/api/playrecords'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, deleted: 0, failed: 0 });
    expect(mockDb.deletePlayRecord).not.toHaveBeenCalled();
  });

  test('单条删除路径不变（带 key 仍回 {success:true}）', async () => {
    mockDb.deletePlayRecord.mockResolvedValue(undefined);
    const res = await DELETE(
      // key 中的 + 必须编码为 %2B，与 db.client.ts 的 encodeURIComponent(key) 一致
      new ShimRequest('http://localhost/api/playrecords?key=s1%2B100')
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true });
    expect(mockDb.deletePlayRecord).toHaveBeenCalledTimes(1);
  });
});
