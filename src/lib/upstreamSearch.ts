import {
  recordUpstreamFailure,
  recordUpstreamSuccess,
  shouldSkipUpstream,
} from '@/lib/circuitBreaker';
import { getConfig } from '@/lib/config';
import { searchFromApi } from '@/lib/downstream';
import { SearchResult } from '@/lib/types';
import { containsYellow } from '@/lib/yellow';

type ApiSiteEntry = Awaited<ReturnType<typeof getConfig>>['SourceConfig'][number];

/**
 * HARDENING-001 M-03: doUpstreamSearch 的返回契约。
 * partial=true 表示总超时截断（或异常兜底），results 可能不完整，
 * 调用方不得按完整结果缓存/呈现为完整结果。
 */
export interface UpstreamSearchOutcome {
  results: SearchResult[];
  partial: boolean;
}

/** M-03: 部分结果写 KV 的短 TTL（秒） */
export const SEARCH_PARTIAL_CACHE_TTL_SECONDS = 60;

/** 2026-10-25 OrionTV 搜索整理：去重 + 相关度排序（纯函数，不删条目）。 */
const SEARCH_DEMOTE_RE = /电影解说|解说|预告|幕后|花絮|特辑/;
function normSearchTitle(title: string): string {
  return String(title || '')
    .replace(/\s+/g, '')
    .replace(/[·•・\-–—_]/g, '')
    .replace(/[(（](普通话版|粤语版|国语版|中文版|英文版|国配|粤语|普通话)[)）]$/, '')
    .replace(/(普通话版|粤语版|国语版|中文版|英文版)$/, '')
    .replace(/[()（）\[\]【】《》]/g, '')
    .toLowerCase();
}
function searchTier(title: string, query: string): number {
  const cleanTitle = String(title || '').replace(/[《》\s]/g, '');
  const cleanQuery = String(query || '').replace(/\s/g, '');
  if (!cleanTitle || !cleanQuery) return 0;
  if (cleanTitle === cleanQuery) return 100;
  if (cleanTitle.startsWith(cleanQuery)) return 80;
  if (cleanTitle.includes(cleanQuery)) return 60;
  return 0;
}
export function rankSearchResults(
  results: SearchResult[],
  query: string
): SearchResult[] {
  // 去重：同片名 + 同年份只留第一条（源顺序在前者优先）。同址多源展开
  // 造成的重复、语言版重复都在这里合并成一条，不删任何不同片。
  const seen = new Map<string, SearchResult>();
  for (const item of results) {
    if (!item || !item.title) continue;
    const key = normSearchTitle(item.title) + '|' + String(item.year || '');
    if (!seen.has(key)) seen.set(key, item);
  }
  const scored = Array.from(seen.values()).map((item) => ({
    item,
    tier: searchTier(item.title, query),
    demote: SEARCH_DEMOTE_RE.test(
      String(item.title || '') + ' ' + String(item.type_name || '')
    )
      ? 1
      : 0,
  }));
  // 顺序：相关度层 → 解说/预告/幕后降权（不删）→ 年份降序 → 片名。
  // SearchResult 无豆瓣分字段，故不用评分排序，避免上游注水分数误导。
  scored.sort(
    (a, b) =>
      b.tier - a.tier ||
      a.demote - b.demote ||
      (parseInt(String(b.item.year || ''), 10) || 0) -
        (parseInt(String(a.item.year || ''), 10) || 0) ||
      String(a.item.title || '').localeCompare(
        String(b.item.title || ''),
        'zh'
      )
  );
  return scored.map((x) => x.item);
}

/** 搜索总超时默认值（毫秒） */
const SEARCH_TOTAL_TIMEOUT_MS = 10000;

/** 原搜索主流程下沉为函数：44 上游并行 → 黄词过滤，便于缓存层复用
 * M-03: 导出供回归测试；totalTimeoutMs 可注入（默认 10s，生产行为不变），
 * 返回 {results, partial}，partial 表示总超时截断、结果可能不完整。 */
