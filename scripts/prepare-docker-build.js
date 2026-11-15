/**
 * Docker 构建预处理（L7：替代 Dockerfile 里脆弱的 sed）。
 *
 * 做两件事（与旧 sed 行为一致）：
 * 1. 把全部 API 路由的 `export const runtime = 'edge'` 翻为 'nodejs'
 *    （Docker 自托管跑 Node 运行时，不跑 Edge）；
 * 2. 向 src/app/layout.tsx 注入 `export const dynamic = 'force-dynamic'`
 *    （运行时读环境变量）。
 *
 * 与 sed 的关键区别：锚点缺失、替换失败、重复执行时直接退出非零
 * 失败构建，杜绝"sed 静默不做任何事、构建仍成功、部署后行为异常
 * 难排查"。只在 Docker 构建阶段运行（见 Dockerfile），不改动本地源码。
 *
 * 注意：Next.js 的 route segment config（runtime/dynamic）必须是静态
 * 字面量，无法用环境变量在源码里分支，因此构建期改写仍是必要的；
 * 本脚本只是让改写过程可校验、可失败。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function fail(message) {
  console.error(`[prepare-docker-build] 错误: ${message}`);
  process.exit(1);
}

// 1. 路由 runtime 翻转
const ROUTE_FILES = [];
function collectRouteFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectRouteFiles(full);
    } else if (entry.name === 'route.ts') {
      ROUTE_FILES.push(full);
    }
  }
}
collectRouteFiles(path.join(ROOT, 'src', 'app', 'api'));

if (ROUTE_FILES.length === 0) {
  fail('未找到任何 src/app/api/**/route.ts，疑似构建上下文错误');
}

let flipped = 0;
for (const file of ROUTE_FILES) {
  const src = fs.readFileSync(file, 'utf8');
  if (!src.includes("export const runtime = 'edge';")) {
    fail(
      `未找到 edge runtime 锚点: ${path.relative(
        ROOT,
        file,
      )}（锚点文本可能已变化，请同步更新本脚本）`,
    );
  }
  const next = src.replaceAll(
    "export const runtime = 'edge';",
    "export const runtime = 'nodejs';",
  );
  if (next === src) {
    fail(`替换失败: ${path.relative(ROOT, file)}`);
  }
  fs.writeFileSync(file, next);
  flipped += 1;
}
console.log(`[prepare-docker-build] 已翻转 ${flipped} 个路由为 nodejs runtime`);

// 2. layout.tsx 注入 force-dynamic
const layoutPath = path.join(ROOT, 'src', 'app', 'layout.tsx');
const anchor = "const inter = Inter({ subsets: ['latin'] });";
const layout = fs.readFileSync(layoutPath, 'utf8');
if (layout.includes("export const dynamic = 'force-dynamic';")) {
  fail('layout.tsx 已含 force-dynamic，疑似重复执行');
}
if (!layout.includes(anchor)) {
  fail('layout.tsx 未找到 Inter 锚点，无法注入 force-dynamic');
}
fs.writeFileSync(
  layoutPath,
  layout.replace(anchor, `${anchor}\nexport const dynamic = 'force-dynamic';`),
);
console.log('[prepare-docker-build] 已向 layout.tsx 注入 force-dynamic');
