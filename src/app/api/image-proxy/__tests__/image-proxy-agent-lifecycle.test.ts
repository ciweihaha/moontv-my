/**
 * @jest-environment node
 *
 * image-proxy pinned Agent 生命周期回归（AUDIT-R8）。
 *
 * 背景（2026-10-20 实测，moontv-verify）：route.ts 的 getPinnedFetchClient
 * 在每个重定向跳都 new 一个 undici Agent 且从不 close/destroy，FD 按请求
 * 线性累积（+2/次），仅靠 undici 空闲超时（约 9 秒）自回收；突发高频下
 * 可能打满容器 FD 上限。修复后每跳 Agent 在响应体消费完成（或请求失败）
 * 后必须被确定性释放（releasePinnedDispatcher → destroy）。
 *
 * 本文件分两层：
 *  1. 真实 undici + 本地 HTTP 服务，按 route 的逐跳构造方式钉死到
 *     127.0.0.1 连发请求，断言「释放模式」下 FD/socket 增量回到基线附近；
 *     附「从不释放」的对照组，证明该断言对泄漏敏感（不是恒真）。
 *  2. route 本体的接线断言在 image-proxy-ssrf.test.ts 的
 *     「AUDIT-R8 生命周期」用例里（mock dispatcher 的 destroy 间谍）。
 *
 * 说明：buildPinnedLookup 与 route.ts 中的实现逐字一致地复制于此
 * （route 模块不导出内部函数；语义由 ssrf 套件的钉死用例另行覆盖）。
 */
import { readdirSync } from 'node:fs';
import { type Server,createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

jest.setTimeout(90000);

/** 与 src/app/api/image-proxy/route.ts 的 buildPinnedLookup 逐字一致。 */
function buildPinnedLookup(validatedIps: string[]) {
  const pinned = validatedIps.map((ip) => ({
    address: ip,
    family: ip.includes(':') ? 6 : 4,
  }));
  const lookup = (
    _hostname: string,
    options: { all?: boolean },
    callback: (...args: unknown[]) => void
  ): void => {
    if (options && options.all === true) {
      callback(
        null,
        pinned.map((p) => ({ address: p.address, family: p.family }))
      );
      return;
    }
    const first = pinned[0];
    if (!first) {
      callback(new Error('pinned lookup: empty validated IP set'));
      return;
    }
    callback(null, first.address, first.family);
  };
  return lookup;
}

function fdCount(): number {
  return readdirSync('/proc/self/fd').length;
}

function socketHandleCount(): number {
  const handles = (
    process as unknown as { _getActiveHandles: () => unknown[] }
  )._getActiveHandles();
  return handles.filter(
    (h) => (h as object).constructor.name === 'Socket'
  ).length;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('pinned Agent 生命周期（真实 undici，AUDIT-R8）', () => {
  let server: Server;
  let port = 0;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      res.end(Buffer.alloc(2048, 0x11));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve())
    );
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** 按 route 逐跳构造方式发一次请求；release=true 时模拟修复后的释放。 */
  async function oneFetch(release: boolean): Promise<void> {
    const agent = new Agent({
      connect: { lookup: buildPinnedLookup(['127.0.0.1']) },
    });
    try {
      const resp = await undiciFetch(`http://lifecycle.test:${port}/pic`, {
        dispatcher: agent,
      });
      await resp.arrayBuffer();
    } finally {
      if (release) {
        await agent.destroy().catch(() => undefined);
      }
    }
  }

  it('修复模式：连发 60 次，FD/socket 增量立即回到基线附近（不等空闲自回收）', async () => {
    // 先热身一次，排除首次加载 undici 的一次性句柄
    await oneFetch(true);
    await sleep(200);
    const baseFd = fdCount();
    const baseSock = socketHandleCount();

    for (let i = 0; i < 60; i++) {
      await oneFetch(true);
    }
    // destroy 是同步拆 socket；给事件循环少量时间落地，但远小于约 9 秒的自回收
    await sleep(300);

    const fdDelta = fdCount() - baseFd;
    const sockDelta = socketHandleCount() - baseSock;
    // 宽松阈值：允许少量运行时噪声，但必须远离泄漏模式的量级（60 次≈+120）
    expect(fdDelta).toBeLessThanOrEqual(10);
    expect(sockDelta).toBeLessThanOrEqual(10);
  });

  it('对照组：从不释放时句柄显著累积（证明上条断言对泄漏敏感）', async () => {
    const baseFd = fdCount();
    const baseSock = socketHandleCount();

    for (let i = 0; i < 20; i++) {
      await oneFetch(false);
    }
    const fdDelta = fdCount() - baseFd;
    const sockDelta = socketHandleCount() - baseSock;
    // 泄漏模式实测约 +2 FD/请求；阈值只要求显著大于噪声即可
    expect(Math.max(fdDelta, sockDelta)).toBeGreaterThanOrEqual(15);

    // 等空闲自回收，避免污染同进程后续用例
    await sleep(10000);
  });
});
