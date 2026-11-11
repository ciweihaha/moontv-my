import { SearchResult } from '@/lib/types';

/**
 * 深查第 16 轮：搜索页客户端排序比较器（纯函数，供 src/app/search/page.tsx 使用）。
 *
 * 旧实现（page.tsx 内联）：
 *   parseInt(a.year) > parseInt(b.year) ? -1 : 1
 * 违反比较器全序契约：
 * - 年份为空串/非数字时 parseInt 得 NaN，NaN 与任何数比较均为 false，
 *   两个方向都返回 1（a 在 b 后、b 也在 a 后），TimSort 顺序不定；
 * - 空年份本应沉底，却可能浮到有年份的条目前面；
 * - 相等年份恒返 1（应为 0 或退到标题比较），同样破坏反对称性。
 * 新实现：无效年份（NaN/空串）一律沉底；不同年份按数字降序；同年
 * （含都无效）退到标题 localeCompare。'unknown' 由调用方既有分支
 * 先处理（沉底），此处与之一致：parseInt('unknown') 为 NaN → 沉底。
 */
export function compareSearchResults(
  a: SearchResult,
  b: SearchResult,
  query: string
): number {
  const trimmedQuery = query.trim();
  const aExactMatch = a.title === trimmedQuery;
  const bExactMatch = b.title === trimmedQuery;
  if (aExactMatch && !bExactMatch) return -1;
  if (!aExactMatch && bExactMatch) return 1;

  if (a.year === b.year) {
    return a.title.localeCompare(b.title);
  }
  // 'unknown' 沉底（与旧分支一致）
  if (a.year === 'unknown') return 1;
  if (b.year === 'unknown') return -1;

  const ya = parseInt(a.year || '', 10);
  const yb = parseInt(b.year || '', 10);
  const aValid = Number.isFinite(ya);
  const bValid = Number.isFinite(yb);
  // 无效年份沉底；都无效退到标题比较
  if (!aValid && !bValid) return a.title.localeCompare(b.title);
  if (!aValid) return 1;
  if (!bValid) return -1;
  // 都是数字年份：大的在前；相等退到标题比较
  if (ya !== yb) return yb - ya;
  return a.title.localeCompare(b.title);
}

/** 按搜索页口径排序（不改动原数组，返回新数组） */
export function sortSearchResults(
  results: SearchResult[],
  query: string
): SearchResult[] {
  return [...results].sort((a, b) => compareSearchResults(a, b, query));
}
