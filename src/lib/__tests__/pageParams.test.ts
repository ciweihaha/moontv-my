/**
 * @jest-environment node
 */
/**
 * 深查第 4 轮（2026-11-06）：parsePageInt 回归测试。
 *
 * 旧实现缺陷（src/app/api/douban/route.ts:189-190 与
 * src/app/api/douban/categories/route.ts:17-18，基线 422256e）：
 * 裸 parseInt('abc') 得 NaN，而 NaN 与任何数比较均为 false，旧校验
 * `pageSize < 1 || pageSize > 100` / `pageStart < 0` 拦不住非法输入，
 * NaN 一路流进上游 URL（page_limit=NaN）、Top250（start=NaN）与
 * 豆瓣 KV 缓存 key。见 /tmp/deep4-repro-baseline.js 的基线复现。
 *
 * 新行为：缺参/空串回默认值；非数字回 null（调用方回 400）；其余
 * 沿用 parseInt 既有宽松语义（'16abc' → 16、' 20 ' → 20、
 * '0x10' → 16 均不变），范围校验仍由调用方原有条件负责。
 */

import { parsePageInt } from '@/lib/pageParams';

describe('parsePageInt', () => {
  it('缺参（null）回默认值', () => {
    expect(parsePageInt(null, 16)).toBe(16);
    expect(parsePageInt(null, 0)).toBe(0);
  });

  it('空串回默认值（与旧 `|| 默认值` 行为一致）', () => {
    expect(parsePageInt('', 20)).toBe(20);
  });

  it('合法十进制字符串正常解析', () => {
    expect(parsePageInt('16', 16)).toBe(16);
    expect(parsePageInt('0', 16)).toBe(0);
    expect(parsePageInt('100', 16)).toBe(100);
    expect(parsePageInt('-1', 0)).toBe(-1);
  });

  it('非数字输入回 null（旧实现此处得 NaN 并通过校验）', () => {
    expect(parsePageInt('abc', 16)).toBeNull();
    expect(parsePageInt('NaN', 16)).toBeNull();
    expect(parsePageInt('xyz', 0)).toBeNull();
  });

  it('沿用 parseInt 既有宽松语义，不额外收紧', () => {
    expect(parsePageInt('16abc', 16)).toBe(16);
    expect(parsePageInt(' 20 ', 16)).toBe(20);
    expect(parsePageInt('0x10', 16)).toBe(16);
    expect(parsePageInt('1.5x', 16)).toBe(1); // parseInt 前缀解析：不在本轮收紧范围
  });

  it('NaN 输入不再能通过路由的比较校验', () => {
    // 路由校验原文：pageSize < 1 || pageSize > 100 / pageStart < 0。
    // 旧值 NaN：三式全为 false → 通过；新值 null：`=== null` 命中 → 400。
    const oldValue = parseInt('abc');
    expect(oldValue < 1 || oldValue > 100).toBe(false);
    expect(oldValue < 0).toBe(false);
    const newValue = parsePageInt('abc', 16);
    expect(newValue === null || (newValue as number) < 1 || (newValue as number) > 100).toBe(true);
  });
});
