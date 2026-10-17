/* ============================================================
   古代史及汉籍研究工具 · Service Worker
   ------------------------------------------------------------
   策略：应用外壳预缓存（很小），其余按需缓存
     · 导航请求（HTML）      → 网络优先，失败回落缓存 / 首页
     · 同源静态资源（JS/CSS/图）→ 先给缓存再后台更新（SWR）
     · 跨域请求              → 不接管，交给浏览器

   ⚠️ 发布新版本时请同步修改下面的 VERSION，
      旧缓存会在 activate 阶段被自动清理。
   ⚠️ kanseki_data.js 有 9.6 MB，**绝不预缓存**，
      只在用户真正打开古籍类目查询页时按需缓存。
   ============================================================ */

const VERSION = 'pwa-2';
const CACHE = 'kanseki-' + VERSION;

/* 预缓存：只放「离线也必须有」的最小集合（约 750 KB） */
const PRECACHE = [
  './',
  './m.html',
  './index.html',
  './kanseki.html',
  './era_data.js',
  './manifest.webmanifest',
  './assets/logo.png',
  './assets/favicon.png',
  './assets/icon-192.png',
  './assets/icon-512.png'
];

/* ---------------- install ---------------- */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 逐条缓存：某一条失败（如 404）不影响其余，避免整次安装失败
    await Promise.allSettled(
      PRECACHE.map((url) => cache.add(new Request(url, { cache: 'reload' })))
    );
    await self.skipWaiting();
  })());
});

/* ---------------- activate ---------------- */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

/* ---------------- fetch ---------------- */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // 只管同源；跨域（GitHub API、京都汉籍库、DeepSeek 等）一律不接管
  if (url.origin !== self.location.origin) return;
  // 不碰自己的脚本，也不碰任何带查询串的接口式请求之外的特殊路径
  if (url.pathname.endsWith('/sw.js')) return;

  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req));
  } else {
    event.respondWith(staleWhileRevalidate(req));
  }
});

/* 网络优先：导航请求始终拿最新 HTML，断网时回落到缓存 */
async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (_) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    const shell = await cache.match('./index.html');
    if (shell) return shell;
    return new Response('当前处于离线状态，且该页面尚未缓存。', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

/* 先给缓存、后台更新：静态资源二次访问几乎瞬时 */
async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });

  const network = fetch(req).then((res) => {
    if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  }).catch(() => null);

  if (hit) return hit;
  const res = await network;
  if (res) return res;
  return new Response('', { status: 504, statusText: 'Offline' });
}

/* 允许页面主动要求跳过等待（用于发版后立即生效） */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
