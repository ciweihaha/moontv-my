/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 海报兜底链纯函数测试。
 * 2026-11-05 豆瓣海报修复：豆瓣图床要求 *.douban.com Referer，无 Referer
 * 返回 418；VideoCard 的 no-referrer 直连必然失败。未配置代理时豆瓣图
 * 默认走内置同源代理 /api/image-proxy（它带豆瓣 Referer），兜底链改为
 * 双向只换一次源：代理失败 → 直连再试，直连失败 → 代理重试。
 */
import {
  BUILTIN_IMAGE_PROXY_PREFIX,
  getRawImageProxyPrefix,
  isDoubanioPosterUrl,
  isImageProxyExplicitlyDisabled,
  nextPosterFallbackSrc,
} from '@/lib/utils';

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

  it('两处都无值或空白时返回内置同源代理前缀（兜底链不断）', () => {
    delete (window as any).RUNTIME_CONFIG;
    expect(getRawImageProxyPrefix()).toBe(BUILTIN_IMAGE_PROXY_PREFIX);
    localStorage.setItem('imageProxyUrl', '   ');
    expect(getRawImageProxyPrefix()).toBe(BUILTIN_IMAGE_PROXY_PREFIX);
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

  it('当前已是代理地址 → 返回直连原图再试一次', () => {
    expect(nextPosterFallbackSrc(PROXIED, DIRECT, PREFIX, false)).toBe(DIRECT);
  });

  it('无代理前缀 → 返回 null', () => {
    expect(nextPosterFallbackSrc(DIRECT, DIRECT, null, false)).toBeNull();
  });

  it('原图为空 → 返回 null', () => {
    expect(nextPosterFallbackSrc('', '', PREFIX, false)).toBeNull();
  });

  it('当前既非直连也非代理地址 → 返回代理地址', () => {
    expect(
      nextPosterFallbackSrc('https://img.example.com/stale.jpg', DIRECT, PREFIX, false)
    ).toBe(PROXIED);
  });
});

describe('isDoubanioPosterUrl', () => {
  it('img*.doubanio.com 子域为豆瓣图床', () => {
    expect(isDoubanioPosterUrl('https://img2.doubanio.com/view/photo/s_ratio_poster/public/p1.jpg')).toBe(true);
    expect(isDoubanioPosterUrl('http://img9.doubanio.com/view/photo/p2.jpg')).toBe(true);
  });

  it('非豆瓣图床返回 false', () => {
    expect(isDoubanioPosterUrl('https://img.example.com/pic.jpg')).toBe(false);
    expect(isDoubanioPosterUrl('https://doubanio.com.evil.example.com/pic.jpg')).toBe(false);
    expect(isDoubanioPosterUrl('not-a-url')).toBe(false);
  });
});

describe('isImageProxyExplicitlyDisabled', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('未设置时返回 false', () => {
    expect(isImageProxyExplicitlyDisabled()).toBe(false);
  });

  it('enableImageProxy=false 时返回 true', () => {
    localStorage.setItem('enableImageProxy', 'false');
    expect(isImageProxyExplicitlyDisabled()).toBe(true);
  });

  it('enableImageProxy=true 时返回 false', () => {
    localStorage.setItem('enableImageProxy', 'true');
    expect(isImageProxyExplicitlyDisabled()).toBe(false);
  });
});

describe('processImageUrl', () => {
  // getImageProxyUrl 有模块级 memo（键为 localStorage 原始字符串，不含
  // RUNTIME_CONFIG），每场景 resetModules 重新加载模块，避免跨场景污染。
  const ORIGINAL_RUNTIME_CONFIG = (window as any).RUNTIME_CONFIG;
  const DOUBAN = 'https://img2.doubanio.com/view/photo/s_ratio_poster/public/p2936709341.jpg';
  const OTHER = 'https://img.example.com/pic.jpg';
  const USER_PREFIX = 'https://proxy.example.com/?url=';

  let utils: typeof import('@/lib/utils');

  beforeEach(async () => {
    jest.resetModules();
    localStorage.clear();
    (window as any).RUNTIME_CONFIG = ORIGINAL_RUNTIME_CONFIG;
    utils = await import('@/lib/utils');
  });

  afterEach(() => {
    localStorage.clear();
    (window as any).RUNTIME_CONFIG = ORIGINAL_RUNTIME_CONFIG;
  });

  it('豆瓣图床未配置代理 → 默认走内置同源代理', () => {
    delete (window as any).RUNTIME_CONFIG;
    expect(utils.processImageUrl(DOUBAN)).toBe(
      `${BUILTIN_IMAGE_PROXY_PREFIX}${encodeURIComponent(DOUBAN)}`
    );
  });

  it('豆瓣图床用户配了代理 → 用户代理优先', () => {
    delete (window as any).RUNTIME_CONFIG;
    localStorage.setItem('imageProxyUrl', USER_PREFIX);
    expect(utils.processImageUrl(DOUBAN)).toBe(
      `${USER_PREFIX}${encodeURIComponent(DOUBAN)}`
    );
  });

  it('豆瓣图床服务端配了代理 → 服务端代理优先', () => {
    (window as any).RUNTIME_CONFIG = { IMAGE_PROXY: USER_PREFIX };
    expect(utils.processImageUrl(DOUBAN)).toBe(
      `${USER_PREFIX}${encodeURIComponent(DOUBAN)}`
    );
  });

  it('用户明确关闭代理 → 豆瓣图床也直连（尊重选择）', () => {
    delete (window as any).RUNTIME_CONFIG;
    localStorage.setItem('enableImageProxy', 'false');
    expect(utils.processImageUrl(DOUBAN)).toBe(DOUBAN);
  });

  it('非豆瓣图床未配置代理 → 直连不变', () => {
    delete (window as any).RUNTIME_CONFIG;
    expect(utils.processImageUrl(OTHER)).toBe(OTHER);
  });

  it('空原图 → 返回空', () => {
    expect(utils.processImageUrl('')).toBe('');
  });
});
