/**
 * @jest-environment node
 */
/**
 * D1 密码哈希与兼容迁移（repo-hardening 第 17 项，用户定「全部修复」）。
 *
 * 旧行为：registerUser 直存明文、verifyUser 明文直比、changePassword 直写。
 * 新行为：WebCrypto PBKDF2 存储（格式 pbkdf2$<iter>$<salt_b64>$<hash_b64>）；
 * verifyUser 见前缀走哈希校验、无前缀按旧明文比对且成功后透明升级回写；
 * 比较用常量时间。登录/校验层不对存量密码做长度拦截（长度门槛只在
 * 新密码校验处，见 userValidation）——存量短密码必须仍可登录并升级。
 *
 * 测试用内存版 D1 mock（注入 D1Storage 实例的缓存字段；process.env
 * 无法承载对象型 mock——赋值会被强转字符串）。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const g = globalThis as any;
if (!g.crypto?.subtle) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  g.crypto = require('crypto').webcrypto;
}

// ---- 内存版 D1 mock ----
const usersTable = new Map<string, string>();

function makeStatement(sql: string) {
  const stmt: any = {
    _values: [] as any[],
    bind(...values: any[]) {
      stmt._values = values;
      return stmt;
    },
    async first() {
      if (sql.startsWith('SELECT password FROM users')) {
        const pw = usersTable.get(stmt._values[0]);
        return pw === undefined ? null : { password: pw };
      }
      return null;
    },
    async run() {
      if (sql.startsWith('INSERT INTO users')) {
        usersTable.set(stmt._values[0], stmt._values[1]);
      } else if (sql.startsWith('UPDATE users SET password')) {
        usersTable.set(stmt._values[1], stmt._values[0]);
      }
      return { success: true };
    },
    async all() {
      return { results: [], success: true };
    },
  };
  return stmt;
}

const mockD1 = {
  prepare: (sql: string) => makeStatement(sql),
  exec: async () => ({ count: 0, duration: 0 }),
  batch: async () => [],
};

import { D1Storage } from '../d1.db';

let storage: D1Storage;
beforeAll(() => {
  storage = new D1Storage();
  // getD1Database 读 process.env.DB，但 process.env 赋值会把对象强转成
  // 字符串，无法注入对象型 mock；改为直接注入实例缓存字段（getDatabase
  // 见 this.db 已存在便直接用），效果等价。
  (storage as any).db = mockD1;
});
beforeEach(() => {
  usersTable.clear();
});

describe('D1 密码哈希（第 17 项）', () => {
  test('新注册存的不是明文、带 pbkdf2 前缀，且可验证登录', async () => {
    await storage.registerUser('alice', 'password123');
    const stored = usersTable.get('alice')!;
    expect(stored).not.toBe('password123');
    expect(stored.startsWith('pbkdf2$')).toBe(true);
    expect(stored).not.toContain('password123');
    await expect(storage.verifyUser('alice', 'password123')).resolves.toBe(
      true
    );
  });

  test('相同密码两次注册盐不同 → 存储值不同', async () => {
    await storage.registerUser('u1', 'same-password');
    await storage.registerUser('u2', 'same-password');
    expect(usersTable.get('u1')).not.toBe(usersTable.get('u2'));
  });

  test('错密码被拒绝（哈希账户）', async () => {
    await storage.registerUser('bob', 'correct-horse');
    await expect(storage.verifyUser('bob', 'wrong-horse')).resolves.toBe(
      false
    );
    await expect(storage.verifyUser('nobody', 'whatever1')).resolves.toBe(
      false
    );
  });

  test('旧明文账户可登录，且登录后透明升级为哈希', async () => {
    usersTable.set('carol', 'legacy-pass');
    await expect(storage.verifyUser('carol', 'legacy-pass')).resolves.toBe(
      true
    );
    const upgraded = usersTable.get('carol')!;
    expect(upgraded.startsWith('pbkdf2$')).toBe(true);
    expect(upgraded).not.toBe('legacy-pass');
    // 升级后仍可登录、错密码拒绝
    await expect(storage.verifyUser('carol', 'legacy-pass')).resolves.toBe(
      true
    );
    await expect(storage.verifyUser('carol', 'nope-nope')).resolves.toBe(
      false
    );
  });

  test('旧明文账户错密码不登录、也不升级', async () => {
    usersTable.set('dave', 'legacy-pass');
    await expect(storage.verifyUser('dave', 'bad-guess')).resolves.toBe(false);
    expect(usersTable.get('dave')).toBe('legacy-pass');
  });

  test('存量短密码（<8 位）仍可登录并升级——登录不做长度拦截', async () => {
    usersTable.set('erin', 'abc123'); // 6 位，低于新密码门槛 8
    await expect(storage.verifyUser('erin', 'abc123')).resolves.toBe(true);
    expect(usersTable.get('erin')!.startsWith('pbkdf2$')).toBe(true);
  });

  test('changePassword 后存哈希、旧密码失效、新密码可用', async () => {
    await storage.registerUser('frank', 'old-password');
    await storage.changePassword('frank', 'new-password');
    const stored = usersTable.get('frank')!;
    expect(stored.startsWith('pbkdf2$')).toBe(true);
    await expect(storage.verifyUser('frank', 'old-password')).resolves.toBe(
      false
    );
    await expect(storage.verifyUser('frank', 'new-password')).resolves.toBe(
      true
    );
  });
});
