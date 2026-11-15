/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import {
  getAuthInfoFromCookie,
  isSessionSecretConfigError,
  verifyAuthSession,
} from '@/lib/auth';

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 跳过不需要认证的路径
  if (shouldSkipAuth(pathname)) {
    return NextResponse.next();
  }

  if (!process.env.PASSWORD && !process.env.SESSION_SECRET) {
    // 如果没有设置密码，重定向到警告页面
    const warningUrl = new URL('/warning', request.url);
    return NextResponse.redirect(warningUrl);
  }

  // 从cookie获取认证信息
  const authInfo = getAuthInfoFromCookie(request);

  // AUDIT-R2 P0: 统一走 verifyAuthSession（HMAC 签名 + 时间戳时效）
  // localstorage 模式验 'localstorage-auth' 固定标识签名，其他模式验用户名签名
  // H1: verifyAuthSession 在生产未配 SESSION_SECRET 时抛错——此前无
  // try-catch，抛错冒泡成裸 500，全站不可用且原因不明。现在返回明确的
  // 503 配置错误（fail-closed，仍不放行未认证请求）。
  let session = null;
  try {
    session = await verifyAuthSession(authInfo);
  } catch (err) {
    console.error('[middleware] 会话验证失败:', err);
    if (isSessionSecretConfigError(err)) {
      return configErrorResponse(pathname);
    }
    return handleAuthFailure(request, pathname);
  }
  if (!session) {
    return handleAuthFailure(request, pathname);
  }

  return NextResponse.next();
}

// H1: 会话密钥缺配时的明确 503 配置错误（API 回 JSON，页面回错误页）
function configErrorResponse(pathname: string): NextResponse {
  const message =
    '服务器未配置 SESSION_SECRET，会话功能不可用，请联系管理员配置后重试';
  if (pathname.startsWith('/api')) {
    return NextResponse.json({ error: message }, { status: 503 });
  }
  return new NextResponse(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>服务配置错误</title></head>` +
      `<body><h1>服务配置错误</h1><p>${message}</p></body></html>`,
    {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }
  );
}

// 处理认证失败的情况
function handleAuthFailure(
  request: NextRequest,
  pathname: string
): NextResponse {
  // 如果是 API 路由，返回 401 状态码
  if (pathname.startsWith('/api')) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  // 否则重定向到登录页面
  const loginUrl = new URL('/login', request.url);
  // 保留完整的URL，包括查询参数
  const fullUrl = `${pathname}${request.nextUrl.search}`;
  loginUrl.searchParams.set('redirect', fullUrl);
  return NextResponse.redirect(loginUrl);
}

// 判断是否需要跳过认证的路径
function shouldSkipAuth(pathname: string): boolean {
  const skipPaths = [
    '/_next',
    '/favicon.ico',
    '/robots.txt',
    '/manifest.json',
    '/icons/',
    '/logo.png',
    '/screenshot.png',
    // M7: 健康检查供外部监控不鉴权调用（只暴露组件状态，无敏感信息）
    '/api/health',
  ];

  return skipPaths.some((path) => pathname.startsWith(path));
}

// 配置middleware匹配规则
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|login|warning|api/login|api/register|api/logout|api/cron|api/server-config|api/health).*)',
  ],
};
