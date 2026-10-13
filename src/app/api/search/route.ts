import { NextResponse } from 'next/server';

import { getCacheTime, getConfig } from '@/lib/config';
import { searchFromApi } from '@/lib/downstream';
import { yellowWords } from '@/lib/yellow';

export const runtime = 'edge';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');

  if (!query) {
    const cacheTime = await getCacheTime();
    return NextResponse.json(
      { results: [] },
      {
        headers: {
          'Cache-Control': `public, max-age=${cacheTime}, s-maxage=${cacheTime}`,
          'CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
          'Vercel-CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
        },
      }
    );
  }

  const config = await getConfig();
  const apiSites = config.SourceConfig.filter((site) => !site.disabled);

  // R1: 按上游 api 地址去重，相同地址只请求一次（9 组重复地址 → 44 个唯一地址）
  const sitesByApi = new Map<string, typeof apiSites>();
  for (const site of apiSites) {
    const group = sitesByApi.get(site.api);
    if (group) {
      group.push(site);
    } else {
      sitesByApi.set(site.api, [site]);
    }
  }
  const searchPromises = Array.from(sitesByApi.values()).map(
    async (sites: typeof apiSites) => {
      // 用组内第一个站点作为代表发起请求
      const results = await searchFromApi(sites[0], query);
      // 结果展开回组内每个站点，保留各自的 source key 和 source_name
      return sites.flatMap((site: (typeof apiSites)[number]) =>
        results.map((r) => ({ ...r, source: site.key, source_name: site.name }))
      );
    }
  );

  try {
    const results = await Promise.all(searchPromises);
    let flattenedResults = results.flat();
    if (!config.SiteConfig.DisableYellowFilter) {
      flattenedResults = flattenedResults.filter((result) => {
        const typeName = result.type_name || '';
        return !yellowWords.some((word: string) => typeName.includes(word));
      });
    }
    const cacheTime = await getCacheTime();

    return NextResponse.json(
      { results: flattenedResults },
      {
        headers: {
          'Cache-Control': `public, max-age=${cacheTime}, s-maxage=${cacheTime}`,
          'CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
          'Vercel-CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
        },
      }
    );
  } catch (error) {
    return NextResponse.json({ error: '搜索失败' }, { status: 500 });
  }
}
