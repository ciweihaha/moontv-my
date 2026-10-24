/**
 * 密码哈希（repo-hardening 第 17 项）。
 *
 * 用 WebCrypto PBKDF2-HMAC-SHA256——Edge 与 Node 运行时均原生可用，
 * 不引入新依赖。存储格式：`pbkdf2$<iterations>$<salt_b64>$<hash_b64>`。
 *
 * 迭代次数：Cloudflare Workers 的 WebCrypto 对 PBKDF2 有 100,000 次的
 * 平台上限（超出会抛错），故取上限值 100,000 作为常量；这也是在该
 * 平台上能取到的最高量级。若将来部署平台放开上限，可调高此常量——
 * 校验按存储串里记录的迭代次数执行，老数据不受常量变更影响。
 *
 * 兼容迁移：verifyUser 对无 `pbkdf2$` 前缀的存量值按旧明文比对，
 * 成功后由调用方透明升级回写为哈希（见 d1.db.ts 的 verifyUser）。
 */

export const PBKDF2_ITERATIONS = 100_000;

const PBKDF2_PREFIX = 'pbkdf2$';
const SALT_BYTES = 16;
const HASH_BYTES = 32;

function getSubtle(): SubtleCrypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.subtle) {
    throw new Error('WebCrypto SubtleCrypto 不可用，无法处理密码哈希');
  }
  return c.subtle;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

/** 字节数组常量时间比较（长度不同直接 false，哈希长度固定故无泄漏面） */
export function constantTimeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

/** 字符串常量时间比较（用于存量明文兼容比对） */
export function constantTimeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function deriveBits(
  password: string,
  salt: Uint8Array,
  iterations: number
): Promise<Uint8Array> {
  const subtle = getSubtle();
  const keyMaterial = await subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    HASH_BYTES * 8
  );
  return new Uint8Array(bits);
}

/** 将明文密码哈希为存储串（每次随机盐） */
export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(SALT_BYTES);
  (globalThis as { crypto: Crypto }).crypto.getRandomValues(salt);
  const hash = await deriveBits(password, salt, PBKDF2_ITERATIONS);
  return `${PBKDF2_PREFIX}${PBKDF2_ITERATIONS}$${bytesToBase64(
    salt
  )}$${bytesToBase64(hash)}`;
}

/** 存储值是否为本模块格式的哈希串 */
export function isPasswordHash(stored: string): boolean {
  return typeof stored === 'string' && stored.startsWith(PBKDF2_PREFIX);
}

export interface PasswordCheck {
  ok: boolean;
  /** 存量明文比对成功——调用方应把存储值透明升级为哈希 */
  needsUpgrade: boolean;
}

/**
 * 校验密码与存储值是否匹配：
 * - 哈希串：解析迭代次数/盐/哈希，重新派生后常量时间比较；
 * - 存量明文（无前缀）：常量时间字符串比较，成功标记 needsUpgrade；
 * - 格式损坏的哈希串：一律不通过（不回退明文比对，防降级）。
 */
export async function verifyPassword(
  password: string,
  stored: string
): Promise<PasswordCheck> {
  if (isPasswordHash(stored)) {
    const parts = stored.split('$');
    if (parts.length !== 4) return { ok: false, needsUpgrade: false };
    const iterations = parseInt(parts[1], 10);
    if (!Number.isFinite(iterations) || iterations <= 0) {
      return { ok: false, needsUpgrade: false };
    }
    let salt: Uint8Array;
    let expected: Uint8Array;
    try {
      salt = base64ToBytes(parts[2]);
      expected = base64ToBytes(parts[3]);
    } catch {
      return { ok: false, needsUpgrade: false };
    }
    const actual = await deriveBits(password, salt, iterations);
    return {
      ok: constantTimeEqualBytes(actual, expected),
      needsUpgrade: false,
    };
  }
  const ok = constantTimeEqualString(password, stored);
  return { ok, needsUpgrade: ok };
}
