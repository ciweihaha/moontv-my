/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import Hls from 'hls.js';

/**
 * 获取图片代理 URL 设置
 *
 * PERF-R1: localStorage 读取 memo 化。processImageUrl 在每张海报渲染时都会调用，
 * 直接读 localStorage 开销累积明显。用原始字符串做变更检测：设置变化时自动失效，
 * 行为与直接读取完全一致。
 */
let _imgProxyCacheKey = '\0';
let _imgProxyCacheVal: string | null = null;

/**
 * 深查第 7 轮：localStorage 代理开关值解析容错。
 * enableImageProxy / enableDoubanProxy 由用户或旧版本写入，值损坏
 *（如 "yes"、截断写入）时 JSON.parse 抛 SyntaxError；旧实现无
 * try/catch，getImageProxyUrl 在 VideoCard 渲染路径（processImageUrl）
 * 被调用，整页渲染崩溃，getDoubanProxyUrl 同理拖垮豆瓣请求。
 * db.client.ts 与 isImageProxyExplicitlyDisabled 的同类解析均已包
 * try/catch，唯独这两处漏网。损坏值按“未明确关闭”处理（默认启用
 * 代理），与 isImageProxyExplicitlyDisabled 的容错口径一致；
 * 可解析值保持原语义不变。
 */
function parseProxyEnabled(raw: string | null): boolean {
  if (raw === null) return true;
  try {
    return JSON.parse(raw) as boolean;
  } catch {
    return true;
  }
}

/**
 * 解析 localStorage 里的布尔开关：损坏值（非法 JSON/非布尔）按 fallback
 * 处理，不抛错。深查第 24 轮：UserMenu 挂载 effect 里 4 处裸 JSON.parse，
 * 任一损坏都会让 effect 抛错、触发全局错误边界，且“重新加载”重试也
 * 过不去（同一损坏值反复触发），只能手动清 localStorage 才能恢复。
 */
export function parseStoredBoolean(
  raw: string | null,
  fallback: boolean
): boolean {
  if (raw === null) return fallback;
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === 'boolean' ? v : fallback;
  } catch {
    return fallback;
  }
}

export function getImageProxyUrl(): string | null {
  if (typeof window === 'undefined') return null;

  const rawEnable = localStorage.getItem('enableImageProxy');
  const rawUrl = localStorage.getItem('imageProxyUrl');
  const cacheKey = `${rawEnable}|${rawUrl}`;
  if (cacheKey === _imgProxyCacheKey) return _imgProxyCacheVal;

  let result: string | null = null;
  // 本地未开启图片代理，则不使用代理
  if (rawEnable !== null) {
    if (!parseProxyEnabled(rawEnable)) {
      _imgProxyCacheKey = cacheKey;
      _imgProxyCacheVal = null;
      return null;
    }
  }

  if (rawUrl != null) {
    result = rawUrl.trim() ? rawUrl.trim() : null;
  } else {
    // 如果未设置，则使用全局对象
    const serverImageProxy = (window as any).RUNTIME_CONFIG?.IMAGE_PROXY;
    result =
      serverImageProxy && serverImageProxy.trim() ? serverImageProxy.trim() : null;
  }
  _imgProxyCacheKey = cacheKey;
  _imgProxyCacheVal = result;
  return result;
}

/**
 * 处理图片 URL，如果设置了图片代理则使用代理
 *
 * 2026-11-05 豆瓣海报修复：豆瓣图床（img*.doubanio.com）现要求请求带
 * *.douban.com 的 Referer，无 Referer 直接返回 418（本地实测：无 Referer
 * 4 个子域全部 418，带 Referer: https://movie.douban.com/ 3/3 返回 200）。
 * 而 VideoCard 为防盗链把 img 的 referrerPolicy 设为 no-referrer，直连
 * 必然 418；失败兜底又依赖用户/服务端配置的图片代理前缀，生产未配置
 * NEXT_PUBLIC_IMAGE_PROXY 时前缀为 null，兜底直接死胡同、只剩标题占位。
 * 因此：未配置代理且用户未明确关闭代理时，豆瓣图床默认走内置同源代理
 * /api/image-proxy（它发 Referer: https://movie.douban.com/ + 浏览器 UA，
 * 且有 Cache API 缓存）；用户配了代理仍优先用用户代理，用户明确关闭
 * （enableImageProxy=false）则尊重选择、直连。非豆瓣图床行为不变。
 */
