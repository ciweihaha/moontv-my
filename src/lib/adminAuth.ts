import { NextRequest, NextResponse } from 'next/server';

import { AdminConfig } from '@/lib/admin.types';
import { getAuthInfoFromCookie } from '@/lib/auth';
import { getConfig } from '@/lib/config';

/**
 * R2-A2: Admin 路由统一鉴权助手。
 *
 * 收敛 7 个 admin 路由重复的认证样板：
 *   getAuthInfoFromCookie → 401 → 查用户角色 → 403
 *
 * 用法：
 *   const { user, config, error } = await requireAdmin(request);
 *   if (error) return error; // 已是 401/403 的 NextResponse
 *   // ... 业务逻辑，可用 user.username / user.role / config
 */

export interface AdminUser {
  username: string;
  role: 'owner' | 'admin';
}

interface RequireAdminResult {
  user: AdminUser | null;
  config: AdminConfig | null;
  /** 非空时直接 return 此响应（401/403/400） */
  error: NextResponse | null;
}

/**
 * 校验管理员身份。owner（环境变量 USERNAME）或 role=admin 的用户通过。
 * @param requireDb 存储类型为 localstorage 时是否直接 400（默认 true，管理配置类接口需要）
 */
export async function requireAdmin(
  request: NextRequest,
  requireDb = true
): Promise<RequireAdminResult> {
  const fail = (
    message: string,
    status: number
  ): RequireAdminResult => ({
    user: null,
    config: null,
    error: NextResponse.json({ error: message }, { status }),
  });

  if (requireDb) {
    const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
    if (storageType === 'localstorage') {
      return fail('不支持本地存储进行管理员配置', 400);
    }
  }

  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo || !authInfo.username) {
    return fail('Unauthorized', 401);
  }
  const username = authInfo.username;

  const config = await getConfig();

  // owner：环境变量 USERNAME 指定的超级管理员
  if (username === process.env.USERNAME) {
    return { user: { username, role: 'owner' }, config, error: null };
  }

  const userEntry = config.UserConfig.Users.find((u) => u.username === username);
  if (userEntry && userEntry.role === 'admin') {
    return { user: { username, role: 'admin' }, config, error: null };
  }

  return fail('Forbidden: 需要管理员权限', 403);
}
