// 敏感词表：英文词统一转小写，使用方需先把待检文本 toLowerCase() 后再比较，
// 防止大小写绕过（如 COSPLAY、Swag）；中文词不受 toLowerCase 影响
const rawYellowWords = [
  '伦理片',
  '福利',
  '里番动漫',
  '门事件',
  '萝莉少女',
  '制服诱惑',
  '国产传媒',
  'cosplay',
  '黑丝诱惑',
  '无码',
  '日本无码',
  '有码',
  '日本有码',
  'SWAG',
  '网红主播',
  '色情片',
  '同性片',
  '福利视频',
  '福利片',
  '写真热舞',
];

export const yellowWords = rawYellowWords.map((w) => w.toLowerCase());

// PERF-R1: 预编译为单个正则，调用方用 yellowRegex.test(text) 替代
// yellowWords.some((w) => text.includes(w))，避免每词一次 includes 扫描。
// 注意：不带 g 标记，test() 无状态，可安全复用。
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const yellowRegex = new RegExp(
  yellowWords.map(escapeRegExp).join('|')
);
