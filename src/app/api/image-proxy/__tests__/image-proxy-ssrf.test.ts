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

// AUDIT-R7 钉死路径的 undici mock：route 在 nodejs 运行时会
// `await import('undici')` 并取其 Agent/fetch；这里替换为记录行为的假实现。
// 注意：jest.mock 工厂只能引用 mock* 前缀变量（hoist 限制）。
const mockUndiciFetch = jest.fn();
const mockAgentInstances: Array<{ options: any; destroy?: any; close?: any }> = [];
jest.mock('undici', () => {
  const Agent = jest.fn().mockImplementation((opts: any) => {
    // AUDIT-R8：实例带 destroy/close 间谍，供生命周期回归断言读取
    const inst = {
      options: opts,
      destroy: jest.fn(async () => undefined),
      close: jest.fn(async () => undefined),
    };
    mockAgentInstances.push(inst);
    return inst;
  });
  return {
    Agent,
    fetch: (...args: any[]) => mockUndiciFetch(...args),
  };
});

const DOH_PREFIX = 'https://cloudflare-dns.com/dns-query';

interface DohEntry {
  a?: string[];
  aaaa?: string[];
  /** DoH 响应的 Status 字段；0=NOERROR（默认），2=SERVFAIL，3=NXDOMAIN */
  dohStatus?: number;
  /** false 表示 DoH HTTP 层直接失败 */
  dohOk?: boolean;
  /** 按查询类型（A / AAAA）分别指定 DoH 响应，用于不对称状态测试 */
  aType?: DohTypeEntry;
  aaaaType?: DohTypeEntry;
}

