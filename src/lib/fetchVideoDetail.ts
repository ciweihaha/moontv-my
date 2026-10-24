import { getAvailableApiSites, getConfig } from '@/lib/config';
import { SearchResult } from '@/lib/types';

import { getDetailFromApi, searchFromApi } from './downstream';

interface FetchVideoDetailOptions {
  source: string;
  id: string;
  fallbackTitle?: string;
  // P1-5: cron 场景下 source+id 已知，跳过搜索直查详情，省 1~2 个上游请求
  skipSearch?: boolean;
}

/**
 * 根据 source 与 id 获取视频详情。
 * 1. 若传入 fallbackTitle，则先调用 /api/search 搜索精确匹配。
 * 2. 若搜索未命中或未提供 fallbackTitle，则直接调用 /api/detail。
 */
export async function fetchVideoDetail({
  source,
  id,
  fallbackTitle = '',
  skipSearch = false,
}: FetchVideoDetailOptions): Promise<SearchResult> {
  // S4: 整体 15s 超时兜底（下游各有 8s/10s 单超时，此处防整体 hanging）
  // repo-hardening 第 8 项（M-05）：超时时真正 abort 下游请求，
  // 而不是只让外层 race 抛错、后台请求继续占用资源。
  const timeoutMs = 15000;
  const abortController = new AbortController();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => {
      abortController.abort();
      reject(new Error('fetchVideoDetail 总超时'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      doFetchVideoDetail({
        source,
        id,
        fallbackTitle,
        skipSearch,
        signal: abortController.signal,
      }),
      timeoutPromise,
    ]);
  } finally {
    // 竞速落定后必须清掉截止定时器（超时已触发时 clear 为无操作）：
    // 旧实现从不清理，成功/失败路径每次调用都遗留一个最长 15s 的
    // 无用定时器（生产句柄占用；Jest worker 退出滞留的 src/lib 分区
    // 残余候选）。超时语义与返回结构不变。
    clearTimeout(deadlineTimer);
  }
}

async function doFetchVideoDetail({
  source,
  id,
  fallbackTitle = '',
  skipSearch = false,
  signal,
}: FetchVideoDetailOptions & { signal?: AbortSignal }): Promise<SearchResult> {
  // 优先通过搜索接口查找精确匹配
  const apiSites = await getAvailableApiSites();
  const apiSite = apiSites.find((site) => site.key === source);
  if (!apiSite) {
    throw new Error('无效的API来源');
  }
  if (fallbackTitle && !skipSearch) {
    try {
      // PERF-R1: 最大搜索页数一次传入，避免 searchFromApi 内部重复读取配置
      const config = await getConfig();
      const searchData = await searchFromApi(
        apiSite,
        fallbackTitle.trim(),
        config.SiteConfig.SearchDownstreamMaxPage,
        signal
      );
      const exactMatch = searchData.find(
        (item: SearchResult) =>
          item.source.toString() === source.toString() &&
          item.id.toString() === id.toString()
      );
      if (exactMatch) {
        return exactMatch;
      }
    } catch {
      // do nothing
    }
  }

  // 调用 /api/detail 接口
  const detail = await getDetailFromApi(apiSite, id, signal);
  if (!detail) {
    throw new Error('获取视频详情失败');
  }

  return detail;
}
