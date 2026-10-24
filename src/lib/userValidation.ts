/**
 * 用户名 / 新密码共享校验（repo-hardening 第 18 项）。
 *
 * 此前口径散落三处且不一致：注册有用户名正则＋密码长度内联校验，
 * admin/user 的 add/changePassword 只查密码存在（1 字符也放行），
 * 自助改密另有一份内联长度校验。现在统一到这里，调用方：
 * - POST /api/register（公开注册）
 * - POST /api/admin/user 的 add / changePassword（管理员新增/改密）
 * - POST /api/change-password（自助改密）
 *
 * 密码最小长度为 8（2026-10-24 用户定，统一提高）。此门槛只作用于
 * 「设置新密码」的校验；登录/校验存量密码时不做长度拦截，避免把
 * 旧规则下注册的短密码账户锁死（存量密码的哈希升级见 passwordHash.ts）。
 */

/** 用户名：2-20 位，字母/数字/下划线/中文（与注册原 SEC-R2 口径一致） */
export const USERNAME_PATTERN = /^[a-zA-Z0-9_\u4e00-\u9fa5]{2,20}$/;

/** 新密码最小长度（仅新密码校验，登录不拦截存量） */
export const MIN_PASSWORD_LENGTH = 8;

/** 校验用户名；通过返回 null，否则返回错误信息 */
export function validateUsername(username: unknown): string | null {
  if (!username || typeof username !== 'string') {
    return '用户名不能为空';
  }
  if (!USERNAME_PATTERN.test(username)) {
    return '用户名格式不正确（2-20位，仅限字母、数字、下划线、中文）';
  }
  return null;
}

/** 校验新密码；通过返回 null，否则返回错误信息 */
export function validateNewPassword(password: unknown): string | null {
  if (!password || typeof password !== 'string') {
    return '密码不能为空';
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `密码长度至少 ${MIN_PASSWORD_LENGTH} 位`;
  }
  return null;
}

/** 注册口径的组合校验：先用户名、后密码 */
export function validateCredentials(
  username: unknown,
  password: unknown
): string | null {
  return validateUsername(username) ?? validateNewPassword(password);
}
