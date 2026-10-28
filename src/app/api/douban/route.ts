/* eslint-disable no-console */

import { NextResponse } from 'next/server';

import { getCacheTime, getConfig } from '@/lib/config';
import {
  buildDoubanCacheKey,
  getCachedDouban,
  setCachedDouban,
} from '@/lib/doubanCache';
import { reportError } from '@/lib/errorReport';
import { fetchWithRetry } from '@/lib/fetchRetry';
import { jsonWithCache } from '@/lib/http';
import { DoubanItem, DoubanResult } from '@/lib/types';
import { doUpstreamSearch } from '@/lib/upstreamSearch';

interface DoubanApiResponse {
  subjects: Array<{
    id: string;
    title: string;
    cover: string;
    rate: string;
  }>;
}

async function fetchDoubanData(url: string): Promise<DoubanApiResponse> {
  // R4-S8: 加重试（之前是裸 fetch，豆瓣偶发 5xx 直接失败）
  const response = await fetchWithRetry(
    url,
    {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        Referer: 'https://movie.douban.com/',
        Accept: 'application/json, text/plain, */*',
      },
    },
    { timeoutMs: 10000, retries: 1 }
  );

  if (!response.ok) {
    throw new Error(`HTTP error! Status: ${response.status}`);
  }

  // R5: 响应体大小硬限制（豆瓣列表正常 <100KB，1MB 为 generous 上限）
  const MAX_DOUBAN_BODY_BYTES = 1 * 1024 * 1024;
  const contentLength = response.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_DOUBAN_BODY_BYTES) {
    throw new Error('豆瓣响应体过大');
  }
  if (!response.body) {
    return await response.json();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_DOUBAN_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error('豆瓣响应体过大');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(merged));
}

/**
 * 2026-10-28 豆瓣空白兜底（只改本文件，不动 top250 与参数校验）：
 * 豆瓣对同一 type+tag 一会儿 403（error 008）、一会儿返回空 subjects，
 * 且旧逻辑把空结果也写进 6 小时 KV 缓存，一次空就锁空白半天。
 * 兜底链：recommend → new_score 再试一次 → 点播源搜索该 tag 兜底 →
 * 仍无结果时返回 code 200 + 空 list + 说明，不返回 500。
 * 兜底片单来自后端已有 doUpstreamSearch（与 /api/search 同源，不新接
 * 付费源、不加成人内容，黄词过滤与搜索接口一致），且不写入豆瓣 KV
 * 缓存，下次请求仍可重试豆瓣。注意兜底是按片名含 tag 搜索，不是按
 * 类型分类，类型片（如标题不含“恐怖”的恐怖片）不一定能被兜底填满。
 */
function buildDoubanTarget(
  type: string,
  tag: string,
  sort: string,
  pageSize: number,
  pageStart: number
): string {
  return `https://movie.douban.com/j/search_subjects?type=${type}&tag=${encodeURIComponent(tag)}&sort=${sort}&page_limit=${pageSize}&page_start=${pageStart}`;
}

