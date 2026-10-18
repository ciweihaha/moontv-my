/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getSearchKV } from '@/lib/kv';

export const runtime = 'edge';

/**
 * O5: 管理员一键清 KV 缓存。
 * DELETE /api/admin/cache?prefix=v1:search  （不传 prefix 则清空全部 v1: 缓存）
 * 需管理员鉴权。
 */
export async function DELETE(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo || !authInfo.username) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const kv = getSearchKV();
  if (!kv) {
    return NextResponse.json(
      { error: 'KV 未绑定，无需清理' },
      { status: 400 }
    );
  }

  try {
    const { searchParams } = new URL(request.url);
    const prefix = searchParams.get('prefix') || 'v1:';

    // 安全：只允许 v1: 开头的前缀，防止误删
    if (!prefix.startsWith('v1:')) {
      return NextResponse.json(
        { error: 'prefix 必须以 v1: 开头' },
        { status: 400 }
      );
    }

    let deleted = 0;
    let cursor: string | undefined;
    do {
      const list = await kv.list({ prefix, cursor });
      for (const key of list.keys) {
        await kv.delete(key.name);
        deleted++;
        // 单次最多删 1000，防止超时
        if (deleted >= 1000) break;
      }
      cursor = list.list_complete ? undefined : list.cursor;
      if (deleted >= 1000) break;
    } while (cursor);

    console.log(`[admin/cache] 用户 ${authInfo.username} 清理缓存 prefix=${prefix}，删除 ${deleted} 条`);
    return NextResponse.json({ ok: true, deleted, prefix });
  } catch (error) {
    console.error('[admin/cache] 清理失败:', error);
    return NextResponse.json({ error: '清理缓存失败' }, { status: 500 });
  }
}
