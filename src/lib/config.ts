/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

import { getStorage } from '@/lib/db';

import { AdminConfig } from './admin.types';
import runtimeConfig from './runtime';

export interface ApiSite {
  key: string;
  api: string;
  name: string;
  detail?: string;
}

interface ConfigFileStruct {
  cache_time?: number;
  api_site: {
    [key: string]: ApiSite;
  };
  custom_category?: {
    name?: string;
    type: 'movie' | 'tv';
    query: string;
  }[];
}

export const API_CONFIG = {
  search: {
    path: '?ac=videolist&wd=',
    pagePath: '?ac=videolist&wd={query}&pg={page}',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept: 'application/json',
    },
  },
  detail: {
    path: '?ac=videolist&ids=',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept: 'application/json',
    },
  },
};

// 在模块加载时根据环境决定配置来源
let fileConfig: ConfigFileStruct;
let cachedConfig: AdminConfig;
// P2-4: 缓存初始化 Promise，并发请求共享，避免冷启动重复初始化
let initPromise: Promise<void> | null = null;

// repo-hardening 第 21 项：初始化失败必须显式化。此前 doInitConfig 的
// catch 只打日志、cachedConfig 保持未赋值，getConfig 会把 undefined
// 当配置返回，调用方在 config.UserConfig 处抛含糊 TypeError，根源被吞。
// 现在记录 initError，getConfig 在缓存仍为空时抛 ConfigInitError。
let initError: Error | null = null;

// M6: D1 模式进程内配置缓存（短 TTL）。此前 D1 分支每次 getConfig 都读
// 库，单次搜索触发 2 次全量配置读取（配置含全部源 + 全部用户，JSON 不小）；
// cachedConfig 只在 localstorage 模式使用。管理端写配置后须调用
// invalidateConfigCache() 主动失效（见各 admin 路由与 register 路由）。
const DB_CONFIG_CACHE_TTL_MS = 60_000;
let dbConfigCache: { config: AdminConfig; expiresAt: number } | null = null;

/** 主动失效 D1 配置缓存（管理端写配置 / 重置配置后调用） */
export function invalidateConfigCache(): void {
  dbConfigCache = null;
}

export class ConfigInitError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'ConfigInitError';
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

function ensureCachedConfigOrThrow(): AdminConfig {
  if (!cachedConfig) {
    throw new ConfigInitError(
      `管理员配置初始化失败，配置不可用${
        initError ? `: ${initError.message}` : ''
      }`,
      initError ?? undefined
    );
  }
  return cachedConfig;
}

async function initConfig() {
  if (cachedConfig) {
    return;
  }
  if (initPromise) {
    return initPromise;
  }
  initPromise = doInitConfig();
  try {
    await initPromise;
  } finally {
    initPromise = null;
  }
}

