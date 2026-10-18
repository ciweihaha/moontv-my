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
      sameSite: 'lax', // 改为 lax 以支持 PWA
      httpOnly: false, // PWA 需要客户端可访问
      secure: false, // 根据协议自动设置
    });

    return response;
  } catch (error) {
    // S2: 加 try-catch，避免 cookie 操作异常导致无结构 500
    console.error('[logout] 登出失败:', error);
    return NextResponse.json({ error: '登出失败' }, { status: 500 });
  }
}
