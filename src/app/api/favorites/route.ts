/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { db } from '@/lib/db';
import { Favorite } from '@/lib/types';

export const runtime = 'edge';

/**
 * GET /api/favorites
 *
 * 支持两种调用方式：
 * 1. 不带 query，返回全部收藏列表（Record<string, Favorite>）。
 * 2. 带 key=source+id，返回单条收藏（Favorite | null）。
 */
export async function GET(request: NextRequest) {
  try {
    // 从 cookie 获取用户信息
    const authInfo = getAuthInfoFromCookie(request);
    if (!authInfo || !authInfo.username) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const key = searchParams.get('key');

    // 查询单条收藏
    if (key) {
      const [source, id] = key.split('+');
      if (!source || !id) {
        return NextResponse.json(
          { error: 'Invalid key format' },
          { status: 400 }
        );
      }
      const fav = await db.getFavorite(authInfo.username, source, id);
      return NextResponse.json(fav, { status: 200 });
    }

    // 查询全部收藏
    const favorites = await db.getAllFavorites(authInfo.username);
    return NextResponse.json(favorites, { status: 200 });
  } catch (err) {
    console.error('获取收藏失败', err);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/favorites
 * body: { key: string; favorite: Favorite }
 */
export async function POST(request: NextRequest) {
  try {
    // 从 cookie 获取用户信息
    const authInfo = getAuthInfoFromCookie(request);
    if (!authInfo || !authInfo.username) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { key, favorite }: { key: string; favorite: Favorite } = body;

    if (!key || !favorite) {
      return NextResponse.json(
        { error: 'Missing key or favorite' },
        { status: 400 }
      );
    }

    // 验证必要字段
    if (!favorite.title || !favorite.source_name) {
      return NextResponse.json(
        { error: 'Invalid favorite data' },
        { status: 400 }
      );
    }

    const [source, id] = key.split('+');
    if (!source || !id) {
      return NextResponse.json(
        { error: 'Invalid key format' },
        { status: 400 }
      );
    }

    const finalFavorite = {
      ...favorite,
      save_time: favorite.save_time ?? Date.now(),
    } as Favorite;

    await db.saveFavorite(authInfo.username, source, id, finalFavorite);

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (err) {
    console.error('保存收藏失败', err);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/favorites
 *
 * 1. 不带 query -> 清空全部收藏
 * 2. 带 key=source+id -> 删除单条收藏
 */
export async function DELETE(request: NextRequest) {
  try {
    // 从 cookie 获取用户信息
    const authInfo = getAuthInfoFromCookie(request);
    if (!authInfo || !authInfo.username) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const username = authInfo.username;
    const { searchParams } = new URL(request.url);
    const key = searchParams.get('key');

    if (key) {
      // 删除单条
      const [source, id] = key.split('+');
      if (!source || !id) {
        return NextResponse.json(
          { error: 'Invalid key format' },
          { status: 400 }
        );
      }
      await db.deleteFavorite(username, source, id);
    } else {
      // 清空全部：分批删除（每批 5 并发，与 cron 播放记录批处理同口径），
      // 避免收藏量大时 N 个 D1 写操作同时扇出；单条失败不中断整批，
      // 用 allSettled 汇总已删/失败数——旧实现 Promise.all 遇任一失败
      // 即整单 500，局部已删的成功被掩盖、客户端误以为全未删除。
      // 深查第 18 轮。
      const all = await db.getAllFavorites(username);
      const keys = Object.keys(all);
      let deleted = 0;
      let failed = 0;
      const CONCURRENCY = 5;
      for (let i = 0; i < keys.length; i += CONCURRENCY) {
        const batch = keys.slice(i, i + CONCURRENCY);
        const settled = await Promise.allSettled(
          batch.map(async (k) => {
            const [s, i] = k.split('+');
            if (!s || !i) return false; // 无效键不删除、不计数
            await db.deleteFavorite(username, s, i);
            return true;
          })
        );
        for (const r of settled) {
          if (r.status === 'fulfilled' && r.value) deleted += 1;
          else if (r.status === 'rejected') failed += 1;
        }
      }
      return NextResponse.json(
        { success: true, deleted, failed },
        { status: 200 }
      );
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (err) {
    console.error('删除收藏失败', err);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}
