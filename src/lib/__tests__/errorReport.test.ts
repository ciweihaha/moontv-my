/**
 * @jest-environment node
 */
/**
 * 深查第 12 轮：错误上报 webhook fetch 必须有超时。
 * 旧 reportError 是无超时 fire-and-forget POST，webhook 侧挂起时
 * 上报 fetch 在 isolate 内无限滞留，错误高发时滞留连接成批堆积。
 * 新行为：显式 AbortController ＋ setTimeout 硬截止 5 秒，超时即 abort，
 * 上报失败仍静默、不影响主流程；落定后清掉定时器。
 * 模块级 webhookUrl 有缓存，每场景 resetModules 重新加载模块。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('reportError webhook 超时（深查第 12 轮）', () => {
  const fetchMock = jest.fn();
  let errorReport: typeof import('@/lib/errorReport');

  beforeEach(async () => {
    jest.resetModules();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response('{}'));
    (globalThis as any).fetch = fetchMock;
    process.env.ERROR_WEBHOOK_URL = 'https://hook.example.com/report';
    errorReport = await import('@/lib/errorReport');
  });

  afterEach(() => {
    delete process.env.ERROR_WEBHOOK_URL;
    jest.useRealTimers();
  });

  it('上报 fetch 带 5 秒超时信号', () => {
    errorReport.reportError('api/search', new Error('boom'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  it('5 秒后信号自动 abort（假定时器推进）', () => {
    jest.useFakeTimers();
    errorReport.reportError('api/search', new Error('boom'));
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    jest.advanceTimersByTime(4999);
    expect(signal.aborted).toBe(false);
    jest.advanceTimersByTime(1);
    expect(signal.aborted).toBe(true);
  });

  it('未配置 webhook 时不发起请求', async () => {
    jest.resetModules();
    delete process.env.ERROR_WEBHOOK_URL;
    errorReport = await import('@/lib/errorReport');
    errorReport.reportError('api/search', new Error('boom'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('上报 fetch 被拒不抛错（静默）', async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(() =>
      errorReport.reportError('api/search', new Error('boom'))
    ).not.toThrow();
    // 让 .catch 链跑完，不留未处理拒绝
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
});
