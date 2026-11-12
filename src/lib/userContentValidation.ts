/**
 * 用户内容字段校验（L5）：收藏 / 播放记录 / 搜索历史等用户提交内容的
 * 类型与长度上限，防超大字段撑爆 D1 存储与下游渲染。
 *
 * 通过返回 null，否则返回面向客户端的错误原因（英文，与现有路由口径一致）。
 */

const MAX_TITLE_LENGTH = 200;
const MAX_SOURCE_NAME_LENGTH = 100;
const MAX_COVER_LENGTH = 2048;
const MAX_YEAR_LENGTH = 10;
const MAX_SEARCH_TITLE_LENGTH = 200;
/** 搜索关键词长度上限 */
export const MAX_SEARCH_KEYWORD_LENGTH = 100;

function isNonEmptyString(value: unknown, maxLength: number): boolean {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= maxLength
  );
}

function isOptionalString(value: unknown, maxLength: number): boolean {
  return (
    value === undefined ||
    (typeof value === 'string' && value.length <= maxLength)
  );
}

function isOptionalNonNegativeNumber(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'number' && Number.isFinite(value) && value >= 0)
  );
}

/** 校验收藏对象（favorites POST） */
export function validateFavorite(favorite: unknown): string | null {
  if (!favorite || typeof favorite !== 'object') {
    return 'Invalid favorite data';
  }
  const f = favorite as Record<string, unknown>;
  if (!isNonEmptyString(f.title, MAX_TITLE_LENGTH)) {
    return 'Invalid favorite title';
  }
  if (!isNonEmptyString(f.source_name, MAX_SOURCE_NAME_LENGTH)) {
    return 'Invalid favorite source_name';
  }
  if (!isOptionalString(f.cover, MAX_COVER_LENGTH)) {
    return 'Invalid favorite cover';
  }
  if (!isOptionalString(f.year, MAX_YEAR_LENGTH)) {
    return 'Invalid favorite year';
  }
  if (!isOptionalString(f.search_title, MAX_SEARCH_TITLE_LENGTH)) {
    return 'Invalid favorite search_title';
  }
  if (!isOptionalNonNegativeNumber(f.total_episodes)) {
    return 'Invalid favorite total_episodes';
  }
  if (!isOptionalNonNegativeNumber(f.save_time)) {
    return 'Invalid favorite save_time';
  }
  return null;
}

/** 校验播放记录对象（playrecords POST） */
export function validatePlayRecord(record: unknown): string | null {
  if (!record || typeof record !== 'object') {
    return 'Invalid record data';
  }
  const r = record as Record<string, unknown>;
  if (!isNonEmptyString(r.title, MAX_TITLE_LENGTH)) {
    return 'Invalid record title';
  }
  if (!isNonEmptyString(r.source_name, MAX_SOURCE_NAME_LENGTH)) {
    return 'Invalid record source_name';
  }
  // index 必须为整数且 >= 1：旧实现 `record.index < 1` 在 index 为
  // undefined 时为 false，可绕过校验。
  if (
    typeof r.index !== 'number' ||
    !Number.isInteger(r.index) ||
    r.index < 1
  ) {
    return 'Invalid record index';
  }
  if (!isOptionalString(r.cover, MAX_COVER_LENGTH)) {
    return 'Invalid record cover';
  }
  if (!isOptionalString(r.year, MAX_YEAR_LENGTH)) {
    return 'Invalid record year';
  }
  if (!isOptionalString(r.search_title, MAX_SEARCH_TITLE_LENGTH)) {
    return 'Invalid record search_title';
  }
  if (!isOptionalNonNegativeNumber(r.total_episodes)) {
    return 'Invalid record total_episodes';
  }
  if (!isOptionalNonNegativeNumber(r.play_time)) {
    return 'Invalid record play_time';
  }
  if (!isOptionalNonNegativeNumber(r.total_time)) {
    return 'Invalid record total_time';
  }
  if (!isOptionalNonNegativeNumber(r.save_time)) {
    return 'Invalid record save_time';
  }
  return null;
}
