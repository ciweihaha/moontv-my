/* eslint-disable no-console */
import { NextResponse } from 'next/server';
import type { LookupFunction } from 'node:net';

// M4: 主机/IP 拦截逻辑已抽到共享模块 @/lib/ssrf（与管理员添加视频源共用）
import { isBlockedHost } from '@/lib/ssrf';

export const runtime = 'edge';

// OrionTV 兼容接口（从旧 MoonTV 移植，已修复 SSRF）
// 用途：代理豆瓣等图床的图片，解决防盗链导致的海报黑屏

// round2 F1: edge allowlist
// Initial list: hostnames of api fields in config.json api_site, deduplicated.
// Non-listed hostname returns 403 before any fetch.
// 2026-10-25 OrionTV 海报回归，豆瓣封面来自 img*.doubanio.com，不在 api 域名表里导致全 403，只放行 doubanio 公共图床后缀，仍走后面的 DNS 校验与内网拦截。
// 2026-10-31 海报全量 403 修复：采集 API 返回的 vod_pic 全部托管在独立图床 CDN（youkupic/jinyingimage/ppqrrs 等），
// 不在 api 域名表里导致所有海报 403。实测聚合接口全库采样得到下列 16 个图床域，按「域名家族后缀」放行
// （子域名会轮换，如 v10/v11.ppqrrs.com、pic/pic3），仍逐跳走 DNS 校验与内网拦截，SSRF 防护不变。
const ALLOWED_IMAGE_HOSTNAME_SUFFIXES = [
  '.doubanio.com',
  // 2026-10-31 新增：采集站点公共图床（按后缀放行，覆盖子域名轮换）
  '.youkupic.com',
  '.jinyingimage.com',
  '.guangsuimage.com',
  '.jisuimage.com',
  '.lzipic.com',
  '.ukuapi88.com',
  '.ppqrrs.com',
  '.yzzyimg.online',
  '.mdzypic.com',
  '.hongniuzyimage.com',
  '.huyajs.com',
  '.jegms.com',
  '.xltupian.com',
  '.bfvp26.com',
];
function isAllowedImageHostname(hostname: string): boolean {
    const h = hostname.toLowerCase();
    if (ALLOWED_IMAGE_HOSTNAMES.has(h)) return true;
    return ALLOWED_IMAGE_HOSTNAME_SUFFIXES.some((suffix) => h.endsWith(suffix));
}
const ALLOWED_IMAGE_HOSTNAMES = new Set([
  'api.guangsuapi.com',
  'api.xinlangapi.com',
  'api.wujinapi.me',
  'api.wujinapi.net',
  'api.1080zyku.com',
  'www.huyaapi.com',
  'hhzyapi.com',
  'subocaiji.com',
  'cj.lziapi.com',
  'jinyingzy.com',
  'jyzyapi.com',
  'cj.ffzyapi.com',
  'caiji.moduapi.cc',
  'www.mdzyapi.com',
  'api.ffzyapi.com',
  'jszyapi.com',
  'www.hongniuzy3.com',
  'api.ukuapi88.com',
  'api.wujinapi.cc',
  '360zy.com',
  'api.ukuapi.com',
  'ikunzyapi.com',
  'cj.rycjapi.com',
  'api.wujinapi.com',
  'bfzyapi.com',
  'zuidazy.me',
  'm3u8.apiyhzy.com',
  'caiji.dyttzyapi.com',
  'www.hongniuzy2.com',
  'www.moduzy.com',
  // 2026-10-31 新增：无子域名/特殊前缀的图床裸域（endsWith 后缀匹配不含裸域，需精确条目）
  'hongniuzyimage.com',
  'ynztctv.com',
  // 2026-10-31 新增：自建聚合服务域名（部分数据源的 vod_pic 已封装为聚合站图片代理 URL）
  'ysp.ciweihaha.win',
  'live.ciweihaha.win',
]);

// 允许的图片 Content-Type
const ALLOWED_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
];

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB
// AUDIT-R2: 总超时覆盖「建连 + 响应头 + 完整响应体读取」
const TOTAL_TIMEOUT_MS = 20000;
// AUDIT-R3 P0-C: 最大重定向跳数
const MAX_REDIRECTS = 5; /* ROUND2 F5: per-isolate concurrency, edge memory is not shared */ /* 2026-11-01 列表页批量图片修复：50→150，热门/Top250 页一次性几十张海报，叠加同 isolate 其他用户请求极易触发 429（配合新增的 Cache API 结果缓存，命中请求不再占用额度） */ const MAX_CONCURRENT_IMAGE_PROXY = 150; let activeImageProxyRequests = 0;

