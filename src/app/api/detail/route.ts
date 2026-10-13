import { NextResponse } from 'next/server';

import { getAvailableApiSites, getCacheTime } from '@/lib/config';
import { getDetailFromApi } from '@/lib/downstream';
import { jsonWithCache } from '@/lib/http';
import { yellowRegex } from '@/lib/yellow';

export const runtime = 'edge';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  const sourceCode = searchParams.get('source');

  if (!id || !sourceCode) {
    return NextResponse.json({ error: '缺少必要参数' }, { status: 400 });
  }

  if (!/^[\w-]+$/.test(id)) {
    return NextResponse.json({ error: '无效的视频ID格式' }, { status: 400 });
  }

  try {
    const apiSites = await getAvailableApiSites();
    const apiSite = apiSites.find((site) => site.key === sourceCode);

    if (!apiSite) {
      return NextResponse.json({ error: '无效的API来源' }, { status: 400 });
    }

    const result = await getDetailFromApi(apiSite, id);

    // 黄色词过滤（与搜索接口对齐，防止绕过）；转小写做大小写归一化
    // PERF-R1: 预编译正则一次匹配，替代逐词 includes
    const checkText = ((result.title || '') + (result.type_name || '')).toLowerCase();
    if (yellowRegex.test(checkText)) {
      return NextResponse.json({ error: '内容不可用' }, { status: 451 });
    }

    const cacheTime = await getCacheTime();

    // QUALITY-R3: 缓存头拼写收敛到 jsonWithCache
    return jsonWithCache(result, cacheTime);
  } catch (error) {
    // 不泄露上游错误原文，记录到服务端日志
    console.error('详情获取失败:', error);
    return NextResponse.json(
      { error: '详情获取失败' },
      { status: 500 }
    );
  }
}
