/* eslint-disable no-console,@typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server';

import { AdminConfig } from '@/lib/admin.types';
import {
  buildSessionSignData,
  generateSignature,
  getSessionSecret,
  isSessionSecretConfigError,
  shouldUseSecureCookie,
} from '@/lib/auth';
import { getConfig, invalidateConfigCache } from '@/lib/config';
import { db } from '@/lib/db';
import { ADMIN_CONFIG_LOCK_KEY, withLock } from '@/lib/mutex';
import {
  checkRateLimit,
  getClientIp,
} from '@/lib/rateLimit';
import { validateCredentials } from '@/lib/userValidation';

export const runtime = 'edge';

// SEC-R2: 注册限频配置（与登录同口径，防批量刷号）
// 深查第 20 轮：登录早有 10 次/分钟限频，注册却全无——开放注册时
// 每次注册都写 D1 用户表 + 全量 admin config 读改写，可被无限刷号
// 拖垮，并发注册还可能互相冲掉配置里的 Users 写入。
const REGISTER_RATE_LIMIT = 10; // 每窗口最大尝试次数
const REGISTER_RATE_WINDOW_MS = 60_000; // 1 分钟窗口

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
    // SEC-R2: 注册限频，防批量刷号（429）
    const clientIp = getClientIp(req);
    if (
      !checkRateLimit(
        `register:${clientIp}`,
        REGISTER_RATE_LIMIT,
        REGISTER_RATE_WINDOW_MS
      )
    ) {
      return NextResponse.json(
        { error: '尝试过于频繁，请稍后再试' },
        { status: 429 }
      );
    }

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
    // L2: 与"用户已存在"返回同一通用文案，防用户名枚举
    if (username === process.env.USERNAME) {
      return NextResponse.json({ error: '注册失败' }, { status: 400 });
    }

    try {
      // M9: 整个 check-then-insert + 配置读-改-写在进程内锁下串行化，
      // 与管理端用户写操作互斥；锁内重新读取最新配置再合并，避免并发
      // 注册互相覆盖 Users。返回 true 表示用户名已存在（或并发撞唯一约束）。
      const duplicate = await withLock(
        ADMIN_CONFIG_LOCK_KEY,
        async (): Promise<boolean> => {
          // 检查用户是否已存在
          const exist = await db.checkUserExist(username);
          if (exist) return true;

          try {
            await db.registerUser(username, password);
          } catch (err) {
            // 并发同名注册撞唯一约束：返回 400 而非 500（不泄露已存在）
            if (
              err instanceof Error &&
              /UNIQUE constraint/i.test(err.message)
            ) {
              return true;
            }
            throw err;
          }

          // 锁内重新读取最新配置再合并（不用锁外 getConfig 的旧快照）
          let target: AdminConfig | null = null;
          try {
            target = await db.getAdminConfig();
          } catch {
            target = null;
          }
          const base = target ?? config;
          if (
            !base.UserConfig.Users.some((u) => u.username === username)
          ) {
            base.UserConfig.Users.push({
              username,
              role: 'user',
            });
          }
          await db.saveAdminConfig(base);
          // M6: 写配置后主动失效 D1 配置缓存
          invalidateConfigCache();
          return false;
        }
      );
      if (duplicate) {
        return NextResponse.json({ error: '注册失败' }, { status: 400 });
      }

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
        // L14：按请求协议动态决定 secure（HTTP 自托管下 secure 会导致
        // Cookie 无法设置）
        secure: shouldUseSecureCookie(req),
      });

      return response;
    } catch (err) {
      console.error('数据库注册失败', err);
      return NextResponse.json({ error: '数据库错误' }, { status: 500 });
    }
  } catch (error) {
    console.error('注册接口异常', error);
    // H1: 生产未配 SESSION_SECRET 时返回明确的 503 配置错误而非裸 500
    if (isSessionSecretConfigError(error)) {
      return NextResponse.json(
        { error: '服务器未配置 SESSION_SECRET，请联系管理员' },
        { status: 503 }
      );
    }
    return NextResponse.json({ error: '服务器错误' }, { status: 500 });
  }
}
