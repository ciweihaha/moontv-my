import { API_CONFIG, ApiSite } from '@/lib/config';
import { SearchResult } from '@/lib/types';
import { cleanHtmlTags } from '@/lib/utils';

import { fetchWithRetry } from './fetchRetry';

interface ApiSearchItem {
  vod_id: string;
  vod_name: string;
  vod_pic: string;
  vod_remarks?: string;
  vod_play_url?: string;
  vod_class?: string;
  vod_year?: string;
  vod_content?: string;
  vod_douban_id?: number;
  type_name?: string;
}

// R3: 读取时字节数硬上限。content-length 响应头在分块传输（chunked）时缺失，
// 仅靠头部检查会被绕过；此处在实际读取 body 后校验字节数，超限返回 null。
const MAX_SEARCH_BODY_BYTES = 5 * 1024 * 1024;
const MAX_DETAIL_BODY_BYTES = 2 * 1024 * 1024;

// PERF-R1: 正则提升到模块级，避免在每条目 map 回调内重复编译
const SEARCH_M3U8_REGEX = /\$(https?:\/\/[^"'\s]+?\.m3u8)/g;

/** 从 vod_play_url 提取 m3u8 剧集链接（去重并清理）
 * @param splitBest 为 true 时按 $$$ 分片取匹配最多的一段（第一页逻辑）；
 *                  为 false 时直接全串匹配（翻页逻辑，保持原行为） */
function extractSearchEpisodes(
  vodPlayUrl: string | undefined,
  splitBest: boolean
): string[] {
  if (!vodPlayUrl) return [];
  let episodes: string[] = [];
  if (splitBest) {
    const vod_play_url_array = vodPlayUrl.split('$$$');
    vod_play_url_array.forEach((url: string) => {
      // 注意：全局正则需重置 lastIndex，避免跨分片污染
      SEARCH_M3U8_REGEX.lastIndex = 0;
      const matches = url.match(SEARCH_M3U8_REGEX) || [];
      if (matches.length > episodes.length) {
        episodes = matches;
      }
    });
  } else {
    SEARCH_M3U8_REGEX.lastIndex = 0;
    episodes = vodPlayUrl.match(SEARCH_M3U8_REGEX) || [];
  }
  return Array.from(new Set(episodes)).map((link: string) => {
    link = link.substring(1); // 去掉开头的 $
    const parenIndex = link.indexOf('(');
    return parenIndex > 0 ? link.substring(0, parenIndex) : link;
  });
}

/** 将上游搜索条目映射为统一 SearchResult */
function mapSearchItem(
  item: ApiSearchItem,
  source: string,
  sourceName: string,
  splitBest: boolean
): SearchResult | null {
  // P0-2: 脏数据守卫 - vod_id/vod_name 为空时返回 null，调用方过滤，只跳过单条
  if (item.vod_id == null || item.vod_name == null) {
    return null;
  }
  return {
    id: item.vod_id.toString(),
    title: item.vod_name.trim().replace(/\s+/g, ' '),
    poster: item.vod_pic,
    episodes: extractSearchEpisodes(item.vod_play_url, splitBest),
    source,
    source_name: sourceName,
    class: item.vod_class,
    year: item.vod_year ? item.vod_year.match(/\d{4}/)?.[0] || '' : 'unknown',
    desc: cleanHtmlTags(item.vod_content || ''),
    type_name: item.type_name,
    douban_id: item.vod_douban_id,
  };
}

/**
 * AUDIT-R4 P1-1: 流式读取响应体并做字节数硬上限。
 * 之前先用 response.arrayBuffer() 把整个响应读入内存再检查大小，
 * 超大响应会先占满内存。现改为逐块读取、累计字节数，
 * 超过上限立即取消读取并返回 null，内存占用恒定为上限值。
 */
async function readBodyWithLimit(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal
): Promise<ArrayBuffer | null> {
  // 无 body 流的降级路径（极少数环境）
  if (!response.body) {
    const buf = await response.arrayBuffer();
    return buf.byteLength > maxBytes ? null : buf;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      // 外部取消（整体超时）时立即停止读取
      if (signal?.aborted) {
        await reader.cancel().catch(() => undefined);
        throw new DOMException('Aborted', 'AbortError');
      }
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        // 超上限：取消上游流，不再继续读
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  // 合并分块为单个 ArrayBuffer
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result.buffer;
}

export async function searchFromApi(
  apiSite: ApiSite,
  query: string,
  // PERF-R1: 由调用方一次性传入，避免每次搜索对每个上游重复读取配置（44 次/搜索）
  maxSearchPages: number = 2,
  // AUDIT-R3 P1: 外部取消信号（搜索整体超时时取消后台请求）
  signal?: AbortSignal
): Promise<SearchResult[]> {
  try {
    const apiBaseUrl = apiSite.api;
    const apiUrl =
      apiBaseUrl + API_CONFIG.search.path + encodeURIComponent(query);
    const apiName = apiSite.name;

    // S3: 超时 + 指数退避重试（8s 单次超时，1 次重试）
    const response = await fetchWithRetry(
      apiUrl,
      { headers: API_CONFIG.search.headers, signal },
      { timeoutMs: 8000, retries: 1 }
    );

    // R3: 响应头 content-length 只是快速预检；分块传输时头部缺失，
    // 读取时再做字节数硬上限，防止超大响应占满内存
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_SEARCH_BODY_BYTES) {
      return [];
    }

    if (!response.ok) {
      return [];
    }

    const searchBody = await readBodyWithLimit(
      response,
      MAX_SEARCH_BODY_BYTES,
      signal
    );
    if (searchBody === null) {
      return [];
    }
    const data = JSON.parse(new TextDecoder().decode(searchBody));
    if (
      !data ||
      !data.list ||
      !Array.isArray(data.list) ||
      data.list.length === 0
    ) {
      return [];
    }
    // 处理第一页结果（PERF-R1: 复用模块级 mapSearchItem，避免重复代码）
    const results = data.list
      .map((item: ApiSearchItem) =>
        mapSearchItem(item, apiSite.key, apiName, true)
      )
      .filter(Boolean) as SearchResult[];

    // PERF-R1: 最大页数由调用方传入，不再每次重复读取配置
    const MAX_SEARCH_PAGES: number = maxSearchPages;

    // 获取总页数
    const pageCount = data.pagecount || 1;
    // 确定需要获取的额外页数
    const pagesToFetch = Math.min(pageCount - 1, MAX_SEARCH_PAGES - 1);

    // 如果有额外页数，获取更多页的结果
    if (pagesToFetch > 0) {
      const additionalPagePromises = [];

      for (let page = 2; page <= pagesToFetch + 1; page++) {
        const pageUrl =
          apiBaseUrl +
          API_CONFIG.search.pagePath
            .replace('{query}', encodeURIComponent(query))
            .replace('{page}', page.toString());

        const pagePromise = (async () => {
          try {
            // R4-S7: 分页请求也加重试（之前是裸 fetch，瞬时失败直接丢页）
            // AUDIT-R4 P1-1: 传入整体 signal，超时后分页请求也被取消
            const pageResponse = await fetchWithRetry(
              pageUrl,
              { headers: API_CONFIG.search.headers, signal },
              { timeoutMs: 8000, retries: 1 }
            );

            // R3: 响应头预检 + 读取时硬上限（防分块传输绕过）
            const pageCL = pageResponse.headers.get('content-length');
            if (pageCL && parseInt(pageCL, 10) > MAX_SEARCH_BODY_BYTES)
              return [];

            if (!pageResponse.ok) return [];

            const pageBody = await readBodyWithLimit(
              pageResponse,
              MAX_SEARCH_BODY_BYTES,
              signal
            );
            if (pageBody === null) return [];
            const pageData = JSON.parse(new TextDecoder().decode(pageBody));

            if (!pageData || !pageData.list || !Array.isArray(pageData.list))
              return [];

            return pageData.list
              .map((item: ApiSearchItem) =>
                mapSearchItem(item, apiSite.key, apiName, false)
              )
              .filter(Boolean) as SearchResult[];
          } catch {
            return [];
          }
        })();

        additionalPagePromises.push(pagePromise);
      }

      // 等待所有额外页的结果
      const additionalResults = await Promise.all(additionalPagePromises);

      // 合并所有页的结果
      additionalResults.forEach((pageResults) => {
        if (pageResults.length > 0) {
          results.push(...pageResults);
        }
      });
    }

    return results;
  } catch {
    return [];
  }
}

// 匹配 m3u8 链接的正则
const M3U8_PATTERN = /(https?:\/\/[^"'\s]+?\.m3u8)/g;

export async function getDetailFromApi(
  apiSite: ApiSite,
  id: string
): Promise<SearchResult> {
  // P1-6: id 格式校验（纵深防御，与 /api/detail 路由层一致）
  if (!/^[\w-]+$/.test(id)) {
    throw new Error('无效的视频ID格式');
  }
  if (apiSite.detail) {
    return handleSpecialSourceDetail(id, apiSite);
  }

  const detailUrl = `${apiSite.api}${API_CONFIG.detail.path}${id}`;

  // S3: 超时 + 重试
  const response = await fetchWithRetry(
    detailUrl,
    { headers: API_CONFIG.detail.headers },
    { timeoutMs: 10000, retries: 1 }
  );

  // R3: 响应头预检（详情 2MB 上限）+ 读取时硬上限（防分块传输绕过）
  const detailCL = response.headers.get('content-length');
  if (detailCL && parseInt(detailCL, 10) > MAX_DETAIL_BODY_BYTES) {
    throw new Error('详情响应体过大');
  }

  if (!response.ok) {
    throw new Error(`详情请求失败: ${response.status}`);
  }

  const detailBody = await readBodyWithLimit(response, MAX_DETAIL_BODY_BYTES);
  if (detailBody === null) {
    throw new Error('详情响应体过大');
  }
  const data = JSON.parse(new TextDecoder().decode(detailBody));

  if (
    !data ||
    !data.list ||
    !Array.isArray(data.list) ||
    data.list.length === 0
  ) {
    throw new Error('获取到的详情内容无效');
  }

  const videoDetail = data.list[0];
  let episodes: string[] = [];

  // 处理播放源拆分
  if (videoDetail.vod_play_url) {
    const playSources = videoDetail.vod_play_url.split('$$$');
    if (playSources.length > 0) {
      const mainSource = playSources[0];
      const episodeList = mainSource.split('#');
      episodes = episodeList
        .map((ep: string) => {
          const parts = ep.split('$');
          return parts.length > 1 ? parts[1] : '';
        })
        .filter(
          (url: string) =>
            url && (url.startsWith('http://') || url.startsWith('https://'))
        );
    }
  }

  // 如果播放源为空，则尝试从内容中解析 m3u8
  if (episodes.length === 0 && videoDetail.vod_content) {
    const matches = videoDetail.vod_content.match(M3U8_PATTERN) || [];
    episodes = matches.map((link: string) => link.replace(/^\$/, ''));
  }

  return {
    id: id.toString(),
    title: videoDetail.vod_name,
    poster: videoDetail.vod_pic,
    episodes,
    source: apiSite.key,
    source_name: apiSite.name,
    class: videoDetail.vod_class,
    year: videoDetail.vod_year
      ? videoDetail.vod_year.match(/\d{4}/)?.[0] || ''
      : 'unknown',
    desc: cleanHtmlTags(videoDetail.vod_content),
    type_name: videoDetail.type_name,
    douban_id: videoDetail.vod_douban_id,
  };
}

async function handleSpecialSourceDetail(
  id: string,
  apiSite: ApiSite
): Promise<SearchResult> {
  const detailUrl = `${apiSite.detail}/index.php/vod/detail/id/${id}.html`;

  // S3: 超时 + 重试
  const response = await fetchWithRetry(
    detailUrl,
    { headers: API_CONFIG.detail.headers },
    { timeoutMs: 10000, retries: 1 }
  );

  // R3: 响应头预检（详情 2MB 上限）+ 读取时硬上限（防分块传输绕过）
  const specialCL = response.headers.get('content-length');
  if (specialCL && parseInt(specialCL, 10) > MAX_DETAIL_BODY_BYTES) {
    throw new Error('详情响应体过大');
  }

  if (!response.ok) {
    throw new Error(`详情页请求失败: ${response.status}`);
  }

  const specialBody = await readBodyWithLimit(response, MAX_DETAIL_BODY_BYTES);
  if (specialBody === null) {
    throw new Error('详情响应体过大');
  }
  const html = new TextDecoder().decode(specialBody);
  let matches: string[] = [];

  if (apiSite.key === 'ffzy') {
    const ffzyPattern =
      /\$(https?:\/\/[^"'\s]+?\/\d{8}\/\d+_[a-f0-9]+\/index\.m3u8)/g;
    matches = html.match(ffzyPattern) || [];
  }

  if (matches.length === 0) {
    const generalPattern = /\$(https?:\/\/[^"'\s]+?\.m3u8)/g;
    matches = html.match(generalPattern) || [];
  }

  // 去重并清理链接前缀
  matches = Array.from(new Set(matches)).map((link: string) => {
    link = link.substring(1); // 去掉开头的 $
    const parenIndex = link.indexOf('(');
    return parenIndex > 0 ? link.substring(0, parenIndex) : link;
  });

  // 提取标题
  const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
  const titleText = titleMatch ? titleMatch[1].trim() : '';

  // 提取描述
  const descMatch = html.match(
    /<div[^>]*class=["']sketch["'][^>]*>([\s\S]*?)<\/div>/
  );
  const descText = descMatch ? cleanHtmlTags(descMatch[1]) : '';

  // 提取封面
  const coverMatch = html.match(/(https?:\/\/[^"'\s]+?\.jpg)/g);
  const coverUrl = coverMatch ? coverMatch[0].trim() : '';

  // 提取年份
  const yearMatch = html.match(/>(\d{4})</);
  const yearText = yearMatch ? yearMatch[1] : 'unknown';

  return {
    id,
    title: titleText,
    poster: coverUrl,
    episodes: matches,
    source: apiSite.key,
    source_name: apiSite.name,
    class: '',
    year: yearText,
    desc: descText,
    type_name: '',
    douban_id: 0,
  };
}
