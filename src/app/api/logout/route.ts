/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { shouldUseSecureCookie } from '@/lib/auth';

export const runtime = 'edge';

export async function POST(request: NextRequest) {
  try {
    const response = NextResponse.json({ ok: true });

    // 清除认证cookie
    response.cookies.set('auth', '', {
      path: '/',
      expires: new Date(0),
      sameSite: 'lax',
      // R10-S1: 与 login 保持一致，确保 Cookie 正确清除
      httpOnly: true,
      // L14: 清除时 secure 属性须与登录设置时一致，否则浏览器可能
      // 无法清除该 Cookie；与 login 同口径按请求协议动态决定
      secure: shouldUseSecureCookie(request),
    });

    return response;
  } catch (error) {
    // S2: 加 try-catch，避免 cookie 操作异常导致无结构 500
    console.error('[logout] 登出失败:', error);
    return NextResponse.json({ error: '登出失败' }, { status: 500 });
  }
}
