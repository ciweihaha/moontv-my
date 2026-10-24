/**
 * @jest-environment node
 */
/**
 * favorites 的 search_title 持久化（repo-hardening 第 20 项）。
 *
 * 已核实缺口（仅 favorites，play_records 侧完整无问题）：
 * - D1初始化.md 的 favorites 建表没有 search_title 列；
 * - d1.db.ts 的 setFavorite INSERT 不写该列；
 * - 但 getFavorite/getAllFavorites 读 row.search_title，
 *   cron 刷新收藏时也一路传 fav.search_title 回 saveFavorite。
 * 结果：search_title 写进去就丢，读出来恒为 undefined。
 *
 * 修法：建表加列、INSERT 补列与绑定、文档加存量迁移段（ALTER TABLE）。
 * 本测试用内存版 D1 mock：按 INSERT 语句声明的列清单动态存行——
 * INSERT 不写 search_title 时存储行就没这个字段，往返必然失败，
 * 同时充当列一致性断言；并对 D1初始化.md 本体做文本断言
 * （建表含列 + 迁移段存在）。mock 注入方式同 passwordHashing.test.ts。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { readFileSync } from 'fs';
import { join } from 'path';

// ---- 内存版 D1 mock（favorites 表） ----
interface FavRow {
  [col: string]: any;
}
const favTable = new Map<string, FavRow>();
const rowKey = (u: string, k: string) => `${u}${k}`;

function makeStatement(rawSql: string) {
  // 规范化空白（setFavorite 的 SQL 是带缩进的模板串）
  const sql = rawSql.replace(/\s+/g, ' ').trim();
  const stmt: any = {
    _values: [] as any[],
    bind(...values: any[]) {
      stmt._values = values;
      return stmt;
    },
    async first() {
      if (sql.startsWith('SELECT * FROM favorites WHERE username = ? AND key = ?')) {
        return favTable.get(rowKey(stmt._values[0], stmt._values[1])) ?? null;
      }
      return null;
    },
    async all() {
      if (sql.startsWith('SELECT * FROM favorites WHERE username = ?')) {
        const rows = [...favTable.values()].filter(
          (r) => r.username === stmt._values[0]
        );
        return { results: rows, success: true };
      }
      return { results: [], success: true };
    },
    async run() {
      if (sql.startsWith('INSERT OR REPLACE INTO favorites')) {
        // 按语句声明的列清单把绑定值映射成行（列缺失 → 行里就没这字段）
        const colList = sql
          .slice(sql.indexOf('(') + 1, sql.indexOf(')'))
          .split(',')
          .map((s) => s.trim());
        const row: FavRow = {};
        colList.forEach((col, i) => {
          row[col] = stmt._values[i];
        });
        favTable.set(rowKey(row.username, row.key), row);
      }
      return { success: true };
    },
  };
  return stmt;
}

const mockD1 = {
  prepare: (sql: string) => makeStatement(sql),
  exec: async () => ({ count: 0, duration: 0 }),
  batch: async () => [],
};

import { D1Storage } from '../d1.db';

let storage: D1Storage;
beforeAll(() => {
  storage = new D1Storage();
  (storage as any).db = mockD1;
});
beforeEach(() => {
  favTable.clear();
});

const FAV: any = {
  title: '某剧',
  source_name: '源A',
  cover: 'http://x/p.jpg',
  year: '2024',
  total_episodes: 12,
  save_time: 1720000000000,
  search_title: '搜索用标题',
};

describe('favorites search_title 往返（第 20 项）', () => {
  test('setFavorite → getFavorite：search_title 不丢', async () => {
    await storage.setFavorite('alice', 'srcA+42', FAV);
    const got = await storage.getFavorite('alice', 'srcA+42');
    expect(got).not.toBeNull();
    expect(got!.search_title).toBe('搜索用标题');
    expect(got!.title).toBe('某剧');
  });

  test('setFavorite → getAllFavorites：search_title 不丢', async () => {
    await storage.setFavorite('alice', 'srcA+42', FAV);
    const all = await storage.getAllFavorites('alice');
    expect(all['srcA+42']?.search_title).toBe('搜索用标题');
  });

  test('未提供 search_title 时往返为 undefined/null，不报错', async () => {
    const { search_title, ...noSearch } = FAV;
    void search_title;
    await storage.setFavorite('alice', 'srcA+43', noSearch);
    const got = await storage.getFavorite('alice', 'srcA+43');
    expect(got).not.toBeNull();
    expect(got!.search_title == null).toBe(true);
  });
});

describe('D1初始化.md 与实现一致（第 20 项）', () => {
  const doc = readFileSync(
    join(__dirname, '..', '..', '..', 'D1初始化.md'),
    'utf8'
  );

  test('favorites 建表含 search_title 列', () => {
    const favBlock = doc.slice(
      doc.indexOf('CREATE TABLE IF NOT EXISTS favorites'),
      doc.indexOf('CREATE TABLE IF NOT EXISTS search_history')
    );
    expect(favBlock).toContain('search_title');
  });

  test('含存量迁移段：ALTER TABLE favorites ADD COLUMN search_title 且标注勿重复执行', () => {
    expect(doc).toContain('ALTER TABLE favorites ADD COLUMN search_title');
    expect(doc).toMatch(/迁移|存量/);
    expect(doc).toMatch(/勿重复|不要重复|已执行/);
  });
});
