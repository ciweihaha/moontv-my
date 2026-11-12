/** @type {import('next').NextConfig} */
/* eslint-disable @typescript-eslint/no-var-requires */
const nextConfig = {
  eslint: {
    dirs: ['src'],
  },

  reactStrictMode: false,

  // R5-S1: 安全响应头（防点击劫持、MIME 嗅探）
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
          // L12: 基线 CSP，作为 XSS 的第二道防线（与 H2 的转义配合）。
          // 注意：Next.js App Router 与 layout 内联 RUNTIME_CONFIG 脚本
          // 需要 script-src 'unsafe-inline'，完整 nonce 方案是后续工作；
          // 当前基线仍可拦截 object/embed 注入与外域脚本/frame。
          // media/connect 需放行任意 http(s) 上游（HLS 点播流与分片来自任意域名），
          // img 需放行任意图床与 data:。
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              'img-src \'self\' data: https: http:',
              'media-src \'self\' https: http: blob:',
              'connect-src \'self\' https: http: ws: wss:',
              "font-src 'self' data:",
              "frame-src 'self' https:",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
              "frame-ancestors 'self'",
            ].join('; '),
          },
        ],
      },
    ];
  },

  // Uncoment to add domain whitelist
  images: {
    unoptimized: true,
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**',
      },
      {
        protocol: 'http',
        hostname: '**',
      },
    ],
  },

  webpack(config) {
    // Grab the existing rule that handles SVG imports
    const fileLoaderRule = config.module.rules.find((rule) =>
      rule.test?.test?.('.svg')
    );

    config.module.rules.push(
      // Reapply the existing rule, but only for svg imports ending in ?url
      {
        ...fileLoaderRule,
        test: /\.svg$/i,
        resourceQuery: /url/, // *.svg?url
      },
      // Convert all other *.svg imports to React components
      {
        test: /\.svg$/i,
        issuer: { not: /\.(css|scss|sass)$/ },
        resourceQuery: { not: /url/ }, // exclude if *.svg?url
        loader: '@svgr/webpack',
        options: {
          dimensions: false,
          titleProp: true,
        },
      }
    );

    // Modify the file loader rule to ignore *.svg, since we have it handled now.
    fileLoaderRule.exclude = /\.svg$/i;

    config.resolve.fallback = {
      ...config.resolve.fallback,
      net: false,
      tls: false,
      crypto: false,
    };

    return config;
  },
};

// L11: 默认 next-pwa runtimeCaching 会缓存所有同源 /api/* GET 响应
// （NetworkFirst 24h），同一浏览器多账号共用时，网络超时可能把 A 的
// 收藏/播放记录返回给 B。用户相关接口一律 NetworkOnly（不缓存），
// 规则置于默认列表最前（workbox 按注册顺序匹配，首个命中生效）；
// 其余默认规则（搜索/详情/豆瓣/图片等公开接口）保持不变。
// 注意：next-pwa 的 urlPattern 函数在 Service Worker 内执行，可用 self。
const defaultRuntimeCaching = require('next-pwa/cache');
const runtimeCaching = [
  {
    urlPattern: ({ url }) =>
      url.origin === self.origin &&
      /^\/api\/(favorites|playrecords|searchhistory|skipconfigs|admin|auth|change-password|login|register|logout|health|cron|server-config)(\/|$)/.test(
        url.pathname
      ),
    handler: 'NetworkOnly',
  },
  ...defaultRuntimeCaching,
];

const withPWA = require('next-pwa')({
  dest: 'public',
  disable:
    process.env.NODE_ENV === 'development' || process.env.CF_PAGES === '1',
  register: true,
  skipWaiting: true,
  runtimeCaching,
});

module.exports = withPWA(nextConfig);
