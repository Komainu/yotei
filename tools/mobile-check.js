#!/usr/bin/env node
/*
 * スマホ幅 (375px) で HOME・一覧・編集画面・設定が横にはみ出していないかを確かめる。
 * Playwright と Chromium が必要 (npm test には含めない)。使い方:
 *   npm run check:mobile            … 結果を表示 (はみ出しがあれば終了コード1)
 *   npm run check:mobile -- out/    … 画面の写真も out/ に保存
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { console.error('Playwright が必要です: npm i -D playwright && npx playwright install chromium'); process.exit(2); }

const root = path.join(__dirname, '..');
const out = process.argv[2];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname.replace(/^\/yotei\//, '/')).replace(/\/$/, '/index.html'));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});

server.listen(0, '127.0.0.1', async () => {
  const url = `http://127.0.0.1:${server.address().port}/yotei/`;
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const now = new Date();
  const dl = d => new Date(now.getTime() + d * 864e5).toISOString().slice(0, 10) + 'T21:00';
  const P = (id, f) => Object.assign({ id, name: '案件', chain: 'ETH', deadline: '', memo: '', sources: [], pinned: false, status: 'open', createdAt: now.toISOString(), updatedAt: now.toISOString() }, f);
  const state = { projects: [
    P('a', { name: 'Arc 毎日TX (とても長い名前の案件でも折り返されるか確認します)', deadline: dl(0), repeat: { type: 'daily' }, memo: 'ブリッジしてTXを1回。https://example.com/very/long/url/that/should/not/overflow/the/screen/width', sources: [{ url: 'https://example.com/' + 'a'.repeat(60), title: '' }] }),
    P('b', { name: '期限切れ', deadline: dl(-2), chain: 'Solana' }),
    P('c', { name: '重要な案件', pinned: true, repeat: { type: 'weekly', dow: [1, 4] } }),
    P('d', { name: '完了', status: 'done', doneAt: now.toISOString() }),
  ], settings: {}, deleted: {} };
  await page.addInitScript(s => { if (!localStorage.getItem('sakiyomi_v1')) localStorage.setItem('sakiyomi_v1', s); }, JSON.stringify(state));
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(url);
  await page.waitForTimeout(400);
  let bad = 0;
  const check = async (label, file) => {
    const r = await page.evaluate(() => {
      const W = document.documentElement.clientWidth, over = [];
      for (const el of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed' || el.closest('#roomBg')) continue;
        let sc = el.parentElement, inScroll = false;   // 横スクロールする枠 (タブなど) の中は除く
        while (sc && sc !== document.body) { const o = getComputedStyle(sc).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') { inScroll = true; break; } sc = sc.parentElement; }
        if (inScroll) continue;
        const b = el.getBoundingClientRect();
        if (b.width && (b.right > W + 1 || b.left < -1)) over.push((el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + [...el.classList].join('.')) + ` ${Math.round(b.left)}..${Math.round(b.right)}`);
      }
      const dlg = document.querySelector('dialog[open]');
      let dlgOk = true;
      if (dlg) { const r = dlg.getBoundingClientRect(); const foot = dlg.querySelector('.dlg-foot'); const f = foot && foot.getBoundingClientRect(); dlgOk = r.left >= 0 && r.right <= W && (!f || f.bottom <= innerHeight); }
      return { W, sw: document.documentElement.scrollWidth, over: over.slice(0, 10), dlgOk };
    });
    const ok = r.sw <= r.W && !r.over.length && r.dlgOk;
    if (!ok) bad++;
    console.log(`${ok ? '✅' : '❌'} ${label}: 横幅 ${r.sw}/${r.W}px` + (r.over.length ? ' はみ出し: ' + r.over.join(', ') : '') + (r.dlgOk ? '' : ' (編集画面のボタンが画面の外)'));
    if (out) { fs.mkdirSync(out, { recursive: true }); await page.screenshot({ path: path.join(out, file), fullPage: !(await page.$('dialog[open]')) }); }
  };
  await check('HOME', 'home.png');
  await page.click('nav.tabs button[data-tab="projects"]'); await page.waitForTimeout(200);
  await check('よてい一覧', 'list.png');
  await page.click('.pcard[data-id="a"] [data-act="edit"]'); await page.waitForTimeout(200);
  await page.selectOption('#fRepeat', 'weekly');
  await check('編集画面', 'edit.png');
  await page.evaluate(() => document.querySelector('#pDialog').close());
  await page.click('nav.tabs button[data-tab="settings"]'); await page.waitForTimeout(300);
  await check('設定', 'settings.png');
  if (errors.length) { bad++; console.log('❌ エラー:', errors); }
  await b.close();
  server.close();
  process.exit(bad ? 1 : 0);
});