/** 单个查询类型（A 或 AAAA）的 DoH 响应 */
interface DohTypeEntry {
  /** 该地址族的地址列表 */
  ips?: string[];
  /** DoH Status；0=NOERROR（默认） */
  dohStatus?: number;
  /** true 时返回不带 Status 的 payload（视为解析服务异常） */
  noStatus?: boolean;
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

/** 按查询类型构造 DoH 响应：{Status:0} 且无 Answer 表示 NODATA */
function dohTypeJson(qtype: string, sub: DohTypeEntry): MockTargetResponse {
  if (sub.dohOk === false) return dohHttpFail();
  if (sub.noStatus) return dohJson({});
  const status = sub.dohStatus ?? 0;
  if (status !== 0) return dohJson({ Status: status });
  const t = qtype === 'AAAA' ? 28 : 1;
  const answers = (sub.ips ?? []).map((ip) => ({ type: t, data: ip }));
  return dohJson(answers.length > 0 ? { Status: 0, Answer: answers } : { Status: 0 });
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
  | 'redirect-public'
  | 'redirect-pin-hop2';

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
    case 'redirect-pin-hop2':
      return redirect302('http://pin-hop2.example/done.jpg');
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
      const qtype = u.searchParams.get('type') || 'A';
      const entry = opts.doh[name];
      if (!entry) return dohHttpFail();
      // 按查询类型分别指定的响应（不对称状态测试）
      const sub = qtype === 'AAAA' ? entry.aaaaType : entry.aType;
      if (sub) return dohTypeJson(qtype, sub);
      // 旧扁平写法：同一 payload 同时用作 A/AAAA 的响应
      if (entry.dohOk === false) return dohHttpFail();
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

  describe('IPv4 新增 IANA 特殊用途段 → 403 且不发起任何请求', () => {
    const cases: Array<[string, string]> = [
      ['100.64.0.0/10 共享地址空间（CGNAT）', 'http://100.64.1.1/x.jpg'],
      ['192.0.0.0/24 IETF 协议分配', 'http://192.0.0.1/x.jpg'],
      ['192.0.2.0/24 文档示例', 'http://192.0.2.1/x.jpg'],
      ['198.18.0.0/15 基准测试', 'http://198.18.0.1/x.jpg'],
      ['198.51.100.0/24 文档示例', 'http://198.51.100.1/x.jpg'],
      ['203.0.113.0/24 文档示例', 'http://203.0.113.1/x.jpg'],
      ['224.0.0.0/4 组播', 'http://224.0.0.1/x.jpg'],
      ['240.0.0.0/4 保留', 'http://240.0.0.1/x.jpg'],
      ['255.255.255.255 有限广播', 'http://255.255.255.255/x.jpg'],
    ];
    it.each(cases)('%s', async (_label, target) => {
      const { calls } = installFetchMock({ doh: {}, targets: {} });
      const res = await callProxy(target);
      expect(res.status).toBe(403);
      expect(calls).toHaveLength(0);
    });
  });

  describe('NAT64 前缀内嵌 IPv4 → 提取后按 IPv4 规则判定', () => {
    it.each([
      ['64:ff9b::/96 → 内嵌 169.254.169.254（链路本地）', 'http://[64:ff9b::a9fe:a9fe]/x.jpg'],
      ['64:ff9b:1::/48 → 内嵌 192.168.1.1（私有）', 'http://[64:ff9b:1::c0a8:101]/x.jpg'],
    ])('%s', async (_label, target) => {
      const { calls } = installFetchMock({ doh: {}, targets: {} });
      const res = await callProxy(target);
      expect(res.status).toBe(403);
      expect(calls).toHaveLength(0);
    });

    it('64:ff9b::/96 → 内嵌 8.8.8.8（公网）→ 放行', async () => {
      const { calls } = installFetchMock({
        doh: {},
        // Node 的 URL.hostname 对 IPv6 字面量保留方括号（已实测），键需含括号
        targets: { '[64:ff9b::808:808]': 'image' },
      });
      const res = await callProxy('http://[64:ff9b::808:808]/x.jpg');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(calls.some((c) => c.includes('64:ff9b::808:808'))).toBe(true);
    });
  });

  describe('DoH 不对称状态 → 查询失败即拒绝，NODATA 合法继续', () => {
    it('A=SERVFAIL + AAAA=公网 → 403（错误不被当作无记录）', async () => {
      const { calls } = installFetchMock({
        doh: {
          'asym-sfail-a.example': {
            aType: { dohStatus: 2 },
            aaaaType: { ips: [PUBLIC_A] },
          },
        },
        targets: {},
      });
      const res = await callProxy('http://asym-sfail-a.example/x.jpg');
      expect(res.status).toBe(403);
      expect(calls.every((c) => c.startsWith(DOH_PREFIX))).toBe(true);
    });

    it('AAAA=SERVFAIL + A=公网 → 403', async () => {
      const { calls } = installFetchMock({
        doh: {
          'asym-sfail-aaaa.example': {
            aType: { ips: [PUBLIC_A] },
            aaaaType: { dohStatus: 2 },
          },
        },
        targets: {},
      });
      const res = await callProxy('http://asym-sfail-aaaa.example/x.jpg');
      expect(res.status).toBe(403);
      expect(calls.every((c) => c.startsWith(DOH_PREFIX))).toBe(true);
    });

    it('A 缺 Status + AAAA=公网 → 403（缺失视为失败）', async () => {
      const { calls } = installFetchMock({
        doh: {
          'asym-nostatus-a.example': {
            aType: { noStatus: true },
            aaaaType: { ips: [PUBLIC_A] },
          },
        },
        targets: {},
      });
      const res = await callProxy('http://asym-nostatus-a.example/x.jpg');
      expect(res.status).toBe(403);
      expect(calls.every((c) => c.startsWith(DOH_PREFIX))).toBe(true);
    });

    it('A=NODATA + AAAA=公网 → 200 放行', async () => {
      const { calls } = installFetchMock({
        doh: {
          'asym-nodata-a.example': {
            aType: {},
            aaaaType: { ips: [PUBLIC_A] },
          },
        },
        targets: { 'asym-nodata-a.example': 'image' },
      });
      const res = await callProxy('http://asym-nodata-a.example/x.jpg');
      expect(res.status).toBe(200);
      expect(calls.some((c) => c.startsWith('http://asym-nodata-a.example'))).toBe(true);
    });

    it('AAAA=NODATA + A=公网 → 200 放行', async () => {
      const { calls } = installFetchMock({
        doh: {
          'asym-nodata-aaaa.example': {
            aType: { ips: [PUBLIC_A] },
            aaaaType: {},
          },
        },
        targets: { 'asym-nodata-aaaa.example': 'image' },
      });
      const res = await callProxy('http://asym-nodata-aaaa.example/x.jpg');
      expect(res.status).toBe(200);
      expect(calls.some((c) => c.startsWith('http://asym-nodata-aaaa.example'))).toBe(true);
    });
  });

  describe('域名 DoH 解析到 CGNAT 共享地址空间 → 403', () => {
    it('域名解析到 100.64.23.9 → 403，且不抓取目标', async () => {
      const { calls } = installFetchMock({
        doh: { 'cgnat-a.example': { a: ['100.64.23.9'] } },
        targets: {},
      });
      const res = await callProxy('http://cgnat-a.example/x.jpg');
      expect(res.status).toBe(403);
      expect(calls.every((c) => c.startsWith(DOH_PREFIX))).toBe(true);
    });
  });

  describe('IP 钉死（nodejs 运行时，AUDIT-R7）', () => {
    const realFetch = g.fetch;
    let restoreRuntime: () => void = () => undefined;

    interface UndiciMockOpts {
      targets: Record<string, TargetKind>;
      /** 模拟建连不可达的地址（测试多 IP 回退 / 全不可达） */
      unreachable?: Set<string>;
    }

    /**
     * 模拟 undici 的建连语义：调用 dispatcher 里钉死 lookup 的 {all:true}，
     * 按返回顺序取第一个不在 unreachable 里的地址作为"连上"的目标；
     * 全部不可达时抛连接错误（模拟 ECONNREFUSED，无系统 DNS 回退）。
     */
    function installUndiciMock(opts: UndiciMockOpts): {
      connectedTo: string[];
      lookups: Array<{
        hostname: string;
        all: boolean;
        addrs: Array<{ address: string; family: number }>;
      }>;
    } {
      const connectedTo: string[] = [];
      const lookups: Array<{
        hostname: string;
        all: boolean;
        addrs: Array<{ address: string; family: number }>;
      }> = [];
      const unreachable = opts.unreachable ?? new Set<string>();
      mockUndiciFetch.mockImplementation(async (input: unknown, init: any) => {
        const url = String(input);
        const hostname = new URL(url).hostname;
        const lookup = init?.dispatcher?.options?.connect?.lookup;
        if (typeof lookup !== 'function') {
          throw new Error('pinned fetch called without pinned dispatcher');
        }
        const addrs: Array<{ address: string; family: number }> =
          await new Promise((resolve, reject) => {
            lookup(hostname, { all: true }, (err: any, res: any) => {
              if (err) {
                reject(err);
              } else {
                lookups.push({ hostname, all: true, addrs: res });
                resolve(res);
              }
            });
          });
        const target = addrs.find((a) => !unreachable.has(a.address));
        if (!target) {
          const e = new Error(
            `connect ECONNREFUSED ${addrs[0]?.address ?? 'unknown'}`
          ) as any;
          e.code = 'ECONNREFUSED';
          e.cause = { code: 'ECONNREFUSED' };
          throw e;
        }
        connectedTo.push(target.address);
        const kind = opts.targets[hostname];
        if (!kind) {
          throw new Error(
            `unexpected pinned fetch to ${url} (should have been blocked)`
          );
        }
        return targetResponse(kind);
      });
      return { connectedTo, lookups };
    }

    function withNodejsRuntime(): () => void {
      const prev = process.env.NEXT_RUNTIME;
      process.env.NEXT_RUNTIME = 'nodejs';
      mockUndiciFetch.mockReset();
      mockAgentInstances.length = 0;
      return () => {
        if (prev === undefined) delete process.env.NEXT_RUNTIME;
        else process.env.NEXT_RUNTIME = prev;
      };
    }

    beforeEach(() => {
      restoreRuntime = withNodejsRuntime();
    });

    afterEach(() => {
      restoreRuntime();
      g.fetch = realFetch;
    });

    it('nodejs 下图片抓取走 undici 钉死路径，lookup 只返回已校验 IP', async () => {
      const { connectedTo, lookups } = installUndiciMock({
        targets: { 'pin-basic.example': 'image' },
      });
      const { calls } = installFetchMock({
        doh: { 'pin-basic.example': { a: [PUBLIC_A] } },
        targets: {},
      });
      const res = await callProxy('http://pin-basic.example/x.jpg');
      expect(res.status).toBe(200);
      // undici 被使用：每跳恰构造一个 Agent，fetch 走了 undici
      expect(mockAgentInstances).toHaveLength(1);
      expect(mockUndiciFetch).toHaveBeenCalledTimes(1);
      const dispatcherArg = (mockUndiciFetch.mock.calls[0] as any[])[1]
        ?.dispatcher;
      expect(dispatcherArg).toBeDefined();
      // lookup 只返回已校验集合（忽略系统 DNS，不存在"重绑定后解析"）
      expect(lookups).toHaveLength(1);
      expect(lookups[0].hostname).toBe('pin-basic.example');
      expect(lookups[0].addrs).toEqual([{ address: PUBLIC_A, family: 4 }]);
      expect(connectedTo).toEqual([PUBLIC_A]);
      // 全局 fetch 只走了 DoH：图片 URL 没经过它（失败也不会回退）
      expect(calls.every((c) => c.startsWith(DOH_PREFIX))).toBe(true);
    });

    it('多 IP 按顺序回退：首个不可达时连第二个已校验 IP', async () => {
      const second = '93.184.216.36';
      const { connectedTo, lookups } = installUndiciMock({
        targets: { 'pin-fallback.example': 'image' },
        unreachable: new Set([PUBLIC_A]),
      });
      installFetchMock({
        doh: { 'pin-fallback.example': { a: [PUBLIC_A, second] } },
        targets: {},
      });
      const res = await callProxy('http://pin-fallback.example/x.jpg');
      expect(res.status).toBe(200);
      // lookup 返回整组已校验 IP（顺序保留），建连取第一个可达的
      expect(lookups[0].addrs).toEqual([
        { address: PUBLIC_A, family: 4 },
        { address: second, family: 4 },
      ]);
      expect(connectedTo).toEqual([second]);
    });

    it('已校验 IP 全不可达 → 明确失败，不回退系统解析', async () => {
      installUndiciMock({
        targets: { 'pin-dead.example': 'image' },
        unreachable: new Set([PUBLIC_A]),
      });
      const { calls } = installFetchMock({
        doh: { 'pin-dead.example': { a: [PUBLIC_A] } },
        targets: {},
      });
      const res = await callProxy('http://pin-dead.example/x.jpg');
      expect(res.status).toBe(500);
      // 失败后没有回退到全局 fetch 重试：全局侧只见过 DoH
      expect(calls.every((c) => c.startsWith(DOH_PREFIX))).toBe(true);
      expect(mockUndiciFetch).toHaveBeenCalledTimes(1);
    });

    it('lookup 非 all 模式返回首个已校验地址', async () => {
      installUndiciMock({ targets: { 'pin-single.example': 'image' } });
      installFetchMock({
        doh: { 'pin-single.example': { a: [PUBLIC_A, '93.184.216.36'] } },
        targets: {},
      });
      await callProxy('http://pin-single.example/x.jpg');
      const lookup = mockAgentInstances[0].options.connect.lookup;
      const [err, address, family] = await new Promise<any[]>((resolve) => {
        lookup('pin-single.example', {}, (...args: any[]) => resolve(args));
      });
      expect(err).toBeNull();
      expect(address).toBe(PUBLIC_A);
      expect(family).toBe(4);
    });

    it('IPv6 已校验地址 family=6', async () => {
      const v6 = '2606:4700:4700::1111';
      const { connectedTo, lookups } = installUndiciMock({
        targets: { 'pin-v6.example': 'image' },
      });
      installFetchMock({
        doh: { 'pin-v6.example': { aaaa: [v6] } },
        targets: {},
      });
      const res = await callProxy('http://pin-v6.example/x.jpg');
      expect(res.status).toBe(200);
      expect(lookups[0].addrs).toEqual([{ address: v6, family: 6 }]);
      expect(connectedTo).toEqual([v6]);
    });

    it('重定向每跳独立钉死：各跳只连各自已校验 IP', async () => {
      const hop2ip = '93.184.216.37';
      const { connectedTo, lookups } = installUndiciMock({
        targets: {
          'pin-hop1.example': 'redirect-pin-hop2', // 302 → http://pin-hop2.example/done.jpg
          'pin-hop2.example': 'image',
        },
      });
      installFetchMock({
        doh: {
          'pin-hop1.example': { a: [PUBLIC_A] },
          'pin-hop2.example': { a: [hop2ip] },
        },
        targets: {},
      });
      const res = await callProxy('http://pin-hop1.example/go.jpg');
      expect(res.status).toBe(200);
      // 两跳 → 两个 Agent，每跳的 lookup 只返回本跳集合
      expect(mockAgentInstances).toHaveLength(2);
      expect(mockUndiciFetch).toHaveBeenCalledTimes(2);
      expect(lookups).toHaveLength(2);
      expect(lookups[0].hostname).toBe('pin-hop1.example');
      expect(lookups[0].addrs).toEqual([{ address: PUBLIC_A, family: 4 }]);
      expect(lookups[1].hostname).toBe('pin-hop2.example');
      expect(lookups[1].addrs).toEqual([{ address: hop2ip, family: 4 }]);
      expect(connectedTo).toEqual([PUBLIC_A, hop2ip]);
    });

    it('IP 字面量目标：钉死集合即字面量本身', async () => {
      const { connectedTo } = installUndiciMock({
        targets: { '93.184.216.38': 'image' },
      });
      installFetchMock({ doh: {}, targets: {} });
      const res = await callProxy('http://93.184.216.38/x.jpg');
      expect(res.status).toBe(200);
      expect(mockAgentInstances).toHaveLength(1);
      expect(connectedTo).toEqual(['93.184.216.38']);
    });

    it('AUDIT-R8 生命周期：单跳成功后该跳 Agent 被确定性释放', async () => {
      installUndiciMock({ targets: { 'life-one.example': 'image' } });
      installFetchMock({
        doh: { 'life-one.example': { a: [PUBLIC_A] } },
        targets: {},
      });
      const res = await callProxy('http://life-one.example/x.jpg');
      expect(res.status).toBe(200);
      expect(mockAgentInstances).toHaveLength(1);
      expect(mockAgentInstances[0].destroy).toHaveBeenCalledTimes(1);
    });

    it('AUDIT-R8 生命周期：重定向两跳各自 Agent 均被释放', async () => {
      const hop2ip = '93.184.216.37';
      installUndiciMock({
        targets: {
          'life-hop1.example': 'redirect-pin-hop2', // 302 → http://pin-hop2.example/done.jpg
          'pin-hop2.example': 'image',
        },
      });
      installFetchMock({
        doh: {
          'life-hop1.example': { a: [PUBLIC_A] },
          'pin-hop2.example': { a: [hop2ip] },
        },
        targets: {},
      });
      const res = await callProxy('http://life-hop1.example/go.jpg');
      expect(res.status).toBe(200);
      expect(mockAgentInstances).toHaveLength(2);
      for (const inst of mockAgentInstances) {
        expect(inst.destroy).toHaveBeenCalledTimes(1);
      }
    });

    it('AUDIT-R8 生命周期：抓取失败（全不可达）也释放 Agent', async () => {
      installUndiciMock({
        targets: { 'life-dead.example': 'image' },
        unreachable: new Set([PUBLIC_A]),
      });
      installFetchMock({
        doh: { 'life-dead.example': { a: [PUBLIC_A] } },
        targets: {},
      });
      const res = await callProxy('http://life-dead.example/x.jpg');
      expect(res.status).toBe(500);
      expect(mockAgentInstances).toHaveLength(1);
      expect(mockAgentInstances[0].destroy).toHaveBeenCalledTimes(1);
    });
  });

  describe('edge 分支不受钉死影响', () => {
    const realFetch = g.fetch;

    beforeEach(() => {
      delete process.env.NEXT_RUNTIME;
      mockUndiciFetch.mockReset();
      mockAgentInstances.length = 0;
    });

    afterEach(() => {
      g.fetch = realFetch;
    });

    it('未设置 NEXT_RUNTIME 时走全局 fetch，不构造 undici', async () => {
      const { calls } = installFetchMock({
        doh: { 'edge-unaffected.example': { a: [PUBLIC_A] } },
        targets: { 'edge-unaffected.example': 'image' },
      });
      const res = await callProxy('http://edge-unaffected.example/x.jpg');
      expect(res.status).toBe(200);
      expect(mockAgentInstances).toHaveLength(0);
      expect(mockUndiciFetch).not.toHaveBeenCalled();
      expect(
        calls.some((c) => c.startsWith('http://edge-unaffected.example'))
      ).toBe(true);
    });
  });
});