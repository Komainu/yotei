'use strict';
/* 財務省 Fiscal Data と NY連銀 Markets API の偽物 (2026-11 に確かめた本物の形をまねている)
   ・TGA: dts/operating_cash_balance の「Treasury General Account (TGA) Closing Balance」行。値は open_today_bal (100万ドル単位の文字列)、close_today_bal は "null"
   ・国債入札: od/auctions_query (空の欄は "null" の文字列。金額はドル) と od/upcoming_auctions
   ・NY連銀: rp/results/search.json (totalAmtAccepted はドル)、rates/.../last/N.json (volumeInBillions は10億ドル) */
const DAY = 86400000;
const ymd = t => new Date(t).toISOString().slice(0, 10);

/** 平日 (土日を除く) の一覧。祝日は気にしない */
function bizDays(from, to) {
  const out = [];
  for (let t = Date.parse(from + 'T00:00:00Z'); t <= Date.parse(to + 'T00:00:00Z'); t += DAY) { const w = new Date(t).getUTCDay(); if (w && w < 6) out.push(ymd(t)); }
  return out;
}

/** 入札1件 (auctions_query の行の形)。結果が無いもの (btc: null) は、発表済みでまだの入札 */
function auc(o) {
  const n = v => (v == null ? 'null' : String(v));
  const held = o.btc != null;
  return {
    record_date: o.issue || o.d, cusip: o.cusip || ('C' + o.d.replace(/-/g, '') + (o.term || '').replace(/\W/g, '')), security_type: o.type, security_term: o.sterm || o.term,
    original_security_term: o.term, auction_date: o.d, issue_date: o.issue || o.d, offering_amt: n(o.amt == null ? null : o.amt * 1e9),
    bid_to_cover_ratio: held ? Number(o.btc).toFixed(6) : 'null', high_yield: held && o.type !== 'Bill' ? n(o.rate) : 'null',
    high_investment_rate: held && o.type === 'Bill' ? n(o.rate) : 'null', high_discnt_rate: held && o.type === 'Bill' ? n(o.rate - 0.1) : 'null', high_discnt_margin: 'null',
    indirect_bidder_accepted: held ? n(o.ind == null ? null : o.ind * 1e9) : 'null', comp_accepted: held ? n(o.comp == null ? null : o.comp * 1e9) : 'null',
    total_accepted: held ? n((o.comp || 0) * 1e9 + 1e9) : 'null', inflation_index_security: o.tips ? 'Yes' : 'No', floating_rate: o.frn ? 'Yes' : 'No',
    cash_management_bill_cmb: o.cmb ? 'Yes' : 'No', reopening: 'No',
  };
}
/** 既定の入札: 10年債は今回が過去6回より低い (不調)、30年債は過去3回より高い (好調)、2年債は前が1回だけ (判定しない) */
function defaultAuctions() {
  const ten = [['2026-05-13', 2.5], ['2026-06-10', 2.6], ['2026-07-09', 2.4], ['2026-08-12', 2.55], ['2026-09-10', 2.5], ['2026-10-08', 2.45], ['2026-11-12', 2.3]];
  return [
    ...ten.map(([d, btc], i) => auc({ type: 'Note', term: '10-Year', d, btc, rate: 4.1 + i / 100, amt: 42, ind: i === 6 ? 30 : 28, comp: 40 })),
    auc({ type: 'Note', term: '10-Year', d: '2026-02-11', btc: 2.9, rate: 4, amt: 42, ind: 28, comp: 40 }),   // 7回より前 (平均に入らない)
    ...[['2026-08-13', 2.3], ['2026-09-11', 2.4], ['2026-10-09', 2.35], ['2026-11-13', 2.6]].map(([d, btc]) => auc({ type: 'Bond', term: '30-Year', sterm: d === '2026-11-13' ? '29-Year 9-Month' : '30-Year', d, btc, rate: 4.7, amt: 25, ind: 16, comp: 24 })),
    auc({ type: 'Note', term: '2-Year', d: '2026-09-24', btc: 2.6, rate: 3.6, amt: 69, ind: 40, comp: 60 }),
    auc({ type: 'Note', term: '2-Year', d: '2026-10-28', btc: 2.7, rate: 3.55, amt: 69, ind: 42, comp: 60 }),
    auc({ type: 'Note', term: '10-Year', tips: true, d: '2026-10-23', btc: 2.4, rate: 1.9, amt: 19, ind: 14, comp: 18 }),
    ...['2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09'].map((d, i) => auc({ type: 'Bill', term: '13-Week', d, btc: 2.8 + i / 10, rate: 3.8, amt: 86, ind: 50, comp: 80 })),
    auc({ type: 'Bill', term: '4-Week', d: '2026-11-10', btc: 2.9, rate: 3.9, amt: 90, ind: 40, comp: 85 }),          // 見ない短期国債
    auc({ type: 'Bill', term: '13-Week', cmb: true, d: '2026-11-11', btc: 3.5, rate: 3.9, amt: 30, ind: 10, comp: 29 }), // 臨時 (CMB)
    auc({ type: 'Note', term: '5-Year', d: '2026-10-22', btc: null, amt: 26 }),                                      // 過去なのに結果が空 (本物でも遅れてこうなる) → 出さない
    auc({ type: 'Bond', term: '20-Year', d: '2026-11-18', btc: null, amt: 13 }),                                     // これから
  ];
}
function defaultUpcoming() {
  const u = (type, term, d, amt) => ({ record_date: '2026-11-12', security_type: type, security_term: term, reopening: 'No', cusip: 'U' + d + term, offering_amt: amt == null ? 'null' : String(amt * 1e9), announcemt_date: '2026-11-12', auction_date: d, issue_date: d });
  return [u('Bill', '52-Week', '2026-11-17', null), u('Bond', '20-Year', '2026-11-18', 13), u('Note', '7-Year', '2026-11-30', 44), u('Bill', '6-Week', '2026-11-17', 80)];
}

