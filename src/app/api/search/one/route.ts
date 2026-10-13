import { NextResponse } from 'next/server';

import { getCacheTime, getConfig } from '@/lib/config';
import { searchFromApi } from '@/lib/downstream';
import { jsonWithCache } from '@/lib/http';
import { yellowRegex } from '@/lib/yellow';

export const runtime = 'edge';

// OrionTV 兼容接口
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');
  const resourceId = searchParams.get('resourceId');

  // SEC-R2: 关键词长度上限，防超长输入
  if (query && query.length > 100) {
    return NextResponse.json(
      { result: null, error: '搜索关键词过长' },
      { status: 400 }
    );
  }

  if (!query || !resourceId) {
    const cacheTime = await getCacheTime();
    // QUALITY-R3: 缓存头拼写收敛到 jsonWithCache
    return jsonWithCache(
      { result: null, error: '缺少必要参数: q 或 resourceId' },
      cacheTime
    );
  }

  const config = await getConfig();
  const apiSites = config.SourceConfig.filter((site) => !site.disabled);

  try {
    // 根据 resourceId 查找对应的 API 站点
    const targetSite = apiSites.find((site) => site.key === resourceId);
    if (!targetSite) {
      return NextResponse.json(
        {
          error: `未找到指定的视频源: ${resourceId}`,
          result: null,
        },
        { status: 404 }
      );
    }

    // PERF-R1: 最大搜索页数一次传入，避免 searchFromApi 内部重复读取配置
    const results = await searchFromApi(
      targetSite,
      query,
      config.SiteConfig.SearchDownstreamMaxPage
    );
    let result = results.filter((r) => r.title === query);
    if (!config.SiteConfig.DisableYellowFilter) {
      result = result.filter((result) => {
        // 与搜索/详情接口对齐：同时检查 title + type_name，转小写做大小写归一化
        // PERF-R1: 预编译正则一次匹配，替代逐词 includes
        const checkText = (
          (result.title || '') + (result.type_name || '')
        ).toLowerCase();
        return !yellowRegex.test(checkText);
      });
    }
    const cacheTime = await getCacheTime();

    if (result.length === 0) {
      return NextResponse.json(
        {
          error: '未找到结果',
          result: null,
        },
        { status: 404 }
      );
    } else {
      // QUALITY-R3: 缓存头拼写收敛到 jsonWithCache
      return jsonWithCache({ results: result }, cacheTime);
    }
  } catch (error) {
    return NextResponse.json(
      {
        error: '搜索失败',
        result: null,
      },
      { status: 500 }
    );
  }
}
