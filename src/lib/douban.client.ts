import { DoubanItem, DoubanResult } from './types';
import { getDoubanProxyUrl } from './utils';
import { readTextWithLimit } from './version';

interface DoubanCategoriesParams {
  kind: 'tv' | 'movie';
  category: string;
  type: string;
  pageLimit?: number;
  pageStart?: number;
  /** 只供测试快跑，生产默认 10 秒不变（与 version.ts / doubanCategories.ts 同例）。 */
  timeoutMs?: number;
}

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

/** 与服务端 /api/douban 的 1MB 口径一致（route.ts / doubanCategories.ts / doubanTop250.ts）。 */
const MAX_DOUBAN_CLIENT_BODY_BYTES = 1 * 1024 * 1024;

/**
 * 带超时的豆瓣 JSON 请求（客户端代理路径专用）。
 *
 * 旧实现缺陷（与第 2/3/5 轮修掉的服务端三处同形态，是该类的最后一处）：
 * 旧 fetchWithTimeout 在 fetch 返回（仅收到响应头）后立即 clearTimeout，
 * 随后的 response.json() 不再受任何超时约束、也无字节上限——代理响应体
 * 停滞时豆瓣页永远转圈，超大响应整块读入内存。仅配置了豆瓣代理的用户
 * 走此路径（shouldUseDoubanClient() 为真时才调 fetchDoubanCategories /
 * fetchDoubanList；未配代理走同源 /api/douban*，服务端已有超时与限长）。
 *
 * 新行为：超时覆盖“请求头＋读体”全过程（读完/超限/取消后才清定时器），
 * 复用 version.ts 的客户端版流式限长读取 readTextWithLimit（1MB 上限，
 * 与服务端口径一致）；非 200 先 cancel 响应体再抛错。
 */
async function fetchDoubanJson(
  url: string,
  options: { timeoutMs?: number } = {}
): Promise<DoubanCategoryApiResponse> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 10000; // 10秒超时
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  // 检查是否使用代理
  const proxyUrl = getDoubanProxyUrl();
  const finalUrl = proxyUrl ? `${proxyUrl}${encodeURIComponent(url)}` : url;

  try {
    const response = await fetch(finalUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        Referer: 'https://movie.douban.com/',
        Accept: 'application/json, text/plain, */*',
      },
    });

    if (!response.ok) {
      // 非 200：取消响应体再抛错，避免悬着的流占用连接（与 version.ts 同口径）
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    const text = await readTextWithLimit(
      response,
      MAX_DOUBAN_CLIENT_BODY_BYTES,
      controller.signal
    );
    if (text === null) {
      throw new Error('豆瓣响应体过大');
    }
    return JSON.parse(text) as DoubanCategoryApiResponse;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 检查是否应该使用客户端获取豆瓣数据
 */
export function shouldUseDoubanClient(): boolean {
  return getDoubanProxyUrl() !== null;
}

/**
 * 浏览器端豆瓣分类数据获取函数
 */
export async function fetchDoubanCategories(
  params: DoubanCategoriesParams
): Promise<DoubanResult> {
  const {
    kind,
    category,
    type,
    pageLimit = 20,
    pageStart = 0,
    timeoutMs,
  } = params;

  // 验证参数
  if (!['tv', 'movie'].includes(kind)) {
    throw new Error('kind 参数必须是 tv 或 movie');
  }

  if (!category || !type) {
    throw new Error('category 和 type 参数不能为空');
  }

  if (pageLimit < 1 || pageLimit > 100) {
    throw new Error('pageLimit 必须在 1-100 之间');
  }

  if (pageStart < 0) {
    throw new Error('pageStart 不能小于 0');
  }

  const target = `https://m.douban.com/rexxar/api/v2/subject/recent_hot/${kind}?start=${pageStart}&limit=${pageLimit}&category=${category}&type=${type}`;

  try {
    const doubanData: DoubanCategoryApiResponse = await fetchDoubanJson(
      target,
      { timeoutMs }
    );

    // 深查第 15 轮：与服务端分类路由（第 14 轮）同口径，代理回 200 但无
    // items 数组时按空结果处理，不抛错、不弹全局错误。
    const items = Array.isArray(doubanData?.items) ? doubanData.items : [];
    // 转换数据格式
    const list: DoubanItem[] = items.map((item) => ({
      id: item.id,
      title: item.title,
      poster: item.pic?.normal || item.pic?.large || '',
      rate: item.rating?.value ? item.rating.value.toFixed(1) : '',
      year: item.card_subtitle?.match(/(\d{4})/)?.[1] || '',
    }));

    return {
      code: 200,
      message: '获取成功',
      list: list,
    };
  } catch (error) {
    // 触发全局错误提示
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('globalError', {
          detail: { message: '获取豆瓣分类数据失败' },
        })
      );
    }
    throw new Error(`获取豆瓣分类数据失败: ${(error as Error).message}`);
  }
}