/**
 * world = {
 *   days: 平日の一覧 (既定 2026-06-01〜2026-11-13), tga: (日付, i, n) => 10億ドル, rrp: (日付, i, n) => 10億ドル (null でその日の行なし),
 *   srf: { 日付: [1回目, 2回目] (10億ドル) }, sofr: (i) => [金利, p1, p99, 取引額], effr: i => 金利 (i は新しい方から何本目),
 *   auctions: [...], upcoming: [...], down: { tga, rrp, srf, sofr, effr, auctions, upcoming, all }
 * }
 * 戻り値: 財務省・NY連銀宛ての URL なら応答、それ以外は null
 */
function usFetch(clock, world) {
  world = world || {};
  world.days = world.days || bizDays('2026-06-01', '2026-11-13');
  // TGA: 最後の5営業日で 900 → 950 (10ずつ増える)
  world.tga = world.tga || ((d, i, n) => (i >= n - 5 ? 900 + (i - (n - 6)) * 10 : 900));
  // ON RRP: ふだん 1.5、最後の日 0.3。最後から3日目は行が無い (前の値を引き継ぐ)
  world.rrp = world.rrp || ((d, i, n) => (i === n - 1 ? 0.3 : i === n - 3 ? null : 1.5));
  world.srf = world.srf || {};
  world.sofr = world.sofr || (() => [3.9, 3.84, 3.98, 3100]);
  world.effr = world.effr || (() => 3.88);
  world.auctions = world.auctions || defaultAuctions();
  world.upcoming = world.upcoming || defaultUpcoming();
  world.down = world.down || {};
  const ok = o => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify(o) });
  const filters = u => Object.fromEntries((u.searchParams.get('filter') || '').split(',').filter(Boolean).map(f => { const m = f.match(/^(\w+):(\w+):(.*)$/); return [m[1] + ':' + m[2], m[3]]; }));
  const isDown = k => world.down.all || world.down[k];
  const fetch = url => {
    const fd = /^https:\/\/api\.fiscaldata\.treasury\.gov\/services\/api\/fiscal_service\//.test(url), ny = /^https:\/\/markets\.newyorkfed\.org\/api\//.test(url);
    if (!fd && !ny) return null;
    const u = new URL(url), f = filters(u), n = world.days.length;
    if (u.pathname.endsWith('/v1/accounting/dts/operating_cash_balance')) {
      if (isDown('tga')) throw new Error('Fiscal Data 503');
      if (f['account_type:eq'] !== 'Treasury General Account (TGA) Closing Balance') throw new Error('TGA の行に絞っていない: ' + url);
      const rows = world.days.map((d, i) => [d, world.tga(d, i, n)]).filter(r => r[1] != null && (!f['record_date:gte'] || r[0] >= f['record_date:gte']))
        .map(([d, v]) => ({ record_date: d, account_type: 'Treasury General Account (TGA) Closing Balance', close_today_bal: 'null', open_today_bal: String(Math.round(v * 1000)), open_month_bal: '0', table_nbr: 'I' }));
      return ok({ data: rows, meta: { count: rows.length } });
    }
    if (u.pathname.endsWith('/v1/accounting/od/auctions_query')) {
      if (isDown('auctions')) throw new Error('Fiscal Data 500');
      const rows = world.auctions.filter(r => !f['auction_date:gte'] || r.auction_date >= f['auction_date:gte']).sort((a, b) => (a.auction_date < b.auction_date ? 1 : -1));
      return ok({ data: rows, meta: { count: rows.length } });
    }
    if (u.pathname.endsWith('/v1/accounting/od/upcoming_auctions')) {
      if (isDown('upcoming')) throw new Error('Fiscal Data 500');
      const rows = world.upcoming.filter(r => !f['auction_date:gte'] || r.auction_date >= f['auction_date:gte']);
      return ok({ data: rows, meta: { count: rows.length } });
    }
    if (u.pathname === '/api/rp/results/search.json') {
      const from = u.searchParams.get('startDate'), to = u.searchParams.get('endDate');
      const want = u.searchParams.get('operationTypes');
      if (isDown(want === 'Reverse Repo' ? 'rrp' : 'srf')) throw new Error('NY Fed 503');
      // 本物と同じく、種類の絞り込みに関係なく両方を返す (新しい順)
      const ops = [];
      world.days.forEach((d, i) => {
        if (d < from || d > to) return;
        const s = world.srf[d] || [0, 0], r = world.rrp(d, i, n);
        ops.push({ operationId: 'RP ' + d + ' 25', auctionStatus: 'Results', operationDate: d, operationType: 'Repo', operationMethod: 'Full Allotment', term: 'Overnight', totalAmtSubmitted: s[0] * 1e9, totalAmtAccepted: s[0] * 1e9 });
        if (r != null) ops.push({ operationId: 'RP ' + d + ' 26', auctionStatus: 'Results', operationDate: d, operationType: 'Reverse Repo', operationMethod: 'Fixed Rate', term: 'Overnight', totalAmtSubmitted: r * 1e9, totalAmtAccepted: r * 1e9 });
        ops.push({ operationId: 'RP ' + d + ' 27', auctionStatus: 'Results', operationDate: d, operationType: 'Repo', operationMethod: 'Full Allotment', term: 'Overnight', totalAmtSubmitted: s[1] * 1e9, totalAmtAccepted: s[1] * 1e9 });
      });
      return ok({ repo: { operations: ops.reverse() } });
    }
    const m = u.pathname.match(/^\/api\/rates\/(secured\/sofr|unsecured\/effr)\/last\/(\d+)\.json$/);
    if (m) {
      const sofr = m[1] === 'secured/sofr';
      if (isDown(sofr ? 'sofr' : 'effr')) throw new Error('NY Fed 503');
      const ds = world.days.slice(-Number(m[2])).reverse();   // 新しい順
      return ok({ refRates: ds.map((d, i) => {
        if (sofr) { const [r, p1, p99, vol] = world.sofr(i); return { effectiveDate: d, type: 'SOFR', percentRate: r, percentPercentile1: p1, percentPercentile25: r - 0.03, percentPercentile75: r + 0.05, percentPercentile99: p99, volumeInBillions: vol, revisionIndicator: '' }; }
        const r = world.effr(i); return { effectiveDate: d, type: 'EFFR', percentRate: r, percentPercentile1: r - 0.03, percentPercentile25: r - 0.01, percentPercentile75: r + 0.01, percentPercentile99: r + 0.07, targetRateFrom: 3.75, targetRateTo: 4, volumeInBillions: 110, revisionIndicator: '' };
      }) });
    }
    throw new Error('想定外の URL: ' + url);
  };
  fetch.world = world;
  return fetch;
}

/** FRED の WALCL (週ごと・水曜・100万ドル単位) の CSV。既定は 6,600,000、最後の週 (11/11) だけ 6,580,000 */
function walclCsv(weeks) {
  weeks = weeks || (() => { const out = []; for (let t = Date.parse('2025-07-02T00:00:00Z'); t <= Date.parse('2026-11-11T00:00:00Z'); t += 7 * DAY) out.push([ymd(t), ymd(t) === '2026-11-11' ? 6580000 : 6600000]); return out; })();
  return 'observation_date,WALCL\n' + weeks.map(([d, v]) => d + ',' + v).join('\n') + '\n';
}

module.exports = { usFetch, bizDays, auc, defaultAuctions, defaultUpcoming, walclCsv };
