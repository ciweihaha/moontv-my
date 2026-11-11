/**
 * 深查第 13 轮：fetchSessionInfo 失败不缓存，下次调用重试。
 * 旧实现把 !ok 与网络异常都缓存为 null，会话接口一次瞬时抖动后，
 * 本页生命周期内再也不重试，用户已登录、界面却一直显示未登录，
 * 直到整页刷新；登录页登录后刷新会话也可能撞上此次缓存。
 * 新行为：只缓存成功结果，失败留 undefined（下次调用重新请求）。
 * auth.ts 有模块级内存缓存，每场景 resetModules 重新加载模块。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
describe('fetchSessionInfo 失败不缓存（深查第 13 轮）', () => {
  const fetchMock = jest.fn();

  beforeEach(async () => {
    jest.resetModules();
    fetchMock.mockReset();
    (globalThis as any).fetch = fetchMock;
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  async function freshAuth() {
    return (await import('@/lib/auth')) as typeof import('@/lib/auth');
  }

  it('会话接口先 500、再恢复 → 第二次调用重试并拿到会话', async () => {
    const auth = await freshAuth();
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500 } as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ username: 'alice', role: 'user' }),
      } as any);

    expect(await auth.fetchSessionInfo()).toBeNull();
    const session = await auth.fetchSessionInfo();
    expect(session).toEqual({ username: 'alice', role: 'user' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('网络异常后恢复 → 第二次调用重试并拿到会话', async () => {
    const auth = await freshAuth();
    fetchMock
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ username: 'bob', role: 'admin' }),
      } as any);

    expect(await auth.fetchSessionInfo()).toBeNull();
    expect(await auth.fetchSessionInfo()).toEqual({
      username: 'bob',
      role: 'admin',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('成功结果仍只请求一次（缓存成功不变）', async () => {
    const auth = await freshAuth();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ username: 'carol', role: 'user' }),
    } as any);

    expect(await auth.fetchSessionInfo()).toEqual({
      username: 'carol',
      role: 'user',
    });
    expect(await auth.fetchSessionInfo()).toEqual({
      username: 'carol',
      role: 'user',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
