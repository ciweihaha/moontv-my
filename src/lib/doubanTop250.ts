import { readBodyWithLimit } from '@/lib/downstream';
import { DoubanItem } from '@/lib/types';

/** 豆瓣 Top250 页面 HTML 上限：与 /api/douban 的 fetchDoubanData 同口径（1MB），单页 25 条，正常 HTML 远小于此值。 */
const MAX_DOUBAN_BODY_BYTES = 1 * 1024 * 1024;

/**
 * 从豆瓣 Top250 取一页 HTML 并解析为条目（供 src/app/api/douban/route.ts 的 handleTop250 调用）。
 *
 * 注意：不要把本函数放回路由文件——Next.js 路由文件只允许导出合法的
 * Route 字段（GET/POST/runtime 等），具名导出其他函数会在 next build
 * 类型校验时报错（PR #29 CI 曾因此 3 项检查全失败）。
 *
 * 超时覆盖响应体读取全过程：旧实现（route.ts handleTop250）在 fetch
 * 返回（仅收到响应头）后立即 clearTimeout，随后的 response.text()
 * 不再受 10s 约束——响应体停滞时请求无限挂起，且无大小上限、超大
 * HTML 会整块读入内存。现改用流式限长读取（readBodyWithLimit）：
 * 超时信号透传进读取循环，读完/超限/取消后才清定时器；超限抛错
 * （调用方返回 500，与旧失败语义一致）。
 */
export async function fetchTop250(
  pageStart: number,
  options?: { timeoutMs?: number }
): Promise<DoubanItem[]> {
  const target = `https://movie.douban.com/top250?start=${pageStart}&filter=`;

  const controller = new AbortController();
  const timeoutMs = options?.timeoutMs ?? 10000; // 10 秒超时，与旧实现一致
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(target, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        Referer: 'https://movie.douban.com/',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      },
    });

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
    const html = new TextDecoder().decode(body);

    // 通过正则同时捕获影片 id、标题、封面以及评分（与旧 handleTop250 同款）
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

    return movies;
  } finally {
    clearTimeout(timeoutId);
  }
}
