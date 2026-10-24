/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * VideoCard 海报兜底链组件测试：直连失败 → 代理重试一次 → 再失败显示可见占位。
 * next/image 以普通 img 模拟（转发 onError，onLoad 触发 onLoadingComplete）。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import VideoCard from '@/components/VideoCard';

jest.mock('next/image', () => ({
  __esModule: true,
  default: (props: any) => {
    const { onLoadingComplete, fill: _fill, ...rest } = props;
    // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
    return <img {...rest} onLoad={() => onLoadingComplete?.()} />;
  },
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock('@/lib/db.client', () => ({
  deleteFavorite: jest.fn(),
  deletePlayRecord: jest.fn(),
  generateStorageKey: jest.fn(() => 'k'),
  isFavorited: jest.fn(),
  saveFavorite: jest.fn(),
  subscribeToDataUpdates: jest.fn(() => () => {}),
}));

const POSTER = 'https://img.example.com/pic.jpg';
const PROXY_PREFIX = 'https://proxy.example.com/?url=';
const PROXIED = `${PROXY_PREFIX}${encodeURIComponent(POSTER)}`;

function renderCard() {
  render(<VideoCard from="douban" title="测试影片" poster={POSTER} />);
  return screen.getByAltText('测试影片') as HTMLImageElement;
}

describe('VideoCard 海报兜底', () => {
  const ORIGINAL_RUNTIME_CONFIG = (window as any).RUNTIME_CONFIG;

  beforeEach(() => {
    localStorage.clear();
    delete (window as any).RUNTIME_CONFIG;
  });

  afterEach(() => {
    (window as any).RUNTIME_CONFIG = ORIGINAL_RUNTIME_CONFIG;
  });

  it('直连失败时改走代理重试一次', () => {
    localStorage.setItem('enableImageProxy', 'false');
    localStorage.setItem('imageProxyUrl', PROXY_PREFIX);
    const img = renderCard();
    expect(img.getAttribute('src')).toBe(POSTER);
    fireEvent.error(img);
    expect(img.getAttribute('src')).toBe(PROXIED);
  });

  it('代理重试仍失败时显示可见占位、加载状态结束', () => {
    localStorage.setItem('enableImageProxy', 'false');
    localStorage.setItem('imageProxyUrl', PROXY_PREFIX);
    const img = renderCard();
    fireEvent.error(img);
    expect(img.getAttribute('src')).toBe(PROXIED);
    fireEvent.error(img);
    // 可见占位（含标题文字），且 img 已移除、骨架不再挂起
    expect(screen.getByTestId('poster-fallback')).toHaveTextContent('测试影片');
    expect(screen.queryByAltText('测试影片')).toBeNull();
  });

  it('无代理可用时直连失败直接显示可见占位', () => {
    const img = renderCard();
    fireEvent.error(img);
    expect(screen.getByTestId('poster-fallback')).toHaveTextContent('测试影片');
    expect(screen.queryByAltText('测试影片')).toBeNull();
  });

  it('正常加载不受影响：onLoad 后骨架消失、图片保留', () => {
    const img = renderCard();
    expect(document.body.innerHTML).toContain('shine');
    fireEvent.load(img);
    expect(document.body.innerHTML).not.toContain('shine');
    expect(screen.getByAltText('测试影片')).toBeInTheDocument();
    expect(screen.queryByTestId('poster-fallback')).toBeNull();
  });
});
