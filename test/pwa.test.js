'use strict';
/* ホーム画面アプリ (PWA): manifest・アイコン・service worker・新しい版のお知らせ・オフライン */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { openApp } = require('./helpers/app');
const { createClock } = require('./helpers/clock');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const html = read('index.html');
const manifest = JSON.parse(read('manifest.webmanifest'));
const swCode = read('sw.js');
const SCOPE = 'https://komainu.github.io/yotei/';

/** PNG の幅と高さ (IHDR) */
function pngSize(file) {
  const b = fs.readFileSync(path.join(root, file));
  assert.equal(b.toString('latin1', 1, 4), 'PNG', file + ' は PNG');
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

test('manifest: ホーム画面に追加できる条件 (名前・開始URL・単独表示・192/512pxのアイコン・maskable)', () => {
  assert.equal(manifest.name, 'ポリマーケット記録');
  assert.ok(manifest.short_name && manifest.short_name.length <= 12);
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.display, 'standalone');
  assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/i);
  assert.match(manifest.background_color, /^#[0-9a-f]{6}$/i);
  for (const size of [192, 512]) {
    for (const purpose of ['any', 'maskable']) {
      const icon = manifest.icons.find(i => i.sizes === `${size}x${size}` && i.purpose === purpose);
      assert.ok(icon, `${size}px ${purpose}`);
      assert.equal(icon.type, 'image/png');
      assert.deepEqual(pngSize(icon.src), [size, size], icon.src);
    }
  }
  assert.deepEqual(pngSize('icons/apple-touch-icon.png'), [180, 180]);
});

test('index.html: manifest・テーマ色・iPhone用アイコンを読み込む', () => {
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/);
  assert.match(html, new RegExp(`<meta name="theme-color" content="${manifest.theme_color}">`));
  assert.match(html, /<link rel="apple-touch-icon" href="icons\/apple-touch-icon\.png">/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1\.0[^"]*">/);
});

test('sw.js: 版数は index.html の APP_VERSION と同じ (変えたら次に開いた時に「新しい版」が出る)', () => {
  const app = html.match(/const APP_VERSION = "([^"]+)"/)[1];
  const sw = swCode.match(/const VERSION = "([^"]+)"/)[1];
  assert.equal(sw, app, 'sw.js の VERSION を APP_VERSION と同じにしてください');
});

/* ---------- service worker を vm で動かす ---------- */
function loadSw(opts) {
  opts = opts || {};
  const listeners = {};
  const stores = new Map();   // キャッシュ名 → Map(url → Response)
  const fetched = [];
  const norm = r => new URL(typeof r === 'string' ? r : r.url, SCOPE).href;
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name);
      return {
        async addAll(reqs) { for (const r of reqs) { fetched.push(r); m.set(norm(r), new Response('cached:' + norm(r))); } },
        async match(r, o) {
          const u = new URL(norm(r));
          if (o && o.ignoreSearch) u.search = '';
          const hit = m.get(u.href);
          return hit ? hit.clone() : undefined;   // 本物のキャッシュも毎回新しい Response を返す
        },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(k) { return stores.delete(k); },
  };
  let skipped = 0, claimed = 0;
  const self = {
    location: new URL(SCOPE + 'sw.js'),
    registration: { scope: SCOPE },
    clients: { claim: async () => { claimed++; } },
    skipWaiting: () => { skipped++; },
    addEventListener: (t, fn) => { listeners[t] = fn; },
  };
  // ブラウザと同じく、相対URLは service worker の場所から解決する
  class SwRequest extends Request { constructor(u, o) { super(typeof u === 'string' ? new URL(u, SCOPE).href : u, o); } }
  const ctx = vm.createContext({
    self, caches, URL, Request: SwRequest, Response, Promise, console,
    fetch: async r => { fetched.push(r); if (opts.offline) throw new TypeError('Failed to fetch'); return new Response('network:' + norm(r)); },
  });
  vm.runInContext(swCode, ctx, { filename: 'sw.js' });
  const VERSION = swCode.match(/const VERSION = "([^"]+)"/)[1];
  /** fetch イベントを送る。respondWith されたら Response、されなければ null */
  async function request(url, init) {
    let res = null;
    const req = new Request(new URL(url, SCOPE).href, { method: (init && init.method) || 'GET', body: init && init.body });
    const event = { request: { url: req.url, method: req.method, mode: (init && init.mode) || 'cors' }, respondWith(p) { res = p; } };
    listeners.fetch(event);
    return res ? res.then(r => r) : null;
  }
  return {
    listeners, stores, fetched, request, VERSION, cacheName: 'yotei-' + VERSION,
    get skipped() { return skipped; }, get claimed() { return claimed; },
    async install() { let p; listeners.install({ waitUntil(x) { p = x; } }); await p; },
    async activate() { let p; listeners.activate({ waitUntil(x) { p = x; } }); await p; },
    setOffline(v) { opts.offline = v; },
  };
}

