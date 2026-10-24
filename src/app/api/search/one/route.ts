import { NextResponse } from 'next/server';

import { getCacheTime, getConfig } from '@/lib/config';
import { jsonWithCache } from '@/lib/http';
import { fetchSearchOneResults } from '@/lib/searchOne';
import { containsYellow } from '@/lib/yellow';

export const runtime = 'edge';

// OrionTV 兼容接口
export async function GET(request: Request) {
  const clientSignal = request.signal;
  let onClientAbort: (() => void) | undefined;
  const clientAbortPromise = new Promise<never>((_, reject) => {
    onClientAbort = () => reject(new Error('client disconnected'));
    if (clientSignal?.aborted) reject(new Error('client disconnected'));
    else if (typeof clientSignal?.addEventListener === 'function') {
      clientSignal.addEventListener('abort', onClientAbort, { once: true });
    }
  });
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
    // M-04: 经保护层调用（熔断/总超时+AbortSignal/单源缓存/single-flight，
    // 与主搜索同一口径，见 src/lib/searchOne.ts）；上游失败/超时/熔断时
    // 返回空结果，走下方「未找到结果」404 出口，与原行为兼容
    const { results, cacheStatus } = await Promise.race([fetchSearchOneResults(
      targetSite,
      query,
      config.SiteConfig.SearchDownstreamMaxPage
    ), clientAbortPromise, ]);
    let result = results.filter((r) => r.title === query);
    if (!config.SiteConfig.DisableYellowFilter) {
      result = result.filter((result) => {
        // 与搜索/详情接口对齐：同时检查 title + type_name；containsYellow 内部做
        // 小写归一化、去空白与词网（含语境正则）匹配
        const checkText = (result.title || '') + (result.type_name || '');
        return !containsYellow(checkText);
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
      // M-04: 标注保护层缓存状态（HIT/HIT-SHARED/MISS/SKIPPED），与主搜索对齐
      return jsonWithCache({ results: result }, cacheTime, 200, {
        'X-Search-Cache': cacheStatus,
      });
    }
  } catch {
    return NextResponse.json(
      {
        error: '搜索失败',
        result: null,
      },
      { status: 500 }
    );
  }
} finally {
  if (onClientAbort && typeof clientSignal?.removeEventListener === 'function') {
    clientSignal.removeEventListener('abort', onClientAbort);
  }
}
}
