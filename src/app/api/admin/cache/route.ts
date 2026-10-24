/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/adminAuth';
import { getSearchKV } from '@/lib/kv';

export const runtime = 'edge';

/**
 * O5: 管理员一键清 KV 缓存。
 * DELETE /api/admin/cache?prefix=v1:search  （不传 prefix 则清空全部 v1: 缓存）
 * 需管理员鉴权。
 */
export async function DELETE(request: NextRequest) {
  const { user, error } = await requireAdmin(request, false);
  if (error) return error;

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
    let truncated = false;
    let cursor: string | undefined;
    outer: do {
      const list = await kv.list({ prefix, cursor });
      for (let i = 0; i < list.keys.length; i++) {
        await kv.delete(list.keys[i].name);
        deleted++;
        // 单次最多删 1000，防止超时
        if (deleted >= 1000) {
          // repo-hardening 第 11 项：如实反馈是否没清完——本页还有未删的
          // key、或后面还有分页时 truncated=true；恰好删满且已列完为 false。
          // 旧响应只有 {ok, deleted}，调用方无法区分这两种情况。
          truncated = i < list.keys.length - 1 || !list.list_complete;
          break outer;
        }
      }
      cursor = list.list_complete ? undefined : list.cursor;
    } while (cursor);

    console.log(`[admin/cache] 用户 ${user!.username} 清理缓存 prefix=${prefix}，删除 ${deleted} 条${truncated ? '（已达单次上限，未清完）' : ''}`);
    return NextResponse.json({ ok: true, deleted, prefix, truncated });
  } catch (error) {
    console.error('[admin/cache] 清理失败:', error);
    return NextResponse.json({ error: '清理缓存失败' }, { status: 500 });
  }
}