// 深查第 1 轮：按 IP 固定窗口速率限制。已有并发上限（150）只挡瞬时并发，
// 不挡持续刷图（一个 IP 长期以低于 150 并发、无限总量抓图仍会拖垮上游与 DoH）。
// 放在缓存命中之后：缓存命中已在前面返回，不计入限额，正常 Top250 首屏
// 约 250 张新图在 600/分钟内，不会误伤正常浏览；仅挡持续高频刷图。
// 重要限制：edge 内存按 isolate，不跨 isolate 全局，故本限制是每 isolate
// 600/分钟，不是全局 600/分钟，不得声称已全局限流；全局限流须 KV/DO，另轮另做。
// 无 IP 时不限制（fail-open，避免把所有未知 IP 合并成一个桶误伤）。
const IMAGE_PROXY_RATE_LIMIT = 600;
const IMAGE_PROXY_RATE_WINDOW_MS = 60_000;
const imageProxyRateBuckets = new Map<string, { count: number; resetAt: number }>();
function getImageProxyClientIp(request: Request): string | null {
  // PR #27 CI 修复：测试的最小请求对象只有 url、没有 headers（旧 handler
  // 只读 request.url），直接读 request.headers.get 会抛
  // Cannot read properties of undefined (reading 'get')，导致 36 个测试失败。
  // request 或 headers 缺失时返回 null，走 fail-open（不限制），不改限流数值。
  if (!request || !request.headers) return null;
  const cf = request.headers.get('cf-connecting-ip');
  if (cf) return cf.trim();
  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]?.trim() || null;
  const real = request.headers.get('x-real-ip');
  return real ? real.trim() : null;
}
function checkImageProxyRateLimit(ip: string, now: number): boolean {
  const b = imageProxyRateBuckets.get(ip);
  if (!b || now >= b.resetAt) {
    if (imageProxyRateBuckets.size >= 1000) {
      // TS2802: tsconfig target is es5, for...of cannot iterate a Map; use forEach.
      // Deleting inside forEach is safe (deleted entries are not visited again).
      imageProxyRateBuckets.forEach((v, k) => {
        if (v.resetAt <= now) imageProxyRateBuckets.delete(k);
      });
      if (imageProxyRateBuckets.size >= 1000) {
        const first = imageProxyRateBuckets.keys().next().value;
        if (first !== undefined) imageProxyRateBuckets.delete(first);
      }
    }
    imageProxyRateBuckets.set(ip, { count: 1, resetAt: now + IMAGE_PROXY_RATE_WINDOW_MS });
    return true;
  }
  b.count += 1;
  return b.count <= IMAGE_PROXY_RATE_LIMIT;
}

// AUDIT-R5 P1: DNS-over-HTTPS 解析配置（防 DNS 重绑定）
// 仅对非 IP 字面量的主机名做 DoH 解析，验证其 A/AAAA 记录全部为公网 IP。
// 2026-10-19 方案 B（fail-closed）：DoH 查不到（NXDOMAIN/SERVFAIL/超时/空记录）
// 或解析出任一内网/特殊地址时都拒绝请求，仅全部记录为公网 IP 时放行。
const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const DOH_TIMEOUT_MS = 5000;
const DNS_CACHE_TTL_MS = 60 * 1000; // 2026-11-05 改回 60 秒（2026-10-28 海报提速曾改为 600 秒）；SSRF 校验、allowlist、大小上限、重定向校验与总超时 20 秒均不动
const dnsCache = new Map<string, { ips: string[]; expires: number }>();

/**
 * AUDIT-R5 P1: 用 DNS-over-HTTPS 解析主机名的 A/AAAA 记录。
 * 返回去重后的 IP 列表；解析失败、超时、两族均无记录时返回 null（表示"未知"，
 * 调用方按 2026-10-19 方案 B（fail-closed）决策：未知直接拒绝，
 * 仅全部记录为公网 IP 时放行）。
 * AUDIT-R6：某地址族 Status=0 但无 Answer（NODATA）不视为失败，
 * 仅合法地继续查另一地址族；错误码（含 Status 缺失）则整体判未知。
 */
