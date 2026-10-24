/**
 * @jest-environment node
 */
/**
 * 存储类型声明与实现对齐（repo-hardening 第 9 项）。
 *
 * 旧行为：NEXT_PUBLIC_STORAGE_TYPE=redis/upstash 被 login/register 接受
 * 为「数据库模式」，但 db.ts 的 createStorage 只实现 d1/localstorage，
 * 其余落到 default 返回 null 强转实例——运行时在 db 方法里以
 * 「Cannot read properties of null」式晦涩 500 爆掉。
 *
 * 新行为：不支持的类型在 createStorage 显式抛错，信息写明实际值与
 * 已实现类型，让误配在启动/首次加载时快速失败。
 */

const ORIGINAL_ENV = process.env.NEXT_PUBLIC_STORAGE_TYPE;

beforeEach(() => {
  jest.resetModules();
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.NEXT_PUBLIC_STORAGE_TYPE;
  } else {
    process.env.NEXT_PUBLIC_STORAGE_TYPE = ORIGINAL_ENV;
  }
  jest.resetModules();
});

describe('createStorage 存储类型对齐', () => {
  test('redis → 加载即抛明确错误（写明未实现与已实现类型）', async () => {
    process.env.NEXT_PUBLIC_STORAGE_TYPE = 'redis';
    await expect(import('../db')).rejects.toThrow(/redis/);
    await expect(import('../db')).rejects.toThrow(/localstorage/);
    await expect(import('../db')).rejects.toThrow(/d1/);
  });

  test('upstash → 加载即抛明确错误', async () => {
    process.env.NEXT_PUBLIC_STORAGE_TYPE = 'upstash';
    await expect(import('../db')).rejects.toThrow(/upstash/);
  });

  test('localstorage → 不抛错（既有语义：服务端存储为 null，数据在浏览器端）', async () => {
    process.env.NEXT_PUBLIC_STORAGE_TYPE = 'localstorage';
    const mod = await import('../db');
    expect(mod.getStorage()).toBeNull();
  });

  test('未设置 → 默认 localstorage，不抛错', async () => {
    delete process.env.NEXT_PUBLIC_STORAGE_TYPE;
    const mod = await import('../db');
    expect(mod.getStorage()).toBeNull();
  });

  test('d1 → 不抛错且返回带完整方法的存储实例', async () => {
    process.env.NEXT_PUBLIC_STORAGE_TYPE = 'd1';
    const mod = await import('../db');
    const storage = mod.getStorage() as unknown as Record<string, unknown>;
    expect(storage).not.toBeNull();
    expect(typeof storage.getPlayRecord).toBe('function');
    expect(typeof storage.verifyUser).toBe('function');
  });
});