export const BUILTIN_IMAGE_PROXY_PREFIX = '/api/image-proxy?url=';

/** 是否为豆瓣图床：只有这类地址被实测确认必须带豆瓣 Referer 才放行。 */
export function isDoubanioPosterUrl(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase().endsWith('.doubanio.com');
  } catch {
    return false;
  }
}

/** 用户是否明确关闭了图片代理（localStorage enableImageProxy=false）。损坏值按未关闭处理（见 parseProxyEnabled）。 */
export function isImageProxyExplicitlyDisabled(): boolean {
  if (typeof window === 'undefined') return false;
  const raw = localStorage.getItem('enableImageProxy');
  return raw !== null && !parseProxyEnabled(raw);
}

export function processImageUrl(originalUrl: string): string {
  if (!originalUrl) return originalUrl;

  const proxyUrl = getImageProxyUrl();
  if (proxyUrl) return `${proxyUrl}${encodeURIComponent(originalUrl)}`;

  // 用户明确关闭代理时尊重选择，不强制走内置代理（失败兜底仍可救一次）。
  if (isImageProxyExplicitlyDisabled()) return originalUrl;

  // 豆瓣图床直连会被 418，默认走内置同源代理。
  if (isDoubanioPosterUrl(originalUrl)) {
    return `${BUILTIN_IMAGE_PROXY_PREFIX}${encodeURIComponent(originalUrl)}`;
  }

  return originalUrl;
}

/**
 * 获取原始图片代理前缀（不论用户代理开关是否开启）。
 * 服务端 RUNTIME_CONFIG.IMAGE_PROXY 优先，其次 localStorage 的 imageProxyUrl；
 * 两处都未配置时返回内置同源代理前缀 /api/image-proxy?url=，兜底链不断。
 * 仅在海报加载失败的兜底路径调用，不参与首屏渲染，故不走 memo 缓存、每次读最新值。
 * 失败路径不输出任何 URL 以外的信息。
 */
export function getRawImageProxyPrefix(): string | null {
  if (typeof window === 'undefined') return null;

  const serverPrefix = (window as any).RUNTIME_CONFIG?.IMAGE_PROXY;
  if (typeof serverPrefix === 'string' && serverPrefix.trim()) {
    return serverPrefix.trim();
  }

  const rawUrl = localStorage.getItem('imageProxyUrl');
  if (rawUrl && rawUrl.trim()) return rawUrl.trim();

  return BUILTIN_IMAGE_PROXY_PREFIX;
}

/**
 * 海报失败兜底决策（纯函数），双向只试一次：
 * - 当前是直连（与原图相同）→ 返回代理地址；
 * - 当前已是代理地址（直连或代理首选失败，如豆瓣图床默认走内置代理）→
 *   返回直连原图再试一次（覆盖代理本身故障、但直连可达的网络）；
 * - 已重试过 / 无代理前缀 / 原图为空 → 返回 null（显示可见占位，不再重试）。
 * 注意：调用方（VideoCard）用 imgRetried 只调一次本函数，整张海报生命
 * 周期内最多换一次源，不会来回横跳。
 */
export function nextPosterFallbackSrc(
  currentSrc: string,
  originalUrl: string,
  proxyPrefix: string | null,
  alreadyRetried: boolean
): string | null {
  if (alreadyRetried) return null;
  if (!originalUrl || !proxyPrefix) return null;

  const proxied = `${proxyPrefix}${encodeURIComponent(originalUrl)}`;
  // 已是代理地址：回退直连再试一次。
  if (currentSrc === proxied) return originalUrl;
  // 直连失败：走代理重试一次；其他未知状态也走代理（旧行为）。
  return proxied;
}

/**
 * 获取豆瓣代理 URL 设置
 *
 * PERF-R1: 同 getImageProxyUrl，localStorage 读取 memo 化 + 原始字符串变更检测。
 */
