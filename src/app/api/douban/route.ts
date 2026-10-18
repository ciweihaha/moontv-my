/* eslint-disable no-console */

import { NextResponse } from 'next/server';

import { getCacheTime } from '@/lib/config';
import {
  buildDoubanCacheKey,
  getCachedDouban,
  setCachedDouban,
} from '@/lib/doubanCache';
import { reportError } from '@/lib/errorReport';
import { fetchWithRetry } from '@/lib/fetchRetry';
import { jsonWithCache } from '@/lib/http';
import { DoubanItem, DoubanResult } from '@/lib/types';

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

  return await response.json();
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

  const target = `https://movie.douban.com/j/search_subjects?type=${type}&tag=${encodeURIComponent(tag)}&sort=recommend&page_limit=${pageSize}&page_start=${pageStart}`;

  // P2: KV 缓存（榜单变化慢，6 小时）
  const cacheKey = buildDoubanCacheKey(type, tag, pageSize, pageStart);
  const cacheTime = await getCacheTime();
  const cached = await getCachedDouban(cacheKey);
  if (cached) {
    return jsonWithCache(cached, cacheTime, 200, {
      'X-Douban-Cache': 'HIT',
    });
  }

  try {
    // 调用豆瓣 API
    const doubanData = await fetchDoubanData(target);

    // 转换数据格式
    const list: DoubanItem[] = doubanData.subjects.map((item) => ({
      id: item.id,
      title: item.title,
      poster: item.cover,
      rate: item.rate,
      year: '',
    }));

    const response: DoubanResult = {
      code: 200,
      message: '获取成功',
      list: list,
    };

    // 异步写缓存
    setCachedDouban(cacheKey, response).catch(() => {});

    // QUALITY-R3: 缓存头拼写收敛到 jsonWithCache
    return jsonWithCache(response, cacheTime, 200, {
      'X-Douban-Cache': 'MISS',
    });
  } catch (error) {
    // QUALITY-R3: 不向客户端泄露内部错误原文
    console.error('[douban] 获取失败:', error);
    reportError('api/douban', error);
    return NextResponse.json({ error: '获取豆瓣数据失败' }, { status: 500 });
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
