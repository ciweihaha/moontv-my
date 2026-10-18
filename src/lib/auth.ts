import { NextRequest } from 'next/server';

/**
 * QUALITY-R3: HMAC-SHA256 签名（原在 login/register 路由中重复定义，现集中到此）。
 */
export async function generateSignature(
  data: string,
  secret: string
): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const messageData = encoder.encode(data);

  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, messageData);

  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** HMAC 签名验证（原在 middleware.ts，AUDIT-R2 集中到此复用） */
export async function verifyHmacSignature(
  data: string,
  signature: string,
  secret: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const messageData = encoder.encode(data);

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const signatureBuffer = new Uint8Array(
      signature.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || []
    );

    return await crypto.subtle.verify(
      'HMAC',
      key,
      signatureBuffer,
      messageData
    );
  } catch {
    return false;
  }
}

export interface AuthCookieData {
  password?: string;
  username?: string;
  signature?: string;
  timestamp?: number;
  role?: 'owner' | 'admin' | 'user';
}

/** 解析 auth Cookie 原始值（服务端用，供 NextRequest / 普通 Request 复用） */
export function parseAuthCookieValue(
  value: string | undefined | null
): AuthCookieData | null {
  if (!value) return null;
  try {
    let decoded = decodeURIComponent(value);
    // 处理可能的双重编码
    if (decoded.includes('%')) {
      decoded = decodeURIComponent(decoded);
    }
    return JSON.parse(decoded) as AuthCookieData;
  } catch {
    return null;
  }
}

// 从cookie获取认证信息 (服务端使用)
export function getAuthInfoFromCookie(
  request: NextRequest
): AuthCookieData | null {
  const authCookie = request.cookies.get('auth');
  return parseAuthCookieValue(authCookie?.value);
}

// 会话有效期：7 天（与登录 Cookie 的浏览器过期时间一致）
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 会话签名密钥。
 * 优先使用独立的 SESSION_SECRET；未配置时回退到 PASSWORD（兼容现有会话）。
 * 建议在生产环境配置高强度随机的 SESSION_SECRET，与密码验证用途分离。
 */
export function getSessionSecret(): string {
  return process.env.SESSION_SECRET || process.env.PASSWORD || '';
}

export interface VerifiedSession {
  username: string | null;
  role: 'owner' | 'admin' | 'user';
}

/**
 * AUDIT-R3 P0-B: 构建规范化会话签名数据。
 * 签名必须绑定 username + role + timestamp，防止篡改时间戳绕过过期、
 * 篡改 role 提权。格式：subject|role|timestamp
 */
export function buildSessionSignData(
  subject: string,
  role: string,
  timestamp: number
): string {
  return `${subject}|${role}|${timestamp}`;
}

/**
 * AUDIT-R3 P0-B: 服务端会话验证（签名 + 时间戳时效）。
 * 签名覆盖 username/role/timestamp 整体；验签通过后再检查有效期。
 * 缺失时间戳的旧 Cookie 直接拒绝（不再放行）。
 */
export async function verifyAuthSession(
  authInfo: AuthCookieData | null
): Promise<VerifiedSession | null> {
  if (!authInfo?.signature) return null;

  const secret = getSessionSecret();
  if (!secret) return null;

  // P0-B: 缺失时间戳的旧 Cookie 直接拒绝
  if (typeof authInfo.timestamp !== 'number') {
    return null;
  }

  // P0-B: 时间戳时效检查（拒绝未来时间戳与过期时间戳）
  const age = Date.now() - authInfo.timestamp;
  if (age < 0 || age > SESSION_MAX_AGE_MS) {
    return null;
  }

  // P0-B: 签名覆盖 subject + role + timestamp 整体
  const subject = authInfo.username || 'localstorage-auth';
  const role = authInfo.role ?? 'user';
  const signData = buildSessionSignData(subject, role, authInfo.timestamp);
  const valid = await verifyHmacSignature(signData, authInfo.signature, secret);
  if (!valid) return null;

  return {
    username: authInfo.username ?? null,
    role: role as 'owner' | 'admin' | 'user',
  };
}

// ---------------------------------------------------------------------------
// 客户端会话状态（AUDIT-R2 P0：替代已失效的 document.cookie 读取）
// Cookie 现为 HttpOnly，JS 无法读取；客户端展示用的用户名/角色改为走
// 服务端验证的 /api/auth/session 接口。以下仅用于展示与缓存分区，
// 不做任何鉴权决策（鉴权一律走服务端 HttpOnly Cookie）。
// ---------------------------------------------------------------------------

export interface ClientSession {
  username: string | null;
  role: 'owner' | 'admin' | 'user' | null;
}

const CLIENT_SESSION_KEY = 'moontv.client.session';

let memCachedSession: ClientSession | null | undefined = undefined;

/** 异步获取会话信息（带内存缓存），客户端组件在 useEffect 中调用 */
export async function fetchSessionInfo(): Promise<ClientSession | null> {
  if (typeof window === 'undefined') return null;
  if (memCachedSession !== undefined) return memCachedSession;
  try {
    const res = await fetch('/api/auth/session', { credentials: 'same-origin' });
    if (!res.ok) {
      memCachedSession = null;
      return null;
    }
    const data = await res.json();
    memCachedSession = {
      username: data.username ?? null,
      role: data.role ?? null,
    };
    try {
      // 同步一份用户名到 localStorage，供 db.client.ts 等同步调用方使用
      if (memCachedSession.username) {
        window.localStorage.setItem(
          CLIENT_SESSION_KEY,
          JSON.stringify(memCachedSession)
        );
      } else {
        window.localStorage.removeItem(CLIENT_SESSION_KEY);
      }
    } catch {
      // localStorage 不可用时忽略
    }
    return memCachedSession;
  } catch {
    memCachedSession = null;
    return null;
  }
}

/** 同步读取已缓存的用户名（db.client.ts 缓存分区用）；未加载时返回 null */
export function getSyncSessionUsername(): string | null {
  if (typeof window === 'undefined') return null;
  if (memCachedSession !== undefined) {
    return memCachedSession?.username ?? null;
  }
  try {
    const raw = window.localStorage.getItem(CLIENT_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ClientSession;
    return parsed.username ?? null;
  } catch {
    return null;
  }
}

/** 登出时清理客户端会话缓存 */
export function clearClientSession(): void {
  memCachedSession = undefined;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(CLIENT_SESSION_KEY);
    } catch {
      // 忽略
    }
  }
}
