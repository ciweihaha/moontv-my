/**
 * @jest-environment node
 */
/**
 * 深查第 20 轮：注册路由加登录同口径限频（每 IP 每分钟 10 次，超限 429）。
 * 旧实现：登录有 SEC-R2 限频，公开注册全无——开放注册时每次注册都写
 * D1 用户表 + 全量 admin config 读改写，可被无限刷号。
 * 路由级测试：mock config/db/auth；限频桶是模块内内存 Map，用不同
 * cf-connecting-ip 隔离各用例的计数。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// 路由在模块顶层读取 NEXT_PUBLIC_STORAGE_TYPE，必须在 import 路由前置为 d1
process.env.NEXT_PUBLIC_STORAGE_TYPE = 'd1';

class ShimRequest {
  readonly url: string;
  private body: unknown;
  readonly headers: { get: (name: string) => string | null };
  constructor(url: string, ip: string, body: unknown) {
    this.url = url;
    this.body = body;
    this.headers = {
      get: (name: string) =>
        name.toLowerCase() === 'cf-connecting-ip' ? ip : null,
    };
  }
  async json() {
    return this.body;
  }
}

const mockDb = {
  checkUserExist: jest.fn(),
  registerUser: jest.fn(),
  saveAdminConfig: jest.fn(),
};

jest.mock('@/lib/config', () => ({
  getConfig: jest.fn(),
}));
jest.mock('@/lib/db', () => ({ db: mockDb }));
jest.mock('@/lib/auth', () => ({
  buildSessionSignData: () => 'sign-data',
  generateSignature: async () => 'sig',
  getSessionSecret: () => 'test-secret',
}));

import { getConfig } from '@/lib/config';

const mockedGetConfig = getConfig as jest.Mock;

let POST: (request: any) => Promise<Response>;
beforeAll(async () => {
  const mod = (await import('../route')) as typeof import('../route');
  POST = mod.POST;
});

function allowRegisterConfig() {
  return { UserConfig: { AllowRegister: true, Users: [] } };
}

beforeEach(() => {
  mockDb.checkUserExist.mockReset().mockResolvedValue(false);
  mockDb.registerUser.mockReset().mockResolvedValue(undefined);
  mockDb.saveAdminConfig.mockReset().mockResolvedValue(undefined);
  mockedGetConfig.mockReset().mockImplementation(allowRegisterConfig);
});

describe('注册限频（深查第 20 轮）', () => {
  test('单次注册成功：写用户 + 配置追加新用户', async () => {
    const res = await POST(
      new ShimRequest('http://localhost/api/register', '10.0.0.1', {
        username: 'newuser',
        password: 'password123',
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(mockDb.registerUser).toHaveBeenCalledTimes(1);
    expect(mockDb.registerUser).toHaveBeenCalledWith(
      'newuser',
      'password123'
    );
    expect(mockDb.saveAdminConfig).toHaveBeenCalledTimes(1);
    const saved = mockDb.saveAdminConfig.mock.calls[0][0];
    expect(saved.UserConfig.Users).toEqual([
      { username: 'newuser', role: 'user' },
    ]);
  });

  test('同一 IP 1 分钟内第 11 次注册回 429（旧实现全部 200）', async () => {
    const ip = '10.0.0.2';
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await POST(
        new ShimRequest('http://localhost/api/register', ip, {
          username: `user${i}`,
          password: 'password123',
        })
      );
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(statuses[10]).toBe(429);
    // 第 11 次被限频拦截，未写库
    expect(mockDb.registerUser).toHaveBeenCalledTimes(10);
  });

  test('不同 IP 互不干扰', async () => {
    const res = await POST(
      new ShimRequest('http://localhost/api/register', '10.0.0.3', {
        username: 'otherip',
        password: 'password123',
      })
    );
    expect(res.status).toBe(200);
  });

  test('未开放注册仍回 400（限频不改变原有语义）', async () => {
    mockedGetConfig.mockImplementation(() => ({
      UserConfig: { AllowRegister: false, Users: [] },
    }));
    const res = await POST(
      new ShimRequest('http://localhost/api/register', '10.0.0.4', {
        username: 'closedreg',
        password: 'password123',
      })
    );
    expect(res.status).toBe(400);
    expect(mockDb.registerUser).not.toHaveBeenCalled();
  });
});
