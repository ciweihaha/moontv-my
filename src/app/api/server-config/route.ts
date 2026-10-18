/* eslint-disable no-console */

import { NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';

export const runtime = 'edge';

export async function GET() {
  try {
    // QUALITY-R6: 移除每次请求打印 URL 的噪音日志（生产日志污染，且 URL 可能含敏感参数）
    const config = await getConfig();
    const result = {
      SiteName: config.SiteConfig.SiteName,
      StorageType: process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage',
    };
    return NextResponse.json(result);
  } catch (error) {
    // S1: 加 try-catch，避免配置读取异常导致无结构 500
    console.error('[server-config] 获取配置失败:', error);
    return NextResponse.json({ error: '获取服务配置失败' }, { status: 500 });
  }
}
