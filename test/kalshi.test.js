'use strict';
/* Kalshi と Polymarket の比較 (FOMC) と、Hyperliquid の建玉・ファンディングの記録 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('./helpers/gas');
const { openApp, GAS_URL } = require('./helpers/app');
const { createClock } = require('./helpers/clock');

const km = (cs, bid, ask, last, v) => ({ custom_strike: cs, yes_bid_dollars: String(bid), yes_ask_dollars: String(ask), last_price_dollars: String(last), volume_24h_fp: String(v || 1000) });
function world(opts) {
  opts = opts || {};
  const st = { oi: 1e9, fund: '0.0000125', hold: [0.21, 0.23], pmHold: 0.62 };
  const ok = obj => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify(obj) });
  const fetch = (url, params) => {
    if (/api\.elections\.kalshi\.com/.test(url)) {
      return ok({ events: [{ event_ticker: 'KXFEDDECISION-26DEC', title: 'Fed decision in Dec 2026?', strike_date: '2026-12-09T19:00:00Z', markets: [
        km({ Hike: '0' }, st.hold[0], st.hold[1], 0.22), km({ Hike: '25' }, 0.75, 0.77, 0.76), km({ Hike: '>25' }, 0.01, 0.02, 0.02), km({ Cut: '25' }, 0, 0.02, 0.02), km({ Cut: '>25' }, 0, 0.01, 0.01)] }] });
    }
    if (/gamma-api\.polymarket\.com\/public-search/.test(url)) {
      const q = new URL(url).searchParams.get('q');
      return ok({ events: /Fed decision in December/.test(q) ? [{ id: 'f', title: 'Fed Decision in December?', slug: 'fed-decision-in-december', endDate: '2026-12-10T00:00:00Z', volume: '9000000', markets: [
        { groupItemTitle: 'No change', outcomePrices: JSON.stringify([String(st.pmHold), String(1 - st.pmHold)]), bestBid: st.pmHold - 0.01, bestAsk: st.pmHold + 0.01 },
        { groupItemTitle: '25 bps decrease', outcomePrices: '["0.02","0.98"]' }, { groupItemTitle: '50+ bps decrease', outcomePrices: '["0.01","0.99"]' },
        { groupItemTitle: '25+ bps increase', outcomePrices: '["0.35","0.65"]', bestBid: 0.34, bestAsk: 0.36 }] }] : [] });
    }
    if (/gamma-api\.polymarket\.com\/markets/.test(url)) return ok([]);
    if (/api\.hyperliquid\.xyz/.test(url)) {
      const b = JSON.parse(params.payload);
      if (b.type === 'metaAndAssetCtxs') return ok([{ universe: ['BTC', 'ETH', 'SOL', 'HYPE', 'DOGE', 'OLD'].map(name => ({ name, isDelisted: name === 'OLD' })) },
        ['BTC', 'ETH', 'SOL', 'HYPE', 'DOGE', 'OLD'].map((n, i) => ({ markPx: String(n === 'BTC' ? 74000 : 10 + i), prevDayPx: '1', funding: n === 'HYPE' ? '-0.00005' : st.fund, openInterest: String((n === 'BTC' ? st.oi : 1e6) / (n === 'BTC' ? 74000 : 10 + i)) }))]);
      return ok([]);
    }
    throw new Error('使わない: ' + url);
  };
  const clock = createClock('2026-11-09T10:00:00+09:00');
  const gas = loadGas({ clock, fetch, props: Object.assign({ MAIL_TO: 'muse@example.com' }, opts.props) });
  return { clock, gas, st };
}

test('Kalshi 比較: 選択肢を4つの箱 (据え置き・0.25%利下げ・0.5%以上の利下げ・利上げ) にそろえ、差とずれを出す', () => {
  const { gas } = world();
  const r = gas.get({ action: 'compare' });
  assert.equal(r.ok, true);
  const m = r.list[0];
  assert.equal(m.d, '2026-12-09');
  assert.match(m.pm.url, /fed-decision-in-december/);
  const by = Object.fromEntries(m.rows.map(x => [x.b, x]));
  assert.equal(by.hold.k.p, 0.22, 'Kalshi は買値と売値の真ん中');
  assert.equal(by.hold.pm.p, 0.62);
  assert.equal(by.hold.diff, 0.4);
  assert.equal(by.hold.gap, 0.38, '買値・売値の幅を考えたずれ: 0.61 − 0.23');
  assert.equal(by.hike.k.p, 0.775, 'Kalshi の利上げ25bp と 25bp超 を合計');
  assert.equal(by.hike.pm.p, 0.35);
  assert.equal(by.cut25.pm.p, 0.02);
  assert.equal(by.cut50.k.p, 0.01, '買値が0の時は最後の取引値');
});

test('Kalshi 比較: 1時間ごとに記録し、大きなずれはメールで知らせる (12時間に1回)', () => {
  const { gas, clock, st } = world();
  gas.ctx.pmRecord();
  const log = JSON.parse(gas.drive.folderFiles('ポリマーケット記録').find(f => f.name === 'fed-compare.json').content);
  assert.equal(log.rows.length, 1);
  assert.deepEqual(log.rows[0].b.hold, [0.62, 0.22]);
  const mail = gas.mails.find(x => /Kalshi とのずれ/.test(x.subject));
  assert.ok(mail, 'ずれの通知');
  assert.match(mail.body, /2026-12-09 の FOMC ― 据え置き: Polymarket 62% .* Kalshi 22% .* ずれ 38pt/);
  // 1時間後: まだ送らない。ずれが小さければ送らない
  const n = gas.mails.length;
  clock.tick(3600000); gas.ctx.pmRecord();
  assert.equal(gas.mails.filter(x => /Kalshi/.test(x.subject)).length, 1);
  st.pmHold = 0.22; clock.tick(13 * 3600000); gas.ctx.pmRecord();
  assert.ok(!gas.mails.slice(n).some(x => /Kalshi とのずれ.*据え置き/.test(x.subject)), '差が小さければ送らない');
});

test('Hyperliquid: 建玉・ファンディングを1時間ごとに記録し、24時間で建玉が20%以上動いたら知らせる', () => {
  const { gas, clock, st } = world();
  gas.ctx.pmRecord();
  const f = JSON.parse(gas.drive.folderFiles('ポリマーケット記録').find(x => x.name === 'hl-2026-11.json').content);
  const e = f['2026-11-09T10:00'];
  assert.deepEqual(Object.keys(e).sort(), ['BTC', 'DOGE', 'ETH', 'HYPE', 'SOL'], '上場廃止は除く');
  assert.equal(Math.round(e.BTC[0]), 1e9);
  // 24時間後に建玉 +30%
  clock.tick(24 * 3600000); st.oi = 1.3e9;
  gas.ctx.pmRecord();
  assert.ok(gas.mails.some(x => /HYPE のファンディングレート -0\.040% \/ 8時間 — 売りが優勢/.test(x.body)), 'マイナスに大きい時も知らせる');
  const m = gas.mails.find(x => /暗号資産の先物/.test(x.subject) && /BTC の建玉/.test(x.body));
  assert.ok(m);
  assert.match(m.body, /BTC の建玉が24時間で \+30% \(10億ドル → 13億ドル\)/);
  assert.match(m.body, /レバレッジが急に積み上がっています/);
  // ファンディングの極端 (8時間 +0.08%)
  st.fund = '0.0001'; clock.tick(13 * 3600000); gas.ctx.pmRecord();
  assert.ok(gas.mails.some(x => /ファンディングレート 0\.080% \/ 8時間 — 買いが過熱/.test(x.body)));
  // アプリ用の推移
  const mac = gas.get({ action: 'macro' }).macro;
  assert.ok(mac.hl.BTC.length >= 2);
});

test('レポート: Kalshi とのずれ・先物の建玉とファンディングの表が入る', () => {
  const { gas, clock, st } = world();
  gas.ctx.pmRecord(); clock.tick(24 * 3600000); st.oi = 1.2e9; gas.ctx.pmRecord();
  const t = gas.get({ action: 'report', days: '7', parts: 'kalshi,hl' }).text;
  assert.match(t, /## 5\. Polymarket と Kalshi の FOMC 予想のずれ/);
  assert.match(t, /\| 2026-11-10 \| 2026-12-09 \| 据え置き \| 62% \| 22% \| 40pt \|/);
  assert.match(t, /## 6\. 暗号資産の先物/);
  assert.match(t, /### BTC\n[\s\S]*\| 2026-11-10 \| \$74,000 \| 12億ドル \| 20\.0% \|/);
});

test('アプリ: Polymarket タブの「⚖️ Kalshi 比較」で、ずれを赤・黄で色分けして大きい順に並べる。FOMC のカードと詳細にも出す', async () => {
  const { gas, clock, st } = world();
  for (let i = 0; i < 26; i++) { if (i === 25) st.oi = 1.25e9; gas.ctx.pmRecord(); clock.tick(3600000); }
  // Polymarket の一覧 (アプリが直接取る) に FOMC のイベントを入れる
  const mk = (id, g, p) => ({ id, question: 'Fed ' + g, groupItemTitle: g, outcomes: '["Yes","No"]', outcomePrices: JSON.stringify([String(p), String(1 - p)]), negRisk: true,
    volume24hr: 100000, volumeNum: 1e6, liquidityNum: 1e4, endDate: '2026-12-10T00:00:00Z', clobTokenIds: '["t' + id + '"]', closed: false, events: [{ id: 'fedev', title: 'Fed Decision in December?', slug: 'fed-decision-in-december' }] });
  const fetch = async url => {
    const u = new URL(url);
    const reply = o => ({ ok: true, status: 200, json: async () => o });
    if (u.pathname === '/markets' && !u.searchParams.get('id')) return reply(Number(u.searchParams.get('offset')) === 0 ? [mk('a', 'No change', 0.62), mk('b', '25+ bps increase', 0.35)] : []);
    if (u.pathname.startsWith('/events/') || u.pathname === '/public-search') return reply({ events: [] });
    if (u.host === 'clob.polymarket.com') return reply({ history: [] });
    throw new TypeError('offline');
  };
  const app = await openApp({ clock, gas, fetch, state: { projects: [], settings: { gasUrl: GAS_URL, gasAuto: false }, deleted: {} } });
  try {
    for (let i = 0; i < 8; i++) await app.settle();
    // 分野ボタンに件数 (赤が2つ)
    const chip = app.doc.querySelector('#pmCats [data-cat="kalshi"]');
    assert.match(chip.textContent, /⚖️ Kalshi 比較 🔴2/);
    // カードの印
    const card = app.doc.querySelector('.pm-card[data-ev="fedev"]');
    assert.match(card.querySelector('.cmp-badge').textContent.replace(/\s+/g, ' '), /⚖️ Kalshi: (据え置き 22%|利上げ 78%) \(差 [+-]4\dpt\) ⚠ 大きくずれています/);
    assert.ok(card.querySelector('.cmp-badge').classList.contains('cmp-bg-r'));
    // 比較の画面: ずれの大きい順・色分け・どちらが高いか
    chip.click();
    const rows = [...app.doc.querySelectorAll('#pmList .cmp-row')];
    assert.equal(rows.length, 4);
    assert.match(rows[0].textContent.replace(/\s+/g, ''), /利上げ.*35%.*78%.*-42pt.*Kalshiが高い↓.*幅を考えたずれ40pt/);
    assert.ok(rows[0].classList.contains('cmp-bg-r'));
    assert.match(rows[1].textContent.replace(/\s+/g, ''), /据え置き.*62%.*22%.*\+40pt.*Polymarketが高い↑/);
    assert.ok(rows.slice(2).every(r => r.classList.contains('cmp-bg-n')), '差が小さいものは色なし');
    // 会合ごと
    app.doc.querySelector('#pmList [data-cmpsort="meet"]').click();
    assert.match(app.text('#pmList'), /FOMC \(米国時間 2026-12-09\)/);
    assert.equal(app.doc.querySelector('#pmMovers').innerHTML, '', '急変の帯は出さない');
    // 詳細シートにも比較
    app.doc.querySelector('#pmCats [data-cat="all"]').click();
    app.doc.querySelector('.pm-card[data-ev="fedev"]').click();
    for (let i = 0; i < 3; i++) await app.settle();
    assert.match(app.text('#pmSOutcomes'), /⚖️ Kalshi との比較/);
    assert.ok(app.doc.querySelector('#pmSOutcomes .cmp-row.cmp-bg-r'));
    app.doc.querySelector('#pmSheet .pm-x').click();
    // マクロ: 大きなカードは無く、カレンダーの FOMC の行に Kalshi の確率だけ
    app.run('switchTab("btc")');
    for (let i = 0; i < 8; i++) await app.settle();
    assert.equal(app.doc.querySelector('#mcCmp'), null);
    assert.match(app.text('#mcCal').replace(/\s+/g, ' '), /Kalshi: 利上げ 78% ／ 据え置き 22%/);
    const oi = app.doc.querySelector('.mc-card[data-mc="oi"]').textContent.replace(/\s+/g, ' ');
    assert.match(oi, /24時間 \+25\.0%/);
    assert.match(oi, /🔴 建玉が急増/);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});
