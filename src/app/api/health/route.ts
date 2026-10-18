/* eslint-disable no-console */

import { NextResponse } from 'next/server';

import { getSearchKV } from '@/lib/kv';

export const runtime = 'edge';

/**
 * O3: 深度健康检查，供 UptimeFlare / 监控系统调用。
 * 不鉴权（只暴露组件状态，不暴露敏感信息）。
 */
export async function GET() {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};

  // KV 绑定检查
  try {
    const kv = getSearchKV();
    checks.kv = kv
      ? { ok: true, detail: 'SEARCH_KV bound' }
      : { ok: true, detail: 'SEARCH_KV not bound (cache disabled, degraded)' };
  } catch (error) {
    checks.kv = {
      ok: false,
      detail: error instanceof Error ? error.message : 'unknown',
    };
  }

  // 存储类型
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  checks.storage = { ok: true, detail: storageType };

  // 关键环境变量
  const hasCronSecret = !!process.env.CRON_SECRET;
  const hasErrorWebhook = !!process.env.ERROR_WEBHOOK_URL;
  checks.config = {
    ok: true,
    detail: `cron_secret=${hasCronSecret ? 'set' : 'unset'},error_webhook=${hasErrorWebhook ? 'set' : 'unset'}`,
  };

  const allOk = Object.values(checks).every((c) => c.ok);

  return NextResponse.json(
    {
      status: allOk ? 'healthy' : 'degraded',
      time: new Date().toISOString(),
      checks,
    },
    { status: allOk ? 200 : 503 }
  );
}