test('service worker: 入る時に index.html・manifest・アイコンを最新で (HTTPキャッシュを通さず) 保存する', async () => {
  const sw = loadSw();
  await sw.install();
  const saved = [...sw.stores.get(sw.cacheName).keys()].sort();
  assert.deepEqual(saved, [SCOPE, SCOPE + 'icons/apple-touch-icon.png', SCOPE + 'icons/icon-192.png', SCOPE + 'icons/icon-512.png',
    SCOPE + 'icons/maskable-192.png', SCOPE + 'icons/maskable-512.png', SCOPE + 'index.html', SCOPE + 'manifest.webmanifest'].sort());
  for (const r of sw.fetched) assert.equal(r.cache, 'reload');
  // 保存するファイルが本当にある
  const assets = swCode.match(/const ASSETS = \[([\s\S]*?)\];/)[1].match(/"\.\/([^"]*)"/g).map(s => s.slice(3, -1)).filter(Boolean);
  for (const f of assets) assert.ok(fs.existsSync(path.join(root, f)), f);
});

test('service worker: データの通信 (Apps Script・Telegram・外部API・POST) と、ほかのページには手を出さない', async () => {
  const sw = loadSw();
  await sw.install();
  for (const url of [
    'https://script.google.com/macros/s/XXXX/exec?action=load&key=k',
    'https://script.googleusercontent.com/macros/echo?user_content_key=x',
    'https://api.telegram.org/botTOKEN/getUpdates',
    'https://api.stlouisfed.org/fred/series/observations?series_id=X',
    'https://gamma-api.polymarket.com/markets',
    'https://api.coingecko.com/api/v3/simple/price',
  ]) {
    assert.equal(await sw.request(url), null, url);
  }
  assert.equal(await sw.request(SCOPE + 'index.html', { method: 'POST', body: 'x' }), null, 'POST');
  assert.equal(await sw.request(SCOPE + 'docs/storage.md', { mode: 'navigate' }), null, 'docs などほかのページ');
  assert.equal(await sw.request('https://komainu.github.io/other-app/', { mode: 'navigate' }), null, '別のアプリ');
  assert.equal(await sw.request(SCOPE + 'data.json'), null, 'アプリ本体でないファイル');
  // 何も保存していない (実行中にキャッシュへ足さない)
  assert.equal(sw.stores.get(sw.cacheName).size, 8);
});

test('service worker: 電波がなくても、画面 (?付きURLも)・アイコンは保存した内容で開ける', async () => {
  const sw = loadSw();
  await sw.install();
  sw.setOffline(true);
  for (const url of [SCOPE, SCOPE + 'index.html', SCOPE + '?from=homescreen']) {
    const res = await sw.request(url, { mode: 'navigate' });
    assert.ok(res, url);
    assert.equal(await res.text(), 'cached:' + SCOPE + 'index.html', url);
  }
  assert.match(await (await sw.request(SCOPE + 'icons/icon-192.png')).text(), /^cached:/);
  assert.match(await (await sw.request(SCOPE + 'manifest.webmanifest')).text(), /^cached:/);
});

