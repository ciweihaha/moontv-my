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

// 桶数量上限（防内存耗尽攻击）
const MAX_BUCKETS = 10_000;

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
  evictOldestBuckets();
}

/**
 * M3: 桶满时逐出最早插入的桶（Map 按插入顺序迭代），而非清空全部。
 * 旧实现 `buckets.clear()` 会被攻击者用 10,001 个不同 IP 瞬间清零
 * 所有人（含正在被暴力破解的账号）的限频计数。
 */
function evictOldestBuckets(): void {
  const overflow = buckets.size - MAX_BUCKETS;
  if (overflow <= 0) return;
  // 手动 .next() 不需要 downlevelIteration（for...of 才需要）
  const it = buckets.keys();
  for (let i = 0; i < overflow; i++) {
    const next = it.next();
    if (next.done) break;
    buckets.delete(next.value);
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
    // 新桶创建时即控量，不等 sweep 周期（逐出最旧桶；极端情况下
    // 刚重置的过期桶恰为最旧时也会被逐出，下次请求重建，影响可忽略）
    evictOldestBuckets();
    return true;
  }
  if (entry.count >= limit) {
    return false;
  }
  entry.count += 1;
  return true;
}

/**
 * 从请求中提取客户端 IP。
 *
 * M3: 代理 IP 头（cf-connecting-ip / x-forwarded-for）默认不再无条件
 * 信任——非 Cloudflare 部署（Docker 直连、Vercel）下攻击者可任意伪造
 * X-Forwarded-For 轮换 IP，登录限频形同虚设。仅当部署确认位于
 * Cloudflare 之后（CF 会覆盖 cf-connecting-ip 为真实客户端 IP，伪造
 * 无效）或位于会覆盖该头的可信反代之后，才设置
 * TRUST_PROXY_HEADERS=true 开启信任（见 .env.example）。
 * 未开启时返回 'unknown'，限频退化为全局共享桶（fail-closed：宁可
 * 误伤正常登录尝试，也不放行伪造 IP 的暴力破解）。
 */
export function getClientIp(request: Request): string {
  if (process.env.TRUST_PROXY_HEADERS === 'true') {
    const cfIp = request.headers.get('cf-connecting-ip');
    if (cfIp) return cfIp.trim();
    const xff = request.headers.get('x-forwarded-for');
    if (xff) {
      const first = xff.split(',')[0];
      if (first) return first.trim();
    }
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
