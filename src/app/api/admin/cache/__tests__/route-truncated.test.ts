/**
 * @jest-environment node
 */
/**
 * 管理员清缓存的 truncated 反馈（repo-hardening 第 11 项）。
 *
 * 旧行为：单次 DELETE 最多删 1000 条即停，响应只有 {ok, deleted}——
 * 调用方无法区分「已全部清完」与「撞到上限、还剩没清」。
 * 新行为：响应附加 truncated 布尔：因上限提前停止且确有剩余时为 true，
 * 恰好删满 1000 且已无剩余时为 false；未达上限时 deleted/truncated
 * 如实反映，响应 shape 向后兼容（仅新增字段）。
 *
 * WHATWG 垫片沿用既有做法；KV 与鉴权被 mock。
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
    return JSON.parse(String(this.body));
  }
}

class ShimRequest {
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
}

const g = globalThis as any;
if (typeof g.Request === 'undefined') g.Request = ShimRequest;
if (typeof g.Response === 'undefined') g.Response = ShimResponse;
if (typeof g.Headers === 'undefined') g.Headers = ShimHeaders;

// ---- 可控 KV mock ----
interface ListPage {
  keys: Array<{ name: string }>;
  list_complete: boolean;
  cursor?: string;
}
const mockPages: ListPage[] = [];
const mockDeleted: string[] = [];
const mockKv = {
  get: async () => null,
  put: async () => undefined,
  delete: async (name: string) => {
    mockDeleted.push(name);
  },
  list: async () => {
    const page = mockPages.shift();
    if (!page) return { keys: [], list_complete: true };
    return page;
  },
};

jest.mock('@/lib/kv', () => ({
  getSearchKV: () => mockKv,
}));

jest.mock('@/lib/adminAuth', () => ({
  requireAdmin: async () => ({ user: { username: 'admin' }, error: null }),
}));

let DELETE: (request: any) => Promise<Response>;
beforeAll(async () => {
  const mod = (await import('../route')) as typeof import('../route');
  DELETE = mod.DELETE;
});

function keysPage(count: number, offset: number, complete: boolean, cursor?: string): ListPage {
  return {
    keys: Array.from({ length: count }, (_, i) => ({
      name: `v1:search:k${offset + i}`,
    })),
    list_complete: complete,
    cursor,
  };
}

beforeEach(() => {
  mockPages.length = 0;
  mockDeleted.length = 0;
});

async function callDelete(): Promise<any> {
  const res = await DELETE(
    new ShimRequest('http://localhost/api/admin/cache') as any
  );
  return res.json();
}

describe('admin cache DELETE truncated 反馈', () => {
  test('总量 1001 条（一页）→ deleted=1000 且 truncated=true', async () => {
    mockPages.push(keysPage(1001, 0, true));
    const body = await callDelete();
    expect(body.ok).toBe(true);
    expect(body.deleted).toBe(1000);
    expect(body.truncated).toBe(true);
    expect(mockDeleted.length).toBe(1000);
  });

  test('总量 5 条 → deleted=5 且 truncated=false', async () => {
    mockPages.push(keysPage(5, 0, true));
    const body = await callDelete();
    expect(body.deleted).toBe(5);
    expect(body.truncated).toBe(false);
  });

  test('恰好 1000 条且已列完 → deleted=1000 且 truncated=false', async () => {
    mockPages.push(keysPage(1000, 0, true));
    const body = await callDelete();
    expect(body.deleted).toBe(1000);
    expect(body.truncated).toBe(false);
  });

  test('分页：600 + 600 → deleted=1000 且 truncated=true', async () => {
    mockPages.push(keysPage(600, 0, false, 'c2'));
    mockPages.push(keysPage(600, 600, true));
    const body = await callDelete();
    expect(body.deleted).toBe(1000);
    expect(body.truncated).toBe(true);
  });
});
