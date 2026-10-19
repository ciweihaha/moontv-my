/**
 * @jest-environment node
 */
/**
 * image-proxy SSRF 回归测试（AUDIT-R5 / 2026-10-19 方案 B fail-closed）。
 *
 * 通过 mock global.fetch 驱动导出的 GET handler：
 * - https://cloudflare-dns.com/dns-query 开头的请求走 DoH mock（按测试用例返回 A/AAAA 记录或失败）
 * - 其他请求走目标 mock（返回 200 图片、302 跳转；未声明的 URL 视为非法抓取并抛错）
 *
 * 覆盖：IPv4/IPv6 字面量内网段、怪异 IP 写法、非 http(s) 协议、
 * DoH 解析到内网/混合记录/解析失败（NXDOMAIN/SERVFAIL/空记录/HTTP 异常）、
 * 重定向逐跳校验（跳到内网 IP、跳到内网域名、全程公网）。
 *
 * 注意：dnsCache 是模块级内存缓存，各用例使用互不重复的主机名，避免缓存串扰。
 *
 * WHATWG 垫片：jest 27 的 node 环境未暴露 Request/Response/Headers/AbortController
 * 全局变量（见 jest.setup.js 对 ReadableStream 的同类处理），而 next/server 在模块
 * 加载时就会引用它们。这里提供仅覆盖 handler 实际用法的最小垫片，并在垫片就绪
 * 后再用动态 import() 加载 route 模块（ES import 会被提升到垫片之前，故不能用）。
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
  /** Next 的 NextResponse.json 内部调用原生 Response 的静态 json 方法 */
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
  async arrayBuffer(): Promise<ArrayBuffer> {
    if (this.body instanceof Uint8Array) {
      return this.body.buffer.slice(
        this.body.byteOffset,
        this.body.byteOffset + this.body.byteLength
      );
    }
    return new ArrayBuffer(0);
  }
}

class ShimRequest {
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
}

class ShimAbortController {
  readonly signal = {
    aborted: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  abort(): void {
    (this.signal as { aborted: boolean }).aborted = true;
  }
}

// eslint-disable-next-line no-undef
const g = globalThis as any;
if (typeof g.Request === 'undefined') g.Request = ShimRequest;
if (typeof g.Response === 'undefined') g.Response = ShimResponse;
if (typeof g.Headers === 'undefined') g.Headers = ShimHeaders;
if (typeof g.AbortController === 'undefined')
  g.AbortController = ShimAbortController;

// 垫片就绪后再动态加载被测模块（静态 import 会被提升到垫片之前，
// 而 require() 风格被仓库 ESLint 禁止，故用动态 import）。
let GET: (request: Request) => Promise<Response>;
beforeAll(async () => {
  const mod = (await import('../route')) as typeof import('../route');
  GET = mod.GET;
});

const DOH_PREFIX = 'https://cloudflare-dns.com/dns-query';

interface DohEntry {
  a?: string[];
  aaaa?: string[];
  /** DoH 响应的 Status 字段；0=NOERROR（默认），2=SERVFAIL，3=NXDOMAIN */
  dohStatus?: number;
  /** false 表示 DoH HTTP 层直接失败 */
  dohOk?: boolean;
}

/** 最小的目标响应形状：GET 只用 ok/status/statusText/headers.get/arrayBuffer/body.getReader/json */
interface MockTargetResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get: (name: string) => string | null };
  arrayBuffer: () => Promise<ArrayBuffer>;
  body: { getReader: () => unknown } | null;
  json?: () => Promise<any>;
}

function dohJson(payload: unknown): MockTargetResponse {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => 'application/dns-json' },
    arrayBuffer: async () => new ArrayBuffer(0),
    body: null,
    json: async () => payload,
  };
}

function dohHttpFail(): MockTargetResponse {
  return {
    ok: false,
    status: 500,
    statusText: 'Internal Server Error',
    headers: { get: () => null },
    arrayBuffer: async () => new ArrayBuffer(0),
    body: null,
  };
}

function image200(): MockTargetResponse {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-type' ? 'image/png' : null,
    },
    arrayBuffer: async () => new ArrayBuffer(0),
    body: {
      getReader: () => ({
        read: async () => ({ done: true, value: undefined }),
        cancel: async () => undefined,
        releaseLock: () => undefined,
      }),
    },
  };
}

function redirect302(location: string): MockTargetResponse {
  return {
    ok: false,
    status: 302,
    statusText: 'Found',
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'location' ? location : null,
    },
    arrayBuffer: async () => new ArrayBuffer(0),
    body: null,
  };
}

/** 重定向目标分类，由各用例声明 */
type TargetKind =
  | 'image'
  | 'redirect-internal-ip'
  | 'redirect-internal-host'
  | 'redirect-public';

