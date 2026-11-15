/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import { NextRequest, NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/adminAuth';
import { getConfig, invalidateConfigCache } from '@/lib/config';
import { getStorage } from '@/lib/db';
import { validateExternalUrl } from '@/lib/ssrf';
import { IStorage } from '@/lib/types';

export const runtime = 'edge';

// M4: 视频源字段长度上限
const SOURCE_KEY_MAX_LENGTH = 64;
const SOURCE_NAME_MAX_LENGTH = 100;

// 支持的操作类型
type Action = 'add' | 'disable' | 'enable' | 'delete' | 'sort';

interface BaseBody {
  action?: Action;
}

export async function POST(request: NextRequest) {
  // R3-A3: 统一 admin 鉴权（requireAdmin 含 localstorage 检查）
  const { user: _adminUser, error: _adminError } = await requireAdmin(request);
  if (_adminError) return _adminError;
  const username = _adminUser!.username;

  try {
    const body = (await request.json()) as BaseBody & Record<string, any>;
    const { action } = body;

    // 基础校验
    const ACTIONS: Action[] = ['add', 'disable', 'enable', 'delete', 'sort'];
    if (!username || !action || !ACTIONS.includes(action)) {
      return NextResponse.json({ error: '参数格式错误' }, { status: 400 });
    }

    // 获取配置与存储
    const adminConfig = await getConfig();
    const storage: IStorage | null = getStorage();


    switch (action) {
      case 'add': {
        const { key, name, api, detail } = body as {
          key?: string;
          name?: string;
          api?: string;
          detail?: string;
        };
        if (
          !key ||
          !name ||
          !api ||
          typeof key !== 'string' ||
          typeof name !== 'string' ||
          typeof api !== 'string' ||
          (detail !== undefined && typeof detail !== 'string')
        ) {
          return NextResponse.json({ error: '缺少必要参数' }, { status: 400 });
        }
        if (
          key.length > SOURCE_KEY_MAX_LENGTH ||
          name.length > SOURCE_NAME_MAX_LENGTH
        ) {
          return NextResponse.json({ error: '参数过长' }, { status: 400 });
        }
        // M4: 校验 api/detail 为合法公网 http(s) URL，复用 image-proxy 的
        // 内网段拦截逻辑——否则 role=admin 可植入内网/元数据地址，
        // 搜索/详情接口随后以服务端身份请求，造成 SSRF（Docker 自托管下可打宿主机内网）
        const apiError = validateExternalUrl(api);
        if (apiError) {
          return NextResponse.json(
            { error: `视频源地址无效：${apiError}` },
            { status: 400 }
          );
        }
        if (detail) {
          const detailError = validateExternalUrl(detail);
          if (detailError) {
            return NextResponse.json(
              { error: `详情地址无效：${detailError}` },
              { status: 400 }
            );
          }
        }
        if (adminConfig.SourceConfig.some((s) => s.key === key)) {
          return NextResponse.json({ error: '该源已存在' }, { status: 400 });
        }
        adminConfig.SourceConfig.push({
          key,
          name,
          api,
          detail,
          from: 'custom',
          disabled: false,
        });
        break;
      }
      case 'disable': {
        const { key } = body as { key?: string };
        if (!key)
          return NextResponse.json({ error: '缺少 key 参数' }, { status: 400 });
        const entry = adminConfig.SourceConfig.find((s) => s.key === key);
        if (!entry)
          return NextResponse.json({ error: '源不存在' }, { status: 404 });
        entry.disabled = true;
        break;
      }
      case 'enable': {
        const { key } = body as { key?: string };
        if (!key)
          return NextResponse.json({ error: '缺少 key 参数' }, { status: 400 });
        const entry = adminConfig.SourceConfig.find((s) => s.key === key);
        if (!entry)
          return NextResponse.json({ error: '源不存在' }, { status: 404 });
        entry.disabled = false;
        break;
      }
      case 'delete': {
        const { key } = body as { key?: string };
        if (!key)
          return NextResponse.json({ error: '缺少 key 参数' }, { status: 400 });
        const idx = adminConfig.SourceConfig.findIndex((s) => s.key === key);
        if (idx === -1)
          return NextResponse.json({ error: '源不存在' }, { status: 404 });
        const entry = adminConfig.SourceConfig[idx];
        if (entry.from === 'config') {
          return NextResponse.json({ error: '该源不可删除' }, { status: 400 });
        }
        adminConfig.SourceConfig.splice(idx, 1);
        break;
      }
      case 'sort': {
        const { order } = body as { order?: string[] };
        if (!Array.isArray(order)) {
          return NextResponse.json(
            { error: '排序列表格式错误' },
            { status: 400 }
          );
        }
        const map = new Map(adminConfig.SourceConfig.map((s) => [s.key, s]));
        const newList: typeof adminConfig.SourceConfig = [];
        order.forEach((k) => {
          const item = map.get(k);
          if (item) {
            newList.push(item);
            map.delete(k);
          }
        });
        // 未在 order 中的保持原顺序
        adminConfig.SourceConfig.forEach((item) => {
          if (map.has(item.key)) newList.push(item);
        });
        adminConfig.SourceConfig = newList;
        break;
      }
      default:
        return NextResponse.json({ error: '未知操作' }, { status: 400 });
    }

    // 持久化到存储
    if (storage && typeof (storage as any).setAdminConfig === 'function') {
      await (storage as any).setAdminConfig(adminConfig);
      // M6: 写配置后主动失效 D1 配置缓存
      invalidateConfigCache();
    }

    return NextResponse.json(
      { ok: true },
      {
        headers: {
          'Cache-Control': 'no-store',
        },
      }
    );
  } catch (error) {
    // L3: 只记日志，不向客户端回显内部错误原文
    console.error('视频源管理操作失败:', error);
    return NextResponse.json({ error: '视频源管理操作失败' }, { status: 500 });
  }
}
