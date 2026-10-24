/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 海报兜底链纯函数测试：直连失败 → 代理重试一次 → 再失败则占位。
 * 对应 VideoCard 的 onError 兜底逻辑（本文件先红后绿）。
 */
import { getRawImageProxyPrefix, nextPosterFallbackSrc } from '@/lib/utils';

describe('getRawImageProxyPrefix', () => {
  const ORIGINAL_RUNTIME_CONFIG = (window as any).RUNTIME_CONFIG;

  afterEach(() => {
    localStorage.clear();
    (window as any).RUNTIME_CONFIG = ORIGINAL_RUNTIME_CONFIG;
  });

  it('服务端前缀优先于 localStorage', () => {
    (window as any).RUNTIME_CONFIG = { IMAGE_PROXY: 'https://proxy.example.com/?url=' };
    localStorage.setItem('imageProxyUrl', 'https://local.example.com/?url=');
    expect(getRawImageProxyPrefix()).toBe('https://proxy.example.com/?url=');
  });

  it('无服务端前缀时取 localStorage 的 imageProxyUrl', () => {
    delete (window as any).RUNTIME_CONFIG;
    localStorage.setItem('imageProxyUrl', 'https://local.example.com/?url=');
    expect(getRawImageProxyPrefix()).toBe('https://local.example.com/?url=');
  });

  it('两处都无值或空白时返回 null', () => {
    delete (window as any).RUNTIME_CONFIG;
    expect(getRawImageProxyPrefix()).toBeNull();
    localStorage.setItem('imageProxyUrl', '   ');
    expect(getRawImageProxyPrefix()).toBeNull();
  });

  it('空白自动 trim', () => {
    delete (window as any).RUNTIME_CONFIG;
    localStorage.setItem('imageProxyUrl', '  https://local.example.com/?url=  ');
    expect(getRawImageProxyPrefix()).toBe('https://local.example.com/?url=');
  });
});

describe('nextPosterFallbackSrc', () => {
  const DIRECT = 'https://img.example.com/pic.jpg';
  const PREFIX = 'https://proxy.example.com/?url=';
  const PROXIED = `${PREFIX}${encodeURIComponent(DIRECT)}`;

  it('直连失败且有代理前缀、未重试过 → 返回代理地址', () => {
    expect(nextPosterFallbackSrc(DIRECT, DIRECT, PREFIX, false)).toBe(PROXIED);
  });

  it('已重试过 → 返回 null（不再重试，避免失败循环）', () => {
    expect(nextPosterFallbackSrc(PROXIED, DIRECT, PREFIX, true)).toBeNull();
  });

  it('当前已是代理地址 → 返回 null', () => {
    expect(nextPosterFallbackSrc(PROXIED, DIRECT, PREFIX, false)).toBeNull();
  });

  it('无代理前缀 → 返回 null', () => {
    expect(nextPosterFallbackSrc(DIRECT, DIRECT, null, false)).toBeNull();
  });

  it('原图为空 → 返回 null', () => {
    expect(nextPosterFallbackSrc('', '', PREFIX, false)).toBeNull();
  });
});
