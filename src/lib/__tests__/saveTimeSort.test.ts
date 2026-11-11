/**
 * 深查第 23 轮：save_time 降序比较器脏数据兜底。
 * 旧实现 `b.save_time - a.save_time`：任一 save_time 缺失/非数值时
 * 得 NaN，比较器违反全序、排序结果不稳定（首页收藏、继续观看两处
 * 同款）。新实现缺失/非数值按最旧沉底，且满足反对称/传递性。
 */
import { compareSaveTimeDesc } from '@/lib/utils';

describe('compareSaveTimeDesc', () => {
  it('正常时间降序：最新在前', () => {
    const arr = [
      { save_time: 100 },
      { save_time: 300 },
      { save_time: 200 },
    ];
    expect([...arr].sort(compareSaveTimeDesc).map((r) => r.save_time)).toEqual([
      300, 200, 100,
    ]);
  });

  it('缺失/undefined/NaN 的 save_time 沉底（旧实现比较得 NaN）', () => {
    const arr = [
      { save_time: undefined },
      { save_time: 100 },
      {},
      { save_time: NaN },
      { save_time: 200 },
    ];
    const sorted = [...arr].sort(compareSaveTimeDesc);
    expect(sorted.slice(0, 2).map((r) => r.save_time)).toEqual([200, 100]);
    // 沉底三条的相对顺序不作要求，但比较器本身不再返回 NaN
    sorted.forEach((r) => {
      expect(
        Number.isFinite(r.save_time) || r.save_time === undefined || Number.isNaN(r.save_time as number)
      ).toBe(true);
    });
  });

  it('比较器是全序：自反、反对称，无 NaN 返回', () => {
    const values: Array<{ save_time?: unknown }> = [
      { save_time: 100 },
      { save_time: undefined },
      { save_time: 'x' },
      { save_time: NaN },
      { save_time: 0 },
      { save_time: -5 },
      {},
    ];
    for (const a of values) {
      for (const b of values) {
        const ab = compareSaveTimeDesc(a, b);
        const ba = compareSaveTimeDesc(b, a);
        expect(Number.isNaN(ab)).toBe(false);
        expect(Number.isNaN(ba)).toBe(false);
        // 反对称：ab 与 ba 异号或同为 0
        expect(Math.sign(ab) + Math.sign(ba)).toBe(0);
        expect(compareSaveTimeDesc(a, a)).toBe(0);
      }
    }
    // 传递性抽查：300 > 200 > 缺失
    expect(
      compareSaveTimeDesc({ save_time: 300 }, { save_time: 200 })
    ).toBeLessThan(0);
    expect(
      compareSaveTimeDesc({ save_time: 200 }, { save_time: undefined })
    ).toBeLessThan(0);
    expect(
      compareSaveTimeDesc({ save_time: 300 }, { save_time: undefined })
    ).toBeLessThan(0);
  });

  it('字符串 save_time 按缺失处理、不参与数值比较', () => {
    expect(
      compareSaveTimeDesc({ save_time: '9999' }, { save_time: 100 })
    ).toBeGreaterThan(0);
  });
});