test('service worker: 新しい版は「読み込み直す」まで待ち、切り替わったら古いキャッシュを消す', async () => {
  const sw = loadSw();
  sw.stores.set('yotei-2000.01.01', new Map());
  sw.stores.set('other-app-cache', new Map());
  await sw.install();
  assert.equal(sw.skipped, 0, '入っただけでは切り替えない');
  sw.listeners.message({ data: { type: 'OTHER' } });
  assert.equal(sw.skipped, 0);
  sw.listeners.message({ data: { type: 'SKIP_WAITING' } });
  assert.equal(sw.skipped, 1, '「読み込み直す」で切り替える');
  await sw.activate();
  assert.deepEqual([...sw.stores.keys()].sort(), ['other-app-cache', sw.cacheName].sort(), '古い版だけ消す (ほかのアプリのものは残す)');
  assert.equal(sw.claimed, 1);
});

/* ---------- ページ側 ---------- */

/** navigator.serviceWorker の偽物 */
function fakeSw(o) {
  o = o || {};
  const listeners = {};
  const reg = {
    waiting: o.waiting || null, installing: null, updates: 0,
    _l: {}, addEventListener(t, fn) { this._l[t] = fn; }, update: async () => { reg.updates++; },
  };
  const sw = {
    controller: o.controller === undefined ? {} : o.controller,
    registered: [],
    register(url) { sw.registered.push(url); return Promise.resolve(reg); },
    addEventListener(t, fn) { listeners[t] = fn; },
    fire(t) { listeners[t] && listeners[t](); },
    reg,
  };
  return sw;
}
const worker = () => { const w = { state: 'installing', messages: [], _l: {}, postMessage(m) { w.messages.push(m); }, addEventListener(t, fn) { w._l[t] = fn; } }; return w; };

async function pwaApp(sw, url, extra) {
  return openApp(Object.assign({
    url,
    beforeParse(win) { if (sw) Object.defineProperty(win.navigator, 'serviceWorker', { value: sw, configurable: true }); },
  }, extra || {}));
}

test('file:// で開いた時は service worker を登録せず、エラーも出ない', async () => {
  const sw = fakeSw();
  sw.register = () => { throw new Error('file:// では呼ばれてはいけない'); };
  const app = await pwaApp(sw, 'file:///Users/me/yotei/index.html');
  try {
    assert.equal(app.run('setupPwa()'), false);
    assert.deepEqual(app.errors, []);
    assert.equal(app.doc.querySelector('#updateBar').hidden, true);
  } finally { app.close(); }
  // service worker が使えないブラウザ
  const old = await pwaApp(null, SCOPE);
  try { assert.equal(old.run('setupPwa()'), false); assert.deepEqual(old.errors, []); } finally { old.close(); }
});

