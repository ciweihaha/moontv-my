#!/usr/bin/env node

/* eslint-disable no-console,@typescript-eslint/no-var-requires */
const http = require('http');
const path = require('path');

// 调用 generate-manifest.js 生成 manifest.json
function generateManifest() {
  console.log('Generating manifest.json for Docker deployment...');

  try {
    const generateManifestScript = path.join(
      __dirname,
      'scripts',
      'generate-manifest.js'
    );
    require(generateManifestScript);
  } catch (error) {
    console.error('❌ Error calling generate-manifest.js:', error);
    throw error;
  }
}

generateManifest();

// 直接在当前进程中启动 standalone Server（`server.js`）
require('./server.js');

// 每 1 秒轮询一次，直到请求成功；最多尝试 60 次（约 60 秒），
// 超限说明服务始终未能健康启动，打印明确错误并以非零码退出，
// 避免无限轮询把日志刷爆且无人察觉。
const TARGET_URL = `http://${process.env.HOSTNAME || 'localhost'}:${
  process.env.PORT || 3000
}/login`;
const MAX_POLL_ATTEMPTS = 60;
let pollAttempts = 0;

const intervalId = setInterval(() => {
  pollAttempts += 1;
  if (pollAttempts > MAX_POLL_ATTEMPTS) {
    clearInterval(intervalId);
    console.error(
      `Server did not become ready after ${MAX_POLL_ATTEMPTS} attempts (~${MAX_POLL_ATTEMPTS}s), giving up.`
    );
    process.exit(1);
  }

  console.log(`Fetching ${TARGET_URL} ... (attempt ${pollAttempts}/${MAX_POLL_ATTEMPTS})`);

  const req = http.get(TARGET_URL, (res) => {
    // 当返回 2xx 状态码时认为成功，然后停止轮询
    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
      console.log('Server is up, stop polling.');
      clearInterval(intervalId);

      // 服务器启动后，立即执行一次 cron 任务
      executeCronJob();

      // 然后设置每小时执行一次 cron 任务
      setInterval(() => {
        executeCronJob();
      }, 60 * 60 * 1000); // 每小时执行一次
    }
  });

  req.setTimeout(2000, () => {
    req.destroy();
  });
}, 1000);

// 执行 cron 任务的函数
function executeCronJob() {
  const cronUrl = `http://${process.env.HOSTNAME || 'localhost'}:${
    process.env.PORT || 3000
  }/api/cron`;

  console.log(`Executing cron job: ${cronUrl}`);

  // 若部署配置了 CRON_SECRET，/api/cron 要求 Bearer 鉴权；
  // 从环境变量读取并放在 Authorization 头中（不硬编码、不进查询参数）。
  const headers = {};
  if (process.env.CRON_SECRET) {
    headers.Authorization = `Bearer ${process.env.CRON_SECRET}`;
  }

  const req = http.get(cronUrl, { headers }, (res) => {
    let data = '';

    res.on('data', (chunk) => {
      data += chunk;
    });

    res.on('end', () => {
      if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
        console.log('Cron job executed successfully:', data);
      } else {
        console.error('Cron job failed:', res.statusCode, data);
      }
    });
  });

  req.on('error', (err) => {
    console.error('Error executing cron job:', err);
  });

  req.setTimeout(30000, () => {
    console.error('Cron job timeout');
    req.destroy();
  });
}
