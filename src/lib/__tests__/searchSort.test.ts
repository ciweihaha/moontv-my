/**
 * 深查第 16 轮：搜索页排序比较器全序回归。
 * 旧内联比较器 parseInt(a.year) > parseInt(b.year) ? -1 : 1 违反
 * 比较器契约：空年份 parseInt 得 NaN、两个方向都返 1，空年份浮到
 * 有年份前面；相等年份恒返 1。现抽到 src/lib/searchSort.ts 纯函数：
 * 精确匹配在前、unknown/无效年份沉底、年份降序、同年按标题。
 */
import { compareSearchResults, sortSearchResults } from '@/lib/searchSort';
import { SearchResult } from '@/lib/types';

function item(
  overrides: Partial<SearchResult> & { title: string }
): SearchResult {
  return {
    id: '1',
    title: overrides.title,
    poster: '',
    episodes: [],
    source: 's',
    source_name: '源',
    year: '2024',
    ...overrides,
  } as SearchResult;
}

describe('compareSearchResults 全序（深查第 16 轮）', () => {
  it('年份降序：2025 在 2024 前', () => {
    expect(
      sortSearchResults(
        [item({ title: 'B', year: '2024' }), item({ title: 'A', year: '2025' })],
        '片名'
      ).map((r) => r.title)
    ).toEqual(['A', 'B']);
  });

  it('空年份沉底，不浮到有年份前面（旧实现 NaN 两方向都返 1）', () => {
    const sorted = sortSearchResults(
      [
        item({ title: '空年份', year: '' }),
        item({ title: '新片', year: '2025' }),
        item({ title: '旧片', year: '2020' }),
      ],
      '片名'
    ).map((r) => r.title);
    expect(sorted).toEqual(['新片', '旧片', '空年份']);
  });

  it('比较器反对称：空年份 vs 有年份，两方向符号相反', () => {
    const empty = item({ title: 'E', year: '' });
    const dated = item({ title: 'D', year: '2024' });
    expect(compareSearchResults(empty, dated, '片名')).toBeGreaterThan(0);
    expect(compareSearchResults(dated, empty, '片名')).toBeLessThan(0);
  });

  it('同年退到标题比较，不恒返 1', () => {
    const a = item({ title: 'B片', year: '2024' });
    const b = item({ title: 'A片', year: '2024' });
    expect(compareSearchResults(a, b, '片名')).toBeGreaterThan(0);
    expect(compareSearchResults(b, a, '片名')).toBeLessThan(0);
    expect(compareSearchResults(a, a, '片名')).toBe(0);
  });

  it('unknown 沉底；都 unknown 时按标题', () => {
    const sorted = sortSearchResults(
      [
        item({ title: 'U2', year: 'unknown' }),
        item({ title: '新片', year: '2025' }),
        item({ title: 'U1', year: 'unknown' }),
      ],
      '片名'
    ).map((r) => r.title);
    expect(sorted).toEqual(['新片', 'U1', 'U2']);
  });

  it('标题精确匹配排在前面（与查询词完全一致）', () => {
    const sorted = sortSearchResults(
      [
        item({ title: '哪吒之魔童降世', year: '2025' }),
        item({ title: '哪吒', year: '2019' }),
      ],
      '哪吒'
    ).map((r) => r.title);
    expect(sorted).toEqual(['哪吒', '哪吒之魔童降世']);
  });

  it('非数字年份（如 2024年残留）按无效处理沉底', () => {
    const sorted = sortSearchResults(
      [item({ title: '残', year: '年份未知' }), item({ title: '新', year: '2025' })],
      '片名'
    ).map((r) => r.title);
    expect(sorted).toEqual(['新', '残']);
  });

  it('sortSearchResults 不改动原数组', () => {
    const input = [
      item({ title: 'B', year: '2024' }),
      item({ title: 'A', year: '2025' }),
    ];
    const out = sortSearchResults(input, '片名');
    expect(out).not.toBe(input);
    expect(input.map((r) => r.title)).toEqual(['B', 'A']);
  });
});
