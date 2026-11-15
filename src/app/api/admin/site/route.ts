/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import { NextRequest, NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/adminAuth';
import { getConfig, invalidateConfigCache } from '@/lib/config';
import { getStorage } from '@/lib/db';

export const runtime = 'edge';

// H2: 站点名/公告来自管理员输入，会进 layout 的内联脚本与页面展示；
// 限长并拒绝 < >，与 layout 的转义形成双层防护
const SITE_NAME_MAX_LENGTH = 50;
const ANNOUNCEMENT_MAX_LENGTH = 500;
const PROXY_URL_MAX_LENGTH = 2048;

export async function POST(request: NextRequest) {
  // R3-A3: 统一 admin 鉴权（requireAdmin 含 localstorage 检查）
  const { user: _adminUser, error: _adminError } = await requireAdmin(request);
  if (_adminError) return _adminError;

  try {
    const body = await request.json();

    const {
      SiteName,
      Announcement,
      SearchDownstreamMaxPage,
      SiteInterfaceCacheTime,
      ImageProxy,
      DoubanProxy,
      DisableYellowFilter,
    } = body as {
      SiteName: string;
      Announcement: string;
      SearchDownstreamMaxPage: number;
      SiteInterfaceCacheTime: number;
      ImageProxy: string;
      DoubanProxy: string;
      DisableYellowFilter: boolean;
    };

    // 参数校验
    if (
      typeof SiteName !== 'string' ||
      typeof Announcement !== 'string' ||
      typeof SearchDownstreamMaxPage !== 'number' ||
      typeof SiteInterfaceCacheTime !== 'number' ||
      typeof ImageProxy !== 'string' ||
      typeof DoubanProxy !== 'string' ||
      typeof DisableYellowFilter !== 'boolean'
    ) {
      return NextResponse.json({ error: '参数格式错误' }, { status: 400 });
    }

    // H2: 站点名/公告限长并拒绝 < >（可注入内联脚本）；代理地址限长
    if (
      SiteName.length > SITE_NAME_MAX_LENGTH ||
      Announcement.length > ANNOUNCEMENT_MAX_LENGTH ||
      SiteName.includes('<') ||
      SiteName.includes('>') ||
      Announcement.includes('<') ||
      Announcement.includes('>') ||
      ImageProxy.length > PROXY_URL_MAX_LENGTH ||
      DoubanProxy.length > PROXY_URL_MAX_LENGTH
    ) {
      return NextResponse.json(
        {
          error:
            '站点名称（≤50 字符）或公告（≤500 字符）格式错误，不得包含 < >',
        },
        { status: 400 }
      );
    }

    const adminConfig = await getConfig();
    const storage = getStorage();


    // 更新缓存中的站点设置
    adminConfig.SiteConfig = {
      SiteName,
      Announcement,
      SearchDownstreamMaxPage,
      SiteInterfaceCacheTime,
      ImageProxy,
      DoubanProxy,
      DisableYellowFilter,
    };

    // 写入数据库
    if (storage && typeof (storage as any).setAdminConfig === 'function') {
      await (storage as any).setAdminConfig(adminConfig);
      // M6: 写配置后主动失效 D1 配置缓存
      invalidateConfigCache();
    }

    return NextResponse.json(
      { ok: true },
      {
        headers: {
          'Cache-Control': 'no-store', // 不缓存结果
        },
      }
    );
  } catch (error) {
    // L3: 只记日志，不向客户端回显内部错误原文
    console.error('更新站点配置失败:', error);
    return NextResponse.json({ error: '更新站点配置失败' }, { status: 500 });
  }
}
