import { NextResponse } from 'next/server';

import { getCacheTime } from '@/lib/config';
import { readBodyWithLimit } from '@/lib/downstream';
import { jsonWithCache } from '@/lib/http';
import { DoubanItem, DoubanResult } from '@/lib/types';

interface DoubanCategoryApiResponse {
  total: number;
  items: Array<{
    id: string;
    title: string;
    card_subtitle: string;
    pic: {
      large: string;
      normal: string;
    };
    rating: {
      value: number;
    };
  }>;
}

/** 豆瓣分类响应体上限：与 /api/douban 的 fetchDoubanData 同口径（1MB），正常分类 JSON 远小于此值。 */
const MAX_DOUBAN_BODY_BYTES = 1 * 1024 * 1024;

/**
 * 导出以便单元测试（与 downstream.ts 的 readBodyWithLimit 同例）。
 *
 * 超时覆盖响应体读取全过程：旧实现在 fetch 返回（仅收到响应头）后立即
 * clearTimeout，随后的 response.json() 不再受 10s 约束——响应体停滞时
 * 请求无限挂起，且无大小上限、超大响应会整块读入内存。现改用流式限长
 * 读取（readBodyWithLimit）：超时信号透传进读取循环，读完/超限/取消后
 * 才清定时器；超限抛错（调用方返回 500，与旧失败语义一致）。
 */
export async function fetchDoubanData(
  url: string,
  options?: { timeoutMs?: number }
): Promise<DoubanCategoryApiResponse> {
  // 添加超时控制
  const controller = new AbortController();
  const timeoutMs = options?.timeoutMs ?? 10000; // 10秒超时
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  // 设置请求选项，包括信号和头部
  const fetchOptions = {
    signal: controller.signal,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      Referer: 'https://movie.douban.com/',
      Accept: 'application/json, text/plain, */*',
      Origin: 'https://movie.douban.com',
    },
  };

  try {
    // 尝试直接访问豆瓣API
    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    const body = await readBodyWithLimit(
      response,
      MAX_DOUBAN_BODY_BYTES,
      controller.signal
    );
    if (body === null) {
      throw new Error('豆瓣响应体过大');
    }
    return JSON.parse(new TextDecoder().decode(body));
  } finally {
    clearTimeout(timeoutId);
  }
}

export const runtime = 'edge';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  // 获取参数
  const kind = searchParams.get('kind') || 'movie';
  const category = searchParams.get('category');
  const type = searchParams.get('type');
  const pageLimit = parseInt(searchParams.get('limit') || '20');
  const pageStart = parseInt(searchParams.get('start') || '0');

  // 验证参数
  if (!kind || !category || !type) {
    return NextResponse.json(
      { error: '缺少必要参数: kind 或 category 或 type' },
      { status: 400 }
    );
  }

  if (!['tv', 'movie'].includes(kind)) {
    return NextResponse.json(
      { error: 'kind 参数必须是 tv 或 movie' },
      { status: 400 }
    );
  }

  if (pageLimit < 1 || pageLimit > 100) {
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

  const target = `https://m.douban.com/rexxar/api/v2/subject/recent_hot/${kind}?start=${pageStart}&limit=${pageLimit}&category=${category}&type=${type}`;

  try {
    // 调用豆瓣 API
    const doubanData = await fetchDoubanData(target);

    // 转换数据格式
    const list: DoubanItem[] = doubanData.items.map((item) => ({
      id: item.id,
      title: item.title,
      poster: item.pic?.normal || item.pic?.large || '',
      rate: item.rating?.value ? item.rating.value.toFixed(1) : '',
      year: item.card_subtitle?.match(/(\d{4})/)?.[1] || '',
    }));

    const response: DoubanResult = {
      code: 200,
      message: '获取成功',
      list: list,
    };

    const cacheTime = await getCacheTime();
    // QUALITY-R3: 缓存头拼写收敛到 jsonWithCache
    return jsonWithCache(response, cacheTime);
  } catch {
    // QUALITY-R3: 不向客户端泄露内部错误原文
    return NextResponse.json({ error: '获取豆瓣数据失败' }, { status: 500 });
  }
}
