'use strict';
/* Deribit の公開APIの偽物 (オプションの一覧と DVOL) */
const DAY = 86400000;
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const instName = (cur, exp, k, cp) => { const [y, m, d] = exp.split('-').map(Number); return `${cur}-${d}${MON[m - 1]}${String(y).slice(2)}-${k}-${cp}`; };

/** 既定の世界: BTC 100,000ドル・ETH 2,300ドル。12/25 満期の建玉が最大。下のプットの IV が高い (下落を警戒) */
function defaultBook() {
  return {
    BTC: { px: 100000, exps: {
      '2026-11-20': { fwd: 100100, rows: [[90000, 50, 300, 52, 60], [100000, 400, 350, 45, 45], [110000, 500, 20, 47, 50]] },
      '2026-12-25': { fwd: 100800, rows: [[80000, 100, 2000, 55, 62], [90000, 300, 3000, 50, 56], [100000, 2500, 2500, 46, 46], [110000, 4000, 300, 47, 48], [120000, 5000, 100, 50, 52], [200000, 900, 0, 70, 0]] },
      '2027-03-26': { fwd: 102500, rows: [[90000, 200, 800, 52, 55], [100000, 900, 700, 49, 49], [110000, 1000, 100, 49, 50]] },
      '2026-11-01': { fwd: 99000, rows: [[100000, 9999, 9999, 40, 40]] },   // 満期を過ぎたもの (数えない)
    } },
    ETH: { px: 2300, exps: {
      '2026-12-25': { fwd: 2320, rows: [[2000, 1000, 9000, 62, 70], [2300, 8000, 8000, 58, 58], [2600, 12000, 500, 60, 61]] },
    } },
  };
}

/** [コール建玉, プット建玉, コールIV, プットIV] の表から API の応答 (get_book_summary_by_currency) を作る */
function bookRows(cur, book) {
  const out = [];
  for (const [exp, e] of Object.entries(book.exps)) {
    for (const [k, c, p, civ, piv] of e.rows) {
      const base = { estimated_delivery_price: book.px, underlying_price: e.fwd, base_currency: cur, volume_usd: 0 };
      out.push(Object.assign({ instrument_name: instName(cur, exp, k, 'C'), open_interest: c, volume: c / 10, mark_iv: civ }, base));
      out.push(Object.assign({ instrument_name: instName(cur, exp, k, 'P'), open_interest: p, volume: p / 20, mark_iv: piv }, base));
    }
  }
  out.push({ instrument_name: cur + '-PERPETUAL', open_interest: 1, volume: 1, mark_iv: 0, estimated_delivery_price: book.px });   // オプションでない名前は無視される
  return out;
}

/**
 * world = { book, dvol: { BTC: n => 値, ETH: ... }, down: false }
 * 戻り値: Deribit 宛ての URL なら応答、それ以外は null
 */
function deribitFetch(clock, world) {
  world = world || {};
  world.book = world.book || defaultBook();
  world.dvol = world.dvol || { BTC: i => 40 + (i % 5), ETH: i => 60 + (i % 7) };   // i = 何本前か (0 が最新)
  const ok = o => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify({ jsonrpc: '2.0', result: o }) });
  const fetch = url => {
    if (!/^https:\/\/www\.deribit\.com\/api\/v2\/public\//.test(url)) return null;
    if (world.down) throw new Error('Deribit 503');
    const u = new URL(url), cur = u.searchParams.get('currency');
    if (u.pathname.endsWith('/get_book_summary_by_currency')) return ok(bookRows(cur, world.book[cur]));
    if (u.pathname.endsWith('/get_volatility_index_data')) {
      const end = Number(u.searchParams.get('end_timestamp')), start = Number(u.searchParams.get('start_timestamp')), step = DAY / 2;
      const last = Math.floor(end / step) * step, data = [];
      for (let t = last, i = 0; t >= start; t -= step, i++) { const v = world.dvol[cur](i); data.unshift([t, v, v + 1, v - 1, v]); }
      return ok({ data, continuation: null });
    }
    throw new Error('想定外の Deribit の URL: ' + url);
  };
  fetch.world = world;
  return fetch;
}

module.exports = { deribitFetch, defaultBook, bookRows, instName };
