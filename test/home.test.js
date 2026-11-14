'use strict';
/* 🏠 ホーム: 4つのタブの要点を1画面に集める */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { openApp, GAS_URL } = require('./helpers/app');

/** ほかのテストの「世界」(偽のサーバー) を借りる */
function borrow(file, names) {
  const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const m = {};
  new Function('module', 'require', src.slice(0, src.indexOf("\ntest('")) + ';module.exports={' + names + '};')(m, p => require(p.startsWith('./') ? path.join(__dirname, p.slice(2)) : p));
  return m.exports;
}
const reply = o => ({ ok: true, status: 200, json: async () => o });
const mk = (id, q, p, d1, ev) => ({ id, question: q, groupItemTitle: '', outcomes: '["Yes","No"]', outcomePrices: JSON.stringify([String(p), String(1 - p)]), oneDayPriceChange: d1, oneHourPriceChange: 0,
  volume24hr: 1e5, volumeNum: 1e6, liquidityNum: 1e4, endDate: '2026-12-10T00:00:00Z', clobTokenIds: '["t' + id + '"]', closed: false, events: [{ id: ev, title: q, slug: ev }] });
const pmFetch = async url => {
  const u = new URL(url);
  if (u.pathname === '/markets' && !u.searchParams.get('id')) return reply(Number(u.searchParams.get('offset')) === 0 ? [mk('1', 'Will the Fed cut rates?', 0.6, 0.12, 'fed'), mk('2', 'Will BTC hit 100k?', 0.3, -0.02, 'btc')] : []);
  if (u.host === 'clob.polymarket.com') return reply({ history: [] });
  return reply({ events: [] });
};

test('ホーム: 最初に開き、天気・予定・ウォッチ・先物・お金の流れの要点を出す。行を押すとそのタブへ', async () => {
  const { world } = borrow('llama.test.js', 'world');
  const { gas, clock } = world();
  const app = await openApp({ clock, gas, fetch: pmFetch, storage: { pm_watch_v1: { fed: { t: 'Will the Fed cut rates?', m: ['1'] } } }, state: { projects: [], settings: { gasUrl: GAS_URL, gasAuto: false }, deleted: {} } });
  try {
    for (let i = 0; i < 10; i++) await app.settle();
    assert.ok(app.doc.querySelector('nav button[data-tab="top"]').classList.contains('active'));
    const t = app.text('#homeBody').replace(/\s+/g, '');
    assert.match(app.text('#homeDate'), /11月9日/);
    assert.match(t, /これからの予定/);
    assert.match(t, /CPI\(物価\)10月分/);
    assert.match(t, /ウォッチ中の市場くわしく→WilltheFedcutrates\?はい60%・24時間▲12pt/);
    assert.doesNotMatch(t.split('PolymarketとKalshi')[0], /BTChit100k/, 'ウォッチしていない市場は出さない');
    assert.match(t, /TVLが伸びているチェーン\(30日\)Monad/);
    assert.match(t, /暗号資産の先物\(Hyperliquid\)くわしく→取得できませんでした/, '失敗した時は読み込み中のままにしない');
    assert.match(t, /ステーブルコインの流入が最大:HyperliquidL1/);
    assert.match(t, /エアドロップ候補.*LighterPerpsNEW/);
    // ウォッチの行 → Polymarket タブで詳細が開く
    app.doc.querySelector('#homeBody [data-pmopen="fed"]').click();
    assert.ok(app.doc.querySelector('#tab-poly').classList.contains('active'));
    assert.equal(app.doc.querySelector('#pmSheet').hidden, false);
    app.doc.querySelector('#pmSheet .pm-x').click();
    // 「くわしく →」→ お金の流れタブ
    app.run('switchTab("top")');
    app.doc.querySelector('#homeBody .hm-more[data-jump="flow"]').click();
    assert.ok(app.doc.querySelector('#tab-flow').classList.contains('active'));
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('ホーム: 相場の天気 (追い風・向かい風) を大きく出し、指標を押すとマクロのカードへ', async () => {
  const { macroFetch } = borrow('macro.test.js', 'macroFetch');
  const { loadGas } = require('./helpers/gas');
  const { createClock } = require('./helpers/clock');
  const clock = createClock('2026-11-09T10:00:00+09:00');
  const gas = loadGas({ clock, fetch: macroFetch(clock.now).fetch });
  const app = await openApp({ clock, gas, fetch: async () => { throw new TypeError('offline'); }, state: { projects: [], settings: { gasUrl: GAS_URL, gasAuto: false }, deleted: {} } });
  try {
    for (let i = 0; i < 10; i++) await app.settle();
    const hero = app.text('#homeBody .hm-hero').replace(/\s+/g, ' ');
    assert.match(hero, /今日の相場は「(晴れ|晴れ時々くもり|くもり|雨|嵐)」/);
    assert.match(hero, /🔴 向かい風.*VIX \(恐怖指数\)/);
    assert.match(app.text('#homeBody'), /BTC\$74,000/);
    app.doc.querySelector('#homeBody .hm-pill[data-mc="vix"]').click();
    assert.ok(app.doc.querySelector('#tab-btc').classList.contains('active'));
    assert.ok(app.doc.querySelector('.mc-card[data-mc="vix"]').classList.contains('mc-flash'));
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('ホーム: サーバーを登録していない時は、案内を出してエラーにしない', async () => {
  const app = await openApp({ fetch: pmFetch });
  try {
    for (let i = 0; i < 6; i++) await app.settle();
    assert.match(app.text('#homeBody'), /設定でサーバー/);
    assert.match(app.text('#homeBody'), /これからの予定/);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});