async function doInitConfig() {

  // Cloudflare Pages 无 DOCKER_ENV，直接用编译时配置（原 Docker 分支的 import('module') 会导致 esbuild 构建失败）
  fileConfig = runtimeConfig as unknown as ConfigFileStruct;
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  if (storageType !== 'localstorage') {
    // 数据库存储，读取并补全管理员配置
    const storage = getStorage();

    try {
      // 尝试从数据库获取管理员配置
      let adminConfig: AdminConfig | null = null;
      if (storage && typeof (storage as any).getAdminConfig === 'function') {
        adminConfig = await (storage as any).getAdminConfig();
      }

      // 获取所有用户名，用于补全 Users
      let userNames: string[] = [];
      if (storage && typeof (storage as any).getAllUsers === 'function') {
        try {
          userNames = await (storage as any).getAllUsers();
        } catch (e) {
          console.error('获取用户列表失败:', e);
        }
      }

      // 从文件中获取源信息，用于补全源
      const apiSiteEntries = Object.entries(fileConfig.api_site);
      const customCategories = fileConfig.custom_category || [];

      if (adminConfig) {
        // 补全 SourceConfig
        const sourceConfigMap = new Map(
          (adminConfig.SourceConfig || []).map((s) => [s.key, s])
        );

        apiSiteEntries.forEach(([key, site]) => {
          sourceConfigMap.set(key, {
            key,
            name: site.name,
            api: site.api,
            detail: site.detail,
            from: 'config',
            disabled: false,
          });
        });

        // 将 Map 转换回数组
        adminConfig.SourceConfig = Array.from(sourceConfigMap.values());

        // 检查现有源是否在 fileConfig.api_site 中，如果不在则标记为 custom
        const apiSiteKeys = new Set(apiSiteEntries.map(([key]) => key));
        adminConfig.SourceConfig.forEach((source) => {
          if (!apiSiteKeys.has(source.key)) {
            source.from = 'custom';
          }
        });

        // 确保 CustomCategories 被初始化
        if (!adminConfig.CustomCategories) {
          adminConfig.CustomCategories = [];
        }

        // 补全 CustomCategories
        const customCategoriesMap = new Map(
          adminConfig.CustomCategories.map((c) => [c.query + c.type, c])
        );

        customCategories.forEach((category) => {
          customCategoriesMap.set(category.query + category.type, {
            name: category.name,
            type: category.type,
            query: category.query,
            from: 'config',
            disabled: false,
          });
        });

        // 检查现有 CustomCategories 是否在 fileConfig.custom_category 中，如果不在则标记为 custom
        const customCategoriesKeys = new Set(
          customCategories.map((c) => c.query + c.type)
        );
        customCategoriesMap.forEach((category) => {
          if (!customCategoriesKeys.has(category.query + category.type)) {
            category.from = 'custom';
          }
        });

        // 将 Map 转换回数组
        adminConfig.CustomCategories = Array.from(customCategoriesMap.values());

        const existedUsers = new Set(
          (adminConfig.UserConfig.Users || []).map((u) => u.username)
        );
        userNames.forEach((uname) => {
          if (!existedUsers.has(uname)) {
            adminConfig!.UserConfig.Users.push({
              username: uname,
              role: 'user',
            });
          }
        });
        // 站长
        const ownerUser = process.env.USERNAME;
        if (ownerUser) {
          adminConfig!.UserConfig.Users = adminConfig!.UserConfig.Users.filter(
            (u) => u.username !== ownerUser
          );
          adminConfig!.UserConfig.Users.unshift({
            username: ownerUser,
            role: 'owner',
          });
        }
      } else {
        // 数据库中没有配置，创建新的管理员配置
        let allUsers = userNames.map((uname) => ({
          username: uname,
          role: 'user',
        }));
        const ownerUser = process.env.USERNAME;
        if (ownerUser) {
          allUsers = allUsers.filter((u) => u.username !== ownerUser);
          allUsers.unshift({
            username: ownerUser,
            role: 'owner',
          });
        }
        adminConfig = {
          SiteConfig: {
            SiteName: process.env.SITE_NAME || 'MoonTV',
            Announcement:
              process.env.ANNOUNCEMENT ||
              '本网站仅提供影视信息搜索服务，所有内容均来自第三方网站。本站不存储任何视频资源，不对任何内容的准确性、合法性、完整性负责。',
            SearchDownstreamMaxPage:
              Number(process.env.NEXT_PUBLIC_SEARCH_MAX_PAGE) || 2,
            SiteInterfaceCacheTime: fileConfig.cache_time || 7200,
            ImageProxy: process.env.NEXT_PUBLIC_IMAGE_PROXY || '',
            DoubanProxy: process.env.NEXT_PUBLIC_DOUBAN_PROXY || '',
            DisableYellowFilter:
              process.env.NEXT_PUBLIC_DISABLE_YELLOW_FILTER === 'true',
          },
          UserConfig: {
            AllowRegister: process.env.NEXT_PUBLIC_ENABLE_REGISTER === 'true',
            Users: allUsers as any,
          },
          SourceConfig: apiSiteEntries.map(([key, site]) => ({
            key,
            name: site.name,
            api: site.api,
            detail: site.detail,
            from: 'config',
            disabled: false,
          })),
          CustomCategories: customCategories.map((category) => ({
            name: category.name,
            type: category.type,
            query: category.query,
            from: 'config',
            disabled: false,
          })),
        };
      }

      // 写回数据库（更新/创建）
      if (storage && typeof (storage as any).setAdminConfig === 'function') {
        await (storage as any).setAdminConfig(adminConfig);
      }

      // 更新缓存
      cachedConfig = adminConfig;
      initError = null;
    } catch (err) {
      // 第 21 项：不再静默吞掉——记录根源，getConfig 会据此抛
      // ConfigInitError，而不是返回未初始化的 undefined 配置。
      console.error('加载管理员配置失败:', err);
      initError = err instanceof Error ? err : new Error(String(err));
    }
  } else {
    // 本地存储直接使用文件配置
    cachedConfig = {
      SiteConfig: {
        SiteName: process.env.SITE_NAME || 'MoonTV',
        Announcement:
          process.env.ANNOUNCEMENT ||
          '本网站仅提供影视信息搜索服务，所有内容均来自第三方网站。本站不存储任何视频资源，不对任何内容的准确性、合法性、完整性负责。',
        SearchDownstreamMaxPage:
          Number(process.env.NEXT_PUBLIC_SEARCH_MAX_PAGE) || 2,
        SiteInterfaceCacheTime: fileConfig.cache_time || 7200,
        ImageProxy: process.env.NEXT_PUBLIC_IMAGE_PROXY || '',
        DoubanProxy: process.env.NEXT_PUBLIC_DOUBAN_PROXY || '',
        DisableYellowFilter:
          process.env.NEXT_PUBLIC_DISABLE_YELLOW_FILTER === 'true',
      },
      UserConfig: {
        AllowRegister: process.env.NEXT_PUBLIC_ENABLE_REGISTER === 'true',
        Users: [],
      },
      SourceConfig: Object.entries(fileConfig.api_site).map(([key, site]) => ({
        key,
        name: site.name,
        api: site.api,
        detail: site.detail,
        from: 'config',
        disabled: false,
      })),
      CustomCategories:
        fileConfig.custom_category?.map((category) => ({
          name: category.name,
          type: category.type,
          query: category.query,
          from: 'config',
          disabled: false,
        })) || [],
    } as AdminConfig;
  }
}

