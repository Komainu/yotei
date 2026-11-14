/* ポリマーケット記録 — service worker
   ・アプリ本体 (index.html・アイコン・manifest) をキャッシュして、電波が弱くても前回の内容で開けるようにする
   ・データの通信 (Apps Script・Polymarket・外部API) には一切さわらない (キャッシュしない)
   ・新しい版: VERSION が変わると新しい service worker が入り、ページに「新しい版があります」と出る。
     「読み込み直す」が押されたら切り替える (勝手には切り替えない)
   ※ VERSION は index.html の APP_VERSION と必ず同じにする (テストで確認している) */
const VERSION = "2026.12.05";
const CACHE = "yotei-" + VERSION;
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-192.png",
  "./icons/maskable-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", event => {
  // HTTPのキャッシュを通さず、必ず最新を取ってくる
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: "reload" })))));
});

self.addEventListener("activate", event => {
  // 古い版のキャッシュを片付ける (このアプリのものだけ)
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith("yotei-") && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", event => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

/** キャッシュから返してよい通信か (同じサイトのアプリ本体だけ) */
function isAppShell(request) {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;   // Apps Script・Telegram・外部API は対象外
  const scope = new URL(self.registration.scope).pathname;
  if (!url.pathname.startsWith(scope)) return false;
  const path = "./" + url.pathname.slice(scope.length);
  if (request.mode === "navigate") return path === "./" || path === "./index.html";   // docs/ などほかのページは対象外
  return ASSETS.includes(path);
}

self.addEventListener("fetch", event => {
  const req = event.request;
  if (!isAppShell(req)) return;   // 何もしない = いつも通りネットにつなぐ
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // 画面を開く時は index.html を返す (?付きのURLでも同じ)
    const key = req.mode === "navigate" ? "./index.html" : req;
    const hit = await cache.match(key, { ignoreSearch: req.mode === "navigate" });
    if (hit) return hit;
    try { return await fetch(req); }
    catch (e) {
      const fallback = req.mode === "navigate" && await cache.match("./index.html");
      if (fallback) return fallback;
      throw e;
    }
  })());
});
