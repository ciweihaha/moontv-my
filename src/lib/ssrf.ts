/**
 * SSRF 防护：共享的主机/IP 拦截逻辑。
 *
 * 原在 src/app/api/image-proxy/route.ts 内（AUDIT-R4/R6），现抽出供其他
 * 出站请求入口复用——管理员添加视频源（M4）等场景同样需要拦截内网/
 * 链路本地/元数据地址。逻辑与 image-proxy 完全一致，改动一处即处处生效。
 */

// SSRF 防护：禁止的主机名（精确匹配）
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '0.0.0.0',
  '169.254.169.254', // 云元数据
]);

/** IPv4 内网/特殊段检查（输入应为规范点分十进制） */
function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => parseInt(p, 10));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = nums;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 127) return true; // 127.0.0.0/8 回环
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 链路本地
  if (a === 0) return true; // 0.0.0.0/8
  // AUDIT-R6：补齐 IANA 特殊用途地址段（默认仅公网可路由地址才可能放行）
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 共享地址空间（CGNAT）
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF 协议分配
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 文档示例（TEST-NET-1）
  if (a === 198 && b >= 18 && b <= 19) return true; // 198.18.0.0/15 基准测试
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 文档示例（TEST-NET-2）
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 文档示例（TEST-NET-3）
  if (a >= 224 && a <= 239) return true; // 224.0.0.0/4 组播
  if (a >= 240) return true; // 240.0.0.0/4 保留（含 255.255.255.255 有限广播）
  // 注：192.31.196.0/24（AS112）、192.52.193.0/24（AMT）、192.88.99.0/24
  // （已废弃的 6to4 中继，IANA 2015 年回收）不属非公网可路由，故不拦截。
  return false;
}

/**
 * AUDIT-R4 P1-2: 将 IPv6 地址展开为 8 个 16 位组（hextet）的数字数组。
 * 处理 :: 压缩、首尾 ::、IPv4 尾段（如 ::ffff:192.168.1.1）等形式。
 * 无法解析时返回 null。
 */