async function resolveHostnameToIPs(hostname: string): Promise<string[] | null> {
  const now = Date.now();
  const cached = dnsCache.get(hostname);
  if (cached && cached.expires > now) {
    return cached.ips;
  }
  // 简单的缓存淘汰，防止无界增长
  if (dnsCache.size > 500) {
    const now2 = Date.now();
    const toDelete: string[] = [];
    dnsCache.forEach((v, k) => {
      if (v.expires <= now2) toDelete.push(k);
    });
    for (const k of toDelete) {
      dnsCache.delete(k);
      if (dnsCache.size <= 400) break;
    }
  }

  const controller = new AbortController();
  /* ROUND2 F6: expired eviction did not bring size down, clear cache */ if (dnsCache.size > 500) dnsCache.clear(); const timer = setTimeout(() => controller.abort(), DOH_TIMEOUT_MS);
  try {
    const ips = new Set<string>();
    for (const type of ['A', 'AAAA']) {
      const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${type}`;
      const resp = await fetch(url, {
        headers: { Accept: 'application/dns-json' },
        signal: controller.signal,
      });
      if (!resp.ok) return null;
      const data = (await resp.json()) as {
        Status?: number;
        Answer?: Array<{ type: number; data: string }>;
      };
      // AUDIT-R6：严格区分"查询失败"与"该地址族无记录"。
      // - Status 缺失或为错误码（SERVFAIL/FORMERR/REFUSED 等，含 NXDOMAIN=3）：
      //   DNS 解析服务本身不可信 → 整个主机名判为"未知"，按方案 B 直接拒绝。
      // - Status=0 但无 Answer（NODATA）：该地址族确实无记录，合法地继续查另一地址族。
      // 旧逻辑对非 3 的错误码继续查另一种记录，导致 A 查询 SERVFAIL、AAAA 返回公网
      // 时只凭 AAAA 放行——未经验证的错误被当作"无记录"跳过。
      const status = data.Status;
      if (status === undefined || status !== 0) {
        return null;
      }
      if (!data.Answer) {
        continue;
      }
      for (const ans of data.Answer) {
        // type 1 = A, 28 = AAAA
        if (ans.type === 1 || ans.type === 28) {
          ips.add(ans.data.trim());
        }
      }
    }
    if (ips.size === 0) return null;
    const list = Array.from(ips);
    dnsCache.set(hostname, { ips: list, expires: now + DNS_CACHE_TTL_MS });
    return list;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * AUDIT-R5 P1: 验证主机名的 DNS 解析结果全部为公网 IP。
 * - IP 字面量：沿用 isBlockedHost 的字符串检查（WHATWG URL 已规范化）
 * - 域名：DoH 解析 A/AAAA，任一记录为内网/特殊地址时拒绝
 *
 * 2026-10-19 方案 B（fail-closed）：DoH 返回 NXDOMAIN / SERVFAIL / 超时 /
 * 空记录时视为"未知"并直接拒绝（403），仅当解析结果非空且全部为公网 IP
 * 时放行。已确认方案 A 的可用性顾虑（个别图床在公共 DoH 上 NXDOMAIN）服从
 * 安全需求：查不到解析结果的请求不放行。
 * 字符串层检查（isBlockedHost：IP 字面量、localhost、元数据地址等）不受影响，仍全量生效。
 *
 * 注意剩余风险（TOCTOU / DNS 重绑定）：DoH 查询与实际 fetch 之间存在时间窗口。
 * AUDIT-R7（2026-10-19 双运行时 IP 钉死）已封死该窗口在 nodejs 运行时（Docker
 * 自托管）下的利用：本函数返回的 ips 即本跳已校验的 IP 集合，调用方用它构造
 * 钉死 dispatcher（见 getPinnedFetchClient），连接目标被固定为该集合；
 * edge 运行时（Cloudflare Pages）因 workerd 无连接层可定制，保持现状
 * （edge 跑在 Cloudflare 机房，无用户内网可打，残余风险低）。
 * 钉死不改变的假设：DoH 本身仍是信任根；同一已校验 IP 上的内容替换超出 SSRF 范畴。
 */
async function validateHostnameDNS(
  hostname: string
): Promise<{ ok: boolean; reason?: string; ips?: string[] }> {
  const h = hostname.toLowerCase().trim();
  const bare = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;

  // IP 字面量：字符串检查已足够（URL 解析器已规范化十六进制/八进制写法）
  if (bare.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(bare)) {
    return { ok: true, ips: [bare] };
  }

  // 域名：DoH 解析并检查每条记录
  const ips = await resolveHostnameToIPs(bare);
  if (!ips) {
    // 方案 B（fail-closed）：DoH 未知（NXDOMAIN/SERVFAIL/超时/空记录）→ 拒绝
    return { ok: false, reason: 'DNS resolution failed or returned no records' };
  }
  for (const ip of ips) {
    if (isBlockedHost(ip)) {
      console.warn('[image-proxy] DNS resolves to blocked IP:', ip); return { ok: false, reason: 'blocked IP' };
    }
  }
  return { ok: true, ips };
}

// ---------------------------------------------------------------------------
// AUDIT-R7: 双运行时 IP 钉死（DNS 重绑定绑定）
//  - edge（Cloudflare Pages）：workerd 的 fetch 没有连接层可定制，保持全局
//    fetch 现状；edge 运行在 Cloudflare 机房，无用户内网可打。
//  - nodejs（Docker 自托管，构建期 sed 已把本文件 runtime 翻为 'nodejs'）：
//    用 undici 的 Agent 自定义 lookup，只连接本跳已校验的 IP 集合，封死
//    「DoH 检查 → 实际建连」之间的重绑定窗口；TLS 的 SNI/证书校验仍按 URL
//    主机名进行（undici 默认行为），未被绕过。
// ---------------------------------------------------------------------------

/** 钉死 lookup：忽略系统 DNS，只返回本跳已校验的 IP 集合（fail-closed）。 */
function buildPinnedLookup(validatedIps: string[]): LookupFunction {
  const pinned = validatedIps.map((ip) => ({
    address: ip,
    family: ip.includes(':') ? 6 : 4,
  }));
  const lookup = (
    _hostname: string,
    options: { all?: boolean },
    callback: (...args: unknown[]) => void
  ): void => {
    // Node 20+ 默认开启 autoSelectFamily，会以 { all: true } 调用 lookup，
    // 此时必须返回地址数组，否则抛 ERR_INVALID_IP_ADDRESS。
    if (options && options.all === true) {
      callback(
        null,
        pinned.map((p) => ({ address: p.address, family: p.family }))
      );
      return;
    }
    const first = pinned[0];
    if (!first) {
      // 已校验集合为空：fail-closed，绝不回退系统解析
      callback(new Error('pinned lookup: empty validated IP set'));
      return;
    }
    callback(null, first.address, first.family);
  };
  return lookup as unknown as LookupFunction;
}

interface PinnedFetchClient {
  fetch: typeof import('undici').fetch;
  dispatcher: import('undici').Dispatcher;
}

/**
 * 按运行时构造钉死抓取客户端；edge 下返回 null（调用方走全局 fetch 现状）。
 * undici 必须懒加载 + webpackIgnore：禁止打包器把它打进 edge 产物；
 * 且必须用 undici 自己的 fetch + Agent（与全局 fetch 混用会抛
 * invalid onRequestStart）。
 */
async function getPinnedFetchClient(
  validatedIps: string[]
): Promise<PinnedFetchClient | null> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return null;
  }
  const undici = await import(/* webpackIgnore: true */ 'undici');
  const dispatcher = new undici.Agent({
    connect: { lookup: buildPinnedLookup(validatedIps) },
  });
  return { fetch: undici.fetch, dispatcher };
}

/**
 * AUDIT-R8：确定性释放钉死 dispatcher。
 * 每个 Agent 只服务一跳（见 GET 的逐跳构造），此前从不 close/destroy，
 * 只能等 undici 空闲超时（约 9s）回收：实测 FD 按请求线性累积（+2/次），
 * 突发高频下可能打满容器 FD 上限。响应体被调用方消费完（或请求已失败）
 * 后调用本函数立即拆掉底层 socket，不改变任何抓取/校验语义。
 * dispatcher 无 destroy/close（如测试 mock）或释放本身抛错时静默跳过——
 * 释放失败绝不能影响请求结果。
 */
async function releasePinnedDispatcher(
  dispatcher: import('undici').Dispatcher | null | undefined
): Promise<void> {
  if (!dispatcher) return;
  const d = dispatcher as { destroy?: unknown; close?: unknown };
  try {
    if (typeof d.destroy === 'function') {
      await (d.destroy as () => Promise<void>).call(dispatcher);
    } else if (typeof d.close === 'function') {
      await (d.close as () => Promise<void>).call(dispatcher);
    }
  } catch {
    // 释放失败不得影响请求本身
  }
}

/**
 * AUDIT-R3 P0-C: 验证 URL 是否允许请求（协议 + 主机 + DNS 解析）。
 * 每一跳重定向前都要调用，禁止的请求在发出前就被拦截。
 * AUDIT-R5 P1: 增加 DNS-over-HTTPS 解析检查，防 DNS 重绑定。
 * 2026-10-19 方案 B：DNS 未知或解析出内网 IP 时拦截，仅全公网记录放行。
 */
async function validateUrlForFetch(
  urlString: string
): Promise<{ ok: boolean; error?: string; status?: number; ips?: string[] }> {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return { ok: false, error: 'Invalid URL', status: 400 };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'Only http/https allowed', status: 400 };
  }
  if (isBlockedHost(parsed.hostname)) {
    return { ok: false, error: 'Blocked host', status: 403 };
  }
  // AUDIT-R5 P1: DNS 解析结果检查（2026-10-19 方案 B：未知拒绝，仅全公网记录放行）
  // round2 F1: edge allowlist, fail-closed, before DNS/fetch.
  if (!isAllowedImageHostname(parsed.hostname)) {
    return { ok: false, error: 'Host not allowed', status: 403 };
  }
  const dnsCheck = await validateHostnameDNS(parsed.hostname);
  if (!dnsCheck.ok) {
    return { ok: false, error: 'DNS check failed', status: 403 };
  }
  // AUDIT-R7：把本跳已校验的 IP 集合传出，供 nodejs 运行时构造钉死 dispatcher
  return { ok: true, ips: dnsCheck.ips };
}

/**
 * 2026-11-01：Cloudflare Pages edge 的 Cache API 暴露 caches.default（非标准扩展，
 * 同 PoP 共享缓存）；TS 标准 CacheStorage 类型无该属性，这里断言为扩展形态。
 * nodejs 自托管运行时无 caches 全局或无 default 时返回 null，行为与旧版一致。
 */
function getEdgeDefaultCache(): Cache | null {
  if (typeof caches === 'undefined') return null;
  try {
    const ext = caches as unknown as { default?: Cache };
    return ext.default ?? null;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const imageUrl = searchParams.get('url');

  if (!imageUrl) {
    return NextResponse.json({ error: 'Missing image URL' }, { status: 400 });
  }

  // 1. 协议校验：只允许 http/https
  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return NextResponse.json({ error: 'Only http/https allowed' }, { status: 400 });
  }

  // 2. 主机校验：禁内网/元数据（含 IPv6 特殊段与 IPv4 映射）
  if (isBlockedHost(parsed.hostname)) {
    return NextResponse.json({ error: 'Blocked host' }, { status: 403 });
  }

  // 3. 长度上限
  if (imageUrl.length > 2048) {
    return NextResponse.json({ error: 'URL too long' }, { status: 400 });
  }

  // 2026-11-01 列表页图片批量挂载修复：Cache API 结果缓存（edge 运行时）。
  // 同一张海报（热门/Top250/分类页反复出现）二次请求直接命中，不再重走 DoH+上游抓取；
  // 命中不占用并发额度、不计入 20s 总超时，列表页二次加载与多用户共享显著提速。
  const edgeCache = getEdgeDefaultCache();
  if (edgeCache) {
    try {
      const cached = await edgeCache.match(new Request(request.url, { method: 'GET' }));
      if (cached && (cached.headers.get('content-type') || '').startsWith('image/')) {
        return cached;
      }
    } catch { /* 缓存读取失败走正常路径 */ }
  }

  // 深查第 1 轮：缓存命中已返回，不计入限额；此处只对新图请求限流。
  const clientIp = getImageProxyClientIp(request);
  if (clientIp && !checkImageProxyRateLimit(clientIp, Date.now())) {
    return NextResponse.json({ error: 'Too many image proxy requests' }, { status: 429, headers: { 'Retry-After': '60' } });
  }

  if (activeImageProxyRequests >= MAX_CONCURRENT_IMAGE_PROXY) { return NextResponse.json({ error: 'Too many concurrent image proxy requests' }, { status: 429 }); } activeImageProxyRequests++; const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS);
  // 客户端断开联动（2026-10-24 诊断缺口 P2）：此前 GET 全程不读
  // request.signal，客户端中途断开后上游请求与响应体读取仍跑满 20s
  // 总超时才收尾，白白占用连接与缓冲。把客户端信号并入内部 controller
  // 的触发源（任一触发即中止上游）；监听器在请求结束时于 finally 摘除，
  // 避免随请求累积。SSRF 校验、大小上限、逐跳复验与超时语义不变。
  const clientSignal = request.signal;
  const onClientAbort = () => controller.abort();
  if (clientSignal) {
    if (clientSignal.aborted) {
      controller.abort();
    } else if (typeof clientSignal.addEventListener === 'function') {
      clientSignal.addEventListener('abort', onClientAbort, { once: true });
    }
  }
  // AUDIT-R8：最终响应那一跳的钉死 dispatcher，响应体消费完成后在
  // finally 释放。必须声明在 try 外：try 内 let 对 finally 不可见。
  // edge 运行时恒为 null。
  let imageDispatcher: import('undici').Dispatcher | null = null;

  try {
    // AUDIT-R3 P0-C: 手动逐跳处理重定向，每一跳先验证再请求。
    // 禁止的目标在发出请求前就被拦截，不会先收到请求。
    let currentUrl = imageUrl;
    let imageResponse: Response | null = null;

    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
      if (Date.now() > deadline) {
        return NextResponse.json({ error: 'Image fetch timeout' }, { status: 504 });
      }

      const validation: Awaited<ReturnType<typeof validateUrlForFetch>> = await Promise.race([validateUrlForFetch(currentUrl), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Image fetch timeout')), Math.max(0, deadline - Date.now())))]).catch(() => ({ ok: false, error: 'Image fetch timeout', status: 504 }));
      if (!validation.ok) {
        return NextResponse.json(
          { error: validation.error },
          { status: validation.status || 400 }
        );
      }

      // AUDIT-R7 双运行时抓取：
      // - nodejs（Docker 自托管）：undici 钉死 dispatcher，只连接本跳已校验的 IP，
      //   封死 DoH 检查与实际建连之间的 DNS 重绑定窗口；
      // - edge（Cloudflare Pages）：getPinnedFetchClient 返回 null，走全局 fetch 现状。
      const fetchHeaders = {
        Referer: 'https://movie.douban.com/',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      };
      const pinnedClient = await getPinnedFetchClient(validation.ips ?? []);
      // AUDIT-R8：本跳 dispatcher 的所有权——重定向/校验失败/抛错时在本跳
      // 结束（finally）即释放；命中最终响应时所有权移交 imageDispatcher，
      // 由外层 finally 在响应体消费完成后统一释放。
      let hopOwnsDispatcher = pinnedClient !== null;
      try {
        const resp: Response = pinnedClient
          ? ((await pinnedClient.fetch(currentUrl, {
              headers: fetchHeaders,
              signal: controller.signal,
              redirect: 'manual',
              dispatcher: pinnedClient.dispatcher,
            })) as unknown as Response)
          : await fetch(currentUrl, {
              headers: fetchHeaders,
              signal: controller.signal,
              redirect: 'manual', // P0-C: 手动处理，不自动跟随
            });

        // 3xx 重定向：取 Location 头，下一跳继续验证
        if (resp.status >= 300 && resp.status < 400) {
          const location = resp.headers.get('location');
          // 消费掉响应体避免泄漏
          await resp.body?.cancel().catch(() => {});
          if (!location) {
            return NextResponse.json({ error: 'Redirect without location' }, { status: 502 });
          }
          if (redirectCount >= MAX_REDIRECTS) {
            return NextResponse.json({ error: 'Too many redirects' }, { status: 502 });
          }
          try {
            // 相对 Location 按当前 URL 解析
            currentUrl = new URL(location, currentUrl).toString();
          } catch {
            return NextResponse.json({ error: 'Invalid redirect URL' }, { status: 502 });
          }
          continue;
        }

        imageResponse = resp;
        imageDispatcher = pinnedClient ? pinnedClient.dispatcher : null;
        hopOwnsDispatcher = false;
        break;
      } finally {
        if (hopOwnsDispatcher && pinnedClient) {
          await releasePinnedDispatcher(pinnedClient.dispatcher);
        }
      }
    }

    if (!imageResponse) {
      return NextResponse.json({ error: 'Too many redirects' }, { status: 502 });
    }

    if (!imageResponse.ok) { await imageResponse.body?.cancel().catch(() => {});
      return NextResponse.json(
        { error: imageResponse.statusText },
        { status: imageResponse.status }
      );
    }

    // 4. Content-Type 必须是图片
    const contentType = imageResponse.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || '';
    if (!ALLOWED_CONTENT_TYPES.includes(contentType)) { await imageResponse.body?.cancel().catch(() => {});
      return NextResponse.json({ error: 'Not an image' }, { status: 400 });
    }

    // 5a. 声明大小预检（有 Content-Length 时快速拒绝）
    const contentLength = imageResponse.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_IMAGE_BYTES) { await imageResponse.body?.cancel().catch(() => {});
      return NextResponse.json({ error: 'Image too large' }, { status: 413 });
    }

    if (!imageResponse.body) {
      return NextResponse.json(
        { error: 'Image response has no body' },
        { status: 500 }
      );
    }

    // 5b. AUDIT-R2: 实际流式读取并累计字节数，分块传输无 Content-Length 时也能硬限制；
    // 超时覆盖整个响应体读取过程
    const reader = imageResponse.body.getReader(); let readTimedOut = false;
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      for (;;) {
        if (Date.now() > deadline) {
          await reader.cancel().catch(() => undefined);
          return NextResponse.json({ error: 'Image download timeout' }, { status: 504 });
        }
        const { done, value } = await Promise.race([reader.read(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Image download timeout')), Math.max(0, deadline - Date.now()))) ]).catch((err) => { if (err instanceof Error && err.message === 'Image download timeout') { readTimedOut = true; reader.cancel().catch(() => undefined); return { done: true, value: undefined } as ReadableStreamReadResult<Uint8Array>; } throw err; });
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_IMAGE_BYTES) {
          await reader.cancel().catch(() => undefined);
          return NextResponse.json({ error: 'Image too large' }, { status: 413 });
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    if (readTimedOut) { return NextResponse.json({ error: 'Image download timeout' }, { status: 504 }); } // 合并分块
    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const headers = new Headers();
    headers.set('Content-Type', contentType);
    headers.set('X-Content-Type-Options', 'nosniff'); headers.set('Cache-Control', 'public, max-age=15720000, s-maxage=15720000');
    headers.set('CDN-Cache-Control', 'public, s-maxage=15720000');

    const imageResp = new Response(body, { status: 200, headers });
    // 2026-11-01 成功结果写入 Cache API（edge）：≤5MB 才缓存（海报均 <200KB），
    // 写入失败不影响本次响应。与响应头的长 Cache-Control 互补：那个只对
    // 同一浏览器会话生效，Cache API 让同 PoP 的其他用户/重新打开的会话也命中。
    if (edgeCache && totalBytes <= 5 * 1024 * 1024) {
      try { await edgeCache.put(new Request(request.url, { method: 'GET' }), imageResp.clone()); } catch { /* 写缓存失败忽略 */ }
    }
    return imageResp;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return NextResponse.json({ error: 'Image fetch timeout' }, { status: 504 });
    }
    return NextResponse.json({ error: 'Error fetching image' }, { status: 500 });
  } finally {
    clearTimeout(abortTimer);
    // 摘除客户端断开监听（与 GET 开头并入 request.signal 对应），
    // 防止监听器随请求累积泄漏。
    if (clientSignal && typeof clientSignal.removeEventListener === 'function') {
      clientSignal.removeEventListener('abort', onClientAbort);
    }
    // AUDIT-R8：释放最终响应那一跳的钉死 dispatcher（走到这里时响应体
    // 已被完整缓冲，或请求已失败/提前返回）；edge 运行时恒为 null。
    activeImageProxyRequests--; await releasePinnedDispatcher(imageDispatcher);
  }
}
