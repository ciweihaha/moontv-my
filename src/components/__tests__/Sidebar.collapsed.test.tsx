/**
 * 深查第 22 轮：侧边栏挂载时 localStorage 折叠状态损坏不再炸掉组件。
 * 旧实现：useLayoutEffect 里裸 JSON.parse(localStorage.sidebarCollapsed)，
 * 存了 "yes" 等非法 JSON 时抛错、整个侧边栏挂载失败；非布尔值（如 123）
 * 也会直接进状态。新行为：解析失败或非布尔值一律忽略、保持默认展开。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { render, screen } from '@testing-library/react';
import React from 'react';

import Sidebar from '@/components/Sidebar';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: any) => (
    <a href={typeof href === 'string' ? href : href?.pathname} {...rest}>
      {children}
    </a>
  ),
}));

jest.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/components/SiteProvider', () => ({
  useSite: () => ({ siteName: 'TestSite' }),
}));

describe('Sidebar 折叠状态损坏兜底（深查第 22 轮）', () => {
  beforeEach(() => {
    localStorage.clear();
    delete (window as any).__sidebarCollapsed;
    delete document.documentElement.dataset.sidebarCollapsed;
  });

  it('localStorage 存了非法 JSON → 仍正常挂载、不抛错', () => {
    localStorage.setItem('sidebarCollapsed', 'yes');
    expect(() => render(<Sidebar />)).not.toThrow();
    // 导航链接照常渲染
    expect(screen.getByText('TestSite')).toBeInTheDocument();
  });

  it('localStorage 存了非布尔 JSON → 忽略、保持展开（不写全局缓存）', () => {
    localStorage.setItem('sidebarCollapsed', '123');
    render(<Sidebar />);
    expect(screen.getByText('TestSite')).toBeInTheDocument();
    expect((window as any).__sidebarCollapsed).toBeUndefined();
  });

  it('合法 "true" 仍生效：折叠后 Logo 隐藏、全局缓存置 true', () => {
    localStorage.setItem('sidebarCollapsed', 'true');
    render(<Sidebar />);
    expect(screen.queryByText('TestSite')).toBeNull();
    expect((window as any).__sidebarCollapsed).toBe(true);
    expect(document.documentElement.dataset.sidebarCollapsed).toBe('true');
  });

  it('合法 "false" 仍生效：展开显示 Logo', () => {
    localStorage.setItem('sidebarCollapsed', 'false');
    render(<Sidebar />);
    expect(screen.getByText('TestSite')).toBeInTheDocument();
    expect((window as any).__sidebarCollapsed).toBe(false);
  });
});
