/* eslint-disable no-console */

/**
 * S3: 带超时 + 指数退避重试的上游 fetch 封装。
 *
 * 重试策略：
 * - 仅重试网络错误（fetch throw / abort 除外）与 5xx，4xx 不重试
 * - 默认 1 次重试（共 2 次尝试），指数退避 500ms → 1000ms
 * - 每次尝试独立 AbortController 超时，超时不重试（上游 hang 住时快速失败）
 *
 * 注意：仅用于幂等 GET 请求。
 */

export interface FetchRetryOptions {
  /** 单次尝试超时毫秒，默认 8000 */
  timeoutMs?: number;
  /** 重试次数，默认 1（共 2 次尝试） */
  retries?: number;
  /** 初始退避毫秒，默认 500 */
  backoffMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_RETRIES = 1;
const DEFAULT_BACKOFF_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 判断是否值得重试：网络错误或 5xx */
function isRetryable(error: unknown, response?: Response): boolean {
  if (response) {
    return response.status >= 500 && response.status < 600;
  }
  // fetch throw：AbortError（超时）不重试，其他网络错误重试
  if (error instanceof Error && error.name === 'AbortError') {
    return false;
  }
  return true;
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  options: FetchRetryOptions = {}
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;

  // AUDIT-R3 P1: 支持外部取消信号（如搜索整体超时）。
  // 外部 signal abort 时，内部 controller 也 abort，正在进行的请求被取消。
  const externalSignal = init.signal as AbortSignal | undefined;

  let lastError: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    // 外部已取消则直接退出，不再发起新尝试
    if (externalSignal?.aborted) {
      throw new Error('fetchWithRetry: 外部取消');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    // 外部取消 → 内部取消
    const onExternalAbort = () => controller.abort();
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timeoutId);
      externalSignal?.removeEventListener('abort', onExternalAbort);

      if (response.ok || !isRetryable(null, response)) {
        return response;
      }
      // 5xx：记下准备重试
      lastError = new Error(`upstream ${response.status}`);
    } catch (error) {
      clearTimeout(timeoutId);
      externalSignal?.removeEventListener('abort', onExternalAbort);
      lastError = error;
      if (!isRetryable(error)) {
        throw error;
      }
      // 外部取消不重试
      if (externalSignal?.aborted) {
        throw error;
      }
    }

    if (attempt < retries) {
      const delay = backoffMs * Math.pow(2, attempt);
      console.warn(
        `[fetchRetry] ${url.slice(0, 80)} 尝试 ${attempt + 1} 失败，${delay}ms 后重试`
      );
      await sleep(delay);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('fetchWithRetry: 所有重试均失败');
}
