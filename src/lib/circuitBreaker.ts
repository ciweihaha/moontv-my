/* eslint-disable no-console */

/**
 * R2-S5: 上游源熔断器（Circuit Breaker）。
 *
 * 目标：最稳定。某个上游源连续失败时，短暂跳过它而不是每次都等超时，
 * 避免慢源拖慢整体搜索，也避免雪崩时反复冲击已故障的上游。
 *
 * 策略：
 * - 连续失败阈值：3 次 → 进入熔断（open）
 * - 熔断时长：60 秒，之后进入半开（half-open），允许一次试探
 * - 试探成功 → 关闭熔断（closed），计数清零
 * - 试探失败 → 重新熔断
 * - 成功请求 → 失败计数清零
 *
 * 注意：Edge Runtime 内存不跨实例共享，此为单实例尽力而为的优化。
 */

interface BreakerState {
  failures: number;
  openedAt: number; // 熔断开始时间（0 = 未熔断）
  halfOpen: boolean; // 半开试探中
}

const breakers = new Map<string, BreakerState>();

const FAILURE_THRESHOLD = 3;
const OPEN_DURATION_MS = 60_000; // 熔断 60 秒

// 定期清理，防止内存泄漏
let lastSweep = Date.now();
function sweep(now: number): void {
  if (now - lastSweep < 300_000) return; // 5 分钟清一次
  lastSweep = now;
  breakers.forEach((s, key) => {
    if (s.openedAt > 0 && now - s.openedAt > OPEN_DURATION_MS * 2) {
      breakers.delete(key);
    }
  });
  if (breakers.size > 1000) breakers.clear();
}

/**
 * 检查是否应跳过该上游（熔断中）。
 * @param key 上游标识（如 api URL）
 * @returns true = 应跳过（熔断开），false = 可请求
 */
export function shouldSkipUpstream(key: string): boolean {
  const now = Date.now();
  sweep(now);
  const s = breakers.get(key);
  if (!s || s.openedAt === 0) return false;

  const elapsed = now - s.openedAt;
  if (elapsed >= OPEN_DURATION_MS) {
    // 进入半开：允许一次试探
    if (!s.halfOpen) {
      s.halfOpen = true;
      return false; // 放行一次试探
    }
    // 半开试探已在进行中，其他并发请求跳过
    return true;
  }
  return true; // 熔断中，跳过
}

/**
 * 记录上游请求成功。关闭熔断、清零计数。
 */
export function recordUpstreamSuccess(key: string): void {
  const s = breakers.get(key);
  if (s) {
    s.failures = 0;
    s.openedAt = 0;
    s.halfOpen = false;
  }
}

/**
 * 记录上游请求失败。达阈值则熔断。
 */
export function recordUpstreamFailure(key: string): void {
  const now = Date.now();
  sweep(now);
  let s = breakers.get(key);
  if (!s) {
    s = { failures: 0, openedAt: 0, halfOpen: false };
    breakers.set(key, s);
  }
  // 半开试探失败 → 重新熔断
  if (s.halfOpen) {
    s.openedAt = now;
    s.halfOpen = false;
    console.warn(`[circuitBreaker] ${key.slice(0, 60)} 半开试探失败，重新熔断`);
    return;
  }
  s.failures += 1;
  if (s.failures >= FAILURE_THRESHOLD && s.openedAt === 0) {
    s.openedAt = now;
    console.warn(`[circuitBreaker] ${key.slice(0, 60)} 连续失败 ${s.failures} 次，熔断 60s`);
  }
}
