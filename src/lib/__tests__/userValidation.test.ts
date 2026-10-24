/**
 * @jest-environment node
 */
/**
 * 统一密码/用户名校验（repo-hardening 第 18 项，用户最新口径：
 * 密码最小长度统一提高到 8）。
 *
 * 旧行为：注册有用户名正则＋密码 ≥4 的内联校验；admin/user 的 add 与
 * changePassword 只查「密码存在」——1 个字符的密码也能给新用户设上；
 * 自助改密内联 ≥4。三处口径不一。
 * 新行为：共享校验 src/lib/userValidation.ts（用户名规则同注册现行口径；
 * 新密码最小长度 8），注册、管理员新增、管理员改密、自助改密四处共用。
 * 长度门槛只作用于「新密码」校验；登录对存量密码不做长度拦截
 * （见 passwordHashing.test.ts 的存量短密码用例）。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

class ShimHeaders {
  private map = new Map<string, string>();
  constructor(init?: Record<string, string> | ShimHeaders) {
    if (init instanceof ShimHeaders) {
      init.map.forEach((v, k) => this.map.set(k, v));
    } else if (init) {
      for (const k of Object.keys(init)) this.map.set(k.toLowerCase(), init[k]);
    }
  }
  set(name: string, value: string): void {
    this.map.set(name.toLowerCase(), value);
  }
  get(name: string): string | null {
    return this.map.get(name.toLowerCase()) ?? null;
  }
}

class ShimResponse {
  readonly status: number;
  readonly headers: ShimHeaders;
  private readonly body: unknown;
  static json(
    body: unknown,
    init?: { status?: number; headers?: Record<string, string> | ShimHeaders }
  ): ShimResponse {
    const headers =
      init?.headers instanceof ShimHeaders
        ? init.headers
        : new ShimHeaders(init?.headers);
    headers.set('content-type', 'application/json');
    return new ShimResponse(JSON.stringify(body), {
      status: init?.status ?? 200,
      headers,
    });
  }
  constructor(body?: unknown, init?: { status?: number; headers?: unknown }) {
    this.status = init?.status ?? 200;
    this.headers =
      init?.headers instanceof ShimHeaders
        ? init.headers
        : new ShimHeaders(init?.headers as Record<string, string> | undefined);
    this.body = body;
  }
  async json(): Promise<any> {
    return typeof this.body === 'string' ? JSON.parse(this.body) : this.body;
  }
  async text(): Promise<string> {
    return typeof this.body === 'string' ? this.body : JSON.stringify(this.body);
  }
}

class ShimRequest {
  readonly url: string;
  readonly headers = {
    get: (): string | null => null,
  };
  private readonly bodyText: string;
  constructor(url: string, init?: { body?: string }) {
    this.url = url;
    this.bodyText = init?.body ?? '';
  }
  async json(): Promise<any> {
    return JSON.parse(this.bodyText || '{}');
  }
}

const g = globalThis as any;
if (typeof g.Request === 'undefined') g.Request = ShimRequest;
if (typeof g.Response === 'undefined') g.Response = ShimResponse;
if (typeof g.Headers === 'undefined') g.Headers = ShimHeaders;

// ---- admin/user 路由 mock ----
const mockRegisterUser = jest.fn(async () => undefined);
const mockStorageChangePassword = jest.fn(async () => undefined);
const mockAdminConfig: any = {
  UserConfig: { AllowRegister: true, Users: [] as any[] },
};

jest.mock('@/lib/adminAuth', () => ({
  requireAdmin: async () => ({
    user: { username: 'boss', role: 'owner' },
    config: mockAdminConfig,
    error: null,
  }),
}));

jest.mock('@/lib/db', () => ({
  getStorage: () => ({
    registerUser: mockRegisterUser,
    changePassword: mockStorageChangePassword,
    setAdminConfig: async () => undefined,
  }),
}));

// ---- change-password 路由 mock（与 admin 共用 '@/lib/db' mock） ----
jest.mock('@/lib/auth', () => ({
  getAuthInfoFromCookie: () => ({ username: 'alice', password: 'x' }),
}));

let validateUsername: any;
let validateNewPassword: any;
let MIN_PASSWORD_LENGTH: number;
let adminPOST: any;
let selfPOST: any;

beforeAll(async () => {
  const v = await import('../userValidation');
  validateUsername = v.validateUsername;
  validateNewPassword = v.validateNewPassword;
  MIN_PASSWORD_LENGTH = v.MIN_PASSWORD_LENGTH;
  adminPOST = (await import('../../app/api/admin/user/route')).POST;
  selfPOST = (await import('../../app/api/change-password/route')).POST;
});

function req(url: string, body: unknown): any {
  return new ShimRequest(url, { body: JSON.stringify(body) });
}

describe('共享校验函数（第 18 项）', () => {
  test('最小长度常量为 8', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(8);
  });
  test('7 位新密码被拒、8 位通过', () => {
    expect(validateNewPassword('1234567')).toMatch(/至少 8 位/);
    expect(validateNewPassword('12345678')).toBeNull();
  });
  test('空/非字符串密码被拒', () => {
    expect(validateNewPassword('')).not.toBeNull();
    expect(validateNewPassword(undefined)).not.toBeNull();
    expect(validateNewPassword(12345678)).not.toBeNull();
  });
  test('用户名规则与注册现行口径一致', () => {
    expect(validateUsername('ab')).toBeNull();
    expect(validateUsername('a')).not.toBeNull();
    expect(validateUsername('bad name!')).not.toBeNull();
    expect(validateUsername('中文名_1')).toBeNull();
    expect(validateUsername('')).not.toBeNull();
  });
});

describe('admin/user add 走共享校验', () => {
  beforeEach(() => {
    mockRegisterUser.mockClear();
    mockAdminConfig.UserConfig.Users = [];
  });

  test('单字符密码被拒（旧行为放行）且不调用 registerUser', async () => {
    const res = await adminPOST(
      req('http://localhost/api/admin/user', {
        action: 'add',
        targetUsername: 'newbie',
        targetPassword: 'x',
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/至少 8 位/);
    expect(mockRegisterUser.mock.calls.length).toBe(0);
  });

  test('7 位密码被拒、8 位通过并注册', async () => {
    const res7 = await adminPOST(
      req('http://localhost/api/admin/user', {
        action: 'add',
        targetUsername: 'newbie',
        targetPassword: '1234567',
      })
    );
    expect(res7.status).toBe(400);
    expect(mockRegisterUser.mock.calls.length).toBe(0);

    const res8 = await adminPOST(
      req('http://localhost/api/admin/user', {
        action: 'add',
        targetUsername: 'newbie',
        targetPassword: '12345678',
      })
    );
    expect(res8.status).toBe(200);
    expect(mockRegisterUser.mock.calls.length).toBe(1);
  });

  test('管理员改密同样受 8 位门槛约束', async () => {
    mockAdminConfig.UserConfig.Users = [{ username: 'victim', role: 'user' }];
    mockStorageChangePassword.mockClear();
    const res = await adminPOST(
      req('http://localhost/api/admin/user', {
        action: 'changePassword',
        targetUsername: 'victim',
        targetPassword: 'short',
      })
    );
    expect(res.status).toBe(400);
    expect(mockStorageChangePassword.mock.calls.length).toBe(0);
  });
});

describe('自助改密走共享校验', () => {
  beforeEach(() => {
    mockStorageChangePassword.mockClear();
    process.env.NEXT_PUBLIC_STORAGE_TYPE = 'd1';
  });
  afterAll(() => {
    delete process.env.NEXT_PUBLIC_STORAGE_TYPE;
  });

  test('7 位新密码被拒（旧内联口径 ≥4 会放行）', async () => {
    const res = await selfPOST(
      req('http://localhost/api/change-password', { newPassword: '1234567' })
    );
    expect(res.status).toBe(400);
    expect(mockStorageChangePassword.mock.calls.length).toBe(0);
  });

  test('8 位新密码通过', async () => {
    const res = await selfPOST(
      req('http://localhost/api/change-password', { newPassword: '12345678' })
    );
    expect(res.status).toBe(200);
    expect(mockStorageChangePassword.mock.calls.length).toBe(1);
  });
});
