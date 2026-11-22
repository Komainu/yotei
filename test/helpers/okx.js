'use strict';
/* OKX の公開 API (キー不要) の偽物 (2026-11 に確かめた本物の形をまねている)
   ・/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=BTC&period=1H … { code:'0', data: [["ts(ms)", "比率"], …] } 新しい順
   ・/api/v5/public/liquidation-orders?instType=SWAP&uly=BTC-USDT&state=filled&limit=100 … { code:'0', data: [{ details: [{ bkLoss, bkPx, ccy, posSide, side, sz (枚数), time, ts }], instFamily, uly, … }] }
     posSide=long・side=sell が買いの清算。本物は最後の清算が何週間も前のこともあった (古いデータ)
   ・/api/v5/rubik/stat/taker-volume-contract?instId=BTC-USDT-SWAP&period=1H&unit=2&limit=24 … { code:'0', data: [["ts", "売り (ドル)", "買い (ドル)"], …] }
   ・1枚の大きさ (instruments の ctVal): BTC 0.01・ETH 0.1・SOL 1・HYPE 0.1
   world = { down: { 'BTC:ls': true|番号, 'ETH:liq': …, 'SOL:taker': … }, all: 番号 (全部。403 = 米国の IP など), ls: { BTC: [いま, 24時間前] }, liq: { BTC: details[] }, taker: { BTC: [売り, 買い] (1時間あたり) } }
   fetch.calls = [{ coin, part, url, headers, t }] */
const H = 3600000, DAY = 24 * H;
const ok = d => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify({ code: '0', msg: '', data: d }) });
const fail = code => ({ getResponseCode: () => code, getContentText: () => (code === 403 ? '{"msg":"Access restricted","code":"51155"}' : 'error') });

const LS = { BTC: [2.6, 1.5], ETH: [1.8, 1.5], SOL: [1, 1.1], HYPE: [0.55, 0.7] };
const TAKER = { BTC: [50e6, 60e6], ETH: [20e6, 18e6], SOL: [5e6, 5e6], HYPE: [1e6, 1e6] };
/** 既定の清算:
 *  BTC: 100件 (3分おき) で約5時間分。買いの清算 90件 (1件 1,500枚 × 0.01 × 80,000ドル = 120万ドル、5件目だけ 5,000枚 = 400万ドル)・売りの清算 10件 (250枚 = 20万ドル、最後の1件は片側モード side=buy)
 *  ETH: 26日前の30件だけ (古い)。SOL: なし。HYPE: 売りの清算3件 (1万枚 × 0.1 × 40ドル = 4万ドル) */
function defaultLiq(now) {
  const d = (t, posSide, side, sz, px) => ({ bkLoss: '0', bkPx: String(px), ccy: '', posSide, side, sz: String(sz), time: t, ts: String(t) });
  const btc = [];
  for (let i = 0; i < 100; i++) {
    const t = now - 60000 - i * 3 * 60000;
    if (i < 90) btc.push(d(t, 'long', 'sell', i === 5 ? 5000 : 1500, 80000));
    else btc.push(i === 99 ? d(t, '', 'buy', 250, 80000) : d(t, 'short', 'buy', 250, 80000));
  }
  const eth = [];
  for (let i = 0; i < 30; i++) eth.push(d(now - 26 * DAY - i * 60000, 'long', 'sell', 10, 3000));
  const hype = [0, 1, 2].map(i => d(now - (2 + i) * H, 'short', 'buy', 10000, 40));
  return { BTC: btc, ETH: eth, SOL: [], HYPE: hype };
}
function okxFetch(clock, world) {
  world = world || {};
  world.down = world.down || {};
  const calls = [];
  const fetch = (url, params) => {
    if (!/^https:\/\/www\.okx\.com\//.test(url)) return null;
    const u = new URL(url);
    let coin, part;
    if (u.pathname === '/api/v5/rubik/stat/contracts/long-short-account-ratio') { coin = u.searchParams.get('ccy'); part = 'ls'; }
    else if (u.pathname === '/api/v5/public/liquidation-orders') {
      if (u.searchParams.get('instType') !== 'SWAP' || u.searchParams.get('state') !== 'filled') throw new Error('清算の指定が違う: ' + url);
      coin = (u.searchParams.get('uly') || '').replace(/-USDT$/, ''); part = 'liq';
    }
    else if (u.pathname === '/api/v5/rubik/stat/taker-volume-contract') {
      if (u.searchParams.get('unit') !== '2') throw new Error('ドル (unit=2) で取っていない: ' + url);
      coin = (u.searchParams.get('instId') || '').replace(/-USDT-SWAP$/, ''); part = 'taker';
    }
    else throw new Error('想定外の OKX の URL: ' + url);
    calls.push({ coin, part, url, headers: (params && params.headers) || {}, t: clock.now });
    if (world.all) return fail(world.all);
    const dn = world.down[coin + ':' + part] || world.down[coin];
    if (dn) return fail(dn === true ? 503 : dn);
    const now = clock.now;
    if (part === 'ls') {
      const v = (world.ls || LS)[coin] || [1, 1], top = Math.floor(now / H) * H, rows = [];
      for (let i = 0; i < 48; i++) rows.push([String(top - i * H), String(i < 24 ? v[0] : v[1])]);
      return ok(rows);
    }
    if (part === 'liq') {
      const det = ((world.liq || defaultLiq(now))[coin]) || [];
      return ok(det.length ? [{ details: det, instFamily: coin + '-USDT', instId: coin + '-USDT-SWAP', instType: 'SWAP', totalLoss: '0', uly: coin + '-USDT' }] : []);
    }
    const v = (world.taker || TAKER)[coin] || [1, 1], top = Math.floor(now / H) * H, n = Number(u.searchParams.get('limit')) || 100, rows = [];
    for (let i = 0; i < n; i++) rows.push([String(top - i * H), String(v[0]), String(v[1])]);
    return ok(rows);
  };
  fetch.world = world;
  fetch.calls = calls;
  return fetch;
}

module.exports = { okxFetch, defaultLiq, LS, TAKER };
