/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * VideoCard 海报兜底链组件测试：直连失败 → 代理重试一次 → 再失败显示可见占位。
 * next/image 以普通 img 模拟（转发 onError，onLoad 触发 onLoadingComplete）。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { BUILTIN_IMAGE_PROXY_PREFIX } from '@/lib/utils';

import VideoCard from '@/components/VideoCard';

jest.mock('next/image', () => ({
  __esModule: true,
  default: (props: any) => {
    const { onLoadingComplete, fill: _fill, ...rest } = props;
    // eslint-disable-next-line @next/next/no-img-element
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

  it('无代理配置时直连失败改走内置代理重试一次，再失败显示可见占位', () => {
    const img = renderCard();
    fireEvent.error(img);
    expect(img.getAttribute('src')).toBe(
      `${BUILTIN_IMAGE_PROXY_PREFIX}${encodeURIComponent(POSTER)}`
    );
    fireEvent.error(img);
    // 可见占位（含标题文字），且 img 已移除、骨架不再挂起
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

describe('VideoCard 豆瓣链接（深查第 17 轮）', () => {
  const item = (overrides: Record<string, unknown> = {}) => ({
    id: '100',
    title: '测试影片',
    poster: POSTER,
    episodes: ['https://cdn.example.com/1.m3u8'],
    source: 's1',
    source_name: '源1',
    year: '2024',
    ...overrides,
  });

  function doubanLink(): HTMLAnchorElement | null {
    return document.querySelector(
      'a[href*="movie.douban.com/subject/"]'
    ) as HTMLAnchorElement | null;
  }

  it('聚合搜索卡片无豆瓣 id → 不渲染豆瓣链接（旧实现链到 subject/undefined）', () => {
    render(
      <VideoCard from="search" items={[item(), item({ id: '101' })] as any} />
    );
    expect(doubanLink()).toBeNull();
  });

  it('单条搜索卡片 douban_id 缺失 → 不渲染豆瓣链接', () => {
    render(
      <VideoCard
        from="search"
        id="100"
        title="测试影片"
        poster={POSTER}
        source="s1"
        source_name="源1"
      />
    );
    expect(doubanLink()).toBeNull();
  });

  it('douban_id 为 "0" → 不渲染豆瓣链接（subject/0 同样 404）', () => {
    render(
      <VideoCard
        from="search"
        id="100"
        title="测试影片"
        poster={POSTER}
        source="s1"
        source_name="源1"
        douban_id="0"
      />
    );
    expect(doubanLink()).toBeNull();
  });

  it('有豆瓣 id 时正常渲染链接（回归基线）', () => {
    render(
      <VideoCard
        from="search"
        id="100"
        title="测试影片"
        poster={POSTER}
        source="s1"
        source_name="源1"
        douban_id="1234567"
      />
    );
    const link = doubanLink();
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe(
      'https://movie.douban.com/subject/1234567'
    );
  });

  it('聚合卡片取众数豆瓣 id：有 id 的组正常渲染', () => {
    render(
      <VideoCard
        from="search"
        items={[item({ douban_id: 777 }), item({ douban_id: 777 })] as any}
      />
    );
    const link = doubanLink();
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe(
      'https://movie.douban.com/subject/777'
    );
  });
});
