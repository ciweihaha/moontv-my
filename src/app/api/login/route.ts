/* eslint-disable no-console,@typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';
import { db } from '@/lib/db';
import { generateSignature } from '@/lib/auth';
import {
  checkRateLimit,
  constantTimeEqual,
  getClientIp,
} from '@/lib/rateLimit';

export const runtime = 'edge';

// SEC-R2: 登录限频配置（防暴力破解）
const LOGIN_RATE_LIMIT = 10; // 每窗口最大尝试次数
const LOGIN_RATE_WINDOW_MS = 60_000; // 1 分钟窗口

// 读取存储类型环境变量，默认 localstorage
const STORAGE_TYPE =
  (process.env.NEXT_PUBLIC_STORAGE_TYPE as
    | 'localstorage'
    | 'redis'
    | 'd1'
    | 'upstash'
    | undefined) || 'localstorage';

// QUALITY-R3: generateSignature 已移至 @/lib/auth，避免与 register 路由重复定义

// 生成认证Cookie（带签名）
// P1-3: 不再存储明文密码。localstorage 模式下对固定标识做 HMAC 签名，
// 中间件验签即可，无需在 Cookie 里放密码。
async function generateAuthCookie(
  username?: string,
  password?: string,
  role?: 'owner' | 'admin' | 'user',
  includePassword = false
): Promise<string> {
  const authData: any = { role: role || 'user' };

  // P1-3: includePassword 已废弃（不再存明文密码），保留参数以兼容调用方
  void includePassword;
  void password;

  if (username && process.env.PASSWORD) {
    authData.username = username;
    // 使用密码作为密钥对用户名进行签名
    const signature = await generateSignature(username, process.env.PASSWORD);
    authData.signature = signature;
    authData.timestamp = Date.now(); // 添加时间戳防重放攻击
  } else if (process.env.PASSWORD) {
    // P1-3: localstorage 模式：对固定标识签名，不存明文密码
    const signature = await generateSignature(
      'localstorage-auth',
      process.env.PASSWORD
    );
    authData.signature = signature;
    authData.timestamp = Date.now();
  }

  return encodeURIComponent(JSON.stringify(authData));
}

export async function POST(req: NextRequest) {
  try {
    // SEC-R2: 登录限频，防暴力破解（429）
    const clientIp = getClientIp(req);
    if (!checkRateLimit(`login:${clientIp}`, LOGIN_RATE_LIMIT, LOGIN_RATE_WINDOW_MS)) {
      return NextResponse.json(
        { error: '尝试过于频繁，请稍后再试' },
        { status: 429 }
      );
    }

    // 本地 / localStorage 模式——仅校验固定密码
    if (STORAGE_TYPE === 'localstorage') {
      const envPassword = process.env.PASSWORD;

      // 未配置 PASSWORD 时返回 503（服务器配置错误，不直接放行）
      if (!envPassword) {
        return NextResponse.json(
          { error: '服务器未配置认证密码' },
          { status: 503 }
        );
      }

      const { password } = await req.json();
      if (typeof password !== 'string') {
        return NextResponse.json({ error: '密码不能为空' }, { status: 400 });
      }

      // SEC-R2: 常量时间比较，防时序攻击
      if (!constantTimeEqual(password, envPassword)) {
        return NextResponse.json(
          { ok: false, error: '密码错误' },
          { status: 401 }
        );
      }

      // 验证成功，设置认证cookie
      const response = NextResponse.json({ ok: true });
      const cookieValue = await generateAuthCookie(
        undefined,
        password,
        'user',
        true
      ); // localstorage 模式包含 password
      const expires = new Date();
      expires.setDate(expires.getDate() + 7); // 7天过期

      response.cookies.set('auth', cookieValue, {
        path: '/',
        expires,
        sameSite: 'lax', // 改为 lax 以支持 PWA
        httpOnly: true, // 安全加固：禁止 JS 读取
        secure: true, // 安全加固：仅 HTTPS 传输
      });

      return response;
    }

    // 数据库 / redis 模式——校验用户名并尝试连接数据库
    const { username, password } = await req.json();

    if (!username || typeof username !== 'string') {
      return NextResponse.json({ error: '用户名不能为空' }, { status: 400 });
    }
    if (!password || typeof password !== 'string') {
      return NextResponse.json({ error: '密码不能为空' }, { status: 400 });
    }

    // 可能是站长，直接读环境变量
    if (
      username === process.env.USERNAME &&
      password === process.env.PASSWORD
    ) {
      // 验证成功，设置认证cookie
      const response = NextResponse.json({ ok: true });
      const cookieValue = await generateAuthCookie(
        username,
        password,
        'owner',
        false
      ); // 数据库模式不包含 password
      const expires = new Date();
      expires.setDate(expires.getDate() + 7); // 7天过期

      response.cookies.set('auth', cookieValue, {
        path: '/',
        expires,
        sameSite: 'lax', // 改为 lax 以支持 PWA
        httpOnly: true, // 安全加固：禁止 JS 读取
        secure: true, // 安全加固：仅 HTTPS 传输
      });

      return response;
    } else if (username === process.env.USERNAME) {
      return NextResponse.json({ error: '用户名或密码错误' }, { status: 401 });
    }

    const config = await getConfig();
    const user = config.UserConfig.Users.find((u) => u.username === username);
    if (user && user.banned) {
      return NextResponse.json({ error: '用户被封禁' }, { status: 401 });
    }

    // 校验用户密码
    try {
      const pass = await db.verifyUser(username, password);
      if (!pass) {
        return NextResponse.json(
          { error: '用户名或密码错误' },
          { status: 401 }
        );
      }

      // 验证成功，设置认证cookie
      const response = NextResponse.json({ ok: true });
      const cookieValue = await generateAuthCookie(
        username,
        password,
        user?.role || 'user',
        false
      ); // 数据库模式不包含 password
      const expires = new Date();
      expires.setDate(expires.getDate() + 7); // 7天过期

      response.cookies.set('auth', cookieValue, {
        path: '/',
        expires,
        sameSite: 'lax', // 改为 lax 以支持 PWA
        httpOnly: true, // 安全加固：禁止 JS 读取
        secure: true, // 安全加固：仅 HTTPS 传输
      });

      return response;
    } catch (err) {
      console.error('数据库验证失败', err);
      return NextResponse.json({ error: '数据库错误' }, { status: 500 });
    }
  } catch (error) {
    console.error('登录接口异常', error);
    return NextResponse.json({ error: '服务器错误' }, { status: 500 });
  }
}
