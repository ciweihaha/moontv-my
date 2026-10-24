/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { db } from '@/lib/db';
import { reportError } from '@/lib/errorReport';
import { fetchVideoDetail } from '@/lib/fetchVideoDetail';
import { constantTimeEqual } from '@/lib/rateLimit';
import { SearchResult } from '@/lib/types';

export const runtime = 'edge';

export async function GET(request: NextRequest) {
  try {
    // SEC-R5: cron 接口认证。配置 CRON_SECRET 环境变量后，调用方必须携带
    // Authorization: Bearer <secret> 或 ?secret=<secret>；未配置时放行并告警（兼容旧部署）
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) {
      const authHeader = request.headers.get('authorization');
      const querySecret = new URL(request.url).searchParams.get('secret');
      const provided =
        (authHeader?.startsWith('Bearer ')
          ? authHeader.slice(7).trim()
          : '') || querySecret || '';
      if (!constantTimeEqual(provided, cronSecret)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    } else {
      console.warn(
        '警告: 未配置 CRON_SECRET，/api/cron 允许匿名触发，建议配置后加强防护'
      );
    }

    // O4: 结构化日志，方便过滤和告警
    const startTime = Date.now();
    console.log(
      JSON.stringify({
        event: 'cron_start',
        time: new Date().toISOString(),
      })
    );

    const stats = await refreshRecordAndFavorites();

    const durationMs = Date.now() - startTime;
    console.log(
      JSON.stringify({
        event: 'cron_done',
        durationMs,
        ...stats,
        time: new Date().toISOString(),
      })
    );

    // success 是任务级语义（cron 已执行完一轮）；局部失败不再被它掩盖，
    // 细节看 stats.scanned/succeeded/skippedCount/failed 与 terminatedEarly
    // （repo-hardening 第 15 项）。
    return NextResponse.json({
      success: true,
      message: 'Cron job executed successfully',
      timestamp: new Date().toISOString(),
      stats,
    });
  } catch (error) {
    console.error('Cron job failed:', error);
    // O4: 失败上报到 webhook
    reportError('api/cron', error);

    return NextResponse.json(
      {
        success: false,
        message: 'Cron job failed',
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}

interface CronRefreshStats {
  users: number;
  skipped: boolean;
  /** 实际进入处理流程的条目数（播放记录 + 收藏） */
  scanned: number;
  /** 处理完成（详情比对/更新走完）的条目数 */
  succeeded: number;
  /** 因键无效或详情不可用而跳过的条目数 */
  skippedCount: number;
  /** 处理抛错的条目数 */
  failed: number;
  /** 详情上游成功次数（按 detailCache key 去重后计） */
  detailOk: number;
  /** 详情上游失败次数（按 detailCache key 去重后计） */
  detailFailed: number;
  /** 是否因软性执行预算提前终止 */
  terminatedEarly: boolean;
}

function emptyStats(users: number, skipped: boolean): CronRefreshStats {
  return {
    users,
    skipped,
    scanned: 0,
    succeeded: 0,
    skippedCount: 0,
    failed: 0,
    detailOk: 0,
    detailFailed: 0,
    terminatedEarly: false,
  };
}

async function refreshRecordAndFavorites(): Promise<CronRefreshStats> {
  if (
    (process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage') === 'localstorage'
  ) {
    console.log('跳过刷新：当前使用 localstorage 存储模式');
    return emptyStats(0, true);
  }

  const stats = emptyStats(0, false);
  try {
    const users = await db.getAllUsers();
    if (process.env.USERNAME && !users.includes(process.env.USERNAME)) {
      users.push(process.env.USERNAME);
    }
    stats.users = users.length;

    // repo-hardening 第 15 项：软性执行预算。cron 在部分平台有执行时长
    // 上限，与其被平台硬杀导致整轮无统计，不如到点停开新记录、如实上报。
    // 可由 CRON_BUDGET_MS 覆盖（毫秒），默认 120 秒。
    const execStart = Date.now();
    const budgetMs = (() => {
      const v = parseInt(process.env.CRON_BUDGET_MS || '', 10);
      return Number.isFinite(v) && v >= 0 ? v : 120_000;
    })();
    const overBudget = (): boolean => Date.now() - execStart >= budgetMs;

    // 函数级缓存：key 为 `${source}+${id}`，值为 Promise<VideoDetail | null>
    const detailCache = new Map<string, Promise<SearchResult | null>>();

    // 获取详情 Promise（带缓存和错误处理）
    // repo-hardening 第 14 项：Promise 一创建就入缓存——同 key 的并发/后续
    // 调用共享同一次上游请求，且失败的已 settle null 结果同样被缓存，
    // 避免同一次 cron 执行内对同一故障详情反复回源。旧实现只在成功后
    // 才回写一个已 resolve 的 Promise，失败完全不缓存。
    // 作用域仅限本次执行（函数级 Map），不跨运行、不永久缓存。
    const getDetail = (
      source: string,
      id: string,
      fallbackTitle: string
    ): Promise<SearchResult | null> => {
      const key = `${source}+${id}`;
      let promise = detailCache.get(key);
      if (!promise) {
        promise = fetchVideoDetail({
          source,
          id,
          fallbackTitle: fallbackTitle.trim(),
          skipSearch: true, // P1-5: cron 直查详情，不浪费搜索请求
        })
          .then((detail) => {
            stats.detailOk++;
            return detail;
          })
          .catch((err) => {
            stats.detailFailed++;
            console.error(`获取视频详情失败 (${source}+${id}):`, err);
            return null;
          });
        detailCache.set(key, promise);
      }
      return promise;
    };

    // 单条条目的处理结果（供统计计数）
    type EntryOutcome = 'ok' | 'skip';

    for (const user of users) {
      if (overBudget()) {
        stats.terminatedEarly = true;
        console.warn('cron 执行预算已用完，提前终止（用户循环）');
        break;
      }
      console.log(`开始处理用户: ${user}`);

      // 播放记录
      // P1-4: 批次并发（5 并发），避免串行 HTTP 超时
      try {
        const playRecords = await db.getAllPlayRecords(user);
        const entries = Object.entries(playRecords);
        const totalRecords = entries.length;
        let processedRecords = 0;

        const CONCURRENCY = 5;
        for (let i = 0; i < entries.length; i += CONCURRENCY) {
          if (overBudget()) {
            stats.terminatedEarly = true;
            console.warn('cron 执行预算已用完，提前终止（播放记录）');
            break;
          }
          const batch = entries.slice(i, i + CONCURRENCY);
          const results = await Promise.allSettled(
            batch.map(async ([key, record]): Promise<EntryOutcome> => {
              stats.scanned++;
              const [source, id] = key.split('+');
              if (!source || !id) {
                console.warn(`跳过无效的播放记录键: ${key}`);
                return 'skip';
              }
              const detail = await getDetail(source, id, record.title);
              if (!detail) {
                console.warn(`跳过无法获取详情的播放记录: ${key}`);
                return 'skip';
              }
              const episodeCount = detail.episodes?.length || 0;
              if (episodeCount > 0 && episodeCount !== record.total_episodes) {
                await db.savePlayRecord(user, source, id, {
                  title: detail.title || record.title,
                  source_name: record.source_name,
                  cover: detail.poster || record.cover,
                  index: record.index,
                  total_episodes: episodeCount,
                  play_time: record.play_time,
                  year: detail.year || record.year,
                  total_time: record.total_time,
                  save_time: record.save_time,
                  search_title: record.search_title,
                });
                console.log(
                  `更新播放记录: ${record.title} (${record.total_episodes} -> ${episodeCount})`
                );
              }
              return 'ok';
            })
          );
          for (const r of results) {
            if (r.status === 'fulfilled') {
              processedRecords++;
              if (r.value === 'ok') stats.succeeded++;
              else stats.skippedCount++;
            } else {
              stats.failed++;
              console.error('处理播放记录失败:', r.reason);
            }
          }
        }

        console.log(`播放记录处理完成: ${processedRecords}/${totalRecords}`);
      } catch (err) {
        console.error(`获取用户播放记录失败 (${user}):`, err);
      }

      // 收藏
      // P1-4: 批次并发（5 并发），避免串行 HTTP 超时
      try {
        const favorites = await db.getAllFavorites(user);
        const favEntries = Object.entries(favorites);
        const totalFavorites = favEntries.length;
        let processedFavorites = 0;

        const CONCURRENCY = 5;
        for (let i = 0; i < favEntries.length; i += CONCURRENCY) {
          if (overBudget()) {
            stats.terminatedEarly = true;
            console.warn('cron 执行预算已用完，提前终止（收藏）');
            break;
          }
          const batch = favEntries.slice(i, i + CONCURRENCY);
          const results = await Promise.allSettled(
            batch.map(async ([key, fav]): Promise<EntryOutcome> => {
              stats.scanned++;
              const [source, id] = key.split('+');
              if (!source || !id) {
                console.warn(`跳过无效的收藏键: ${key}`);
                return 'skip';
              }
              const favDetail = await getDetail(source, id, fav.title);
              if (!favDetail) {
                console.warn(`跳过无法获取详情的收藏: ${key}`);
                return 'skip';
              }
              const favEpisodeCount = favDetail.episodes?.length || 0;
              if (favEpisodeCount > 0 && favEpisodeCount !== fav.total_episodes) {
                await db.saveFavorite(user, source, id, {
                  title: favDetail.title || fav.title,
                  source_name: fav.source_name,
                  cover: favDetail.poster || fav.cover,
                  year: favDetail.year || fav.year,
                  total_episodes: favEpisodeCount,
                  save_time: fav.save_time,
                  search_title: fav.search_title,
                });
                console.log(
                  `更新收藏: ${fav.title} (${fav.total_episodes} -> ${favEpisodeCount})`
                );
              }
              return 'ok';
            })
          );
          for (const r of results) {
            if (r.status === 'fulfilled') {
              processedFavorites++;
              if (r.value === 'ok') stats.succeeded++;
              else stats.skippedCount++;
            } else {
              stats.failed++;
              console.error('处理收藏失败:', r.reason);
            }
          }
        }

        console.log(`收藏处理完成: ${processedFavorites}/${totalFavorites}`);
      } catch (err) {
        console.error(`获取用户收藏失败 (${user}):`, err);
      }
    }

    console.log('刷新播放记录/收藏任务完成');
    return stats;
  } catch (err) {
    console.error('刷新播放记录/收藏任务启动失败', err);
    reportError('api/cron/refresh', err);
    return stats;
  }
}
