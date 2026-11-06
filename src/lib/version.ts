/* eslint-disable no-console */

'use client';

const CURRENT_VERSION = '20261101234725';

// 版本检查结果枚举
export enum UpdateStatus {
  HAS_UPDATE = 'has_update', // 有新版本
  NO_UPDATE = 'no_update', // 无新版本
  FETCH_FAILED = 'fetch_failed', // 获取失败
}

// 远程版本检查URL配置
// O2: 上游 senshinya/MoonTV 已停更（2025-08），改为检查自己的仓库
const VERSION_CHECK_URLS = [
  'https://ghfast.top/raw.githubusercontent.com/ciweihaha/moontv-my/main/VERSION.txt',
  'https://raw.githubusercontent.com/ciweihaha/moontv-my/main/VERSION.txt',
];

/**
 * 检查是否有新版本可用
 * @returns Promise<UpdateStatus> - 返回版本检查状态
 */
export async function checkForUpdates(options?: {
  timeoutMs?: number;
}): Promise<UpdateStatus> {
  try {
    // 尝试从主要URL获取版本信息
    const primaryVersion = await fetchVersionFromUrl(
      VERSION_CHECK_URLS[0],
      options
    );
    if (primaryVersion) {
      return compareVersions(primaryVersion);
    }

    // 如果主要URL失败，尝试备用URL
    const backupVersion = await fetchVersionFromUrl(
      VERSION_CHECK_URLS[1],
      options
    );
    if (backupVersion) {
      return compareVersions(backupVersion);
    }

    // 如果两个URL都失败，返回获取失败状态
    return UpdateStatus.FETCH_FAILED;
  } catch (error) {
    console.error('版本检查失败:', error);
    return UpdateStatus.FETCH_FAILED;
  }
}

/** VERSION.txt 只是 14 位时间戳版本号，正常只有十几个字节；4KB 上限已留足余量。 */
const MAX_VERSION_BODY_BYTES = 4 * 1024;

/**
 * 流式读响应体为文本并做字节数硬上限（与服务端 readBodyWithLimit 同语义的客户端版）。
 *
 * 不能直接复用 src/lib/downstream 的 readBodyWithLimit：downstream →
 * config → db → d1.db 会把服务端存储代码拖进客户端 bundle；本函数
 * 零依赖，可安全用于 'use client' 模块。
 */
async function readTextWithLimit(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal
): Promise<string | null> {
  // 无 body 流的降级路径（极少数环境）：整块读后校验字节数
  if (!response.body) {
    const buf = await response.arrayBuffer();
    if (buf.byteLength > maxBytes) {
      return null;
    }
    return new TextDecoder().decode(buf);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      // 外部取消（整体超时）时立即停止读取
      if (signal?.aborted) {
        await reader.cancel().catch(() => undefined);
        throw new DOMException('Aborted', 'AbortError');
      }
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        // 超上限：取消上游流，不再继续读
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  // 合并分块后解码
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(result);
}

/**
 * 从指定URL获取版本信息
 * @param url - 版本信息URL
 * @returns Promise<string | null> - 版本字符串或null
 */
export async function fetchVersionFromUrl(
  url: string,
  options?: { timeoutMs?: number }
): Promise<string | null> {
  const controller = new AbortController();
  const timeoutMs = options?.timeoutMs ?? 5000; // 5秒超时
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'Content-Type': 'text/plain',
      },
    });

    if (!response.ok) {
      // 非 200：取消响应体再抛错，避免悬着的流占用连接（与 doubanCategories 同口径）
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    // 超时覆盖读体全过程：旧实现在 fetch 返回（仅收到响应头）后立即
    // clearTimeout，随后的 response.text() 不再受约束——响应体停滞时
    // promise 永远不 settle，调用方 useEffect 的 setIsChecking(false)
    // 走不到，顺序回退的备用 URL 也永远等不到。现改用流式限长读取，
    // 超时信号透传进读取循环，读完/超限/取消后才清定时器。
    const version = await readTextWithLimit(
      response,
      MAX_VERSION_BODY_BYTES,
      controller.signal
    );
    if (version === null) {
      console.warn(
        `从 ${url} 获取版本信息失败: 响应体超过 ${MAX_VERSION_BODY_BYTES} 字节`
      );
      return null;
    }
    return version.trim();
  } catch (error) {
    console.warn(`从 ${url} 获取版本信息失败:`, error);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 比较版本号
 * @param remoteVersion - 远程版本号
 * @returns UpdateStatus - 返回版本比较结果
 */
function compareVersions(remoteVersion: string): UpdateStatus {
  try {
    // 将版本号转换为数字进行比较
    const current = parseInt(CURRENT_VERSION, 10);
    const remote = parseInt(remoteVersion, 10);

    return remote > current ? UpdateStatus.HAS_UPDATE : UpdateStatus.NO_UPDATE;
  } catch (error) {
    console.error('版本比较失败:', error);
    return UpdateStatus.FETCH_FAILED;
  }
}

// 导出当前版本号供其他地方使用
export { CURRENT_VERSION };
