/**
 * 深查第 24 轮：UserMenu 挂载时 localStorage 开关损坏不再触发错误边界。
 * 旧实现：effect 里 4 处裸 JSON.parse，任一损坏（如 enableImageProxy
 * 存了 "yes"）即抛错进全局错误边界，且重试也过不去。新行为：损坏值
 * 按各开关默认值处理，其余设置照常加载。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { UserMenu } from '@/components/UserMenu';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock('@/lib/auth', () => ({
  clearClientSession: jest.fn(),
  fetchSessionInfo: jest.fn(() => Promise.resolve(null)),
}));

jest.mock('@/lib/version', () => ({
  checkForUpdates: jest.fn(() => Promise.resolve('NO_UPDATE')),
  CURRENT_VERSION: 'test',
  UpdateStatus: {
    FETCH_FAILED: 'FETCH_FAILED',
    HAS_UPDATE: 'HAS_UPDATE',
    NO_UPDATE: 'NO_UPDATE',
  },
}));

async function openSettings() {
  fireEvent.click(screen.getByLabelText('User Menu'));
  fireEvent.click(await screen.findByText('设置'));
}

function checkboxFor(heading: string): HTMLInputElement {
  const h = screen.getByText(heading);
  const row = h.parentElement?.parentElement as HTMLElement;
  const input = row.querySelector('input[type="checkbox"]');
  if (!input) throw new Error(`找不到 ${heading} 的开关`);
  return input as HTMLInputElement;
}

describe('UserMenu 损坏的 localStorage 开关（深查第 24 轮）', () => {
  beforeEach(() => {
    localStorage.clear();
    delete (window as any).RUNTIME_CONFIG;
  });

  it('4 个开关全损坏 → 正常挂载、全部按默认值（旧实现挂载即抛错）', async () => {
    localStorage.setItem('defaultAggregateSearch', 'yes');
    localStorage.setItem('enableDoubanProxy', '{broken');
    localStorage.setItem('enableImageProxy', '123');
    localStorage.setItem('enableOptimization', '"on"');
    expect(() => render(<UserMenu />)).not.toThrow();
    await openSettings();
    expect(checkboxFor('默认聚合搜索结果').checked).toBe(true);
    expect(checkboxFor('启用优选和测速').checked).toBe(true);
    expect(checkboxFor('启用豆瓣代理').checked).toBe(false);
    expect(checkboxFor('启用图片代理').checked).toBe(false);
  });

  it('合法存储值仍被尊重（回归基线）', async () => {
    localStorage.setItem('defaultAggregateSearch', 'false');
    localStorage.setItem('enableDoubanProxy', 'true');
    localStorage.setItem('enableImageProxy', 'true');
    localStorage.setItem('enableOptimization', 'false');
    render(<UserMenu />);
    await openSettings();
    expect(checkboxFor('默认聚合搜索结果').checked).toBe(false);
    expect(checkboxFor('启用优选和测速').checked).toBe(false);
    expect(checkboxFor('启用豆瓣代理').checked).toBe(true);
    expect(checkboxFor('启用图片代理').checked).toBe(true);
  });

  it('单个损坏不影响其余设置加载', async () => {
    localStorage.setItem('defaultAggregateSearch', 'false');
    localStorage.setItem('enableImageProxy', 'yes');
    render(<UserMenu />);
    await openSettings();
    expect(checkboxFor('默认聚合搜索结果').checked).toBe(false);
    expect(checkboxFor('启用图片代理').checked).toBe(false);
  });
});