export async function doUpstreamSearch(
  sitesByApi: Map<string, ApiSiteEntry[]>,
  query: string,
  maxSearchPages: number,
  disableYellowFilter: boolean | undefined,
  totalTimeoutMs: number = SEARCH_TOTAL_TIMEOUT_MS
): Promise<UpstreamSearchOutcome> {
  // AUDIT-R2: 全局并发上限，避免首次搜索对数十个上游同时发起请求形成峰值
  const CONCURRENCY_LIMIT = 10;
  // AUDIT-R2: 增量收集已完成结果，总超时到达时返回部分结果而非空数组
  // 结果组保留其源分组索引：各组完成时序随网络时延变化，汇总时按索引
  // 排序再展开，保证同一查询的来源排列顺序确定（与源顺序一致）
  const completedChunks: Array<{ index: number; results: SearchResult[] }> = [];
  // AUDIT-R3 P1: 整体取消控制器，超时后取消所有后台上游请求
  const abortController = new AbortController();

  /** 已收集结果按源分组索引升序展开（完成时序不影响最终顺序） */
  function orderedResults(): SearchResult[] {
    return completedChunks
      .slice()
      .sort((a, b) => a.index - b.index)
      .flatMap((chunk) => chunk.results);
  }

  async function searchOneGroup(
    sites: ApiSiteEntry[],
    groupIndex: number
  ): Promise<void> {
    // 已取消则直接退出
    if (abortController.signal.aborted) return;
    // R2-S5: 熔断器——连续失败的上游短暂跳过，不拖慢整体
    const apiKey = sites[0].api;
    if (shouldSkipUpstream(apiKey)) {
      return;
    }
    // 用组内第一个站点作为代表发起请求（PERF-R1: 页数一次传入，避免重复读配置）
    try {
      // M-02: searchFromApi 新契约——失败（重试耗尽/5xx/网络等）抛
      // SearchUpstreamError，只有 HTTP 200（含空列表）才 resolve，
      // 因此 resolve 记 success、reject 记 failure，熔断不再被吞错架空
      const results = await searchFromApi(sites[0], query, maxSearchPages, abortController.signal);
      recordUpstreamSuccess(apiKey);
      // 结果展开回组内每个站点，保留各自的 source key 和 source_name
      const expanded = sites.flatMap((site) =>
        results.map((r) => ({ ...r, source: site.key, source_name: site.name }))
      );
      completedChunks.push({ index: groupIndex, results: expanded });
    } catch {
      // 熔断计数规则（与单源路由 searchOne.ts 同口径：总超时即记失败）：
      // 干净失败（源自身单次超时/5xx/网络/解析）与总截止取消（组在
      // 总超时到达时仍在途）一律记失败。理由：①在途组已耗尽本次
      // 搜索预算而未交付，无论挂死还是起步晚，都无法在预算内交付
      // ——正是熔断器要隔离的形态；②未起步的组（入口处 aborted
      // 早退）不记，每搜索每组至多记 1 次；③阈值 3 要求连续 3 次
      // 搜索都被截断才跳过，单次慢搜索不致误熔断；④60s 后半开试探
      // 恢复，成功清零、失败重熔断。旧实现以 signal.aborted 为界
      // 不记取消，导致永久挂起源永不熔断（干净失败恰好撞上总超时
      // 时也会漏记）。
      recordUpstreamFailure(apiKey);
      // 单组失败不影响其他组（原 Promise.allSettled 语义）
    }
  }

  // 简单 worker 池：限制同时进行的上游请求数
  async function runWithConcurrencyLimit(): Promise<void> {
    const groups = Array.from(sitesByApi.values());
    let nextIndex = 0;
    async function worker(): Promise<void> {
      while (nextIndex < groups.length) {
        // 检查取消
        if (abortController.signal.aborted) break;
        const i = nextIndex++;
        await searchOneGroup(groups[i], i);
      }
    }
    const workers = Array.from(
      { length: Math.min(CONCURRENCY_LIMIT, groups.length) },
      () => worker()
    );
    await Promise.all(workers);
  }

  // M-03: 总超时是否先于全部上游完成触发（决定 partial 标记）
  let timedOut = false;
  try {
    // P2-5/AUDIT-R2: 总超时 10s；超时后返回已完成的部分结果，不再等最慢上游，
    // 也不丢弃已拿到的数据（修复原来超时返回空数组与注释不一致的问题）
    // AUDIT-R3 P1: 超时后 abort，取消所有后台上游请求，不再消耗资源
    const allDone = runWithConcurrencyLimit();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        abortController.abort();
        resolve();
      }, totalTimeoutMs);
    });
    try { await Promise.race([allDone, timeout]); } finally { if (timer) clearTimeout(timer); }
    // 无论 race 完成还是抛错，finally 都清掉定时器，避免悬挂的 10s 定时器拖住进程/测试
    

    const flattenedResults: SearchResult[] = orderedResults();
    if (flattenedResults.length === 0) {
      return { results: [], partial: timedOut };
    }
    // 2026-10-25：先去重排序再过黄词过滤（过滤不改变顺序）。
    const rankedResults = rankSearchResults(flattenedResults, query);
    if (disableYellowFilter) {
      return { results: rankedResults, partial: timedOut };
    }
    return {
      results: rankedResults.filter((result) => {
        // 与详情接口对齐：同时检查 title + type_name；containsYellow 内部做
        // 小写归一化、去空白与词网（含语境正则）匹配
        const checkText = (result.title || '') + (result.type_name || '');
        return !containsYellow(checkText);
      }),
      partial: timedOut,
    };
  } catch {
    // 异常兜底：返回已收集的部分结果，并保守按 partial 处理（不写长 TTL）
    return { results: orderedResults(), partial: true };
  }
}
