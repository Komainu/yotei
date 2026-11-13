'use strict';
/* タブどうしをつなげる: Polymarket の市場 ⇄ Hyperliquid・マクロ・お金の流れ */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { openApp, GAS_URL } = require('./helpers/app');

function borrow(file, names) {
  const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const m = {};
  new Function('module', 'require', src.slice(0, src.indexOf("\ntest('")) + ';module.exports={' + names + '};')(m, p => require(p.startsWith('./') ? path.join(__dirname, p.slice(2)) : p));
  return m.exports;
}
const reply = o => ({ ok: true, status: 200, json: async () => o });
const mk = (id, q, g, ev, title) => ({ id, question: q, groupItemTitle: g, outcomes: '["Yes","No"]', outcomePrices: '["0.4","0.6"]', oneDayPriceChange: 0, oneHourPriceChange: 0,
  volume24hr: 1e5, volumeNum: 1e6, liquidityNum: 1e4, endDate: '2027-12-31T00:00:00Z', clobTokenIds: '["t' + id + '"]', closed: false, events: [{ id: ev, title: title || q, slug: ev }] });
const MARKETS = [
  mk('1', 'Base FDV above $1B one day after launch?', '$1B', 'basefdv', 'Base FDV above ___ one day after launch?'),
  mk('2', 'Base FDV above $5B one day after launch?', '$5B', 'basefdv', 'Base FDV above ___ one day after launch?'),
  mk('3', 'Will Lighter launch a token by June 30?', '', 'lighter', 'Will Lighter launch a token by June 30?'),
  mk('4', 'Will Bitcoin hit $100k in 2026?', '', 'btc'),
  mk('5', 'Will the Fed cut rates in December?', '', 'fed'),
  mk('6', 'HYPE FDV above $50B on December 31?', '$50B', 'hypefdv', 'HYPE FDV above ___ on December 31?'),
  mk('7', 'HYPE FDV above $100B on December 31?', '$100B', 'hypefdv', 'HYPE FDV above ___ on December 31?'),
];
const pmFetch = async url => {
  const u = new URL(url);
  if (u.pathname === '/markets' && !u.searchParams.get('id')) return reply(Number(u.searchParams.get('offset')) === 0 ? MARKETS : []);
  if (u.host === 'clob.polymarket.com') return reply({ history: [] });
  return reply({ events: [] });
};
const open = async (gas, clock) => { const app = await openApp({ clock, gas, fetch: pmFetch, state: { projects: [], settings: { gasUrl: GAS_URL, gasAuto: false }, deleted: {} } }); for (let i = 0; i < 10; i++) await app.settle(); return app; };
const rel = app => app.text('#pmSRelated').replace(/\s+/g, '');

test('お金の流れ ⇄ Polymarket: チェーン・エアドロップ候補に「予測市場あり」、市場の詳細にチェーンと先物 DEX の数字', async () => {
  const { gas, clock } = borrow('llama.test.js', 'world').world();
  const app = await open(gas, clock);
  try {
    app.run('switchTab("flow")');
    for (let i = 0; i < 4; i++) await app.settle();
    // チェーンの一覧: Base に印。Ethereum などには無い
    const row = n => [...app.doc.querySelectorAll('#flChains tbody tr')].find(r => r.querySelector('b').textContent === n);
    assert.ok(row('Base').querySelector('.rel-b'), 'Base の FDV 市場がある');
    assert.equal(row('Ethereum').querySelector('.rel-b'), null);
    assert.ok(app.doc.querySelector('#flCand .fl-cand .rel-b'), 'Lighter のトークン発行の市場がある');
    // 印を押す → Polymarket タブで詳細が開く
    row('Base').querySelector('.rel-b').click();
    await app.settle();
    assert.ok(app.doc.querySelector('#tab-poly').classList.contains('active'));
    assert.match(app.text('#pmSTitle'), /Base FDV/);
    assert.match(rel(app), /Baseチェーンのお金の流れTVL57\.0億ドル\(30日\+20\.0%\)・ステーブルコイン51\.0億ドル\(30日\+5\.0億ドル\)/);
    // 関連の行を押す → 詳細を閉じて、お金の流れタブへ
    app.doc.querySelector('#pmSRelated [data-relgo="flow"]').click();
    assert.equal(app.doc.querySelector('#pmSheet').hidden, true);
    assert.ok(app.doc.querySelector('#tab-flow').classList.contains('active'));
    // Lighter の市場 → 先物 DEX の数字、押すとその DEX の詳細
    app.run('switchTab("poly"); pmOpen("lighter")');
    assert.match(rel(app), /LighterPerps\(先物DEX\)建玉5\.0億ドル\(30日\+150\.0%\)・手数料30日450万ドル・トークン未発行/);
    app.doc.querySelector('#pmSRelated [data-perp]').click();
    for (let i = 0; i < 3; i++) await app.settle();
    assert.match(app.text('#flPDetail'), /Lighter Perps/);
    // 関係のない市場には出さない
    app.run('switchTab("poly"); pmOpen("btc")');
    assert.doesNotMatch(rel(app), /チェーンのお金の流れ|先物DEX/);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('Hyperliquid ⇄ Polymarket: ビットコインの市場に BTC の価格・建玉・ファンディング、FDV の市場に現物のいまの FDV', async () => {
  const { gas, clock } = borrow('hl.test.js', 'world').world();
  gas.ctx.pmRecord();
  const app = await open(gas, clock);
  try {
    app.run('switchTab("poly"); pmOpen("btc")');
    assert.match(rel(app), /BTCの今\(Hyperliquid\)\$74,000\(24時間-1\.3%\)・建玉11\.1億ドル・ファンディング\+0\.0100%/);
    app.doc.querySelector('#pmSRelated [data-coin="BTC"]').click();
    assert.ok(app.doc.querySelector('#tab-hl').classList.contains('active'));
    assert.ok(app.doc.querySelector('#hlChartBox [data-hlsel="BTC"]').classList.contains('active'));
    app.run('switchTab("poly"); pmOpen("hypefdv")');
    assert.match(rel(app), /HYPEの今\(Hyperliquid\)/);
    assert.match(rel(app), /HYPEのいまのFDV\(Hyperliquidの現物\)750億ドル・価格\$75\.00・流通率30%/);
    app.doc.querySelector('#pmSheet .pm-x').click();
    // 現物の一覧にも印
    app.run('switchTab("hl")');
    const hype = [...app.doc.querySelectorAll('#hlSpot tbody tr')].find(r => r.querySelector('b').textContent === 'HYPE');
    assert.ok(hype.querySelector('.rel-b'));
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('マクロ ⇄ Polymarket: FRB の市場に政策金利などの指標 (押すとマクロのカードへ)', async () => {
  const { macroFetch } = borrow('macro.test.js', 'macroFetch');
  const { loadGas } = require('./helpers/gas');
  const { createClock } = require('./helpers/clock');
  const clock = createClock('2026-11-09T10:00:00+09:00');
  const gas = loadGas({ clock, fetch: macroFetch(clock.now).fetch });
  const app = await open(gas, clock);
  try {
    app.run('switchTab("poly"); pmOpen("fed")');
    assert.match(rel(app), /関連するマクロの指標政策金利\(FF金利\)3\.88%2年国債利回り3\.50%/);
    app.doc.querySelector('#pmSRelated [data-mc="ff"]').click();
    assert.ok(app.doc.querySelector('#tab-btc').classList.contains('active'));
    assert.ok(app.doc.querySelector('.mc-card[data-mc="ff"]').classList.contains('mc-flash'));
    assert.equal(app.doc.querySelector('#pmSheet').hidden, true);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});
