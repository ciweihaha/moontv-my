/* eslint-disable no-console */

/**
 * O1: 错误上报到 webhook（可选）。
 *
 * 配置 ERROR_WEBHOOK_URL 环境变量后，关键路径的 catch 中调用 reportError()，
 * 错误会被 POST 到 webhook（飞书/钉钉/Telegram Bot 均可）。
 * 未配置时静默跳过；上报失败不影响主流程。
 */

interface ErrorPayload {
  service: string;
  message: string;
  stack?: string;
  url?: string;
  time: string;
}

let webhookUrl: string | null | undefined;

function getWebhookUrl(): string | null {
  if (webhookUrl === undefined) {
    webhookUrl = process.env.ERROR_WEBHOOK_URL || null;
  }
  return webhookUrl;
}

/**
 * 上报错误到 webhook。fire-and-forget，失败静默。
 */
export function reportError(
  service: string,
  error: unknown,
  extra?: { url?: string }
): void {
  const url = getWebhookUrl();
  if (!url) return;

  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack?.slice(0, 2000) : undefined;

  const payload: ErrorPayload = {
    service,
    message: message.slice(0, 500),
    stack,
    url: extra?.url?.slice(0, 300),
    time: new Date().toISOString(),
  };

  // fire-and-forget：不 await，不阻塞主流程
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      msgtype: 'text',
      text: {
        content: `[MoonTV 告警] ${payload.service}\n${payload.message}\n${payload.time}`,
      },
      // 兼容 Telegram Bot / 通用 webhook：同时发纯文本字段
      text_plain: `[MoonTV] ${payload.service}: ${payload.message}`,
      ...payload,
    }),
  }).catch((err) => {
    console.error('[errorReport] webhook 上报失败:', err);
  });
}
