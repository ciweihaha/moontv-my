/* eslint-disable no-console*/

import { NextRequest, NextResponse } from 'next/server';

import { db, getStorage } from '@/lib/db';
import { checkRateLimit, getClientIp } from '@/lib/rateLimit';
import { IStorage } from '@/lib/types';
import { requireUser } from '@/lib/userAuth';
import { validateNewPassword } from '@/lib/userValidation';

export const runtime = 'edge';

// M2: 改密限频（与登录同口径，防会话被盗后暴力改密），按 IP+用户
const CHANGE_PASSWORD_RATE_LIMIT = 5; // 每窗口最大尝试次数
const CHANGE_PASSWORD_RATE_WINDOW_MS = 60_000; // 1 分钟窗口

export async function POST(request: NextRequest) {
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';

  // 不支持 localstorage 模式
  if (storageType === 'localstorage') {
    return NextResponse.json(
      {
        error: '不支持本地存储模式修改密码',
      },
      { status: 400 }
    );
  }

  try {
    const body = await request.json();
    const { currentPassword, newPassword } = body;

    // M1: 统一走 requireUser 自验会话签名，不再只信任 Cookie 里的用户名
    const auth = await requireUser(request);
    if (auth.error) return auth.error;
    const username = auth.username;

    // M2: 改密限频（5 次/分钟/IP+用户）
    const clientIp = getClientIp(request);
    if (
      !checkRateLimit(
        `change-password:${clientIp}:${username}`,
        CHANGE_PASSWORD_RATE_LIMIT,
        CHANGE_PASSWORD_RATE_WINDOW_MS
      )
    ) {
      return NextResponse.json(
        { error: '尝试过于频繁，请稍后再试' },
        { status: 429 }
      );
    }

    // 验证新密码：repo-hardening 第 18 项，走共享校验（最小长度统一 8，
    // 原内联 SEC-R2 口径为 4）；空值也由共享校验给出错误信息
    const newPasswordError = validateNewPassword(newPassword);
    if (newPasswordError) {
      return NextResponse.json({ error: newPasswordError }, { status: 400 });
    }

    // 不允许站长修改密码（站长用户名等于 process.env.USERNAME）
    if (username === process.env.USERNAME) {
      return NextResponse.json(
        { error: '站长不能通过此接口修改密码' },
        { status: 403 }
      );
    }

    // M2: 要求提交当前密码并校验——仅凭有效会话即可改密时，会话一旦被盗
    // （XSS、共享设备未登出），攻击者可直接改密并永久锁定原用户
    if (typeof currentPassword !== 'string' || !currentPassword) {
      return NextResponse.json({ error: '当前密码不能为空' }, { status: 400 });
    }
    const currentOk = await db.verifyUser(username, currentPassword);
    if (!currentOk) {
      return NextResponse.json({ error: '当前密码错误' }, { status: 401 });
    }

    // 获取存储实例
    const storage: IStorage | null = getStorage();
    if (!storage || typeof storage.changePassword !== 'function') {
      return NextResponse.json(
        { error: '存储服务不支持修改密码' },
        { status: 500 }
      );
    }

    // 修改密码
    await storage.changePassword(username, newPassword);

    return NextResponse.json({ ok: true });
  } catch (error) {
    // SEC-R2: 不向客户端泄露内部错误原文
    console.error('修改密码失败:', error);
    return NextResponse.json(
      {
        error: '修改密码失败',
      },
      { status: 500 }
    );
  }
}
