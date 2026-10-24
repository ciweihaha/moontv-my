/**
 * @jest-environment node
 */
/**
 * Cron 刷新：失败详情缓存 + 统计细化 + 软执行预算（repo-hardening 第 14/15 项）。
 *
 * 第 14 项旧行为：detailCache 只在成功时才写入（且不缓存进行中的 Promise），
 * 失败的详情在同一次 cron 执行内会被多条用户记录反复请求上游。
 * 新行为：Promise 一创建就入缓存（单次执行作用域），失败的已 settle null
 * 结果也被共享——同 key 全程只发一次上游请求。
 *
 * 第 15 项旧行为：响应只有 {success, stats:{users, skipped}}，局部失败被
 * 200 掩盖。新行为：stats 附加 scanned/succeeded/skippedCount/failed/
 * detailOk/detailFailed/terminatedEarly（既有字段兼容）；加软性执行预算
 * （CRON_BUDGET_MS，默认 120s），超限停止处理新记录并置 terminatedEarly。
 *
 * WHATWG 垫片沿用既有做法；db 与 fetchVideoDetail 被 mock。
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
  readonly headers = { get: (_name: string): string | null => null };
  constructor(url: string) {
    this.url = url;
  }
}

const g = globalThis as any;
if (typeof g.Request === 'undefined') g.Request = ShimRequest;
if (typeof g.Response === 'undefined') g.Response = ShimResponse;
if (typeof g.Headers === 'undefined') g.Headers = ShimHeaders;

// ---- 可控 mock ----
const mockFetchDetail = jest.fn();
const mockSavePlayRecord = jest.fn(async () => undefined);
const mockSaveFavorite = jest.fn(async () => undefined);
const mockDbState: {
  records: Record<string, any>;
  favorites: Record<string, any>;
} = { records: {}, favorites: {} };

jest.mock('@/lib/fetchVideoDetail', () => ({
  fetchVideoDetail: (...args: any[]) => mockFetchDetail(...args),
}));

jest.mock('@/lib/db', () => ({
  db: {
    getAllUsers: async () => ['u1'],
    getAllPlayRecords: async () => mockDbState.records,
    getAllFavorites: async () => mockDbState.favorites,
    savePlayRecord: (...args: any[]) => mockSavePlayRecord(...args),
    saveFavorite: (...args: any[]) => mockSaveFavorite(...args),
  },
}));

jest.mock('@/lib/errorReport', () => ({ reportError: () => undefined }));

let GET: (request: any) => Promise<Response>;
beforeAll(async () => {
  process.env.NEXT_PUBLIC_STORAGE_TYPE = 'd1';
  const mod = (await import('../route')) as typeof import('../route');
  GET = mod.GET;
});

afterAll(() => {
  delete process.env.NEXT_PUBLIC_STORAGE_TYPE;
  delete process.env.CRON_BUDGET_MS;
});

function makeRecord(title: string, total: number): any {
  return {
    title,
    source_name: '源',
    cover: '',
    index: 0,
    total_episodes: total,
    play_time: 0,
    year: '2024',
    total_time: 100,
    save_time: 1,
    search_title: title,
  };
}

function detailResult(title: string, episodes: number): any {
  return {
    id: 'x',
    title,
    poster: '',
    episodes: Array.from({ length: episodes }, (_, i) => `e${i}`),
    source: 'srcA',
    source_name: '源A',
    class: '',
    year: '2024',
    desc: '',
    type_name: '电视剧',
  };
}

beforeEach(() => {
  mockFetchDetail.mockReset();
  mockSavePlayRecord.mockReset();
  mockSavePlayRecord.mockImplementation(async () => undefined);
  mockSaveFavorite.mockReset();
  mockSaveFavorite.mockImplementation(async () => undefined);
  delete process.env.CRON_BUDGET_MS;
  // srcA+1 成功（2 集，记录里是 1 集 → 触发更新）；srcB+9 失败
  mockDbState.records = {
    'srcA+1': makeRecord('好剧', 1),
    'srcB+9': makeRecord('坏剧', 1),
  };
  mockDbState.favorites = {
    'srcA+1': { ...makeRecord('好剧', 1) },
    'srcB+9': { ...makeRecord('坏剧', 1) },
  };
  mockFetchDetail.mockImplementation(async (opts: any) => {
    if (opts.source === 'srcB') throw new Error('upstream down');
    return detailResult('好剧', 2);
  });
});

async function callCron(): Promise<any> {
  const res = await GET(new ShimRequest('http://localhost/api/cron'));
  return res.json();
}

describe('cron detailCache 失败缓存（第 14 项）', () => {
  test('同 key 成功/失败在记录与收藏间共享：各只发一次上游请求', async () => {
    const body = await callCron();
    const srcACalls = mockFetchDetail.mock.calls.filter(
      (c) => c[0].source === 'srcA'
    ).length;
    const srcBCalls = mockFetchDetail.mock.calls.filter(
      (c) => c[0].source === 'srcB'
    ).length;
    expect(srcACalls).toBe(1);
    // 旧行为：失败不缓存 → srcB 会在记录、收藏各请求一次（共 2 次）
    expect(srcBCalls).toBe(1);
    expect(body.stats.detailOk).toBe(1);
    expect(body.stats.detailFailed).toBe(1);
  });
});

describe('cron 统计细化（第 15 项）', () => {
  test('全量统计如实反映：扫描/成功/跳过/失败与详情计数', async () => {
    const body = await callCron();
    expect(body.success).toBe(true);
    expect(body.stats.users).toBe(1);
    expect(body.stats.skipped).toBe(false);
    expect(body.stats.scanned).toBe(4);
    expect(body.stats.succeeded).toBe(2);
    expect(body.stats.skippedCount).toBe(2);
    expect(body.stats.failed).toBe(0);
    expect(body.stats.terminatedEarly).toBe(false);
    expect(mockSavePlayRecord.mock.calls.length).toBe(1);
    expect(mockSaveFavorite.mock.calls.length).toBe(1);
  });

  test('局部失败（保存抛错）计入 failed，success 仍为 true（任务级语义）', async () => {
    mockSavePlayRecord.mockImplementation(async () => {
      throw new Error('db write failed');
    });
    const body = await callCron();
    expect(body.success).toBe(true);
    expect(body.stats.failed).toBe(1);
    expect(body.stats.succeeded).toBe(1);
  });

  test('执行预算为 0 → 立即 terminatedEarly 且不处理任何记录', async () => {
    process.env.CRON_BUDGET_MS = '0';
    const body = await callCron();
    expect(body.stats.terminatedEarly).toBe(true);
    expect(body.stats.scanned).toBe(0);
    expect(mockFetchDetail.mock.calls.length).toBe(0);
  });
});
