/* eslint-disable no-console */

import { NextResponse } from 'next/server';

import { getAvailableApiSites, getCacheTime } from '@/lib/config';
import {
  buildDetailCacheKey,
  getCachedDetail,
  getDetailInflight,
  setCachedDetail,
  setDetailInflight,
} from '@/lib/detailCache';
import { getDetailFromApi } from '@/lib/downstream';
import { reportError } from '@/lib/errorReport';
import { jsonWithCache } from '@/lib/http';
import { containsYellow } from '@/lib/yellow';

export const runtime = 'edge';

export async function GET(request: Request) {
  const clientSignal = request.signal;
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  const sourceCode = searchParams.get('source');

  if (!id || !sourceCode) {
    return NextResponse.json({ error: '缺少必要参数' }, { status: 400 });
  }

  if (!/^[\w-]+$/.test(id)) {
    return NextResponse.json({ error: '无效的视频ID格式' }, { status: 400 });
  }

  try {
    const apiSites = await getAvailableApiSites();
    const apiSite = apiSites.find((site) => site.key === sourceCode);

    if (!apiSite) {
      return NextResponse.json({ error: '无效的API来源' }, { status: 400 });
    }

    // P1: KV 缓存（未绑定时自动降级）
    const cacheKey = buildDetailCacheKey(sourceCode, id);
    const cacheTime = await getCacheTime();
    const cached = await getCachedDetail(cacheKey);
    if (cached) {
      return jsonWithCache(cached, cacheTime, 200, {
        'X-Detail-Cache': 'HIT',
      });
    }

    // single-flight 防击穿
    const inflight = getDetailInflight(cacheKey);
    if (inflight) {
      const shared = await inflight;
      if (shared) {
        return jsonWithCache(shared, cacheTime, 200, {
          'X-Detail-Cache': 'HIT-SHARED',
        });
      }
    }

    // repo-hardening 第 8 项（任务书 001 的 M-05）：整体截止到达时真正
    // abort 上游请求，而不是只返回 504 任由后台请求继续跑。
    const detailAbort = new AbortController();
    const onClientAbort = () => detailAbort.abort();
    if (clientSignal?.aborted) {
      detailAbort.abort();
    } else if (typeof clientSignal?.addEventListener === 'function') {
      clientSignal.addEventListener('abort', onClientAbort, { once: true });
    }
    const upstreamPromise = (async () => {
      const result = await getDetailFromApi(apiSite, id, detailAbort.signal);

      // 黄色词网过滤（与搜索接口对齐，防止绕过）；containsYellow 内部做
      // 小写归一化、去空白与词网（含语境正则）匹配
      const checkText = (result.title || '') + (result.type_name || '');
      if (containsYellow(checkText)) {
        return null;
      }

      // repo-hardening 第 7 项：返回前等待缓存写入完成。
      // 旧实现 fire-and-forget（.catch 吞错但不 await、也无 waitUntil），
      // 响应返回后该异步工作可能被运行时取消，缓存实际没写进去；
      // 改为 await 落地后才返回，失败仍吞错不影响响应内容。
      await setCachedDetail(cacheKey, result).catch(() => {});
      return result;
    })();
    setDetailInflight(cacheKey, upstreamPromise);

    // R5: 详情整体截止时间 25s（上游单次 10s + 1 次重试，整体不无限等）
    const DETAIL_TOTAL_TIMEOUT_MS = 25000;
    let timedOut = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<null>((resolve) => {
      deadlineTimer = setTimeout(() => {
        timedOut = true;
        resolve(null);
      }, DETAIL_TOTAL_TIMEOUT_MS);
    });
    let result: Awaited<typeof upstreamPromise>;
    try {
      result = await Promise.race([upstreamPromise, timeoutPromise]);
    } finally {
      // 竞速落定后必须清掉截止定时器（超时已触发时 clear 为无操作）：
      // 旧实现从不清理，成功路径每次都遗留一个最长 25s 的无用定时器
      // （生产无谓句柄占用；也是 Jest worker 无法退出的根因，诊断
      // 2026-10-24 已定位）。截止语义与超时行为不变。
      clearTimeout(deadlineTimer);
      if (typeof clientSignal?.removeEventListener === 'function') {
        clientSignal.removeEventListener('abort', onClientAbort);
      }
    }
    if (timedOut) {
      // M-05 真取消：通知下游中止 fetch 与响应体读取（共享同一 inflight
      // 的并发请求会随之失败，属超时场景下可接受的降级）
      detailAbort.abort();
      return NextResponse.json({ error: '详情请求超时' }, { status: 504 });
    }
    if (!result) {
      return NextResponse.json({ error: '内容不可用' }, { status: 451 });
    }

    // QUALITY-R3: 缓存头拼写收敛到 jsonWithCache
    return jsonWithCache(result, cacheTime, 200, {
      'X-Detail-Cache': 'MISS',
    });
  } catch (error) {
    // 不泄露上游错误原文，记录到服务端日志 + 上报
    console.error('详情获取失败:', error);
    reportError('api/detail', error);
    return NextResponse.json(
      { error: '详情获取失败' },
      { status: 500 }
    );
  }
}