/**
 * 统一的豆瓣分类数据获取函数，根据代理设置选择使用服务端 API 或客户端代理获取
 */
export async function getDoubanCategories(
  params: DoubanCategoriesParams
): Promise<DoubanResult> {
  if (shouldUseDoubanClient()) {
    // 使用客户端代理获取（当设置了代理 URL 时）
    return fetchDoubanCategories(params);
  } else {
    // 使用服务端 API（当没有设置代理 URL 时）
    const { kind, category, type, pageLimit = 20, pageStart = 0 } = params;
    const response = await fetch(
      `/api/douban/categories?kind=${kind}&category=${category}&type=${type}&limit=${pageLimit}&start=${pageStart}`
    );

    if (!response.ok) {
      // 触发全局错误提示
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('globalError', {
            detail: { message: '获取豆瓣分类数据失败' },
          })
        );
      }
      throw new Error('获取豆瓣分类数据失败');
    }

    return response.json();
  }
}

interface DoubanListParams {
  tag: string;
  type: string;
  pageLimit?: number;
  pageStart?: number;
  /** 只供测试快跑，生产默认 10 秒不变（与 version.ts / doubanCategories.ts 同例）。 */
  timeoutMs?: number;
}

export async function getDoubanList(
  params: DoubanListParams
): Promise<DoubanResult> {
  const { tag, type, pageLimit = 20, pageStart = 0 } = params;
  if (shouldUseDoubanClient()) {
    // 使用客户端代理获取（当设置了代理 URL 时）
    return fetchDoubanList(params);
  } else {
    const response = await fetch(
      `/api/douban?tag=${tag}&type=${type}&pageSize=${pageLimit}&pageStart=${pageStart}`
    );

    if (!response.ok) {
      // 触发全局错误提示
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('globalError', {
            detail: { message: '获取豆瓣列表数据失败' },
          })
        );
      }
      throw new Error('获取豆瓣列表数据失败');
    }

    return response.json();
  }
}

export async function fetchDoubanList(
  params: DoubanListParams
): Promise<DoubanResult> {
  const { tag, type, pageLimit = 20, pageStart = 0, timeoutMs } = params;

  // 验证参数
  if (!tag || !type) {
    throw new Error('tag 和 type 参数不能为空');
  }

  if (!['tv', 'movie'].includes(type)) {
    throw new Error('type 参数必须是 tv 或 movie');
  }

  if (pageLimit < 1 || pageLimit > 100) {
    throw new Error('pageLimit 必须在 1-100 之间');
  }

  if (pageStart < 0) {
    throw new Error('pageStart 不能小于 0');
  }

  const target = `https://movie.douban.com/j/search_subjects?type=${type}&tag=${tag}&sort=recommend&page_limit=${pageLimit}&page_start=${pageStart}`;

  try {
    const doubanData: DoubanCategoryApiResponse = await fetchDoubanJson(
      target,
      { timeoutMs }
    );

    // 深查第 15 轮：与 fetchDoubanCategories 同口径，无 items 按空结果处理。
    const items = Array.isArray(doubanData?.items) ? doubanData.items : [];
    // 转换数据格式
    const list: DoubanItem[] = items.map((item) => ({
      id: item.id,
      title: item.title,
      poster: item.pic?.normal || item.pic?.large || '',
      rate: item.rating?.value ? item.rating.value.toFixed(1) : '',
      year: item.card_subtitle?.match(/(\d{4})/)?.[1] || '',
    }));

    return {
      code: 200,
      message: '获取成功',
      list: list,
    };
  } catch (error) {
    // 触发全局错误提示
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('globalError', {
          detail: { message: '获取豆瓣列表数据失败' },
        })
      );
    }
    throw new Error(`获取豆瓣分类数据失败: ${(error as Error).message}`);
  }
}
