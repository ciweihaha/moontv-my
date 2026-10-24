/**
 * @jest-environment node
 */
/**
 * 配置初始化失败显式化（repo-hardening 第 21 项）。
 *
 * 旧行为：doInitConfig 的 catch 只 console.error，cachedConfig 未赋值；
 * getConfig 在 DB 无配置走 initConfig 初始化的路径上会直接
 * `return cachedConfig` —— 把 undefined 当 AdminConfig 返回，调用方
 * 在 config.UserConfig 处抛含糊的 TypeError，根源（DB 初始化失败）
 * 被吞掉。
 * 新行为：doInitConfig 记录 initError；getConfig 在初始化失败、
 * cachedConfig 仍为空时抛可识别的 ConfigInitError（name 固定、
 * message 写明初始化失败、cause 挂原始错误）。
 *
 * 场景：DB 里尚无配置（getAdminConfig → null）→ 触发初始化 →
 * setAdminConfig 抛错（模拟 DB 故障）。另测成功路径不回归。
 * config.ts 有模块级状态（cachedConfig/initError），每场景 resetModules
 * 后重新动态导入。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const mockSetAdminConfig = jest.fn();
const mockGetAdminConfig = jest.fn();

jest.mock('@/lib/db', () => ({
  getStorage: () => ({
    getAdminConfig: (...args: any[]) => mockGetAdminConfig(...args),
    setAdminConfig: (...args: any[]) => mockSetAdminConfig(...args),
    getAllUsers: async () => [],
  }),
}));

beforeAll(() => {
  process.env.NEXT_PUBLIC_STORAGE_TYPE = 'd1';
});
afterAll(() => {
  delete process.env.NEXT_PUBLIC_STORAGE_TYPE;
});

beforeEach(() => {
  jest.resetModules();
  mockSetAdminConfig.mockReset();
  mockGetAdminConfig.mockReset();
});

describe('getConfig 初始化失败显式化（第 21 项）', () => {
  test('初始化写库抛错时 getConfig 抛 ConfigInitError（旧行为返回 undefined）', async () => {
    mockGetAdminConfig.mockImplementation(async () => null);
    mockSetAdminConfig.mockImplementation(async () => {
      throw new Error('D1 write exploded');
    });
    const { getConfig, ConfigInitError } = await import('../config');
    const err = await getConfig().then(
      () => null,
      (e: any) => e
    );
    expect(err).not.toBeNull();
    expect(err).toBeInstanceOf(ConfigInitError);
    expect(err.name).toBe('ConfigInitError');
    expect(err.message).toMatch(/初始化失败/);
    expect(err.message).toContain('D1 write exploded');
  });

  test('DB 已有配置时 getConfig 正常返回（不回归）', async () => {
    mockGetAdminConfig.mockImplementation(async () => ({
      SiteConfig: { SiteName: 'X' },
      UserConfig: { AllowRegister: false, Users: [] },
      SourceConfig: [],
      CustomCategories: [],
    }));
    const { getConfig } = await import('../config');
    const cfg = await getConfig();
    expect(cfg).toBeDefined();
    expect(cfg.UserConfig).toBeDefined();
    expect(Array.isArray(cfg.SourceConfig)).toBe(true);
  });

  test('初始化成功（首次写库成功）时 getConfig 正常返回', async () => {
    mockGetAdminConfig.mockImplementation(async () => null);
    mockSetAdminConfig.mockImplementation(async () => undefined);
    const { getConfig } = await import('../config');
    const cfg = await getConfig();
    expect(cfg).toBeDefined();
    expect(cfg.SiteConfig).toBeDefined();
  });
});
