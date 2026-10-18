/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { db } from '@/lib/db';
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

    console.log('Cron job triggered:', new Date().toISOString());

    await refreshRecordAndFavorites();

    return NextResponse.json({
      success: true,
      message: 'Cron job executed successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Cron job failed:', error);

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

async function refreshRecordAndFavorites() {
  if (
    (process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage') === 'localstorage'
  ) {
    console.log('跳过刷新：当前使用 localstorage 存储模式');
    return;
  }

  try {
    const users = await db.getAllUsers();
    if (process.env.USERNAME && !users.includes(process.env.USERNAME)) {
      users.push(process.env.USERNAME);
    }
    // 函数级缓存：key 为 `${source}+${id}`，值为 Promise<VideoDetail | null>
    const detailCache = new Map<string, Promise<SearchResult | null>>();

    // 获取详情 Promise（带缓存和错误处理）
    const getDetail = async (
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
            // 成功时才缓存结果
            const successPromise = Promise.resolve(detail);
            detailCache.set(key, successPromise);
            return detail;
          })
          .catch((err) => {
            console.error(`获取视频详情失败 (${source}+${id}):`, err);
            return null;
          });
      }
      return promise;
    };

    for (const user of users) {
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
          const batch = entries.slice(i, i + CONCURRENCY);
          const results = await Promise.allSettled(
            batch.map(async ([key, record]) => {
              const [source, id] = key.split('+');
              if (!source || !id) {
                console.warn(`跳过无效的播放记录键: ${key}`);
                return;
              }
              const detail = await getDetail(source, id, record.title);
              if (!detail) {
                console.warn(`跳过无法获取详情的播放记录: ${key}`);
                return;
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
            })
          );
          for (const r of results) {
            if (r.status === 'fulfilled') processedRecords++;
            else console.error('处理播放记录失败:', r.reason);
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
          const batch = favEntries.slice(i, i + CONCURRENCY);
          const results = await Promise.allSettled(
            batch.map(async ([key, fav]) => {
              const [source, id] = key.split('+');
              if (!source || !id) {
                console.warn(`跳过无效的收藏键: ${key}`);
                return;
              }
              const favDetail = await getDetail(source, id, fav.title);
              if (!favDetail) {
                console.warn(`跳过无法获取详情的收藏: ${key}`);
                return;
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
            })
          );
          for (const r of results) {
            if (r.status === 'fulfilled') processedFavorites++;
            else console.error('处理收藏失败:', r.reason);
          }
        }

        console.log(`收藏处理完成: ${processedFavorites}/${totalFavorites}`);
      } catch (err) {
        console.error(`获取用户收藏失败 (${user}):`, err);
      }
    }

    console.log('刷新播放记录/收藏任务完成');
  } catch (err) {
    console.error('刷新播放记录/收藏任务启动失败', err);
  }
}
