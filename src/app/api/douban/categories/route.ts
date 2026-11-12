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

  // L4: category/type 限长并拒绝控制字符，避免注入 & 篡改上游查询参数
  // （不用含控制字符的正则，no-control-regex 会报错，改用 charCode 判断）
  const hasControlChars = (s: string): boolean => {
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code <= 0x1f || code === 0x7f) return true;
    }
    return false;
  };
  if (
    category.length > 50 ||
    type.length > 50 ||
    hasControlChars(category) ||
    hasControlChars(type)
  ) {
    return NextResponse.json(
      { error: 'category 或 type 参数非法' },
      { status: 400 }
    );
  }

  // L4: 用户参数编码后拼进上游 URL（与 /api/douban 的 tag 同口径）
  const target = `https://m.douban.com/rexxar/api/v2/subject/recent_hot/${kind}?start=${pageStart}&limit=${pageLimit}&category=${encodeURIComponent(category)}&type=${encodeURIComponent(type)}`;

  try {
    // 调用豆瓣 API
    const doubanData = await fetchDoubanData(target);

    // 深查第 14 轮：豆瓣被拦时有时回 200 但无 items 数组（与 /api/douban
    // 的 subjects 同形态），旧实现直接 .map 抛 TypeError → 500；无 items
    // 按空结果处理（回 200 空列表），与列表接口“空结果不算失败”一致。
    const items = Array.isArray(doubanData?.items) ? doubanData.items : [];
    // 转换数据格式
    const list: DoubanItem[] = items.map((item) => ({
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
