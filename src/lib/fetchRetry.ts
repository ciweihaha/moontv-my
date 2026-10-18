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

  let lastError: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timeoutId);

      if (response.ok || !isRetryable(null, response)) {
        return response;
      }
      // 5xx：记下准备重试
      lastError = new Error(`upstream ${response.status}`);
    } catch (error) {
      clearTimeout(timeoutId);
      lastError = error;
      if (!isRetryable(error)) {
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
