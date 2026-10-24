/**
 * @jest-environment node
 */
/**
 * 搜索缓存指纹补强（repo-hardening 第 6/13 项）。
 *
 * 旧指纹只含去重后的上游 API URL：管理员只改来源 key / 名称 / 启用状态时
 * 指纹不变，旧缓存里的 source / source_name 会继续被返回（显示名过期、
 * 详情请求带旧 key 找不到站点）。
 *
 * 新指纹输入 = 来源配置的稳定序列化（key、name、api、disabled），
 * 任一字段变化都必须使指纹变化；内存缓存以输入串为键，输入变化自然换键失效。
 */

import { webcrypto } from 'crypto';

import { sitesFingerprint, FingerprintSite } from '../searchCache';

// jest 27 的 node 环境未暴露 WebCrypto 全局（生产 Edge/Node 20 自带）；
// searchCache 的 sha256Hex 运行时才调用 crypto.subtle，故在此补齐即可。
const globalCrypto = globalThis as { crypto?: Crypto };
if (typeof globalCrypto.crypto === 'undefined') {
  globalCrypto.crypto = webcrypto as Crypto;
}

const baseSites: FingerprintSite[] = [
  { key: 'alpha', name: '甲站', api: 'https://a.example/api.php', disabled: false },
  { key: 'beta', name: '乙站', api: 'https://b.example/api.php' },
  // 同 api 不同 key/name（重复地址组）：各自的映射身份也要进指纹
  { key: 'beta2', name: '乙站镜像', api: 'https://b.example/api.php' },
];

function clone(): FingerprintSite[] {
  return baseSites.map((s) => ({ ...s }));
}

describe('sitesFingerprint 稳定序列化', () => {
  test('相同配置（含乱序）→ 相同指纹', async () => {
    const fp1 = await sitesFingerprint(clone());
    const fp2 = await sitesFingerprint(clone().reverse());
    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^[0-9a-f]{12}$/);
  });

  test('只改来源名称 → 指纹变化', async () => {
    const before = await sitesFingerprint(clone());
    const changed = clone();
    changed[0].name = '甲站改名';
    const after = await sitesFingerprint(changed);
    expect(after).not.toBe(before);
  });

  test('只改来源 key → 指纹变化', async () => {
    const before = await sitesFingerprint(clone());
    const changed = clone();
    changed[1].key = 'beta-new';
    const after = await sitesFingerprint(changed);
    expect(after).not.toBe(before);
  });

  test('禁用某个来源（disabled 翻转）→ 指纹变化', async () => {
    const before = await sitesFingerprint(clone());
    const changed = clone();
    changed[2].disabled = true;
    const after = await sitesFingerprint(changed);
    expect(after).not.toBe(before);
  });

  test('只改 api 地址 → 指纹变化', async () => {
    const before = await sitesFingerprint(clone());
    const changed = clone();
    changed[0].api = 'https://a2.example/api.php';
    const after = await sitesFingerprint(changed);
    expect(after).not.toBe(before);
  });

  test('新增一个来源 → 指纹变化', async () => {
    const before = await sitesFingerprint(clone());
    const changed = clone();
    changed.push({ key: 'gamma', name: '丙站', api: 'https://c.example/api.php' });
    const after = await sitesFingerprint(changed);
    expect(after).not.toBe(before);
  });
});