export async function getConfig(): Promise<AdminConfig> {
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  if (storageType === 'localstorage') {
    await initConfig();
    return ensureCachedConfigOrThrow();
  }
  // M6: D1 模式短 TTL 缓存命中时直接返回，避免每次请求都读库
  if (dbConfigCache && Date.now() < dbConfigCache.expiresAt) {
    return dbConfigCache.config;
  }
  // 非 docker 环境且 DB 存储，直接读 db 配置
  const storage = getStorage();
  let adminConfig: AdminConfig | null = null;
  if (storage && typeof (storage as any).getAdminConfig === 'function') {
    adminConfig = await (storage as any).getAdminConfig();
  }
  if (adminConfig) {
    // 确保 CustomCategories 被初始化
    if (!adminConfig.CustomCategories) {
      adminConfig.CustomCategories = [];
    }

    // 合并一些环境变量配置
    adminConfig.SiteConfig.SiteName = process.env.SITE_NAME || 'MoonTV';
    adminConfig.SiteConfig.Announcement =
      process.env.ANNOUNCEMENT ||
      '本网站仅提供影视信息搜索服务，所有内容均来自第三方网站。本站不存储任何视频资源，不对任何内容的准确性、合法性、完整性负责。';
    adminConfig.UserConfig.AllowRegister =
      process.env.NEXT_PUBLIC_ENABLE_REGISTER === 'true';
    adminConfig.SiteConfig.ImageProxy =
      process.env.NEXT_PUBLIC_IMAGE_PROXY || '';
    adminConfig.SiteConfig.DoubanProxy =
      process.env.NEXT_PUBLIC_DOUBAN_PROXY || '';
    adminConfig.SiteConfig.DisableYellowFilter =
      process.env.NEXT_PUBLIC_DISABLE_YELLOW_FILTER === 'true';

    // 合并文件中的源信息
    fileConfig = runtimeConfig as unknown as ConfigFileStruct;
    const apiSiteEntries = Object.entries(fileConfig.api_site);
    const sourceConfigMap = new Map(
      (adminConfig.SourceConfig || []).map((s) => [s.key, s])
    );

    apiSiteEntries.forEach(([key, site]) => {
      const existingSource = sourceConfigMap.get(key);
      if (existingSource) {
        // 如果已存在，只覆盖 name、api、detail 和 from
        existingSource.name = site.name;
        existingSource.api = site.api;
        existingSource.detail = site.detail;
        existingSource.from = 'config';
      } else {
        // 如果不存在，创建新条目
        sourceConfigMap.set(key, {
          key,
          name: site.name,
          api: site.api,
          detail: site.detail,
          from: 'config',
          disabled: false,
        });
      }
    });

    // 检查现有源是否在 fileConfig.api_site 中，如果不在则标记为 custom
    const apiSiteKeys = new Set(apiSiteEntries.map(([key]) => key));
    sourceConfigMap.forEach((source) => {
      if (!apiSiteKeys.has(source.key)) {
        source.from = 'custom';
      }
    });

    // 将 Map 转换回数组
    adminConfig.SourceConfig = Array.from(sourceConfigMap.values());

    // 覆盖 CustomCategories
    const customCategories = fileConfig.custom_category || [];
    adminConfig.CustomCategories = customCategories.map((category) => ({
      name: category.name,
      type: category.type,
      query: category.query,
      from: 'config',
      disabled: false,
    }));

    const ownerUser = process.env.USERNAME || '';
    // 检查配置中的站长用户是否和 USERNAME 匹配，如果不匹配则降级为普通用户
    let containOwner = false;
    adminConfig.UserConfig.Users.forEach((user) => {
      if (user.username !== ownerUser && user.role === 'owner') {
        user.role = 'user';
      }
      if (user.username === ownerUser) {
        containOwner = true;
        user.role = 'owner';
      }
    });

    // 如果不在则添加
    if (!containOwner) {
      adminConfig.UserConfig.Users.unshift({
        username: ownerUser,
        role: 'owner',
      });
    }
    cachedConfig = adminConfig;
    dbConfigCache = {
      config: adminConfig,
      expiresAt: Date.now() + DB_CONFIG_CACHE_TTL_MS,
    };
  } else {
    // DB 无配置，执行一次初始化
    await initConfig();
    // initConfig 已填充 cachedConfig，同样进缓存
    if (cachedConfig) {
      dbConfigCache = {
        config: cachedConfig,
        expiresAt: Date.now() + DB_CONFIG_CACHE_TTL_MS,
      };
    }
  }
  // 第 21 项：初始化失败时 cachedConfig 仍为空——抛明确错误，
  // 不把 undefined 当配置返回给调用方。
  return ensureCachedConfigOrThrow();
}