let _doubanProxyCacheKey = '\0';
let _doubanProxyCacheVal: string | null = null;
export function getDoubanProxyUrl(): string | null {
  if (typeof window === 'undefined') return null;

  const rawEnable = localStorage.getItem('enableDoubanProxy');
  const rawUrl = localStorage.getItem('doubanProxyUrl');
  const cacheKey = `${rawEnable}|${rawUrl}`;
  if (cacheKey === _doubanProxyCacheKey) return _doubanProxyCacheVal;

  let result: string | null = null;
  // 本地未开启豆瓣代理，则不使用代理（损坏值按启用处理，见 parseProxyEnabled）
  if (rawEnable !== null) {
    if (!parseProxyEnabled(rawEnable)) {
      _doubanProxyCacheKey = cacheKey;
      _doubanProxyCacheVal = null;
      return null;
    }
  }

  if (rawUrl != null) {
    result = rawUrl.trim() ? rawUrl.trim() : null;
  } else {
    // 如果未设置，则使用全局对象
    const serverDoubanProxy = (window as any).RUNTIME_CONFIG?.DOUBAN_PROXY;
    result =
      serverDoubanProxy && serverDoubanProxy.trim()
        ? serverDoubanProxy.trim()
        : null;
  }
  _doubanProxyCacheKey = cacheKey;
  _doubanProxyCacheVal = result;
  return result;
}

/**
 * 处理豆瓣 URL，如果设置了豆瓣代理则使用代理
 */
export function processDoubanUrl(originalUrl: string): string {
  if (!originalUrl) return originalUrl;

  const proxyUrl = getDoubanProxyUrl();
  if (!proxyUrl) return originalUrl;

  return `${proxyUrl}${encodeURIComponent(originalUrl)}`;
}

/**
 * 按 save_time 降序比较（最新在前）：缺失/非数值的 save_time（脏记录，
 * 如旧版或损坏的 localStorage）按最旧沉底，避免 `b - a` 得 NaN 破坏
 * 比较器的全序、导致排序不稳定。首页收藏与继续观看共用。深查第 23 轮。
 */
export function compareSaveTimeDesc(
  a: { save_time?: unknown },
  b: { save_time?: unknown }
): number {
  const timeOf = (r: { save_time?: unknown }) =>
    typeof r.save_time === 'number' && Number.isFinite(r.save_time)
      ? r.save_time
      : -Infinity;
  const ta = timeOf(a);
  const tb = timeOf(b);
  // 两边同为 -Infinity（都缺失）时直接相减得 NaN，破坏自反性，
  // 必须先判等。
  if (ta === tb) return 0;
  return tb - ta;
}

/**
 * 从播放记录解析续播状态：只接受有限非负整数的 index（1 起）。
 * 深查第 26 轮：脏记录 index 为 0/缺失/非数值时，旧实现算出 -1/NaN
 * 的选集索引，updateVideoUrl 的越界守卫拦不住（-1/NaN >= length 为
 * false），episodes[-1/NaN] 得 undefined → 视频地址置空、无法播放。
 * 非法时返回 null，调用方按无记录处理（从第 1 集播起）。
 */
export function resolveResumeState(record: {
  index?: unknown;
  play_time?: unknown;
}): { episodeIndex: number; resumeTime: number | null } | null {
  const targetIndex =
    typeof record.index === 'number' ? record.index - 1 : NaN;
  if (!Number.isInteger(targetIndex) || targetIndex < 0) return null;
  return {
    episodeIndex: targetIndex,
    resumeTime:
      typeof record.play_time === 'number' ? record.play_time : null,
  };
}

export function cleanHtmlTags(text: string): string {
  if (!text) return '';
  return text
    .replace(/<[^>]+>/g, '\n') // 将 HTML 标签替换为换行
    .replace(/\n+/g, '\n') // 将多个连续换行合并为一个
    .replace(/[ \t]+/g, ' ') // 将多个连续空格和制表符合并为一个空格，但保留换行符
    .replace(/^\n+|\n+$/g, '') // 去掉首尾换行
    .replace(/&nbsp;/g, ' ') // 将 &nbsp; 替换为空格
    .trim(); // 去掉首尾空格
}

/**
 * 从m3u8地址获取视频质量等级和网络信息
 * @param m3u8Url m3u8播放列表的URL
 * @returns Promise<{quality: string, loadSpeed: string, pingTime: number}> 视频质量等级和网络信息
 */
