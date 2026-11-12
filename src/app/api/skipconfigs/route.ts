/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { db } from '@/lib/db';
import { SkipConfig } from '@/lib/types';
import { requireUser } from '@/lib/userAuth';

export const runtime = 'edge';

export async function GET(request: NextRequest) {
  try {
    // M1: 统一走 requireUser 自验会话签名，不再只信任 Cookie 里的用户名
    const auth = await requireUser(request);
    if (auth.error) return auth.error;
    const username = auth.username;

    const { searchParams } = new URL(request.url);
    const source = searchParams.get('source');
    const id = searchParams.get('id');

    if (source && id) {
      // 获取单个配置
      const config = await db.getSkipConfig(username, source, id);
      return NextResponse.json(config);
    } else {
      // 获取所有配置
      const configs = await db.getAllSkipConfigs(username);
      return NextResponse.json(configs);
    }
  } catch (error) {
    console.error('获取跳过片头片尾配置失败:', error);
    return NextResponse.json(
      { error: '获取跳过片头片尾配置失败' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    // M1: 统一走 requireUser 自验会话签名，不再只信任 Cookie 里的用户名
    const auth = await requireUser(request);
    if (auth.error) return auth.error;
    const username = auth.username;

    const body = await request.json();
    const { key, config } = body;

    if (!key || !config) {
      return NextResponse.json({ error: '缺少必要参数' }, { status: 400 });
    }

    // 解析key为source和id
    const [source, id] = key.split('+');
    if (!source || !id) {
      return NextResponse.json({ error: '无效的key格式' }, { status: 400 });
    }

    // 验证配置格式
    const skipConfig: SkipConfig = {
      enable: Boolean(config.enable),
      intro_time: Number(config.intro_time) || 0,
      outro_time: Number(config.outro_time) || 0,
    };

    await db.setSkipConfig(username, source, id, skipConfig);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('保存跳过片头片尾配置失败:', error);
    return NextResponse.json(
      { error: '保存跳过片头片尾配置失败' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    // M1: 统一走 requireUser 自验会话签名，不再只信任 Cookie 里的用户名
    const auth = await requireUser(request);
    if (auth.error) return auth.error;
    const username = auth.username;

    const { searchParams } = new URL(request.url);
    const key = searchParams.get('key');

    if (!key) {
      return NextResponse.json({ error: '缺少必要参数' }, { status: 400 });
    }

    // 解析key为source和id
    const [source, id] = key.split('+');
    if (!source || !id) {
      return NextResponse.json({ error: '无效的key格式' }, { status: 400 });
    }

    await db.deleteSkipConfig(username, source, id);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('删除跳过片头片尾配置失败:', error);
    return NextResponse.json(
      { error: '删除跳过片头片尾配置失败' },
      { status: 500 }
    );
  }
}