async function fetchDoubanList(
  type: string,
  tag: string,
  pageSize: number,
  pageStart: number
): Promise<DoubanItem[]> {
  const sorts = ['recommend', 'new_score'];
  let lastError: unknown = null;
  for (const sort of sorts) {
    try {
      const data = await fetchDoubanData(
        buildDoubanTarget(type, tag, sort, pageSize, pageStart)
      );
      // 豆瓣被拦时有时返回 200 但无 subjects 数组，按失败处理以便换 sort 再试
      if (!data || !Array.isArray(data.subjects)) {
        throw new Error('豆瓣响应无 subjects 数组');
      }
      if (data.subjects.length > 0) {
        return data.subjects.map((item) => ({
          id: item.id,
          title: item.title,
          poster: item.cover,
          rate: item.rate,
          year: '',
        }));
      }
      // 空 subjects：不立即放弃，换下一个 sort 再试一次
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) {
    throw lastError;
  }
  return [];
}

async function fetchFallbackFromSearch(
  tag: string,
  pageSize: number,
  pageStart: number
): Promise<DoubanItem[]> {
  try {
    const config = await getConfig();
    const apiSites = config.SourceConfig.filter((site) => !site.disabled);
    const sitesByApi = new Map<string, typeof apiSites>();
    for (const site of apiSites) {
      if (!site.api) continue;
      const group = sitesByApi.get(site.api);
      if (group) {
        group.push(site);
      } else {
        sitesByApi.set(site.api, [site]);
      }
    }
    if (sitesByApi.size === 0) return [];
    // 兜底搜索预算 8 秒，不拖满豆瓣两次尝试之后的剩余时间
    const upstream = await doUpstreamSearch(
      sitesByApi,
      tag,
      config.SiteConfig.SearchDownstreamMaxPage,
      config.SiteConfig.DisableYellowFilter,
      8000
    );
    return upstream.results
      .slice(pageStart, pageStart + pageSize)
      .map((item) => ({
        id: String(item.id || item.title),
        title: item.title,
        poster: item.poster || '',
        rate: '',
        year: String(item.year || ''),
      }));
  } catch (error) {
    console.error('[douban] 兜底搜索失败:', error);
    return [];
  }
}

export const runtime = 'edge';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  // 获取参数
  const type = searchParams.get('type');
  const tag = searchParams.get('tag');
  const pageSize = parseInt(searchParams.get('pageSize') || '16');
  const pageStart = parseInt(searchParams.get('pageStart') || '0');

  // 验证参数
  if (!type || !tag) {
    return NextResponse.json(
      { error: '缺少必要参数: type 或 tag' },
      { status: 400 }
    );
  }

  if (!['tv', 'movie'].includes(type)) {
    return NextResponse.json(
      { error: 'type 参数必须是 tv 或 movie' },
      { status: 400 }
    );
  }

  if (pageSize < 1 || pageSize > 100) {
    return NextResponse.json(
      { error: 'pageSize 必须在 1-100 之间' },
      { status: 400 }
    );
  }

  if (pageStart < 0) {
    return NextResponse.json(
      { error: 'pageStart 不能小于 0' },
      { status: 400 }
    );
  }

  // P2-6: tag 长度上限 50，与搜索接口风格统一
  if (tag.length > 50) {
    return NextResponse.json(
      { error: 'tag 参数过长（最多 50 字符）' },
      { status: 400 }
    );
  }

  if (tag === 'top250') {
    return handleTop250(pageStart);
  }

  // P2: KV 缓存（榜单变化慢，6 小时）。空结果不命中缓存：旧部署可能已把
  // 空结果写进 KV，若此处直接返回空缓存，兜底部署后仍会空白 6 小时，
  // 因此只有非空缓存才算 HIT，空缓存穿透到下面重新拉取。
  const cacheKey = buildDoubanCacheKey(type, tag, pageSize, pageStart);
  const cacheTime = await getCacheTime();
  const cached = await getCachedDouban(cacheKey);
  if (cached && Array.isArray(cached.list) && cached.list.length > 0) {
    return jsonWithCache(cached, cacheTime, 200, {
      'X-Douban-Cache': 'HIT',
    });
  }

  try {
    // 调用豆瓣 API：recommend 空/失败时换 new_score 再试一次
    const list = await fetchDoubanList(type, tag, pageSize, pageStart);

    if (list.length > 0) {
      const response: DoubanResult = {
        code: 200,
        message: '获取成功',
        list: list,
      };

      // 只有非空结果才写缓存，空结果不写，避免一次空锁空白 6 小时
      setCachedDouban(cacheKey, response).catch(() => {});

      // QUALITY-R3: 缓存头拼写收敛到 jsonWithCache
      return jsonWithCache(response, cacheTime, 200, {
        'X-Douban-Cache': 'MISS',
      });
    }

    // 两次豆瓣都空：用点播源搜索该 tag 兜底，不写入豆瓣 KV 缓存
    const fallback = await fetchFallbackFromSearch(tag, pageSize, pageStart);
    if (fallback.length > 0) {
      const response: DoubanResult = {
        code: 200,
        message: '豆瓣暂无数据，已用点播搜索兜底',
        list: fallback,
      };
      return jsonWithCache(response, cacheTime, 200, {
        'X-Douban-Cache': 'MISS',
        'X-Douban-Source': 'fallback-search',
      });
    }

    // 兜底也无结果：返回 200 空列表 + 说明，不返回 500
    return jsonWithCache(
      {
        code: 200,
        message: '豆瓣侧暂无结果',
        list: [],
      } as DoubanResult,
      cacheTime,
      200,
      { 'X-Douban-Cache': 'MISS' }
    );
  } catch (error) {
    // QUALITY-R3: 不向客户端泄露内部错误原文。豆瓣两次都失败时同样走
    // 兜底搜索，兜底有结果就返回兜底，无结果才返回 200 空列表。
    console.error('[douban] 获取失败:', error);
    reportError('api/douban', error);
    const fallback = await fetchFallbackFromSearch(tag, pageSize, pageStart);
    if (fallback.length > 0) {
      const response: DoubanResult = {
        code: 200,
        message: '豆瓣暂无数据，已用点播搜索兜底',
        list: fallback,
      };
      return jsonWithCache(response, cacheTime, 200, {
        'X-Douban-Cache': 'MISS',
        'X-Douban-Source': 'fallback-search',
      });
    }
    return jsonWithCache(
      {
        code: 200,
        message: '豆瓣侧暂无结果',
        list: [],
      } as DoubanResult,
      cacheTime,
      200,
      { 'X-Douban-Cache': 'MISS' }
    );
  }
}

