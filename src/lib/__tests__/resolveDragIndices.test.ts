/**
 * 深查第 27 轮：拖拽排序下标解析——查不到的 id 不拖拽。
 * 旧实现把 findIndex 的 -1 直接喂给 dnd-kit 的 arrayMove：实测
 * arrayMove(list, -1, 1) 会把最后一个元素挪到位置 1，
 * arrayMove(list, 0, -1) 会把首元素挪到末尾。拖拽中途列表被刷新、
 * id 过期时，一次过期拖拽就静默打乱顺序，还会把“顺序已改”置上、
 * 让用户把错序保存到服务端。
 */
import { arrayMove } from '@dnd-kit/sortable';

import { resolveDragIndices } from '@/lib/utils';

const keyOf = (s: { key: string }) => s.key;
const items = [{ key: 'a' }, { key: 'b' }, { key: 'c' }, { key: 'd' }];

describe('resolveDragIndices', () => {
  it('正常拖拽：返回起止下标', () => {
    expect(resolveDragIndices(items, 'a', 'c', keyOf)).toEqual({
      oldIndex: 0,
      newIndex: 2,
    });
    expect(resolveDragIndices(items, 'd', 'b', keyOf)).toEqual({
      oldIndex: 3,
      newIndex: 1,
    });
  });

  it('over 为空或与 active 相同 → null（不拖拽）', () => {
    expect(resolveDragIndices(items, 'a', null, keyOf)).toBeNull();
    expect(resolveDragIndices(items, 'a', undefined, keyOf)).toBeNull();
    expect(resolveDragIndices(items, 'b', 'b', keyOf)).toBeNull();
  });

  it('active id 过期 → null：旧实现会把末尾元素挪到目标位', () => {
    expect(resolveDragIndices(items, 'stale', 'c', keyOf)).toBeNull();
    // 对照：旧实现 arrayMove(items, -1, 2) 的实际破坏效果
    expect(arrayMove(items, -1, 2).map((s) => s.key)).toEqual([
      'a',
      'b',
      'd',
      'c',
    ]);
  });

  it('over id 过期 → null：旧实现会把起拖元素挪到末尾', () => {
    expect(resolveDragIndices(items, 'a', 'stale', keyOf)).toBeNull();
    // 对照：旧实现 arrayMove(items, 0, -1) 的实际破坏效果
    expect(arrayMove(items, 0, -1).map((s) => s.key)).toEqual([
      'b',
      'c',
      'd',
      'a',
    ]);
  });

  it('空列表 → null', () => {
    expect(resolveDragIndices([], 'a', 'b', keyOf)).toBeNull();
  });
});
