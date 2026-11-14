'use strict';
/* オプション市場 (Deribit): 予想変動率・プット/コール比率・スキュー・満期ごとの建玉・マックスペイン */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('./helpers/gas');
const { openApp, GAS_URL } = require('./helpers/app');
const { createClock } = require('./helpers/clock');
const { deribitFetch } = require('./helpers/deribit');

const ok = o => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify(o) });
/** Deribit だけ答える世界。digest: true なら Polymarket の一覧は空で答える (毎朝のまとめ用) */
function world(opts) {
  opts = opts || {};
  const clock = createClock('2026-11-14T10:00:00+09:00');
  const deribit = deribitFetch(clock, opts.world);
  const calls = [];
  const fetch = (url, params) => {
    calls.push(url);
    const dr = deribit(url); if (dr) return dr;
    if (/gamma-api\.polymarket\.com\/markets/.test(url)) return ok(opts.pm ? (Number(new URL(url).searchParams.get('offset')) === 0 ? [{ id: '1', question: 'Q', outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]', volume24hr: 1, closed: false, events: [{ id: 'e', title: 'E', slug: 'e' }] }] : []) : []);
    if (/gamma-api/.test(url)) return ok({ events: [] });
    if (/kalshi/.test(url)) return ok({ events: [] });
    if (opts.pm && /hyperliquid/.test(url)) { const b = JSON.parse(params.payload); return ok(b.type === 'metaAndAssetCtxs' ? [{ universe: [{ name: 'BTC' }] }, [{ markPx: '1', prevDayPx: '1', openInterest: '1', funding: '0', dayNtlVlm: '1', premium: '0' }]] : []); }
    throw new Error('使わない: ' + url);
  };
  const gas = loadGas({ clock, fetch, props: opts.props || {} });
  const deribitCalls = () => calls.filter(u => /deribit/.test(u)).length;
  return { clock, gas, w: deribit.world, deribitCalls };
}
const optFiles = gas => gas.drive.folderFiles('ポリマーケット記録').filter(f => /^opt-/.test(f.name));
const fileJson = (gas, name) => { const f = gas.drive.folderFiles('ポリマーケット記録').find(x => x.name === name); return f ? JSON.parse(f.content) : null; };

test('サーバー: BTC・ETH の価格・建玉・プット/コール比率・スキュー・マックスペイン・DVOL を計算し、読み取りの文をつける', () => {
  const { gas } = world();
  const r = gas.get({ action: 'opt' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.opt.errors, []);
  const B = r.opt.cur.BTC;
  assert.equal(B.px, 100000);
  // 満期を過ぎた 11/01 と PERPETUAL は数えない
  assert.deepEqual(B.exps.map(e => e.exp), ['2026-11-20', '2026-12-25', '2027-03-26']);
  // 全体: コール 15,850枚・プット 10,170枚
  assert.equal(B.oi, 2602000000);
  assert.equal(B.pc, 0.64);
  assert.equal(B.pcVol, 0.32, '出来高はコール = 建玉/10、プット = 建玉/20');
  const e = Object.fromEntries(B.exps.map(x => [x.exp, x]));
  assert.equal(e['2026-11-20'].pc, 0.71);
  assert.equal(e['2026-12-25'].pc, 0.62);
  assert.equal(e['2027-03-26'].pc, 0.76);
  for (const x of B.exps) assert.equal(x.mp, 100000, 'マックスペイン ' + x.exp);
  assert.equal(e['2026-12-25'].topC, 120000);
  assert.equal(e['2026-12-25'].topP, 90000);
  assert.equal(e['2026-11-20'].topC, 110000);
  assert.equal(e['2026-11-20'].topP, 100000);
  assert.equal(e['2026-12-25'].iv, 46);
  assert.equal(e['2026-12-25'].skew, 9, '90,000 のプット 56 − 110,000 のコール 47');
  assert.equal(e['2026-11-20'].skew, 13);
  // 行使価格の表は今の価格の 0.6〜1.6倍だけ (200,000 は出さない)
  assert.deepEqual(e['2026-12-25'].strikes.map(s => s[0]), [80000, 90000, 100000, 110000, 120000]);
  assert.deepEqual(e['2026-12-25'].strikes[2], [100000, 2500, 2500]);
  // 建玉がいちばん大きい満期・スキューは30日に近い満期 (7日未満の 11/20 は使わない)
  assert.deepEqual(B.main, { exp: '2026-12-25', days: 41.3, mp: 100000, oi: 2070000000 });
  assert.equal(B.skew, 9);
  assert.equal(B.skewExp, '2026-12-25');
  // DVOL: 最新 40、24時間前 (2本前) 42、7日前 (14本前) 44。値の 1/5 が 40 なので位置は 20
  assert.equal(B.dvol.v, 40);
  assert.equal(B.dvol.d1, -2);
  assert.equal(B.dvol.d7, -4);
  assert.equal(B.dvol.lo, 40);
  assert.equal(B.dvol.hi, 44);
  assert.equal(B.dvol.rank, 20);
  assert.equal(B.dvol.s.length, 180);
  const read = B.read.join('\n');
  assert.match(read, /予想変動率 \(DVOL\) は 40 \(24時間で −2\)。直近90日で低い水準/);
  assert.match(read, /今後1日の値動きの目安は ±2\.1%/);
  assert.match(read, /下落への保険 \(プット\) が割高です \(スキュー \+9\)/);
  assert.match(read, /プット\/コール比率 \(建玉\) は 0\.64: コール \(上昇への賭け\) のほうが多い/);
  assert.match(read, /建玉がいちばん大きい満期は 12\/25 \(あと41日\)。マックスペインは 100,000ドル/);
  const E = r.opt.cur.ETH;
  assert.equal(E.px, 2300);
  assert.equal(E.pc, 0.83);
  assert.equal(E.skew, 10);
  assert.equal(E.main.mp, 2300);
  assert.equal(E.dvol.v, 60);
});

test('サーバー: 55分以内は取り直さない。Deribit が落ちても前回の値を返し、前回が無ければ ok:false', () => {
  const { gas, clock, w, deribitCalls } = world();
  gas.get({ action: 'opt' });
  const n = deribitCalls();
  assert.equal(n, 4, 'BTC・ETH それぞれ一覧と DVOL');
  clock.tick(50 * 60000);
  const r = gas.get({ action: 'opt' });
  assert.equal(deribitCalls(), n, '取り直さない');
  assert.equal(r.opt.cur.BTC.px, 100000);
  // 落ちている → 前回の値のまま
  w.down = true; clock.tick(10 * 60000);
  const r2 = gas.get({ action: 'opt' });
  assert.equal(r2.ok, true);
  assert.equal(r2.opt.cur.BTC.px, 100000);
  assert.ok(deribitCalls() > n, '取り直そうとはする');
  // 前回が無い
  const g2 = world({ world: { down: true } }).gas;
  const r3 = g2.get({ action: 'opt' });
  assert.equal(r3.ok, false);
  assert.match(r3.error, /Deribit 503/);
});

test('記録: その日の行を opt-YYYY-MM.json に残し、同じ日は上書き。落ちている時はエラーにして書き換えない', () => {
  const { gas, clock, w } = world();
  gas.ctx.optRecord_();
  let f = fileJson(gas, 'opt-2026-11.json');
  assert.deepEqual(Object.keys(f), ['2026-11-14']);
  assert.deepEqual(f['2026-11-14'].BTC, [100000, 40, 0.64, 0.32, 2602000000, 209350000, 9, 100000, '2026-12-25']);
  assert.equal(f['2026-11-14'].ETH[0], 2300);
  // 同じ日の後の記録で上書き
  w.book.BTC.px = 101000; clock.tick(3600000);
  gas.ctx.optRecord_();
  f = fileJson(gas, 'opt-2026-11.json');
  assert.deepEqual(Object.keys(f), ['2026-11-14']);
  assert.equal(f['2026-11-14'].BTC[0], 101000);
  assert.deepEqual(optFiles(gas).map(x => x.name).sort(), ['opt-2026-11.json', 'opt-latest.json']);
  assert.equal(gas.ctx.optHist_(7)['2026-11-14'].BTC[0], 101000);
  // 落ちている → 投げる (見張りで error)・ファイルはそのまま
  const before = fileJson(gas, 'opt-2026-11.json');
  w.down = true; clock.tick(14 * 3600000);   // 翌日
  assert.throws(() => gas.ctx.optRecord_(), /オプションの最新を取得できません/);
  assert.deepEqual(fileJson(gas, 'opt-2026-11.json'), before);
});

test('通知: DVOL が24時間で8以上動いたらメール (12時間に1回)。オフ・基準の変更ができる', () => {
  const jump = { BTC: i => (i < 2 ? 55 : 45), ETH: i => 60 };   // BTC は 24時間で +10
  const { gas, clock } = world({ world: { dvol: jump }, props: { MAIL_TO: 'muse@example.com' } });
  gas.ctx.optRecord_();
  assert.equal(gas.mails.length, 1);
  assert.match(gas.mails[0].subject, /オプション市場.*BTC/);
  assert.match(gas.mails[0].body, /BTC の予想変動率 \(DVOL\) が24時間で \+10 \(45 → 55\)/);
  assert.doesNotMatch(gas.mails[0].body, /ETH の予想変動率/);
  clock.tick(6 * 3600000); gas.ctx.optRecord_();
  assert.equal(gas.mails.length, 1, '12時間以内は送らない');
  clock.tick(7 * 3600000); gas.ctx.optRecord_();
  assert.equal(gas.mails.length, 2, '12時間たてばまた送る');
  // 基準を 20 にすると送らない
  gas.post({ action: 'pmConfig', notify: { dvol: 20 } });
  clock.tick(13 * 3600000); gas.ctx.optRecord_();
  assert.equal(gas.mails.length, 2);
  // オフ
  gas.post({ action: 'pmConfig', notify: { dvol: 8, opt: false } });
  clock.tick(13 * 3600000); gas.ctx.optRecord_();
  assert.equal(gas.mails.length, 2, 'オフの時は送らない');
  gas.post({ action: 'pmConfig', notify: { opt: true } });
  clock.tick(13 * 3600000); gas.ctx.optRecord_();
  assert.equal(gas.mails.length, 3);
});

test('毎朝のまとめ: 「■■ オプション市場 (Deribit)」に BTC・ETH の要点。dOpt をオフにすると載せない', () => {
  const { gas } = world({ props: { MAIL_TO: 'muse@example.com' } });
  gas.ctx.pmDigest();
  const body = gas.mails[gas.mails.length - 1].body;
  assert.match(body, /■■ オプション市場 \(Deribit\)/);
  assert.match(body, /■ BTC: 価格 100,000ドル/);
  assert.match(body, /■ ETH: 価格 2,300ドル/);
  assert.match(body, /・予想変動率 \(DVOL\) は 40/);
  assert.match(body, /12\/25 \(あと41日\): 建玉 .*マックスペイン 100,000ドル/);
  gas.post({ action: 'pmConfig', notify: { dOpt: false } });
  gas.ctx.pmDigest();
  assert.doesNotMatch(gas.mails[gas.mails.length - 1].body, /オプション市場/);
});

test('レポート: 「## 8. オプション市場」に満期の表、記録があれば日ごとの表', () => {
  const { gas } = world();
  let t = gas.get({ action: 'report', days: '7', parts: 'opt' }).text;
  assert.match(t, /## 8\. オプション市場/);
  assert.match(t, /\| 満期 \| 残り日数 \| 建玉 \|/);
  assert.match(t, /\| 2026-12-25 \| 41 \|.*\| 0\.62 \| 46% \| 9 \| 100000 \| 120000 \| 90000 \|/);
  assert.match(t, /日ごとの記録はまだありません/);
  gas.ctx.optRecord_();
  t = gas.get({ action: 'report', days: '7', parts: 'opt' }).text;
  assert.match(t, /\| 日付 \| 価格 \| DVOL \|/);
  assert.match(t, /\| 2026-11-14 \| \$100,000 \| 40 \| 0\.64 \| 0\.32 \|.*\| 9 \| 100000 \(2026-12-25\) \|/);
});

test('見張り: pmRecord の後、オプション市場の記録は ok', () => {
  const { gas } = world({ pm: true });
  gas.ctx.pmRecord();
  const j = gas.get({ action: 'health' }).health.jobs.find(x => x.k === 'opt');
  assert.equal(j.st, 'ok');
  assert.equal(j.n, 'オプション市場 (Deribit)');
  assert.ok(fileJson(gas, 'opt-2026-11.json')['2026-11-14']);
});

test('アプリ: オプションタブに 要点・読み取り・満期の表・行使価格ごとの建玉。満期や通貨を切り替え、? で解説', async () => {
  const { gas, clock } = world();
  gas.ctx.optRecord_();
  const app = await openApp({ clock, gas, fetch: async () => { throw new TypeError('offline'); }, state: { settings: { gasUrl: GAS_URL, gasKey: 'secret-pass-12345', gasAuto: false } } });
  try {
    gas.props.setProperty('API_SECRET', 'secret-pass-12345');
    app.run('switchTab("opt")');
    for (let i = 0; i < 6; i++) await app.settle();
    assert.equal(app.doc.querySelectorAll('#opSum .mc-card').length, 4);
    const sum = app.text('#opSum');
    assert.match(sum, /予想変動率 \(DVOL\)\?40 🟢/);
    assert.match(sum, /24時間 −2 ／ 7日 −4/);
    assert.match(sum, /プット\/コール比率\?0\.64/);
    assert.match(sum, /スキュー.*\+9/);
    assert.match(sum, /12\/25 満期 ／ 下げを警戒/);
    assert.match(sum, /建玉の合計\?26\.0億ドル/);
    assert.equal(app.doc.querySelectorAll('#opRead li').length, 5);
    assert.match(app.text('#opRead'), /いまの読み取り \(BTC\)/);
    const rows = [...app.doc.querySelectorAll('#opExps tr[data-opexp]')];
    assert.deepEqual(rows.map(r => r.dataset.opexp), ['2026-11-20', '2026-12-25', '2027-03-26']);
    assert.equal(app.doc.querySelector('#opExps tr.sel').dataset.opexp, '2026-12-25', '建玉が最大の満期を選んでおく');
    assert.match(app.text('#opStrikes'), /26\/12\/25 \(あと41日\)/);
    const st = [...app.doc.querySelectorAll('#opStrikes .op-st:not(.op-st-h)')];
    assert.deepEqual(st.map(x => x.querySelector('b').textContent), ['$120,000', '$110,000', '$100,000', '$90,000', '$80,000']);
    assert.equal(app.doc.querySelector('#opStrikes .op-mp b').textContent, '$100,000');
    assert.match(app.text('#opStrikes .op-now'), /いまの価格/);
    assert.equal(app.doc.querySelector('#opStrikes .op-now').nextElementSibling.querySelector('b').textContent, '$100,000');
    // 別の満期
    rows[0].querySelector('td').click();
    assert.equal(app.doc.querySelector('#opExps tr.sel').dataset.opexp, '2026-11-20');
    assert.match(app.text('#opStrikes'), /26\/11\/20 \(あと6日\)/);
    assert.equal(app.doc.querySelectorAll('#opStrikes .op-st:not(.op-st-h)').length, 3);
    // ETH に切り替え
    app.doc.querySelector('#opCurs [data-opcur="ETH"]').click();
    assert.ok(app.doc.querySelector('#opCurs [data-opcur="ETH"]').classList.contains('active'));
    assert.match(app.text('#opRead'), /いまの読み取り \(ETH\)/);
    assert.match(app.text('#opSum'), /予想変動率 \(DVOL\)\?60/);
    assert.equal(app.doc.querySelector('#opExps tr.sel').dataset.opexp, '2026-12-25');
    assert.match(app.text('#opStrikes .op-mp'), /\$2,300/);
    // ? で解説
    app.doc.querySelector('#opSum [data-term="dvol"]').click();
    assert.equal(app.doc.querySelector('#termSheet').hidden, false);
    assert.match(app.text('#termBody'), /予想変動率 \(DVOL・IV\)/);
    // ホームのカード
    app.run('switchTab("top")');
    for (let i = 0; i < 4; i++) await app.settle();
    const card = [...app.doc.querySelectorAll('#homeBody .hm-card')].find(c => /オプション市場 \(Deribit\)/.test(c.textContent));
    assert.ok(card, 'ホームにオプション市場のカード');
    assert.match(card.textContent, /BTC の予想変動率40 🟢24時間 −2ETH の予想変動率60/);
    assert.match(card.textContent, /BTC のスキュー\+9下げを警戒/);
    // サーバーへの通信は合言葉つき
    const toGas = app.requests.filter(r => r.url.startsWith(GAS_URL));
    assert.ok(toGas.some(r => /action=opt/.test(r.url)));
    for (const r of toGas) {
      const hasKey = /[?&]key=secret-pass-12345/.test(r.url) || (r.init && r.init.body && /secret-pass-12345/.test(r.init.body));
      assert.ok(hasKey, '合言葉なし: ' + r.url);
    }
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('アプリ: サーバーを登録していない時は案内を出す', async () => {
  const clock = createClock('2026-11-14T10:00:00+09:00');
  const app = await openApp({ clock, fetch: async () => { throw new TypeError('offline'); } });
  try {
    app.run('switchTab("opt")');
    await app.settle();
    assert.match(app.text('#opSum'), /設定でサーバー \(Apps Script\) の URL を入れると表示されます/);
    app.run('switchTab("top")');
    await app.settle();
    const card = [...app.doc.querySelectorAll('#homeBody .hm-card')].find(c => /オプション市場/.test(c.textContent));
    assert.match(card.textContent, /設定でサーバー/);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});