function handleTop250(pageStart: number) {
  const target = `https://movie.douban.com/top250?start=${pageStart}&filter=`;

  // 直接使用 fetch 获取 HTML 页面
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  const fetchOptions = {
    signal: controller.signal,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      Referer: 'https://movie.douban.com/',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    },
  };

  return fetch(target, fetchOptions)
    .then(async (fetchResponse) => {
      clearTimeout(timeoutId);

      if (!fetchResponse.ok) {
        throw new Error(`HTTP error! Status: ${fetchResponse.status}`);
      }

      // 获取 HTML 内容
      const html = await fetchResponse.text();

      // 通过正则同时捕获影片 id、标题、封面以及评分
      const moviePattern =
        /<div class="item">[\s\S]*?<a[^>]+href="https?:\/\/movie\.douban\.com\/subject\/(\d+)\/"[\s\S]*?<img[^>]+alt="([^"]+)"[^>]*src="([^"]+)"[\s\S]*?<span class="rating_num"[^>]*>([^<]*)<\/span>[\s\S]*?<\/div>/g;
      const movies: DoubanItem[] = [];
      let match;

      while ((match = moviePattern.exec(html)) !== null) {
        const id = match[1];
        const title = match[2];
        const cover = match[3];
        const rate = match[4] || '';

        // 处理图片 URL，确保使用 HTTPS
        const processedCover = cover.replace(/^http:/, 'https:');

        movies.push({
          id: id,
          title: title,
          poster: processedCover,
          rate: rate,
          year: '',
        });
      }

      const apiResponse: DoubanResult = {
        code: 200,
        message: '获取成功',
        list: movies,
      };

      const cacheTime = await getCacheTime();
      // QUALITY-R3: 缓存头拼写收敛到 jsonWithCache
      return jsonWithCache(apiResponse, cacheTime);
    })
    .catch((_error) => {
      clearTimeout(timeoutId);
      // QUALITY-R3: 不向客户端泄露内部错误原文
      return NextResponse.json(
        {
          error: '获取豆瓣 Top250 数据失败',
        },
        { status: 500 }
      );
    });
}
