'use strict';
/* Hyperliquid 専用タブ: 今の状態 (先物・他の取引所のファンディング・現物) と、記録の蓄積 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('./helpers/gas');
const { openApp, GAS_URL } = require('./helpers/app');
const { createClock } = require('./helpers/clock');

const COINS = [
  // 名前, 価格, 前日, 建玉(枚), ファンディング(1h), 出来高
  ['BTC', 74000, 75000, 15000, '0.0000125', 1.2e9],
  ['ETH', 2100, 2200, 400000, '-0.00003', 8e8],
  ['SOL', 150, 140, 2e6, '0.00002', 2e8],
  ['HYPE', 75, 77, 1e6, '-0.00005', 2e8],
  ['DOGE', 0.2, 0.2, 5e8, '0.0002', 5e7],    // ファンディングが高い (8h 0.16%)
  ['TINY', 1, 1, 10, '0.001', 100],           // 建玉が小さい (差の表には出さない)
];
function world() {
  const st = { btcOi: 15000 };
  const ok = obj => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify(obj) });
  const fetch = (url, params) => {
    if (/api\.hyperliquid\.xyz/.test(url)) {
      const b = JSON.parse(params.payload);
      if (b.type === 'metaAndAssetCtxs') return ok([{ universe: COINS.map(c => ({ name: c[0], maxLeverage: 20 })) },
        COINS.map(c => ({ markPx: String(c[1]), prevDayPx: String(c[2]), openInterest: String(c[0] === 'BTC' ? st.btcOi : c[3]), funding: c[4], dayNtlVlm: String(c[5]), premium: '0.0001' }))]);
      if (b.type === 'predictedFundings') return ok(COINS.map(c => [c[0], [['BinPerp', { fundingRate: '0.0001', fundingIntervalHours: 8 }], ['HlPerp', { fundingRate: c[4], fundingIntervalHours: 1 }], ['BybitPerp', { fundingRate: '0.00005', fundingIntervalHours: 4 }]]]));
      if (b.type === 'spotMetaAndAssetCtxs') return ok([{ tokens: [{ name: 'USDC' }, { name: 'HYPE' }, { name: 'PURR' }], universe: [{ name: '@107', tokens: [1, 0] }, { name: 'PURR/USDC', tokens: [2, 0] }] },
        [{ coin: '@107', markPx: '75', prevDayPx: '77', dayNtlVlm: '5.5e7', circulatingSupply: '3e8', totalSupply: '1e9' }, { coin: 'PURR/USDC', markPx: '0.2', prevDayPx: '0.19', dayNtlVlm: '1e6', circulatingSupply: '6e8', totalSupply: '1e9' }]]);
      return ok([]);
    }
    if (/gamma-api|kalshi/.test(url)) return ok(/kalshi/.test(url) ? { events: [] } : []);
    throw new Error('使わない: ' + url);
  };
  const clock = createClock('2026-11-09T10:00:00+09:00');
  const gas = loadGas({ clock, fetch });
  return { clock, gas, st };
}

test('サーバー: 今の状態 (先物・他の取引所のファンディングを8時間に直したもの・現物の発行量)', () => {
  const { gas } = world();
  const r = gas.get({ action: 'hl' });
  assert.equal(r.ok, true);
  const btc = r.snap.perps.find(x => x.n === 'BTC');
  assert.equal(btc.oi, 15000 * 74000);
  assert.equal(btc.bin, 0.0001, 'Binance は8時間ごとのまま');
  assert.equal(btc.byb, 0.0001, 'Bybit 4時間ごと 0.005% → 8時間 0.01%');
  assert.equal(r.snap.perps[0].n, 'BTC', '建玉が大きい順');
  const hype = r.snap.spot.find(x => x.n === 'HYPE');
  assert.deepEqual([hype.px, hype.circ, hype.total], [75, 3e8, 1e9]);
  assert.deepEqual(r.fixed, ['BTC', 'ETH', 'SOL', 'HYPE']);
});

test('記録: 1時間ごとに [建玉・ファンディング・価格・出来高・プレミアム・Binance・Bybit] を残し、⭐ の銘柄も記録する', () => {
  const { gas, clock } = world();
  gas.ctx.pmRecord();
  const f = n => JSON.parse(gas.drive.folderFiles('ポリマーケット記録').find(x => x.name === n).content);
  const e = f('hl-2026-11.json')['2026-11-09T10:00'];
  assert.deepEqual(e.BTC, [15000 * 74000, 0.0000125, 74000, 1.2e9, 0.0001, 0.0001, 0.0001]);
  assert.ok(e.TINY, '上位6銘柄に入るので記録');
  const sp = f('hl-spot-2026-11.json')['2026-11-09'];
  assert.deepEqual(sp.HYPE, [75, 3e8, 1e9, 5.5e7]);
  // ⭐ で記録する銘柄を指定
  assert.equal(gas.post({ action: 'pmHlWatch', coins: ['FARTCOIN', 'bad coin!'] }).watch.join(), 'FARTCOIN');
  assert.equal(gas.get({ action: 'hl' }).watch.join(), 'FARTCOIN');
  clock.tick(3600000); gas.ctx.pmRecord();
  const s = gas.get({ action: 'hl' }).series;
  assert.equal(s.BTC.length, 2);
  assert.deepEqual(s.BTC[0], ['2026-11-09T10:00', 15000 * 74000, 0.0000125, 74000, 1.2e9, 0.0001, 0.0001, 0.0001]);
  // レポートに Binance との差
  const t = gas.get({ action: 'report', days: '7', parts: 'hl' }).text;
  assert.match(t, /\| 2026-11-09 \| \$74,000 \| 11\.1億ドル \| - \| 0\.0100% \| 0\.0100% \| 0\.0000% \|/);
});

test('アプリ: Hyperliquid タブに 合計・ファンディングの差・先物の一覧・記録のグラフ・現物を出し、⭐ で記録を増やせる', async () => {
  const { gas, clock, st } = world();
  for (let i = 0; i < 26; i++) { if (i === 25) st.btcOi = 18000; gas.ctx.pmRecord(); clock.tick(3600000); }
  const app = await openApp({ clock, gas, fetch: async () => { throw new TypeError('offline'); }, state: { projects: [], settings: { gasUrl: GAS_URL, gasAuto: false }, deleted: {} } });
  try {
    app.doc.querySelector('nav button[data-tab="hl"]').click();
    for (let i = 0; i < 6; i++) await app.settle();
    const sum = app.text('#hlSum').replace(/\s+/g, ' ');
    assert.match(sum, /BTC のファンディング/);
    assert.match(sum, /\+0\.0100% ?8時間あたり ／ Binance \+0\.0100% ／ Bybit \+0\.0100%/);
    assert.match(sum, /24時間 \+20\.0%/, '記録から BTC の建玉の24時間変化');
    // 差の表: DOGE (HL 0.16% − 他 0.01%) が先頭、TINY は建玉が小さいので出さない
    const arb = [...app.doc.querySelectorAll('#hlArb tbody tr')].map(r => r.dataset.coin);
    assert.equal(arb[0], 'DOGE');
    assert.ok(!arb.includes('TINY'));
    assert.match(app.text('#hlArb'), /\+0\.1500%/);
    // 一覧と並べ替え
    let rows = [...app.doc.querySelectorAll('#hlPerps tbody tr')].map(r => r.dataset.coin);
    assert.equal(rows[0], 'BTC');
    const sel = app.doc.querySelector('#hlSort'); sel.value = 'f'; sel.dispatchEvent(new app.win.Event('change'));
    rows = [...app.doc.querySelectorAll('#hlPerps tbody tr')].map(r => r.dataset.coin);
    assert.equal(rows[0], 'TINY');
    // 記録のグラフ
    assert.equal(app.doc.querySelectorAll('#hlChartBox .hl-chart svg').length, 4);
    app.doc.querySelector('#hlChartBox [data-hlsel="ETH"]').click();
    assert.ok(app.doc.querySelector('#hlChartBox [data-hlsel="ETH"]').classList.contains('active'));
    // 現物: FDV と流通率
    assert.match(app.text('#hlSpot').replace(/\s+/g, ''), /HYPE\$75\.00-2\.6%.*225億ドル750億ドル30%/);
    // ⭐ で記録の対象に
    const sel2 = app.doc.querySelector('#hlSort'); sel2.value = 'oi'; sel2.dispatchEvent(new app.win.Event('change'));
    app.doc.querySelector('#hlPerps [data-hlstar="DOGE"]').click();
    for (let i = 0; i < 3; i++) await app.settle();
    assert.equal(gas.props.getProperty('HL_WATCH'), '["DOGE"]');
    assert.equal(app.doc.querySelector('#hlPerps [data-hlstar="DOGE"]').textContent, '★');
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});