test('GitHub Pages で開いた時: sw.js を登録する。初めての時は読み込み直さない', async () => {
  const sw = fakeSw({ controller: null });
  const app = await pwaApp(sw, SCOPE);
  try {
    assert.deepEqual(sw.registered, ['sw.js']);
    app.run('window.__reloads = 0; pwaReload = () => { window.__reloads++; };');
    sw.fire('controllerchange');   // 初めて入った service worker が動き始めた
    assert.equal(app.run('window.__reloads'), 0);
    assert.equal(app.doc.querySelector('#updateBar').hidden, true);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('新しい版: 「新しい版があります」が出て、「読み込み直す」で切り替えて1回だけ読み込み直す', async () => {
  // ① 開いた時にすでに新しい版が待っている
  const w1 = worker();
  const sw = fakeSw({ waiting: w1 });
  const app = await pwaApp(sw, SCOPE);
  try {
    app.run('window.__reloads = 0; pwaReload = () => { window.__reloads++; };');
    const bar = app.doc.querySelector('#updateBar');
    assert.equal(bar.hidden, false);
    assert.match(bar.textContent, /新しい版があります/);
    app.doc.querySelector('#updateReload').click();
    assert.deepEqual(JSON.parse(JSON.stringify(w1.messages)), [{ type: 'SKIP_WAITING' }]);
    sw.fire('controllerchange');
    sw.fire('controllerchange');
    assert.equal(app.run('window.__reloads'), 1, '1回だけ');
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }

  // ② 使っている間に新しい版が届く → 「あとで」で閉じられる
  const sw2 = fakeSw();
  const app2 = await pwaApp(sw2, SCOPE);
  try {
    const w2 = worker();
    sw2.reg.installing = w2;
    sw2.reg._l.updatefound();
    assert.equal(app2.doc.querySelector('#updateBar').hidden, true, 'まだ準備中');
    w2.state = 'installed'; w2._l.statechange();
    assert.equal(app2.doc.querySelector('#updateBar').hidden, false);
    app2.doc.querySelector('#updateLater').click();
    assert.equal(app2.doc.querySelector('#updateBar').hidden, true);
    assert.deepEqual(w2.messages, [], '「あとで」では切り替えない');
    // 画面に戻った時に新しい版を確かめる
    Object.defineProperty(app2.doc, 'visibilityState', { value: 'visible', configurable: true });
    app2.doc.dispatchEvent(new app2.win.Event('visibilitychange'));
    await app2.settle();
    assert.ok(sw2.reg.updates >= 1);
    assert.deepEqual(app2.errors, []);
  } finally { app2.close(); }
});

test('オフライン: 前回の Polymarket の一覧がそのまま表示され、「オフライン」の印が出る', async () => {
  const clock = createClock();
  const offline = async () => { throw new TypeError('Failed to fetch'); };   // 電波がない
  const m = { id: '1', q: 'Will the Fed cut rates?', g: '', o: ['Yes', 'No'], p: [0.6, 0.4], h1: 0, d1: 0, w1: 0, v24: 1000, vol: 5000, liq: 10, end: null, tok: [], slug: 'fed', c: false, neg: false, th: null, ev: { id: 'fed', t: 'Fed', s: 'fed' } };
  const app = await openApp({
    clock, fetch: offline,
    storage: { pm_cache_v1: { t: clock.now - 3600000, markets: [m] } },
    beforeParse(win) { Object.defineProperty(win.navigator, 'onLine', { value: false, configurable: true }); },
  });
  try {
    for (let i = 0; i < 5; i++) await app.settle();
    assert.deepEqual([...app.doc.querySelectorAll('#pmList .pm-card')].map(c => c.dataset.ev), ['fed'], '前回の一覧');
    assert.equal(app.doc.querySelector('#offlineTag').hidden, false);
    // 電波が戻った
    Object.defineProperty(app.win.navigator, 'onLine', { value: true, configurable: true });
    app.win.dispatchEvent(new app.win.Event('online'));
    assert.equal(app.doc.querySelector('#offlineTag').hidden, true);
    assert.match(app.text('#toast'), /電波が戻りました/);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('設定: 「ホーム画面に追加」の手順 (iPhone / Android) と、Android のボタン', async () => {
  const app = await openApp();
  try {
    const card = [...app.doc.querySelectorAll('.set-card')].find(c => /ホーム画面に追加/.test(c.querySelector('h3').textContent));
    assert.ok(card);
    assert.match(card.textContent, /iPhone \(Safari\):.*共有ボタン.*ホーム画面に追加/s);
    assert.match(card.textContent, /Android \(Chrome\):.*︙.*(ホーム画面に追加|アプリをインストール)/s);
    assert.match(card.textContent, /新しい版があります/);
    const btn = app.doc.querySelector('#installBtn');
    assert.equal(btn.hidden, true, 'ふだんは隠れている');
    // Chrome が「追加できます」と知らせてきた時だけボタンを出す
    let prompted = 0;
    const ev = new app.win.Event('beforeinstallprompt');
    ev.prompt = () => { prompted++; };
    ev.userChoice = Promise.resolve({ outcome: 'accepted' });
    app.win.dispatchEvent(ev);
    assert.equal(btn.hidden, false);
    btn.click();
    await app.settle();
    assert.equal(prompted, 1);
    assert.equal(btn.hidden, true);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});
