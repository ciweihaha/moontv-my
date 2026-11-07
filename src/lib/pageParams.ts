/**
 * 深查第 4 轮（2026-11-06）：查询串分页参数的安全解析。
 *
 * 背景（src/app/api/douban/route.ts:189-190 与
 * src/app/api/douban/categories/route.ts:17-18，基线 422256e）：
 * 两路由用裸 parseInt 解析 pageSize/pageStart/limit/start，随后只做
 * `pageSize < 1 || pageSize > 100` / `pageStart < 0` 这类比较校验。
 * parseInt('abc') 得 NaN，而 NaN 与任何数比较均为 false，于是非法
 * 输入悄悄通过校验，NaN 一路流进上游 URL（page_limit=NaN、
 * page_start=NaN、top250 的 start=NaN）、豆瓣 KV 缓存 key（…:NaN:NaN，
 * 稳定 key、可被污染）与兜底 slice(NaN, NaN)。
 *
 * 本函数只堵 NaN 这一处：缺参/空串仍回默认值；其余沿用 parseInt 的
 * 既有宽松语义（'16abc' → 16、' 20 ' → 20、'0x10' → 16 均不变），
 * 不收紧、不改合法输入行为。范围校验仍由调用方原有条件负责。
 *
 * 放在 src/lib 下（不在路由文件里导出）以便单元测试；路由文件具名
 * 导出非路由字段会在 next build 类型校验时报错（PR #29 前例）。
 */

/**
 * 解析查询串里的整数分页参数。
 * @param raw - searchParams.get() 的原始值（可能为 null）
 * @param fallback - 缺参/空串时返回的默认值
 * @returns 解析出的整数；输入非数字时返回 null（调用方应回 400）
 */
export function parsePageInt(
  raw: string | null,
  fallback: number
): number | null {
  if (raw === null || raw === '') {
    return fallback;
  }
  const parsed = parseInt(raw);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return parsed;
}