export async function resetConfig() {
  const storage = getStorage();
  // 获取所有用户名，用于补全 Users
  let userNames: string[] = [];
  if (storage && typeof (storage as any).getAllUsers === 'function') {
    try {
      userNames = await (storage as any).getAllUsers();
    } catch (e) {
      console.error('获取用户列表失败:', e);
    }
  }

  // Cloudflare Pages 无 DOCKER_ENV，直接用编译时配置（原 Docker 分支的 import('module') 会导致 esbuild 构建失败）
  fileConfig = runtimeConfig as unknown as ConfigFileStruct;

  const apiSiteEntries = Object.entries(fileConfig.api_site);
  const customCategories = fileConfig.custom_category || [];
  let allUsers = userNames.map((uname) => ({
    username: uname,
    role: 'user',
  }));
  const ownerUser = process.env.USERNAME;
  if (ownerUser) {
    allUsers = allUsers.filter((u) => u.username !== ownerUser);
    allUsers.unshift({
      username: ownerUser,
      role: 'owner',
    });
  }
  const adminConfig = {
    SiteConfig: {
      SiteName: process.env.SITE_NAME || 'MoonTV',
      Announcement:
        process.env.ANNOUNCEMENT ||
        '本网站仅提供影视信息搜索服务，所有内容均来自第三方网站。本站不存储任何视频资源，不对任何内容的准确性、合法性、完整性负责。',
      SearchDownstreamMaxPage:
        Number(process.env.NEXT_PUBLIC_SEARCH_MAX_PAGE) || 2,
      SiteInterfaceCacheTime: fileConfig.cache_time || 7200,
      ImageProxy: process.env.NEXT_PUBLIC_IMAGE_PROXY || '',
      DoubanProxy: process.env.NEXT_PUBLIC_DOUBAN_PROXY || '',
      DisableYellowFilter:
        process.env.NEXT_PUBLIC_DISABLE_YELLOW_FILTER === 'true',
    },
    UserConfig: {
      AllowRegister: process.env.NEXT_PUBLIC_ENABLE_REGISTER === 'true',
      Users: allUsers as any,
    },
    SourceConfig: apiSiteEntries.map(([key, site]) => ({
      key,
      name: site.name,
      api: site.api,
      detail: site.detail,
      from: 'config',
      disabled: false,
    })),
    // M8: 重置时始终用 config.json 的默认值重建自定义分类。旧实现
    // `storageType === 'redis' ? ... : []` 中 redis 存储从未实现
    // （db.ts 会显式抛错），条件恒为 false，每次重置都清空全部自定义分类。
    CustomCategories: customCategories.map((category) => ({
      name: category.name,
      type: category.type,
      query: category.query,
      from: 'config',
      disabled: false,
    })),
  } as AdminConfig;

  if (storage && typeof (storage as any).setAdminConfig === 'function') {
    await (storage as any).setAdminConfig(adminConfig);
  }
  if (cachedConfig == null) {
    // serverless 环境，直接使用 adminConfig
    cachedConfig = adminConfig;
  }
  cachedConfig.SiteConfig = adminConfig.SiteConfig;
  cachedConfig.UserConfig = adminConfig.UserConfig;
  cachedConfig.SourceConfig = adminConfig.SourceConfig;
  cachedConfig.CustomCategories = adminConfig.CustomCategories;
  // M6: 重置后失效 D1 配置缓存，下次读取走库里的新配置
  invalidateConfigCache();
}

export async function getCacheTime(): Promise<number> {
  const config = await getConfig();
  return config.SiteConfig.SiteInterfaceCacheTime || 7200;
}

export async function getAvailableApiSites(): Promise<ApiSite[]> {
  const config = await getConfig();
  return config.SourceConfig.filter((s) => !s.disabled).map((s) => ({
    key: s.key,
    name: s.name,
    api: s.api,
    detail: s.detail,
  }));
}
