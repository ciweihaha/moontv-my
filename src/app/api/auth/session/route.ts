import { NextResponse } from 'next/server';

import { parseAuthCookieValue, verifyAuthSession } from '@/lib/auth';

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

  const session = await verifyAuthSession(authInfo);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return NextResponse.json({
    username: session.username,
    role: session.role,
  });
}