function targetResponse(kind: TargetKind): MockTargetResponse {
  switch (kind) {
    case 'image':
      return image200();
    case 'redirect-internal-ip':
      return redirect302('http://192.168.9.9/pic.jpg');
    case 'redirect-internal-host':
      return redirect302('http://inside.example/pic.jpg');
    case 'redirect-public':
      return redirect302('http://public-b.example/done.jpg');
  }
}

/**
 * 安装 fetch mock。返回所有被 fetch 的 URL 列表（断言用）。
 * DoH 查询按 doh 表返回；目标请求按 targets 表（以主机名匹配）返回；
 * 任何未声明的目标请求都抛错——这本身就是断言（禁止的 URL 不应被抓取）。
 */
function installFetchMock(opts: {
  doh: Record<string, DohEntry>;
  targets: Record<string, TargetKind>;
}): { calls: string[] } {
  const calls: string[] = [];
  const fake = async (input: unknown): Promise<MockTargetResponse> => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith(DOH_PREFIX)) {
      const u = new URL(url);
      const name = u.searchParams.get('name') || '';
      const entry = opts.doh[name];
      if (!entry || entry.dohOk === false) return dohHttpFail();
      const status = entry.dohStatus ?? 0;
      if (status !== 0) return dohJson({ Status: status });
      const answers: Array<{ type: number; data: string }> = [];
      for (const ip of entry.a ?? []) answers.push({ type: 1, data: ip });
      for (const ip of entry.aaaa ?? []) answers.push({ type: 28, data: ip });
      return dohJson(
        answers.length > 0 ? { Status: 0, Answer: answers } : { Status: 0 }
      );
    }
    const host = new URL(url).hostname;
    const kind = opts.targets[host];
    if (!kind) {
      throw new Error(`unexpected fetch to ${url} (should have been blocked)`);
    }
    return targetResponse(kind);
  };
  g.fetch = fake;
  return { calls };
}

/** 调用代理 handler。handler 只读 request.url，这里用最小形状避免依赖全局 Request。 */
async function callProxy(target: string): Promise<Response> {
  const req = {
    url: `http://localhost/api/image-proxy?url=${encodeURIComponent(target)}`,
  } as unknown as Request;
  return (await GET(req)) as unknown as Response;
}

const PUBLIC_A = '93.184.216.34'; // 文档网段，仅作"公网"占位

