/**
 * @jest-environment node
 */
/**
 * requireAdmin 纵深防御（repo-hardening 第 19 项）。
 *
 * 旧行为：requireAdmin 只用 getAuthInfoFromCookie 读出用户名便做角色
 * 判断，不自验会话签名——只要能构造一个写着管理员用户名的 Cookie
 * （哪怕没有签名），绕过 middleware 的路径上就能冒充管理员。
 * 新行为：requireAdmin 先 verifyAuthSession（签名＋时效）再做角色判断，
 * 与 middleware 形成双层；伪造/过期会话由 requireAdmin 本身拒绝（401）。
 *
 * config 被 mock；auth 用真实实现（SESSION_SECRET 环境变量注入），
 * 合法 Cookie 用真实 generateSignature 构造，与 login 路由同口径。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const g = globalThis as any;
if (!g.crypto?.subtle) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  g.crypto = require('crypto').webcrypto;
}

// next/server 在模块加载期需要全局 Request/Response（同仓库既有垫片模式）；
// 被测模块改走 beforeAll 动态导入，确保垫片先就位。
class ShimHeaders {
  private map = new Map<string, string>();
  get(name: string): string | null {
    return this.map.get(name.toLowerCase()) ?? null;
  }
  set(name: string, value: string): void {
    this.map.set(name.toLowerCase(), value);
  }
}
class ShimResponse {
  readonly status: number;
  readonly headers = new ShimHeaders();
  private readonly body: unknown;
  static json(body: unknown, init?: { status?: number }): ShimResponse {
    return new ShimResponse(JSON.stringify(body), { status: init?.status ?? 200 });
  }
  constructor(body?: unknown, init?: { status?: number }) {
    this.status = init?.status ?? 200;
    this.body = body;
  }
  async json(): Promise<any> {
    return JSON.parse(String(this.body));
  }
}
class ShimRequest {
  readonly url = 'http://localhost/';
}
if (typeof g.Request === 'undefined') g.Request = ShimRequest;
if (typeof g.Response === 'undefined') g.Response = ShimResponse;
if (typeof g.Headers === 'undefined') g.Headers = ShimHeaders;

const mockConfig: any = {
  UserConfig: {
    AllowRegister: true,
    Users: [
      { username: 'admin1', role: 'admin' },
      { username: 'user1', role: 'user' },
    ],
  },
};

jest.mock('@/lib/config', () => ({
  getConfig: async () => mockConfig,
}));

let buildSessionSignData: any;
let generateSignature: any;
let requireAdmin: any;

const SECRET = 'test-session-secret-19';

beforeAll(async () => {
  process.env.SESSION_SECRET = SECRET;
  process.env.USERNAME = 'boss';
  process.env.NEXT_PUBLIC_STORAGE_TYPE = 'd1';
  const auth = await import('../auth');
  buildSessionSignData = auth.buildSessionSignData;
  generateSignature = auth.generateSignature;
  requireAdmin = (await import('../adminAuth')).requireAdmin;
});
afterAll(() => {
  delete process.env.SESSION_SECRET;
  delete process.env.USERNAME;
  delete process.env.NEXT_PUBLIC_STORAGE_TYPE;
});

function requestWithCookie(cookieObj: unknown): any {
  const value =
    cookieObj === null ? undefined : encodeURIComponent(JSON.stringify(cookieObj));
  return {
    cookies: {
      get: (name: string) =>
        name === 'auth' && value !== undefined ? { value } : undefined,
    },
  };
}

async function signedCookie(
  username: string,
  role: string,
  timestamp: number
): Promise<any> {
  const signature = await generateSignature(
    buildSessionSignData(username, role, timestamp),
    SECRET
  );
  return { username, role, timestamp, signature };
}

describe('requireAdmin 会话验签（第 19 项）', () => {
  test('伪造 Cookie：只有 admin 用户名、无签名 → 被 requireAdmin 本身拒绝 401（旧行为放行）', async () => {
    const forged = { username: 'boss', role: 'owner', timestamp: Date.now() };
    const { user, error } = await requireAdmin(requestWithCookie(forged));
    expect(user).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.status).toBe(401);
  });

  test('签名无效的 Cookie → 401', async () => {
    const bad = {
      username: 'admin1',
      role: 'admin',
      timestamp: Date.now(),
      signature: 'deadbeef'.repeat(8),
    };
    const { user, error } = await requireAdmin(requestWithCookie(bad));
    expect(user).toBeNull();
    expect(error!.status).toBe(401);
  });

  test('签名合法但已过期的 Cookie → 401', async () => {
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const expired = await signedCookie('boss', 'owner', eightDaysAgo);
    const { user, error } = await requireAdmin(requestWithCookie(expired));
    expect(user).toBeNull();
    expect(error!.status).toBe(401);
  });

  test('合法 owner 会话不回归', async () => {
    const good = await signedCookie('boss', 'owner', Date.now());
    const { user, error } = await requireAdmin(requestWithCookie(good));
    expect(error).toBeNull();
    expect(user).toEqual({ username: 'boss', role: 'owner' });
  });

  test('合法 admin（配置角色）会话不回归；普通用户仍 403', async () => {
    const admin = await signedCookie('admin1', 'admin', Date.now());
    const r1 = await requireAdmin(requestWithCookie(admin));
    expect(r1.error).toBeNull();
    expect(r1.user).toEqual({ username: 'admin1', role: 'admin' });

    const plain = await signedCookie('user1', 'user', Date.now());
    const r2 = await requireAdmin(requestWithCookie(plain));
    expect(r2.user).toBeNull();
    expect(r2.error!.status).toBe(403);
  });

  test('无 Cookie → 401', async () => {
    const { user, error } = await requireAdmin(requestWithCookie(null));
    expect(user).toBeNull();
    expect(error!.status).toBe(401);
  });
});
