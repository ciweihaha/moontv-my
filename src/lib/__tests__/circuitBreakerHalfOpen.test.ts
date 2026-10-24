/**
 * @jest-environment node
 */
/**
 * 外部审查遗留项 2（d）：熔断器半开（half-open）试探闸门验证。
 *
 * 契约：
 * - 连续失败 3 次 → 熔断 60s，期间一律跳过；
 * - 60s 后进入半开：只放行一个试探请求，并发/后续调用继续跳过；
 * - 试探成功 → 关闭并清零；试探失败 → 重新熔断一个完整周期；
 * - 试探若被「无下文」遗弃（调用方因整体超时等原因既未记成功也未记失败），
 *   闸门不得被这次试探长期占用：再过一个熔断周期后应能重新放行一次试探。
 *
 * 用 jest.spyOn(Date, 'now') 注入可控时钟；每个用例使用独立 key 隔离状态。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  recordUpstreamFailure,
  recordUpstreamSuccess,
  shouldSkipUpstream,
} from '../circuitBreaker';

const OPEN_MS = 60_000;
let now = 0;
let nowSpy: jest.SpyInstance;

beforeAll(() => {
  now = Date.now();
  nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
});

afterAll(() => {
  nowSpy.mockRestore();
});

function tripThrice(key: string): void {
  recordUpstreamFailure(key);
  recordUpstreamFailure(key);
  recordUpstreamFailure(key);
}

describe('熔断半开闸门（审查遗留项 2d）', () => {
  test('连续失败达阈值前不跳过，达阈值后跳过', () => {
    const key = 'https://cb-t1.example/api';
    expect(shouldSkipUpstream(key)).toBe(false);
    recordUpstreamFailure(key);
    recordUpstreamFailure(key);
    expect(shouldSkipUpstream(key)).toBe(false);
    recordUpstreamFailure(key);
    expect(shouldSkipUpstream(key)).toBe(true);
  });

  test('熔断 60s 内跳过；满 60s 只放行一个试探，后续调用继续跳过', () => {
    const key = 'https://cb-t2.example/api';
    tripThrice(key);
    now += OPEN_MS - 1000;
    expect(shouldSkipUpstream(key)).toBe(true); // 未满 60s
    now += 1000; // 恰满 60s
    expect(shouldSkipUpstream(key)).toBe(false); // 放行试探（唯一一次）
    expect(shouldSkipUpstream(key)).toBe(true); // 试探在途，其他调用跳过
    expect(shouldSkipUpstream(key)).toBe(true);
  });

  test('试探成功 → 关闭熔断且失败计数清零', () => {
    const key = 'https://cb-t3.example/api';
    tripThrice(key);
    now += OPEN_MS;
    expect(shouldSkipUpstream(key)).toBe(false); // 试探
    recordUpstreamSuccess(key);
    expect(shouldSkipUpstream(key)).toBe(false);
    // 计数已清零：再失败 2 次不熔断，第 3 次才熔断
    recordUpstreamFailure(key);
    recordUpstreamFailure(key);
    expect(shouldSkipUpstream(key)).toBe(false);
    recordUpstreamFailure(key);
    expect(shouldSkipUpstream(key)).toBe(true);
  });

  test('试探失败 → 重新熔断完整 60s，之后再放行一次试探', () => {
    const key = 'https://cb-t4.example/api';
    tripThrice(key);
    now += OPEN_MS;
    expect(shouldSkipUpstream(key)).toBe(false); // 试探
    recordUpstreamFailure(key); // 试探失败
    expect(shouldSkipUpstream(key)).toBe(true);
    now += OPEN_MS - 1000;
    expect(shouldSkipUpstream(key)).toBe(true);
    now += 1000;
    expect(shouldSkipUpstream(key)).toBe(false); // 第二个周期再放行一次
    expect(shouldSkipUpstream(key)).toBe(true); // 仍只有一个
  });

  test('试探被遗弃（无成功/失败记录）→ 再过一个周期应重新放行一次试探', () => {
    const key = 'https://cb-t5.example/api';
    tripThrice(key);
    now += OPEN_MS;
    expect(shouldSkipUpstream(key)).toBe(false); // 试探放行
    // 试探请求被整体超时取消，调用方按「取消不记失败」约定未做任何记录
    now += OPEN_MS;
    expect(shouldSkipUpstream(key)).toBe(false); // 应重新放行一次试探
    expect(shouldSkipUpstream(key)).toBe(true); // 且仍只有一个
  });
});