export async function getVideoResolutionFromM3u8(m3u8Url: string): Promise<{
  quality: string; // 如720p、1080p等
  loadSpeed: string; // 自动转换为KB/s或MB/s
  pingTime: number; // 网络延迟（毫秒）
}> {
  try {
    // 直接使用m3u8 URL作为视频源，避免CORS问题
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.muted = true;
      video.preload = 'metadata';

      // 测量网络延迟（ping时间） - 使用m3u8 URL而不是ts文件
      const pingStart = performance.now();
      let pingTime = 0;

      // 测量ping时间（使用m3u8 URL）
      fetch(m3u8Url, { method: 'HEAD', mode: 'no-cors' })
        .then(() => {
          pingTime = performance.now() - pingStart;
        })
        .catch(() => {
          pingTime = performance.now() - pingStart; // 记录到失败为止的时间
        });

      // 固定使用hls.js加载
      const hls = new Hls();

      // 设置超时处理
      const timeout = setTimeout(() => {
        hls.destroy();
        video.remove();
        reject(new Error('Timeout loading video metadata'));
      }, 4000);

      video.onerror = () => {
        clearTimeout(timeout);
        hls.destroy();
        video.remove();
        reject(new Error('Failed to load video metadata'));
      };

      let actualLoadSpeed = '未知';
      let hasSpeedCalculated = false;
      let hasMetadataLoaded = false;

      let fragmentStartTime = 0;

      // 检查是否可以返回结果
      const checkAndResolve = () => {
        if (
          hasMetadataLoaded &&
          (hasSpeedCalculated || actualLoadSpeed !== '未知')
        ) {
          clearTimeout(timeout);
          const width = video.videoWidth;
          if (width && width > 0) {
            hls.destroy();
            video.remove();

            // 根据视频宽度判断视频质量等级，使用经典分辨率的宽度作为分割点
            const quality =
              width >= 3840
                ? '4K' // 4K: 3840x2160
                : width >= 2560
                ? '2K' // 2K: 2560x1440
                : width >= 1920
                ? '1080p' // 1080p: 1920x1080
                : width >= 1280
                ? '720p' // 720p: 1280x720
                : width >= 854
                ? '480p'
                : 'SD'; // 480p: 854x480

            resolve({
              quality,
              loadSpeed: actualLoadSpeed,
              pingTime: Math.round(pingTime),
            });
          } else {
            // webkit 无法获取尺寸，直接返回
            resolve({
              quality: '未知',
              loadSpeed: actualLoadSpeed,
              pingTime: Math.round(pingTime),
            });
          }
        }
      };

      // 监听片段加载开始
      hls.on(Hls.Events.FRAG_LOADING, () => {
        fragmentStartTime = performance.now();
      });

      // 监听片段加载完成，只需首个分片即可计算速度
      hls.on(Hls.Events.FRAG_LOADED, (event: any, data: any) => {
        if (
          fragmentStartTime > 0 &&
          data &&
          data.payload &&
          !hasSpeedCalculated
        ) {
          const loadTime = performance.now() - fragmentStartTime;
          const size = data.payload.byteLength || 0;

          if (loadTime > 0 && size > 0) {
            const speedKBps = size / 1024 / (loadTime / 1000);

            // 立即计算速度，无需等待更多分片
            const avgSpeedKBps = speedKBps;

            if (avgSpeedKBps >= 1024) {
              actualLoadSpeed = `${(avgSpeedKBps / 1024).toFixed(1)} MB/s`;
            } else {
              actualLoadSpeed = `${avgSpeedKBps.toFixed(1)} KB/s`;
            }
            hasSpeedCalculated = true;
            checkAndResolve(); // 尝试返回结果
          }
        }
      });

      hls.loadSource(m3u8Url);
      hls.attachMedia(video);

      // 监听hls.js错误
      hls.on(Hls.Events.ERROR, (event: any, data: any) => {
        console.error('HLS错误:', data);
        if (data.fatal) {
          clearTimeout(timeout);
          hls.destroy();
          video.remove();
          reject(new Error(`HLS播放失败: ${data.type}`));
        }
      });

      // 监听视频元数据加载完成
      video.onloadedmetadata = () => {
        hasMetadataLoaded = true;
        checkAndResolve(); // 尝试返回结果
      };
    });
  } catch (error) {
    throw new Error(
      `Error getting video resolution: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
