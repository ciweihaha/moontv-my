/* eslint-disable no-console*/

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getStorage } from '@/lib/db';
import { IStorage } from '@/lib/types';
import { validateNewPassword } from '@/lib/userValidation';

export const runtime = 'edge';

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
    const { newPassword } = body;

    // 获取认证信息
    const authInfo = getAuthInfoFromCookie(request);
    if (!authInfo || !authInfo.username) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 验证新密码：repo-hardening 第 18 项，走共享校验（最小长度统一 8，
    // 原内联 SEC-R2 口径为 4）；空值也由共享校验给出错误信息
    const newPasswordError = validateNewPassword(newPassword);
    if (newPasswordError) {
      return NextResponse.json({ error: newPasswordError }, { status: 400 });
    }

    const username = authInfo.username;

    // 不允许站长修改密码（站长用户名等于 process.env.USERNAME）
    if (username === process.env.USERNAME) {
      return NextResponse.json(
        { error: '站长不能通过此接口修改密码' },
        { status: 403 }
      );
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
