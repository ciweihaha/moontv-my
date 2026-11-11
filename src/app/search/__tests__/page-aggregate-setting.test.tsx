/**
 * 深查第 28 轮：搜索页默认聚合开关损坏不再炸页。
 * 旧实现：getDefaultAggregate 裸 JSON.parse(localStorage)，且在 useState
 * 初始化器里调用——损坏值（如 "yes"）让搜索页首次渲染即抛错进全局
 * 错误边界，重试也过不去（与 UserMenu 第 24 轮同款）。新行为：损坏/
 * 非布尔按默认 true（聚合开）。
 * 聚合开关 checkbox 的 checked 即 viewMode === 'agg'，可直接断言。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { render, screen } from '@testing-library/react';
import React from 'react';

import SearchPage from '@/app/search/page';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useSearchParams: () => new URLSearchParams('q=test'),
}));

jest.mock('@/lib/db.client', () => ({
  addSearchHistory: jest.fn(),
  clearSearchHistory: jest.fn(),
  deleteSearchHistory: jest.fn(),
  getSearchHistory: jest.fn(() => Promise.resolve([])),
  subscribeToDataUpdates: jest.fn(() => () => {}),
}));

jest.mock('@/components/PageLayout', () => ({
  __esModule: true,
  default: ({ children }: any) => <div>{children}</div>,
}));

jest.mock('@/components/VideoCard', () => ({
  __esModule: true,
  default: () => null,
}));

async function aggregateToggle(): Promise<HTMLInputElement> {
  const label = await screen.findByText('聚合');
  const row = label.closest('label') as HTMLElement;
  return row.querySelector('input[type="checkbox"]') as HTMLInputElement;
}

describe('搜索页默认聚合开关损坏兜底（深查第 28 轮）', () => {
  beforeEach(() => {
    localStorage.clear();
    // 挂载即带 q 参数触发一次搜索（空结果也显示结果区与聚合开关）
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ results: [] }),
      } as any)
    ) as any;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('localStorage 存了非法 JSON → 正常渲染、聚合默认开（旧实现首次渲染即抛错）', async () => {
    localStorage.setItem('defaultAggregateSearch', 'yes');
    expect(() => render(<SearchPage />)).not.toThrow();
    expect((await aggregateToggle()).checked).toBe(true);
  });

  it('localStorage 存了非布尔 JSON（"0"）→ 按默认 true（旧实现判为假、聚合关）', async () => {
    localStorage.setItem('defaultAggregateSearch', '0');
    render(<SearchPage />);
    expect((await aggregateToggle()).checked).toBe(true);
  });

  it('合法 "false" 仍生效：聚合默认关（回归基线）', async () => {
    localStorage.setItem('defaultAggregateSearch', 'false');
    render(<SearchPage />);
    expect((await aggregateToggle()).checked).toBe(false);
  });

  it('未存过 → 默认聚合开', async () => {
    render(<SearchPage />);
    expect((await aggregateToggle()).checked).toBe(true);
  });
});
