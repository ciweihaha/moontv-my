import { readBodyWithLimit } from '@/lib/downstream';

export interface DoubanCategoryApiResponse {
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
 * 从豆瓣分类接口取数据（供 src/app/api/douban/categories/route.ts 的 GET 调用）。
 *
 * 注意：不要把本函数放回路由文件——Next.js 路由文件只允许导出合法的
 * Route 字段（GET/POST/runtime 等），具名导出其他函数会在 next build
 * 类型校验时报错（PR #29 CI 曾因此 3 项检查全失败）。
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
