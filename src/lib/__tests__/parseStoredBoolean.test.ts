/**
 * 深查第 24 轮：parseStoredBoolean——localStorage 布尔开关的容错解析。
 * 旧调用方（UserMenu 挂载 effect）裸 JSON.parse：损坏值抛错、触发全局
 * 错误边界且重试也过不去。损坏/非布尔一律按 fallback 处理，不抛错。
 */
import { parseStoredBoolean } from '@/lib/utils';

describe('parseStoredBoolean', () => {
  it('合法 "true"/"false" 正常解析', () => {
    expect(parseStoredBoolean('true', false)).toBe(true);
    expect(parseStoredBoolean('false', true)).toBe(false);
  });

  it('null 按 fallback（未存过）', () => {
    expect(parseStoredBoolean(null, true)).toBe(true);
    expect(parseStoredBoolean(null, false)).toBe(false);
  });

  it('非法 JSON 按 fallback，不抛错（旧实现此处抛错）', () => {
    expect(parseStoredBoolean('yes', true)).toBe(true);
    expect(parseStoredBoolean('yes', false)).toBe(false);
    expect(parseStoredBoolean('{broken', true)).toBe(true);
    expect(parseStoredBoolean('', false)).toBe(false);
  });

  it('合法 JSON 但非布尔（数字/字符串/null）按 fallback', () => {
    expect(parseStoredBoolean('123', true)).toBe(true);
    expect(parseStoredBoolean('123', false)).toBe(false);
    expect(parseStoredBoolean('"true"', false)).toBe(false);
    expect(parseStoredBoolean('null', true)).toBe(true);
    expect(parseStoredBoolean('0', true)).toBe(true);
  });
});
