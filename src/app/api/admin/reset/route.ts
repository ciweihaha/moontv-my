/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/adminAuth';
import { resetConfig } from '@/lib/config';

export const runtime = 'edge';

export async function GET(request: NextRequest) {
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
    return NextResponse.json(
      {
        error: '重置管理员配置失败',
        details: (error as Error).message,
      },
      { status: 500 }
    );
  }
}
