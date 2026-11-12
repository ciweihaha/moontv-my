/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/adminAuth';
import { resetConfig } from '@/lib/config';

export const runtime = 'edge';

// R7-S1: 破坏性操作改用 POST，防 CSRF/预加载误触发
export async function POST(request: NextRequest) {
  // R3-A3: 统一鉴权，owner-only（requireAdmin 含 localstorage 检查）
  const { user, error } = await requireAdmin(request);
  if (error) return error;
  if (user!.role !== 'owner') {
    return NextResponse.json({ error: '仅支持站长重置配置' }, { status: 403 });
  }

  try {
    await resetConfig();

    return NextResponse.json(
      { ok: true },
      {
        headers: {
          'Cache-Control': 'no-store', // 管理员配置不缓存
        },
      }
    );
  } catch (error) {
    // L3: 只记日志，不向客户端回显内部错误原文
    console.error('重置管理员配置失败:', error);
    return NextResponse.json({ error: '重置管理员配置失败' }, { status: 500 });
  }
}
