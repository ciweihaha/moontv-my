/**
 * @jest-environment node
 */
/**
 * 黄色词网回归（fix/yellow-filter-20261024）。
 *
 * 背景：原 yellow.ts 词表仅 20 词，用户实测搜索仍出黄色结果。本轮把词网扩到
 * OK影视聚合主集合实战收敛版（70 子串＋3 语境正则）＋分类名补强，并统一三处
 * 服务端调用点与客户端搜索页到 containsYellow。本测试锁死两条口径：
 * - 成人样本（分类名型/标题型/大小写变体/空格绕过/成人语境）必须被拦；
 * - 干净对照（主流动作/战争/恐怖/犯罪、正常动漫、含「成人」的普通片名、
 *   AV/SM 字母组合词）必须放行——用户口径：主流类型片保留不动、不许误伤。
 * 另有一条 doUpstreamSearch 端到端断言（mock 上游），验证搜索主路径过滤段。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { containsYellow, yellowRegex, yellowWords } from '@/lib/yellow';

describe('containsYellow 成人样本（必须拦）', () => {
  const blocked: Array<[string, string]> = [
    // 分类名型（type_name 成人类名）
    ['某部影片', '伦理片'],
    ['某部影片', '福利视频'],
    ['某部影片', '同性片'],
    ['某部影片', '写真热舞'],
    ['某部影片', '国产传媒'],
    ['某部影片', '制服诱惑'],
    // 标题型
    ['午夜剧场之熟女心事', '剧情片'],
    ['偷拍自拍大合集', '纪录片'],
    ['日本无码精选集', '电影'],
    ['里番动漫合集', '动漫'],
    ['少女的凌辱日记', '剧情片'],
    // 大小写变体
    ['COSPLAY写真特辑', '写真'],
    ['Swag网红主播私密视频', '直播'],
    ['AV女优出道作', '电影'],
    ['SM女王调教室', '电影'],
    // 空格绕过（去空白后命中）
    ['伦 理 片 精 选', '电影'],
    ['无 码 高 清', '电影'],
    // 「成人」语境正则
    ['成人用品专营店', '购物'],
    ['成人动漫精选', '动漫'],
    // 繁体
    ['倫理片精選', '电影'],
  ];
  test.each(blocked)('拦截：%s / %s', (title, typeName) => {
    expect(containsYellow(title + typeName)).toBe(true);
  });
});

describe('containsYellow 干净对照（必须放行）', () => {
  const clean: Array<[string, string]> = [
    ['战狼2', '动作片'],
    ['血战钢锯岭', '战争片'],
    ['恐怖游轮', '恐怖片'],
    ['犯罪都市4', '犯罪片'],
    ['间谍过家家', '日本动漫'],
    ['樱花物语', '国产动漫'],
    // 「成人」普通词语境：不在成人产业后缀集内，不许误伤
    ['长大成人', '爱情片'],
    ['成人生赢家', '剧情片'],
    // 字母组合：AV 词界正则不得误伤 Avatar
    ['AVATAR阿凡达', '科幻片'],
    // 近形词：瑜伽裤≠瑜伽、丝袜≠丝绸
    ['瑜伽教练的一天', '纪录片'],
    ['丝绸之路', '纪录片'],
    ['流浪地球2', '科幻片'],
  ];
  test.each(clean)('放行：%s / %s', (title, typeName) => {
    expect(containsYellow(title + typeName)).toBe(false);
  });

  test('空文本放行', () => {
    expect(containsYellow('')).toBe(false);
  });
});

describe('词网规模护栏', () => {
  test('子串词数已显著扩充（原 20 词口径）', () => {
    expect(yellowWords.length).toBeGreaterThanOrEqual(70);
    expect(yellowRegex.test('伦理')).toBe(true);
  });
});

// ---- 搜索主路径端到端：doUpstreamSearch 过滤段 ----
const mockSearch = jest.fn();

jest.mock('@/lib/downstream', () => ({
  searchFromApi: (...args: any[]) => mockSearch(...args),
  SearchUpstreamError: class SearchUpstreamError extends Error {
    readonly status?: number;
    constructor(message: string, status?: number) {
      super(message);
      this.name = 'SearchUpstreamError';
      this.status = status;
    }
  },
}));

jest.mock('@/lib/config', () => ({
  getConfig: async () => ({ SourceConfig: [], SiteConfig: {} }),
}));

import { doUpstreamSearch } from '@/lib/upstreamSearch';

function sitesByApi(api: string) {
  const site: any = { key: 'k-' + api, api, name: '站点' };
  return new Map<string, any[]>([[api, [site]]]);
}

const MIXED_RESULTS: any[] = [
  { id: 'a1', title: '午夜剧场之熟女心事', type_name: '剧情片' },
  { id: 'a2', title: '普通影片名', type_name: '伦理片' },
  { id: 'a3', title: '战狼2', type_name: '动作片' },
];

beforeEach(() => {
  mockSearch.mockReset();
  mockSearch.mockResolvedValue(MIXED_RESULTS);
});

describe('doUpstreamSearch 黄色过滤（端到端）', () => {
  test('过滤开启：成人标题与成人类名结果被剔除，干净结果保留', async () => {
    const api = 'https://yellow-e2e-on.example/api.php';
    const { results } = await doUpstreamSearch(sitesByApi(api), 'q', 1, false);
    expect(results.map((r: any) => r.id)).toEqual(['a3']);
  });

  test('过滤关闭（DisableYellowFilter）：结果原样返回', async () => {
    const api = 'https://yellow-e2e-off.example/api.php';
    const { results } = await doUpstreamSearch(sitesByApi(api), 'q', 1, true);
    expect(results.map((r: any) => r.id)).toEqual(['a1', 'a2', 'a3']);
  });
});
