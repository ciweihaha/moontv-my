/**
 * 进程内按 key 串行化的互斥锁（M9：注册与管理端用户写操作的
 * check-then-insert / 配置读-改-写竞态缓解）。
 *
 * 实现：Promise 链——每个 key 维护一个 tail Promise，后到的调用等待
 * 前序持有者释放后才执行回调；回调抛错同样释放（finally），不会死锁。
 *
 * 适用边界：仅在同一进程/isolate 内有效。Edge/Serverless 多实例部署
 * 下不跨实例串行化，因此调用方仍须在锁内重新读取最新状态再合并，
 * 并对唯一约束冲突做 400 处理（见 register 路由），不能只依赖本锁。
 */

const tails = new Map<string, Promise<void>>();

/** 管理员配置读-改-写共用的锁 key（注册与管理端用户写操作互斥） */
export const ADMIN_CONFIG_LOCK_KEY = 'admin-config';

export async function withLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // 本次持有者的 tail：前序完成后等待 gate（即本次回调完成）
  const tail = prev.then(() => gate);
  tails.set(key, tail);
  // 等待前序持有者释放（tail 链只 resolve 不 reject，不会抛错）
  await prev;
  try {
    return await fn();
  } finally {
    release();
    // 仍是队尾时清理，避免 Map 无界增长；已有后继者时保留
    if (tails.get(key) === tail) {
      tails.delete(key);
    }
  }
}
