/**
 * SEC-R2: 简单的内存滑动窗口限频器（Edge Runtime）。
 *
 * 说明：Edge 运行时的实例内存不跨实例共享，此限频是"尽力而为"的纵深防御，
 * 可显著提高单实例暴力破解成本。配合 Cloudflare 边缘的速率限制使用效果更佳。
 */

interface WindowEntry {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, WindowEntry>();

// 定期清理过期桶，防止内存无限增长
let lastSweep = Date.now();
function sweep(now: number): void {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  // 用 forEach 避免 Map 迭代需要 downlevelIteration（tsconfig target es5）
  buckets.forEach((entry, key) => {
    if (now - entry.windowStart > 120_000) {
      buckets.delete(key);
    }
  });
  // 桶数量异常时兜底清空（防内存耗尽攻击）
  if (buckets.size > 10_000) {
    buckets.clear();
  }
}

/**
 * 检查是否超限。未超限时计数 +1 并返回 true；超限返回 false。
 * @param key 限频键（如 `login:<ip>`）
 * @param limit 窗口内最大允许次数
 * @param windowMs 窗口时长（毫秒）
 */
export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number
): boolean {
  const now = Date.now();
  sweep(now);
  const entry = buckets.get(key);
  if (!entry || now - entry.windowStart >= windowMs) {
    buckets.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= limit) {
    return false;
  }
  entry.count += 1;
  return true;
}

/**
 * 从请求中提取客户端 IP（依次尝试 CF / XFF / 直连）。
 */
export function getClientIp(request: Request): string {
  const cfIp = request.headers.get('cf-connecting-ip');
  if (cfIp) return cfIp.trim();
  const xff = request.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0];
    if (first) return first.trim();
  }
  return 'unknown';
}

/**
 * 常量时间字符串比较，防时序攻击（用于密码等敏感比较）。
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
