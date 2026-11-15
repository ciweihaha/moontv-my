import { NextResponse } from 'next/server';

import {
  isSessionSecretConfigError,
  parseAuthCookieValue,
  verifyAuthSession,
} from '@/lib/auth';

export const runtime = 'edge';

/**
 * AUDIT-R2 P0: 客户端会话状态接口。
 * Cookie 为 HttpOnly，JS 无法读取；客户端展示用的用户名/角色走此接口，
 * 服务端验证 HttpOnly Cookie（签名 + 时间戳时效）后返回。
 * 仅用于展示与缓存分区，不做鉴权决策。
 */
export async function GET(request: Request) {
  const cookieHeader = request.headers.get('cookie') || '';
  const match = cookieHeader.match(/(?:^|;\s*)auth=([^;]*)/);
  const authInfo = parseAuthCookieValue(match?.[1]);

  // H1: 生产未配 SESSION_SECRET 时 verifyAuthSession 抛错，返回明确的
  // 503 配置错误而非裸 500
  let session = null;
  try {
    session = await verifyAuthSession(authInfo);
  } catch (err) {
    if (isSessionSecretConfigError(err)) {
      return NextResponse.json(
        { error: '服务器未配置 SESSION_SECRET，请联系管理员' },
        { status: 503 }
      );
    }
    throw err;
  }
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return NextResponse.json({
    username: session.username,
    role: session.role,
  });
}
