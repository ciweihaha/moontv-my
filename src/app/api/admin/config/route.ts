/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { AdminConfigResult } from '@/lib/admin.types';
import { requireAdmin } from '@/lib/adminAuth';

export const runtime = 'edge';

export async function GET(request: NextRequest) {
  // R3-A3: 统一鉴权（requireAdmin 含 localstorage 检查，返回 role）
  const { user, config, error } = await requireAdmin(request);
  if (error) return error;

  try {
    const result: AdminConfigResult = {
      Role: user!.role,
      Config: config!,
    };

    return NextResponse.json(result, {
      headers: {
        'Cache-Control': 'no-store', // 管理员配置不缓存
      },
    });
  } catch (error) {
    console.error('获取管理员配置失败:', error);
    return NextResponse.json(
      {
        error: '获取管理员配置失败',
        details: (error as Error).message,
      },
      { status: 500 }
    );
  }
}