describe('image-proxy SSRF 回归', () => {
  const realFetch = g.fetch;

  afterEach(() => {
    g.fetch = realFetch;
  });

  describe('IPv4 字面量内网段 → 403 且不发起任何请求', () => {
    const cases: Array<[string, string]> = [
      ['192.168.0.0/16', 'http://192.168.1.100/x.jpg'],
      ['10.0.0.0/8', 'http://10.0.0.5/x.jpg'],
      ['172.16.0.0/12', 'http://172.16.5.4/x.jpg'],
      ['127.0.0.1 回环', 'http://127.0.0.1/x.jpg'],
      ['169.254.169.254 元数据', 'http://169.254.169.254/latest/meta-data/'],
      ['0.0.0.0', 'http://0.0.0.0/x.jpg'],
      ['localhost', 'http://localhost:8080/x.jpg'],
    ];
    it.each(cases)('%s', async (_label, target) => {
      const { calls } = installFetchMock({ doh: {}, targets: {} });
      const res = await callProxy(target);
      expect(res.status).toBe(403);
      expect(calls).toHaveLength(0);
    });
  });

  describe('IPv6 字面量特殊段 → 403 且不发起任何请求', () => {
    const cases: Array<[string, string]> = [
      ['::1 回环', 'http://[::1]/x.jpg'],
      [':: 未指定', 'http://[::]/x.jpg'],
      ['fc00::/7 ULA', 'http://[fc00::1]/x.jpg'],
      ['fe80::/10 链路本地', 'http://[fe80::1]/x.jpg'],
      ['::ffff:127.0.0.1 IPv4 映射', 'http://[::ffff:127.0.0.1]/x.jpg'],
    ];
    it.each(cases)('%s', async (_label, target) => {
      const { calls } = installFetchMock({ doh: {}, targets: {} });
      const res = await callProxy(target);
      expect(res.status).toBe(403);
      expect(calls).toHaveLength(0);
    });
  });

  describe('怪异 IP 写法（现行代码实际判定：WHATWG URL 规范化后拦截）', () => {
    const cases: Array<[string, string]> = [
      ['http://127.1 → 规范化为 127.0.0.1', 'http://127.1/x.jpg'],
      ['http://0x7f000001 → 规范化为 127.0.0.1', 'http://0x7f000001/x.jpg'],
      [
        'http://2130706433（十进制）→ 规范化为 127.0.0.1',
        'http://2130706433/x.jpg',
      ],
    ];
    it.each(cases)('%s', async (_label, target) => {
      const { calls } = installFetchMock({ doh: {}, targets: {} });
      const res = await callProxy(target);
      expect(res.status).toBe(403);
      expect(calls).toHaveLength(0);
    });
  });

  describe('非 http/https 协议 → 400', () => {
    const cases: Array<[string, string]> = [
      ['file:', 'file:///etc/passwd'],
      ['data:', 'data:image/png;base64,iVBORw0KGgo='],
      ['gopher:', 'gopher://example.com/1'],
    ];
    it.each(cases)('%s', async (_label, target) => {
      const { calls } = installFetchMock({ doh: {}, targets: {} });
      const res = await callProxy(target);
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });
  });

  describe('DoH 解析驱动的域名判定', () => {
    it('域名解析到内网 IP → 403，且不抓取目标', async () => {
      const { calls } = installFetchMock({
        doh: { 'internal-a.example': { a: ['10.1.2.3'] } },
        targets: {},
      });
      const res = await callProxy('http://internal-a.example/x.jpg');
      expect(res.status).toBe(403);
      expect(calls.every((c) => c.startsWith(DOH_PREFIX))).toBe(true);
    });

    it('域名解析到云元数据地址 → 403', async () => {
      const { calls } = installFetchMock({
        doh: { 'metadata-b.example': { a: ['169.254.169.254'] } },
        targets: {},
      });
      const res = await callProxy('http://metadata-b.example/x.jpg');
      expect(res.status).toBe(403);
      expect(calls.every((c) => c.startsWith(DOH_PREFIX))).toBe(true);
    });

    it('域名全部解析为公网 IP → 200 放行', async () => {
      const { calls } = installFetchMock({
        doh: { 'public-a.example': { a: [PUBLIC_A] } },
        targets: { 'public-a.example': 'image' },
      });
      const res = await callProxy('http://public-a.example/x.jpg');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(calls.some((c) => c.startsWith('http://public-a.example'))).toBe(
        true
      );
    });

    it('混合记录（含任一内网）→ 403', async () => {
      const { calls } = installFetchMock({
        doh: { 'mixed-a.example': { a: [PUBLIC_A, '192.168.1.7'] } },
        targets: {},
      });
      const res = await callProxy('http://mixed-a.example/x.jpg');
      expect(res.status).toBe(403);
      expect(calls.every((c) => c.startsWith(DOH_PREFIX))).toBe(true);
    });

    it('AAAA 解析到 ULA → 403', async () => {
      const { calls } = installFetchMock({
        doh: { 'v6internal-a.example': { aaaa: ['fc00::5'] } },
        targets: {},
      });
      const res = await callProxy('http://v6internal-a.example/x.jpg');
      expect(res.status).toBe(403);
      expect(calls.every((c) => c.startsWith(DOH_PREFIX))).toBe(true);
    });
  });

  describe('DoH 失败 → fail-closed（403），方案 B 回归点', () => {
    const cases: Array<[string, DohEntry]> = [
      ['NXDOMAIN', { dohStatus: 3 }],
      ['SERVFAIL', { dohStatus: 2 }],
      ['DoH HTTP 异常', { dohOk: false }],
      ['空记录（NOERROR 无 Answer）', {}],
    ];
    it.each(cases)('%s', async (_label, entry) => {
      const { calls } = installFetchMock({
        doh: { 'unresolvable-a.example': entry },
        targets: {},
      });
      const res = await callProxy('http://unresolvable-a.example/x.jpg');
      expect(res.status).toBe(403);
      // 只允许 DoH 查询，目标绝不能被抓取
      expect(calls.every((c) => c.startsWith(DOH_PREFIX))).toBe(true);
    });
  });

  describe('重定向逐跳校验', () => {
    it('第一跳公网 302 跳内网 IP → 第二跳 403', async () => {
      const { calls } = installFetchMock({
        doh: { 'redirect-to-ip.example': { a: [PUBLIC_A] } },
        targets: { 'redirect-to-ip.example': 'redirect-internal-ip' },
      });
      const res = await callProxy('http://redirect-to-ip.example/start.jpg');
      expect(res.status).toBe(403);
      expect(calls.some((c) => c.includes('192.168.9.9'))).toBe(false);
    });

    it('第一跳公网 302 跳内网域名 → 第二跳 403（DoH 判定）', async () => {
      const { calls } = installFetchMock({
        doh: {
          'redirect-to-internal.example': { a: [PUBLIC_A] },
          'inside.example': { a: ['10.9.9.9'] },
        },
        targets: { 'redirect-to-internal.example': 'redirect-internal-host' },
      });
      const res = await callProxy('http://redirect-to-internal.example/go.jpg');
      expect(res.status).toBe(403);
      expect(calls.some((c) => c.includes('inside.example/pic.jpg'))).toBe(
        false
      );
    });

    it('全程公网的合法重定向 → 200', async () => {
      installFetchMock({
        doh: {
          'redirect-public.example': { a: [PUBLIC_A] },
          'public-b.example': { a: ['93.184.216.35'] },
        },
        targets: {
          'redirect-public.example': 'redirect-public',
          'public-b.example': 'image',
        },
      });
      const res = await callProxy('http://redirect-public.example/go.jpg');
      expect(res.status).toBe(200);
    });
  });
});
