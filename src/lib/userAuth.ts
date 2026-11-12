import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie, verifyAuthSession } from '@/lib/auth';

/**
 * M1: 用户数据路由统一鉴权助手。
 *
 * 收敛 favorites / playrecords / searchhistory / skipconfigs /
 * change-password 等用户路由重复的认证样板，并补上缺失的纵深防御：
 * 此前这些路由只用 getAuthInfoFromCookie 取 username 就读写该用户的
 * 数据，完全依赖 middleware 做签名验证——绕过 middleware 的路径下，
 * 构造一个写着他人用户名的无签名 Cookie 即可冒充（admin 路由已在
 * repo-hardening 第 19 项修复，用户路由仍是单点防御）。
 *
 * 现在与 requireAdmin 同口径：自验会话签名＋时效，并校验
 * session.username === authInfo.username；验签异常（如生产未配
 * SESSION_SECRET 时 getSessionSecret 抛错）按未登录处理，fail-closed。
 *
 * 用法：
 *   const auth = await requireUser(request);
 *   if (auth.error) return auth.error;
 *   const username = auth.username; // 已验签的用户名
 */

export type RequireUserResult =
  { username: string; error: null } | { username: null; error: NextResponse };

export async function requireUser(
  request: NextRequest,
): Promise<RequireUserResult> {
  const fail = (message: string, status: number): RequireUserResult => ({
    username: null,
    error: NextResponse.json({ error: message }, { status }),
  });

  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo || !authInfo.username) {
    return fail('Unauthorized', 401);
  }

  let session = null;
  try {
    session = await verifyAuthSession(authInfo);
  } catch {
    session = null;
  }
  if (!session || session.username !== authInfo.username) {
    return fail('Unauthorized', 401);
  }

  return { username: authInfo.username, error: null };
}