function expandIPv6(ip: string): number[] | null {
  let addr = ip.toLowerCase().trim();
  // 去括号
  if (addr.startsWith('[') && addr.endsWith(']')) {
    addr = addr.slice(1, -1);
  }
  // 处理 zone id（fe80::1%eth0）
  const pctIdx = addr.indexOf('%');
  if (pctIdx !== -1) {
    addr = addr.slice(0, pctIdx);
  }

  // 拆分 :: 压缩
  const dblColon = addr.split('::');
  if (dblColon.length > 2) return null; // 多个 :: 非法

  const parsePart = (part: string): number[] | null => {
    if (part === '') return [];
    const groups = part.split(':');
    const out: number[] = [];
    for (const g of groups) {
      // IPv4 尾段（如 ::ffff:192.168.1.1 中的 192.168.1.1）
      if (g.includes('.')) {
        const octets = g.split('.');
        if (octets.length !== 4) return null;
        const nums = octets.map((o) => parseInt(o, 10));
        if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
        out.push((nums[0] << 8) | nums[1], (nums[2] << 8) | nums[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
        out.push(parseInt(g, 16));
      }
    }
    return out;
  };

  if (dblColon.length === 1) {
    // 无压缩，必须正好 8 组
    const groups = parsePart(dblColon[0]);
    if (!groups || groups.length !== 8) return null;
    return groups;
  }

  // 有 :: 压缩：左右两部分相加不足 8 组，中间补 0
  const left = parsePart(dblColon[0]);
  const right = parsePart(dblColon[1]);
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null; // :: 至少压缩一组
  return [...left, ...new Array(missing).fill(0), ...right];
}

/**
 * AUDIT-R4 P1-2: 从展开的 IPv6 中提取内嵌 IPv4。
 * 覆盖三种形式：
 *  1. IPv4-mapped ::ffff:0:0/96（如 ::ffff:192.168.1.1 或 ::ffff:c0a8:101）
 *  2. IPv4-compatible ::/96（已废弃，但仍检查）
 *  3. NAT64（RFC 6052 / RFC 8219）：64:ff9b::/96（well-known）与
 *     64:ff9b:1::/48（local-use），内嵌 IPv4 为末 32 位
 * 返回点分十进制字符串，无内嵌 IPv4 时返回 null。
 */
function extractEmbeddedIPv4(groups: number[]): string | null {
  // ::ffff:0:0/96: 前 80 位为 0，第 81-96 位为 0xffff
  const isMapped =
    groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  // ::/96（兼容地址，已废弃）：前 96 位为 0，且不全为 0（::1 除外由上层处理）
  const isCompatible =
    groups.slice(0, 6).every((g) => g === 0) &&
    !(groups[6] === 0 && groups[7] <= 1);
  // AUDIT-R6：NAT64 前缀的内嵌 IPv4 为末 32 位（groups[6], groups[7]）
  const isNat64WellKnown =
    groups[0] === 0x64 &&
    groups[1] === 0xff9b &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0;
  const isNat64LocalUse =
    groups[0] === 0x64 && groups[1] === 0xff9b && groups[2] === 0x1;
  if (!isMapped && !isCompatible && !isNat64WellKnown && !isNat64LocalUse)
    return null;
  const a = (groups[6] >> 8) & 0xff;
  const b = groups[6] & 0xff;
  const c = (groups[7] >> 8) & 0xff;
  const d = groups[7] & 0xff;
  return `${a}.${b}.${c}.${d}`;
}

/** IPv6 特殊段检查（输入为去括号小写形式） */
function isBlockedIPv6(ip: string): boolean {
  const groups = expandIPv6(ip);
  if (!groups) {
    // 无法解析的按可疑处理：保守起见拦截
    return true;
  }

  // 1. 内嵌 IPv4（映射/兼容地址）：转交 IPv4 检查
  //    覆盖 ::ffff:192.168.1.1（点分）与 ::ffff:c0a8:101（十六进制压缩）等形式
  const embedded = extractEmbeddedIPv4(groups);
  if (embedded) {
    return isBlockedIPv4(embedded);
  }

  // 2. ::1 回环 / :: 未指定
  if (groups.every((g) => g === 0)) return true; // ::
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1

  const first = groups[0];
  // fe80::/10 链路本地
  if (first >= 0xfe80 && first <= 0xfebf) return true;
  // fc00::/7 唯一本地
  if (first >= 0xfc00 && first <= 0xfdff) return true;
  // 2001:db8::/32 文档地址
  if (first === 0x2001 && groups[1] === 0x0db8) return true;
  // 2001::/23 特殊用途（Teredo 等），保守拦截
  if (first === 0x2001 && (groups[1] & 0xff00) === 0x0000) {
    // 仅拦截 2001:0::/32（Teredo）
    if (groups[1] === 0x0000) return true;
  }
  // ff00::/8 组播（出站代理请求组播无意义，拦截）
  if (first >= 0xff00 && first <= 0xffff) return true;

  // repo-hardening 第 10 项：补齐 IANA 特殊用途段，向「仅全球可路由」收敛。
  // 2001:0002::/48 基准测试（RFC 5180）
  if (first === 0x2001 && groups[1] === 0x0002) return true;
  // 2001:0010::/28 ORCHID（RFC 4843）与 2001:0020::/28 ORCHIDv2（RFC 7343）
  if (first === 0x2001 && (groups[1] & 0xfff0) === 0x0010) return true;
  if (first === 0x2001 && (groups[1] & 0xfff0) === 0x0020) return true;
  // 2002::/16 6to4：协议已废弃（RFC 7526），经中继可回指任意内嵌 IPv4，
  // 且正规图床不使用 6to4 地址——整段拦截（内嵌公网也不放行，决定已由测试固定）
  if (first === 0x2002) return true;
  // fec0::/10 站点本地（已废弃，RFC 3879）
  if (first >= 0xfec0 && first <= 0xfeff) return true;
  // 收敛规则：全球单播空间仅 2000::/3，其余未明确放行的一律拦截
  //（覆盖 100::/64 discard-only、未分配段等；内嵌 IPv4 类已在前面优先处理）
  if (first < 0x2000 || first > 0x3fff) return true;

  return false;
}

/**
 * 主机名是否被拦截：localhost/元数据地址、IPv4/IPv6 内网与特殊段、
 * IPv4 映射 IPv6、十六进制/八进制 IP 写法。
 */
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().trim();
  if (BLOCKED_HOSTNAMES.has(h)) return true;

  // 去括号取裸 IPv6
  const bare = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
  if (bare !== h && BLOCKED_HOSTNAMES.has(bare)) return true;

  // IPv6（含 IPv4 映射）
  if (bare.includes(':')) {
    return isBlockedIPv6(bare);
  }

  // IPv4：WHATWG URL 已把十六进制/八进制写法规范为点分十进制，
  // 这里再做一次防御性检查
  if (/^\d+\.\d+\.\d+\.\d+$/.test(bare)) {
    return isBlockedIPv4(bare);
  }
  // 十六进制/八进制 IP 绕过（如 0x7f000001）
  if (/^0x[0-9a-f]+$/i.test(bare.replace(/\./g, ''))) return true;

  return false;
}

/** 出站 URL 长度上限（与 image-proxy 口径一致） */
export const MAX_EXTERNAL_URL_LENGTH = 2048;

/**
 * 校验一个拟由服务端出站请求的 URL（M4：管理员添加视频源时调用）。
 * 通过返回 null，否则返回面向用户的错误原因。
 *
 * 注意：本校验是字符串层面的（协议 + 字面量主机），不做 DNS 解析——
 * 域名解析到内网 IP 的残余风险仍在；视频源搜索/详情的运行时请求
 * 尚未做 image-proxy 式的 DoH 校验与 IP 钉死，后续可按同一模式补齐。
 */
export function validateExternalUrl(urlString: string): string | null {
  if (typeof urlString !== 'string' || urlString.length === 0) {
    return 'URL 不能为空';
  }
  if (urlString.length > MAX_EXTERNAL_URL_LENGTH) {
    return 'URL 过长';
  }
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return 'URL 格式错误';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return '仅允许 http/https 协议';
  }
  if (isBlockedHost(parsed.hostname)) {
    return '禁止内网/回环/元数据地址';
  }
  return null;
}
