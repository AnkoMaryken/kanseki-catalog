// ================================================
// tests/helpers/config.js — 浏览器测试共享配置（参数化）
// 环境变量可覆盖：
//   CHROME_PATH   Chrome 可执行文件路径
//   PORT          静态站端口（默认 8765）
//   APP_PORT      APP 端口（默认 8766）
//   BASE_URL      完整覆盖 URL（优先）
// ================================================
const path = require('path');
const { pathToFileURL } = require('url');

const DEFAULT_CHROME = 'C:/Users/华为/.agent-browser/browsers/chrome-151.0.7922.76/chrome.exe';

function resolveChrome() {
  return process.env.CHROME_PATH || DEFAULT_CHROME;
}

function resolveBaseUrl(port) {
  if (process.env.BASE_URL) return process.env.BASE_URL;
  return `http://localhost:${port}/index.html`;
}

function resolveAppUrl(route = '') {
  const port = process.env.APP_PORT || '8766';
  return `http://localhost:${port}/${route}`;
}

// 解析 playwright-core 绝对路径（ESM/Windows 兼容）
// playwright-core 安装在 WorkBuddy 管理的 node workspace
function playwrightCorePath() {
  const candidates = [
    process.env.PLAYWRIGHT_CORE_PATH,
    'C:/Users/华为/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js',
    path.resolve(__dirname, '..', 'node_modules', 'playwright-core', 'index.js')
  ];
  const fs = require('fs');
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  throw new Error('playwright-core 未找到，请设置 PLAYWRIGHT_CORE_PATH');
}

module.exports = {
  CHROME_PATH: resolveChrome(),
  PORT: process.env.PORT || '8765',
  APP_PORT: process.env.APP_PORT || '8766',
  BASE_URL: resolveBaseUrl(process.env.PORT || '8765'),
  APP_URL: resolveAppUrl(),
  resolveAppUrl,
  playwrightCorePath,
  launchOptions: {
    executablePath: resolveChrome(),
    headless: true,
    args: ['--no-sandbox', '--disable-gpu']
  }
};
