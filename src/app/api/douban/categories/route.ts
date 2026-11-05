import { NextResponse } from 'next/server';

import { getCacheTime } from '@/lib/config';
import { fetchDoubanData } from '@/lib/doubanCategories';
import { jsonWithCache } from '@/lib/http';
import { parsePageInt } from '@/lib/pageParams';
import { DoubanItem, DoubanResult } from '@/lib/types';

export const runtime = 'edge';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  // 获取参数
  const kind = searchParams.get('kind') || 'movie';
  const category = searchParams.get('category');
  const type = searchParams.get('type');
  // 深查第 4 轮：与 /api/douban 同因——裸 parseInt('abc') 得 NaN，
  // 旧比较校验拦不住，NaN 会流进上游 URL（limit=NaN/start=NaN）。
  // 非数字返回 null，此处回 400；缺参仍回默认值。
  const pageLimit = parsePageInt(searchParams.get('limit'), 20);
  const pageStart = parsePageInt(searchParams.get('start'), 0);

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

  if (pageLimit === null || pageLimit < 1 || pageLimit > 100) {
    return NextResponse.json(
      { error: 'pageSize 必须在 1-100 之间' },
      { status: 400 }
    );
  }

  if (pageStart === null || pageStart < 0) {
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
