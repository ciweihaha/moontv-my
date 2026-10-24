/* eslint-disable no-console */

/**
 * S3: 带超时 + 指数退避重试的上游 fetch 封装。
 *
 * 重试策略：
 * - 仅重试网络错误（fetch throw / abort 除外）与 5xx，4xx 不重试
 * - 默认 1 次重试（共 2 次尝试），指数退避 500ms → 1000ms
 * - 每次尝试独立 AbortController 超时，超时不重试（上游 hang 住时快速失败）
 * - 超时覆盖「响应头 + 响应体读取」全过程（repo-hardening 第 8 项）：
 *   返回的 Response 体被跟踪，读完/取消前计时器保持生效；
 *   5xx 重试前会先 cancel 上一响应体释放连接。
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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve(); return new Promise((resolve) => { let timer: ReturnType<typeof setTimeout>; const onAbort = () => { clearTimeout(timer); resolve(); }; timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms); signal?.addEventListener('abort', onAbort, { once: true }); });
}

/**
 * 超时类错误名集合：AbortError（fetch abort，含跨 realm DOMException）
 * 与 TimeoutError（AbortSignal.timeout 等同族超时）。仅按名判断，
 * 不依赖 instanceof——真实 abort 拒绝的原型链随 realm 而异
 * （DOMException 在部分运行时不继承 Error；跨 realm 时 instanceof
 * 全数失效），旧谓词因此从未拦住过真实超时错误。
 * 注意：代码库当前实际产生的超时错误名只有 AbortError；TimeoutError
 * 按同族超时意图一并纳入，不扩大到网络错误（TypeError 等）与 5xx。
 */
const TIMEOUT_ERROR_NAMES = new Set(['AbortError', 'TimeoutError']);

/** 是否超时类错误：只读 .name，不触原型链 */
function isTimeoutError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return TIMEOUT_ERROR_NAMES.has((error as { name?: unknown }).name as string);
}

/** 判断是否值得重试：网络错误或 5xx */
function isRetryable(error: unknown, response?: Response): boolean {
  if (response) {
    return response.status >= 500 && response.status < 600;
  }
  // fetch throw：超时不重试，其他网络错误重试
  if (isTimeoutError(error)) {
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

    // repo-hardening 第 8 项：计时器与外部监听的清理时机改为「响应体读完/
    // 被取消」而非「拿到响应头」。旧实现 clearTimeout 在 fetch 返回后立即
    // 执行，上游响应头及时、响应体永不结束时读取无限挂住、超时失效。
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearTimeout(timeoutId);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    };

    try {
      const response = await fetch(url, { ...init, signal: controller.signal });

      if (response.ok || !isRetryable(null, response)) {
        if (!response.body) {
          cleanup();
          return response;
        }
        // 成功/不可重试：把原始响应体包一层跟踪流——读完、出错或被取消时
        // 才清理计时器；体读取阶段超时到达时 controller.abort() 会让
        // 底层 reader.read() 立即 reject，不再无限挂住。
        const reader = response.body.getReader();
        const trackedBody = new ReadableStream<Uint8Array>({
          async pull(c) {
            try {
              const { done, value } = await reader.read();
              if (done) {
                cleanup();
                c.close();
              } else if (value) {
                c.enqueue(value);
              }
            } catch (e) {
              cleanup();
              c.error(e);
            }
          },
          async cancel(reason) {
            cleanup();
            try {
              await reader.cancel(reason);
            } catch {
              /* 取消失败无妨，资源由运行时回收 */
            }
          },
        });
        return new Response(trackedBody, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
      // 5xx：重试前先取消上一响应体，释放连接/句柄，再记错准备重试
      cleanup();
      try {
        await response.body?.cancel();
      } catch {
        /* 取消失败无妨 */
      }
      lastError = new Error(`upstream ${response.status}`);
    } catch (error) {
      cleanup();
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
      await sleep(delay, externalSignal);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('fetchWithRetry: 所有重试均失败');
}
