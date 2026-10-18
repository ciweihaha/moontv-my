/* eslint-disable no-console */

import { NextResponse } from 'next/server';

export const runtime = 'edge';

export async function POST() {
  try {
    const response = NextResponse.json({ ok: true });

    // 清除认证cookie
    response.cookies.set('auth', '', {
      path: '/',
      expires: new Date(0),
      sameSite: 'lax',
      // R10-S1: 与 login 保持一致，确保 Cookie 正确清除
      httpOnly: true,
      secure: true,
    });

    return response;
  } catch (error) {
    // S2: 加 try-catch，避免 cookie 操作异常导致无结构 500
    console.error('[logout] 登出失败:', error);
    return NextResponse.json({ error: '登出失败' }, { status: 500 });
  }
}
