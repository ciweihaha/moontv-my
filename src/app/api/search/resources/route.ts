import { NextResponse } from 'next/server';

import { getAvailableApiSites, getCacheTime } from '@/lib/config';
import { jsonWithCache } from '@/lib/http';

export const runtime = 'edge';

// OrionTV 兼容接口
export async function GET() {
  try {
    const apiSites = await getAvailableApiSites();
    const cacheTime = await getCacheTime();

    // QUALITY-R3: 缓存头拼写收敛到 jsonWithCache
    return jsonWithCache(apiSites, cacheTime);
  } catch (error) {
    return NextResponse.json({ error: '获取资源失败' }, { status: 500 });
  }
}
