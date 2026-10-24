// 黄色内容词网：搜索（upstreamSearch）、搜索单源（search/one）、详情三处共用。
//
// 词源：① MoonTV 原有词（门事件/cosplay/SWAG/网红主播 等）；
//      ② OK影视聚合主集合标题词网（okys-agg TITLE_WORDS 70 子串＋3 正则），
//         该网经 2026-10 多轮线上采样审计收敛（误伤采样 0/50）：「三级」「人妻」
//         「杀戮」因误伤集中已在聚合侧删除，此处同步不收；裸「成人」在中文片名
//         中是普通词（长大成人/成人生赢家），不用子串、改后缀语境正则；
//      ③ 分类名补强（制服/同性/国产传媒）——针对 type_name 成人类名。
// 注意语义差异：聚合侧的「干净」靠分类白名单＋词网双层实现，MoonTV 无分类
// 白名单层，词网是唯一防线，故全量移植，不做白名单式裁剪。
// 主流类型词（动作/战争/恐怖/犯罪等）不在网内，不拦正常片。
//
// 匹配纪律（与聚合 titleBad 对齐）：待检文本先转小写（防 COSPLAY/Swag 大小写
// 绕过）、去空白（防「伦 理」空格绕过）后做子串匹配；AV/SM 走词界正则防字母
// 组合误伤；「成人」走后缀语境正则。
const rawYellowWords = [
  // —— 聚合主集合标题词网（70 子串）——
  '伦理',
  '倫理',
  '擦边',
  '福利',
  '写真',
  '情色',
  '色情',
  '两性',
  '热舞',
  '女优',
  '午夜',
  '无码',
  '有码',
  '熟女',
  '少妇',
  '乱伦',
  '乱交',
  '强奸',
  '性交',
  '性爱',
  '人兽',
  '偷情',
  '偷拍',
  '自拍',
  '探花',
  '换脸',
  '调教',
  '丝袜',
  '过膝袜',
  '恋腿',
  '诱惑',
  '母狗',
  '口交',
  '颜射',
  '巨乳',
  '萝莉',
  '黑料',
  '网曝',
  '流出',
  '裸聊',
  '群P',
  '多P',
  '自慰',
  '露出',
  '车震',
  '里番',
  '女同',
  '性恋',
  '传媒',
  '闷骚',
  '御姐',
  '辣妹',
  '瑜伽裤',
  '凌辱',
  '撸管',
  '淫',
  '图片专区',
  '劲爆',
  '血腥',
  '猎奇',
  '虐杀',
  '食人',
  '剥皮',
  '变态',
  '分尸',
  '血浆',
  '酷刑',
  '虐童',
  '勾引',
  '嫩模',
  // —— 分类名补强（type_name 成人类名）——
  '制服',
  '同性',
  '国产传媒',
  // —— MoonTV 原有词（聚合网未覆盖者）——
  '门事件',
  'cosplay',
  'SWAG',
  '网红主播',
];

export const yellowWords = rawYellowWords.map((w) => w.toLowerCase());

// PERF-R1: 子串词预编译为单个正则，调用方用 yellowRegex.test(text) 替代
// yellowWords.some((w) => text.includes(w))，避免每词一次 includes 扫描。
// 注意：不带 g 标记，test() 无状态，可安全复用。
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const yellowRegex = new RegExp(
  yellowWords.map(escapeRegExp).join('|')
);

// 语境正则（移植自聚合 TITLE_RES）：AV/SM 词界匹配防字母组合误伤；
// 「成人」仅在成人产业后缀语境下命中，后缀集来自聚合侧已观测真拦样本。
export const yellowPatterns: RegExp[] = [
  /(^|[^A-Za-z0-9])AV([^A-Za-z0-9]|$)/i,
  /(^|[^A-Za-z0-9])SM([^A-Za-z0-9]|$)/i,
  /成人(?=练习生|初学者|级爱情|期|内容|的选择|用品|影院|视频|小说|动漫|玩具|店|交友)/,
];

/**
 * 统一判定入口：文本是否命中黄色词网。
 * 内部完成小写归一化与去空白，调用方直接传 title+type_name 拼接文本即可。
 */
export function containsYellow(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  const flat = lower.replace(/[\s\u3000]+/g, '');
  if (yellowRegex.test(flat)) return true;
  return yellowPatterns.some((re) => re.test(lower));
}
