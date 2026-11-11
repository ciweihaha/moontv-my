/**
 * 深查第 7 轮：localStorage 代理开关值损坏时不得抛错。
 * enableImageProxy / enableDoubanProxy 由用户或旧版本写入，值损坏
 *（"yes"、截断 JSON、"undefined" 等）时旧实现 JSON.parse 直接抛
 * SyntaxError：getImageProxyUrl 在 VideoCard 渲染路径被调用，整页
 * 崩溃；getDoubanProxyUrl 拖垮豆瓣请求。修复后损坏值按“未明确关闭”
 * 处理（默认启用代理），与 isImageProxyExplicitlyDisabled 的容错
 * 口径一致；可解析值保持原语义。
 */
import {
  BUILTIN_IMAGE_PROXY_PREFIX,
  isImageProxyExplicitlyDisabled,
} from '@/lib/utils';

describe('代理开关损坏值容错（深查第 7 轮）', () => {
  const ORIGINAL_RUNTIME_CONFIG = (
    window as unknown as { RUNTIME_CONFIG?: unknown }
  ).RUNTIME_CONFIG;
  const DOUBAN =
    'https://img2.doubanio.com/view/photo/s_ratio_poster/public/p2936709341.jpg';
  const USER_PREFIX = 'https://proxy.example.com/?url=';
  const CORRUPT_VALUES = ['yes', '{"a":', 'undefined', 'tru', ''];

  let utils: typeof import('@/lib/utils');

  beforeEach(async () => {
    jest.resetModules();
    localStorage.clear();
    (window as unknown as { RUNTIME_CONFIG?: unknown }).RUNTIME_CONFIG =
      ORIGINAL_RUNTIME_CONFIG;
    utils = await import('@/lib/utils');
  });

  afterEach(() => {
    localStorage.clear();
    (window as unknown as { RUNTIME_CONFIG?: unknown }).RUNTIME_CONFIG =
      ORIGINAL_RUNTIME_CONFIG;
  });

  it.each(CORRUPT_VALUES)(
    'getImageProxyUrl：enableImageProxy=%p 损坏时不抛错，且仍返回已配代理',
    (bad) => {
      localStorage.setItem('enableImageProxy', bad);
      localStorage.setItem('imageProxyUrl', USER_PREFIX);
      expect(() => utils.getImageProxyUrl()).not.toThrow();
      expect(utils.getImageProxyUrl()).toBe(USER_PREFIX);
    }
  );

  it.each(CORRUPT_VALUES)(
    'getDoubanProxyUrl：enableDoubanProxy=%p 损坏时不抛错，且仍返回已配代理',
    (bad) => {
      localStorage.setItem('enableDoubanProxy', bad);
      localStorage.setItem('doubanProxyUrl', USER_PREFIX);
      expect(() => utils.getDoubanProxyUrl()).not.toThrow();
      expect(utils.getDoubanProxyUrl()).toBe(USER_PREFIX);
    }
  );

  it.each(CORRUPT_VALUES)(
    'processImageUrl：enableImageProxy=%p 损坏时不抛错，豆瓣图床仍走内置代理',
    (bad) => {
      delete (window as unknown as { RUNTIME_CONFIG?: unknown })
        .RUNTIME_CONFIG;
      localStorage.setItem('enableImageProxy', bad);
      expect(() => utils.processImageUrl(DOUBAN)).not.toThrow();
      expect(utils.processImageUrl(DOUBAN)).toBe(
        `${BUILTIN_IMAGE_PROXY_PREFIX}${encodeURIComponent(DOUBAN)}`
      );
    }
  );

  it.each(CORRUPT_VALUES)(
    'isImageProxyExplicitlyDisabled：enableImageProxy=%p 损坏时返回 false（未明确关闭）',
    (bad) => {
      localStorage.setItem('enableImageProxy', bad);
      expect(isImageProxyExplicitlyDisabled()).toBe(false);
    }
  );

  it('可解析值语义不变：false 关闭代理、true 启用代理', async () => {
    localStorage.setItem('enableImageProxy', 'false');
    localStorage.setItem('imageProxyUrl', USER_PREFIX);
    expect(utils.getImageProxyUrl()).toBeNull();
    expect(isImageProxyExplicitlyDisabled()).toBe(true);

    jest.resetModules();
    utils = await import('@/lib/utils');
    localStorage.setItem('enableImageProxy', 'true');
    expect(utils.getImageProxyUrl()).toBe(USER_PREFIX);
    expect(isImageProxyExplicitlyDisabled()).toBe(false);
  });
});
