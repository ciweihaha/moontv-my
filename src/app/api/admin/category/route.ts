import { NextResponse } from 'next/server';

export const runtime = 'edge';

/**
 * M5: 分类管理接口已停用。
 *
 * 该接口在所有存储模式下都不可用：d1/upstash 下 getConfig 每次都用
 * config.json 的 custom_category 覆盖分类（写入即丢失），localstorage
 * 模式无管理端数据库，redis 从未实现。管理后台分类区已改为只读展示
 * （见 src/app/admin/page.tsx 的 CategoryConfig）。
 *
 * 分类请直接修改 config.json 的 custom_category 后重新部署。
 */
export async function POST() {
  return NextResponse.json(
    {
      error:
        '分类管理请通过配置文件 config.json 的 custom_category 修改，本接口已停用',
    },
    { status: 400 }
  );
}
