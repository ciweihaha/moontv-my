/*
  每周自动同步上游片源
  1. 从上游仓库拉取最新 config.json
  2. 找出本地没有的新源，逐个健康检测
  3. 把能用的新源加进来，挂掉的旧源删掉
  4. 只保留 1500ms 内响应的高速源
  用法: node scripts/sync-upstream-sources.js
*/
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

// 成人内容过滤（2026-10-05 新增；2026-10-12 补"麻豆"）
const ADULT_KW = ['AV', '黄', '美少女', '成人', '淫', '色情', '情色', '麻豆'];
function isAdult(name) {
  if (!name) return false;
  return ADULT_KW.some(kw => name.includes(kw));
}

const CONFIG_PATH = path.join(process.cwd(), 'config.json');
// 上游源（按优先级排序）
const UPSTREAMS = [
  'https://raw.githubusercontent.com/bylspro/moontv/main/config.json',
];
const TIMEOUT_MS = 10000;
const MAX_MS = 1500; // 只保留 1.5 秒内响应的

function buildTestUrl(base) {
  let url = String(base).trim();
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}ac=videolist&wd=test&pg=1`;
}

async function fetchWithTimeout(url, ms) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122 Safari/537.36' },
      redirect: 'follow', signal: ac.signal,
    });
    const text = await res.text();
    return { ok: res.ok, text };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  } finally {
    clearTimeout(id);
  }
}

function isWorkingJson(text) {
  try {
    const j = JSON.parse(text);
    // AppleCMS v10: { code:1, list:[...] } 或 { list:[...] }
    if (Array.isArray(j.list) && j.list.length >= 0) return true;
    if (j.code === 1 && j.total !== undefined) return true;
    return false;
  } catch { return false; }
}

async function testSource(api) {
  const start = Date.now();
  const r = await fetchWithTimeout(buildTestUrl(api), TIMEOUT_MS);
  const ms = Date.now() - start;
  if (!r.ok) return { working: false, ms, reason: 'fetch failed' };
  if (!isWorkingJson(r.text)) return { working: false, ms, reason: 'bad format' };
  if (ms > MAX_MS) return { working: false, ms, reason: 'too slow' };
  return { working: true, ms };
}

async function main() {
  const local = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const localSites = local.api_site || {};
  const localApis = new Set(Object.values(localSites).map(s => s.api));

  // 1. 拉取上游
  let upstreamSites = {};
  for (const u of UPSTREAMS) {
    try {
      const r = await fetchWithTimeout(u, 15000);
      if (r.ok) {
        const j = JSON.parse(r.text);
        Object.assign(upstreamSites, j.api_site || {});
        console.log(`上游 ${u} 拉取成功，共 ${Object.keys(j.api_site || {}).length} 个源`);
      }
    } catch (e) {
      console.log(`上游 ${u} 拉取失败: ${e.message}`);
    }
  }

  // 2. 找出新源
  const newCandidates = [];
  for (const [k, v] of Object.entries(upstreamSites)) {
    if (v.api && !localApis.has(v.api)) {
      newCandidates.push({ key: k, ...v });
    }
  }
  console.log(`发现 ${newCandidates.length} 个本地没有的新源`);

  // 3. 测试新源
  let added = 0;
  for (const c of newCandidates) {
    // 同一轮内已加过的 api 跳过（上游可能同一 URL 挂多个名字）
    if (localApis.has(c.api)) {
      console.log(`❌ 跳过: ${c.name} (duplicate api)`);
      continue;
    }
    const t = await testSource(c.api);
    if (t.working) {
      const newKey = `sync_${Date.now()}_${added}`;
      localSites[newKey] = { name: c.name || c.key, api: c.api, detail: c.detail || '' };
      localApis.add(c.api);
      added++;
      console.log(`✅ 新增: ${c.name} (${t.ms}ms)`);
    } else {
      console.log(`❌ 跳过: ${c.name} (${t.reason})`);
    }
  }

  // 4. 复查现有源，删除失效的
  let removed = 0;
  for (const [k, v] of Object.entries({ ...localSites })) {
    // 跳过刚加的
    if (k.startsWith('sync_')) continue;
    const t = await testSource(v.api);
    if (!t.working) {
      delete localSites[k];
      removed++;
      console.log(`🗑 删除失效: ${v.name} (${t.reason})`);
    }
  }

  // 5. 保存
  // 过滤成人源（2026-10-05）
  for (const k of Object.keys(localSites)) {
    if (isAdult(localSites[k].name)) {
      console.log(`过滤成人源: ${localSites[k].name}`);
      delete localSites[k];
    }
  }
  local.api_site = localSites;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(local, null, 2), 'utf8');
  console.log(`\n完成: 新增 ${added}，删除 ${removed}，剩余 ${Object.keys(localSites).length} 个源`);
}

main().catch(e => { console.error(e); process.exit(1); });
