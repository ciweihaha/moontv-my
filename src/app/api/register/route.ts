/* eslint-disable no-console,@typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server';

import { buildSessionSignData, generateSignature, getSessionSecret } from '@/lib/auth';
import { getConfig } from '@/lib/config';
import { db } from '@/lib/db';
import { validateCredentials } from '@/lib/userValidation';

export const runtime = 'edge';

// 读取存储类型环境变量，默认 localstorage
const STORAGE_TYPE =
  (process.env.NEXT_PUBLIC_STORAGE_TYPE as
    | 'localstorage'
    | 'redis'
    | 'd1'
    | 'upstash'
    | undefined) || 'localstorage';

// QUALITY-R3: generateSignature 已移至 @/lib/auth，避免与 login 路由重复定义

// 生成认证Cookie（带签名）
// AUDIT-R3 P0-B: 签名覆盖 username + role + timestamp 整体
async function generateAuthCookie(username: string): Promise<string> {
  const timestamp = Date.now();
  const authData: any = {
    role: 'user',
    username,
    timestamp,
  };

  // 使用会话密钥对规范化会话数据整体签名
  const signingKey = getSessionSecret();
  const signData = buildSessionSignData(username, 'user', timestamp);
  const signature = await generateSignature(signData, signingKey);
  authData.signature = signature;

  return encodeURIComponent(JSON.stringify(authData));
}

export async function POST(req: NextRequest) {
  try {
    // localstorage 模式下不支持注册
    if (STORAGE_TYPE === 'localstorage') {
      return NextResponse.json(
        { error: '当前模式不支持注册' },
        { status: 400 }
      );
    }

    const config = await getConfig();
    // 校验是否开放注册
    if (!config.UserConfig.AllowRegister) {
      return NextResponse.json({ error: '当前未开放注册' }, { status: 400 });
    }

    const { username, password } = await req.json();

    // repo-hardening 第 18 项：用户名/新密码走共享校验（userValidation.ts）；
    // 密码最小长度已统一为 8（原内联 SEC-R2 口径为 4）。
    const credentialError = validateCredentials(username, password);
    if (credentialError) {
      return NextResponse.json({ error: credentialError }, { status: 400 });
    }

    // 检查是否和管理员重复
    if (username === process.env.USERNAME) {
      return NextResponse.json({ error: '用户已存在' }, { status: 400 });
    }

    try {
      // 检查用户是否已存在
      const exist = await db.checkUserExist(username);
      if (exist) {
        return NextResponse.json({ error: '用户已存在' }, { status: 400 });
      }

      await db.registerUser(username, password);

      // 添加到配置中并保存
      config.UserConfig.Users.push({
        username,
        role: 'user',
      });
      await db.saveAdminConfig(config);

      // 注册成功，设置认证cookie
      const response = NextResponse.json({ ok: true });
      const cookieValue = await generateAuthCookie(username);
      const expires = new Date();
      expires.setDate(expires.getDate() + 7); // 7天过期

      response.cookies.set('auth', cookieValue, {
        path: '/',
        expires,
        sameSite: 'lax',
        // R9-S1: 与 login 路由保持一致，禁止 JS 读取、仅 HTTPS 传输
        httpOnly: true,
        secure: true,
      });

      return response;
    } catch (err) {
      console.error('数据库注册失败', err);
      return NextResponse.json({ error: '数据库错误' }, { status: 500 });
    }
  } catch (error) {
    console.error('注册接口异常', error);
    return NextResponse.json({ error: '服务器错误' }, { status: 500 });
  }
}
