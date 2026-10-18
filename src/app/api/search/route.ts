import { NextResponse } from 'next/server';

import { getCacheTime, getConfig } from '@/lib/config';
import { searchFromApi } from '@/lib/downstream';
import { jsonWithCache } from '@/lib/http';
import { yellowRegex } from '@/lib/yellow';

export const runtime = 'edge';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');

  // SEC-R2: 关键词长度上限，防超长输入耗尽上游/内存
  const MAX_QUERY_LENGTH = 100;
  if (query && query.length > MAX_QUERY_LENGTH) {
    return NextResponse.json({ error: '搜索关键词过长' }, { status: 400 });
  }

  if (!query) {
    const cacheTime = await getCacheTime();
    // QUALITY-R3: 缓存头拼写收敛到 jsonWithCache
    return jsonWithCache({ results: [] }, cacheTime);
  }

  const config = await getConfig();
  const apiSites = config.SourceConfig.filter((site) => !site.disabled);

  // R1: 按上游 api 地址去重，相同地址只请求一次（9 组重复地址 → 44 个唯一地址）
  const sitesByApi = new Map<string, typeof apiSites>();
  for (const site of apiSites) {
    // R1: 跳过 api 为空/undefined 的站点，防止被错误合并到同一组
    if (!site.api) continue;
    const group = sitesByApi.get(site.api);
    if (group) {
      group.push(site);
    } else {
      sitesByApi.set(site.api, [site]);
    }
  }
  const searchPromises = Array.from(sitesByApi.values()).map(
    async (sites: typeof apiSites) => {
      // 用组内第一个站点作为代表发起请求（PERF-R1: 页数一次传入，避免重复读配置）
      const results = await searchFromApi(
        sites[0],
        query,
        config.SiteConfig.SearchDownstreamMaxPage
      );
      // 结果展开回组内每个站点，保留各自的 source key 和 source_name
      return sites.flatMap((site: (typeof apiSites)[number]) =>
        results.map((r) => ({ ...r, source: site.key, source_name: site.name }))
      );
    }
  );

  try {
    // P2-5: 总超时 10s，超时后返回已完成部分，不再等最慢上游
    const TOTAL_TIMEOUT_MS = 10000;
    type SearchResult = Awaited<typeof searchPromises[number]>;
    const searchAll: Promise<SearchResult> = Promise.allSettled(searchPromises).then((settled) =>
      settled
        .filter((s): s is PromiseFulfilledResult<SearchResult> => s.status === 'fulfilled')
        .flatMap((s) => s.value)
    );
    const timeout: Promise<SearchResult> = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('搜索总超时')), TOTAL_TIMEOUT_MS)
    );
    const results = await Promise.race([searchAll, timeout]).catch((): SearchResult => {
      // 超时：返回空（上游各自有 8s 单超时，此处为兜底）
      return [];
    });
    let flattenedResults = results.flat();
    if (!config.SiteConfig.DisableYellowFilter) {
      flattenedResults = flattenedResults.filter((result) => {
        // 与详情接口对齐：同时检查 title + type_name，并转小写做大小写归一化
        // PERF-R1: 预编译正则一次匹配，替代逐词 includes
        const checkText = (
          (result.title || '') + (result.type_name || '')
        ).toLowerCase();
        return !yellowRegex.test(checkText);
      });
    }
    const cacheTime = await getCacheTime();

    // QUALITY-R3: 缓存头拼写收敛到 jsonWithCache
    return jsonWithCache({ results: flattenedResults }, cacheTime);
  } catch (error) {
    return NextResponse.json({ error: '搜索失败' }, { status: 500 });
  }
}
