'use strict';
/* 米国のお金の流れ (財務省・NY連銀、日次): TGA・ON RRP・SRF・SOFR・EFFR・日次の正味の流動性・国債入札 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadGas } = require('./helpers/gas');
const { openApp, GAS_URL } = require('./helpers/app');
const { createClock } = require('./helpers/clock');
const { usFetch, walclCsv } = require('./helpers/usflow');

const ok = o => ({ getResponseCode: () => 200, getContentText: () => typeof o === 'string' ? o : JSON.stringify(o) });
/** 財務省・NY連銀と FRED の WALCL だけ答える世界 (毎朝のまとめ用に Polymarket などは空で答える) */
function world(opts) {
  opts = opts || {};
  const clock = createClock(opts.at || '2026-11-14T10:00:00+09:00');
  const us = usFetch(clock, opts.world);
  const calls = [];
  const fetch = (url, params) => {
    calls.push(url);
    const r = us(url); if (r) return r;
    if (opts.macro) return opts.macro(url, params);
    if (/fred\.stlouisfed\.org.*[?&]id=WALCL/.test(url)) return ok(walclCsv());
    if (/gamma-api\.polymarket\.com\/markets/.test(url)) return ok(opts.pm && Number(new URL(url).searchParams.get('offset')) === 0 ? [{ id: '1', question: 'Q', outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]', volume24hr: 1, closed: false, events: [{ id: 'e', title: 'E', slug: 'e' }] }] : []);
    if (/gamma-api/.test(url)) return ok({ events: [] });
    if (/kalshi/.test(url)) return ok({ events: [] });
    if (opts.pm && /hyperliquid/.test(url)) { const b = JSON.parse(params.payload); return ok(b.type === 'metaAndAssetCtxs' ? [{ universe: [{ name: 'BTC' }] }, [{ markPx: '1', prevDayPx: '1', openInterest: '1', funding: '0', dayNtlVlm: '1', premium: '0' }]] : []); }
    throw new Error('使わない: ' + url);
  };
  const gas = loadGas({ clock, fetch, props: opts.props || {} });
  const usCalls = () => calls.filter(u => /fiscaldata|newyorkfed/.test(u)).length;
  return { clock, gas, w: us.world, usCalls, calls };
}
const usFile = gas => { const f = gas.drive.folderFiles('ポリマーケット記録').find(x => x.name === 'us-latest.json'); return f ? JSON.parse(f.content) : null; };
const MAIL = { MAIL_TO: 'muse@example.com' };

test('サーバー: TGA・ON RRP・SRF・SOFR・EFFR を読み、10億ドル単位・日付 YYYY-MM-DD にそろえる', () => {
  const { gas } = world({ world: { srf: { '2026-11-12': [5, 3] } } });
  const r = gas.get({ action: 'us' });
  assert.equal(r.ok, true);
  assert.equal(r.version, gas.C.GAS_VERSION);
  const u = r.us;
  assert.deepEqual(u.errors, []);
  // TGA: 100万ドル単位の open_today_bal → 10億ドル。130日前 (7/7) から
  assert.equal(u.tga[0][0], '2026-07-07');
  assert.deepEqual(u.tga.slice(-3), [['2026-11-11', 930], ['2026-11-12', 940], ['2026-11-13', 950]]);
  // ON RRP: ドル → 10億ドル。11/11 は行が無い
  assert.deepEqual(u.rrp.slice(-3), [['2026-11-10', 1.5], ['2026-11-12', 1.5], ['2026-11-13', 0.3]]);
  // SRF: 1日2回の合計。使われない日は 0
  assert.deepEqual(u.srf.slice(-3), [['2026-11-11', 0], ['2026-11-12', 8], ['2026-11-13', 0]]);
  // SOFR: [日付, 金利, 取引額(10億ドル), 1%点, 99%点] (古い順)、EFFR: [日付, 金利]
  assert.equal(u.sofr.length, 90);
  assert.deepEqual(u.sofr[u.sofr.length - 1], ['2026-11-13', 3.9, 3100, 3.84, 3.98]);
  assert.ok(u.sofr[0][0] < u.sofr[1][0], '古い順');
  assert.deepEqual(u.effr[u.effr.length - 1], ['2026-11-13', 3.88]);
  // ドライブに us-latest.json
  assert.deepEqual(usFile(gas).tga.slice(-1), [['2026-11-13', 950]]);
});

test('サーバー: 日次の正味の流動性 = FRB 総資産 (週ごとの値を引き継ぐ・100万ドル単位) − TGA − ON RRP (無い日は前の値)', () => {
  const { gas } = world();
  const n = Object.fromEntries(gas.get({ action: 'us' }).us.netliq);
  // 11/13 (金): WALCL は 11/11 (水) の 6,580,000 → 6580。6580 − 950 − 0.3
  assert.equal(n['2026-11-13'], 5629.7);
  // 11/12: 6580 − 940 − 1.5
  assert.equal(n['2026-11-12'], 5638.5);
  // 11/11: ON RRP の行が無いので 11/10 の 1.5 を使う。6580 − 930 − 1.5
  assert.equal(n['2026-11-11'], 5648.5);
  // 11/10 (火): まだ 11/04 の 6,600,000。6600 − 920 − 1.5
  assert.equal(n['2026-11-10'], 5678.5);
  assert.equal(n['2026-11-06'], 6600 - 900 - 1.5);
});

test('サーバー: 3時間は取り直さない。1つが落ちても他は新しくなり、落ちたものは前回の値と errors。全部落ちて前回も無ければ ok:false', () => {
  const { gas, clock, w, usCalls } = world();
  gas.get({ action: 'us' });
  const n = usCalls();
  assert.equal(n, 7, 'TGA・ON RRP・SRF・SOFR・EFFR・入札・入札の予定');
  clock.tick(2.5 * 3600000);
  gas.get({ action: 'us' });
  assert.equal(usCalls(), n, '3時間以内は取り直さない');
  // TGA が落ち、SOFR が変わる
  clock.tick(1 * 3600000);
  w.down.tga = true;
  w.sofr = () => [3.95, 3.9, 4.2, 3000];
  const r = gas.get({ action: 'us' });
  assert.ok(usCalls() > n, '取り直す');
  assert.equal(r.ok, true);
  assert.deepEqual(r.us.errors, ['財務省口座 (TGA)']);
  assert.deepEqual(r.us.tga.slice(-1), [['2026-11-13', 950]], 'TGA は前回の値のまま');
  assert.equal(r.us.sofr[r.us.sofr.length - 1][1], 3.95, 'SOFR は新しい値');
  assert.equal(r.us.netliq[r.us.netliq.length - 1][1], 5629.7, '正味の流動性も前回の TGA で計算できる');
  // 力ずくの取り直し (force=1)
  const before = usCalls();
  gas.get({ action: 'us', force: '1' });
  assert.ok(usCalls() > before);
  // 全部落ちて前回も無い → ok:false・見張りは error
  const z = world({ world: { down: { all: true } }, pm: true });
  const r2 = z.gas.get({ action: 'us' });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /米国のお金の流れを取得できません/);
  z.gas.ctx.pmRecord();
  const j = z.gas.get({ action: 'health' }).health.jobs.find(x => x.k === 'us');
  assert.equal(j.st, 'error');
  assert.equal(j.n, '米国のお金の流れ (財務省・NY連銀)');
  // 前回があれば、全部落ちても前回を返す
  w.down.all = true; clock.tick(4 * 3600000);
  const r3 = gas.get({ action: 'us' });
  assert.equal(r3.ok, true);
  assert.equal(r3.us.tga.length > 0, true);
});

test('入札: 種類と年限ごとに前の6回の平均と比べ、不調・好調を判定。見ない短期国債は除く。これからの入札は10日以内', () => {
  const { gas } = world();
  const A = gas.get({ action: 'us' }).us.auctions;
  const by = Object.fromEntries(A.recent.map(a => [a.d + ' ' + a.n, a]));
  // 10年債 11/12: 前の6回 (2.5, 2.6, 2.4, 2.55, 2.5, 2.45) の平均 2.5。2.3 はどれより低い → 不調 (2月の 2.9 は7回より前なので入らない)
  const ten = by['2026-11-12 10年国債'];
  assert.deepEqual([ten.btc, ten.btcAvg, ten.weak, ten.strong, ten.rate, ten.amt, ten.ind], [2.3, 2.5, true, false, 4.16, 42, 75]);
  assert.equal(ten.type, 'Note');
  assert.equal(ten.term, '10-Year');
  // 30年債 11/13 (再開発行で残りの年限は 29年9か月でも、30年債としてまとめる): 前の3回の平均 2.35 より上・どれより高い → 好調
  const thirty = by['2026-11-13 30年国債'];
  assert.deepEqual([thirty.btc, thirty.btcAvg, thirty.weak, thirty.strong], [2.6, 2.35, false, true]);
  // 2年債: 前が1回だけなので判定しない
  const two = by['2026-10-28 2年国債'];
  assert.equal(two.btcAvg, 2.6);
  assert.equal(two.weak, undefined);
  // 物価連動国債は普通の10年債と別にする
  assert.ok(by['2026-10-23 10年物価連動国債']);
  assert.equal(by['2026-10-23 10年物価連動国債'].btcAvg, undefined);
  // 短期国債は 13週・26週・52週だけ (4週と CMB は出さない)
  assert.ok(by['2026-11-09 13週の短期国債'].strong, '13週: 前の3回より高い');
  assert.ok(!A.recent.some(a => /4週/.test(a.n) || a.d === '2026-11-11'));
  // 結果が空のまま過去になったもの (5年債 10/22) は出さない
  assert.ok(!A.recent.some(a => a.d === '2026-10-22'));
  // 新しい順
  assert.deepEqual(A.recent.slice(0, 3).map(a => a.d), ['2026-11-13', '2026-11-12', '2026-11-09']);
  // これから: 10日以内 (11/30 は先すぎ)・6週は除く・2つの一覧で重なったものは1つ
  assert.deepEqual(A.upcoming, [
    { d: '2026-11-17', type: 'Bill', term: '52-Week', n: '52週の短期国債', amt: null },
    { d: '2026-11-18', type: 'Bond', term: '20-Year', n: '20年国債', amt: 13 },
  ]);
  // 予定の一覧が落ちても、入札の一覧の「まだ」の分は出す
  const z = world({ world: { down: { upcoming: true } } });
  const u2 = z.gas.get({ action: 'us' }).us;
  assert.deepEqual(u2.errors, []);
  assert.deepEqual(u2.auctions.upcoming.map(a => a.d + ' ' + a.n), ['2026-11-18 20年国債']);
});

test('読み取り: TGA・ON RRP・正味の流動性・SOFR・SRF・入札をやさしい文にする', () => {
  const { gas } = world();
  const read = gas.get({ action: 'us' }).us.read;
  assert.equal(read.length, 6);
  assert.equal(read[0], '財務省口座 (TGA) は 9,500億ドル (11/13)。前の営業日から +100億ドル、5営業日で +500億ドル: 政府の口座にお金が集まり、市場からお金を吸い上げています');
  assert.equal(read[1], 'リバースレポ (ON RRP) は 3億ドル。ほぼ空で、余ったお金のクッションはもうありません');
  // 5営業日前 (11/06) 6600 − 900 − 1.5 = 5698.5 → −68.8。20営業日前も 5698.5
  assert.equal(read[2], '正味の流動性 (日次) は 5.63兆ドル。5営業日で −688億ドル、20営業日で −688億ドル: 市場のお金は減っています');
  assert.equal(read[3], 'SOFR は 3.90% (EFFR は 3.88%)。短期のお金のやり取りは落ち着いています');
  assert.equal(read[4], '常設レポ (SRF) はこのところ使われていません (短期のお金は足りています)');
  assert.equal(read[5], '30年国債の入札 (11/13) は好調でした: 応札倍率 2.6倍 (前の回の平均 2.35倍)。買い手が多く、国債の人気は保たれています');
  // ひっ迫している時
  const z = world({ world: { sofr: () => [3.97, 3.9, 4.1, 3000], srf: { '2026-11-13': [4, 2.5] }, rrp: () => 120, tga: (d, i, n) => (i >= n - 5 ? 900 - (i - (n - 6)) * 20 : 900), auctions: [] } });
  const r2 = z.gas.get({ action: 'us' }).us.read;
  assert.match(r2[0], /5営業日で −1,000億ドル: 政府の支払いで、市場にお金が出てきています/);
  assert.match(r2[1], /リバースレポ \(ON RRP\) は 1,200億ドル。5営業日で \+0ドル/);
  assert.match(r2[3], /^SOFR \(3\.97%\) が EFFR \(3\.88%\) を 9bp 上回っています: 国債を担保にした短期のお金が足りなくなりかけている合図です$/);
  assert.equal(r2[4], '常設レポ (SRF) が 11/13 に 65億ドル 使われました: 短期のお金がひっ迫した合図です');
  assert.equal(r2.length, 5, '判定できる入札が無ければ入札の文は無し');
  // SOFR の上位1%だけが高い
  const z2 = world({ world: { sofr: () => [3.9, 3.84, 4.1, 3000], srf: { '2026-11-03': [2, 0] } } });
  const r3 = z2.gas.get({ action: 'us' }).us.read;
  assert.match(r3[3], /SOFR は 3\.90% ですが、高い側の取引 \(上位1%\) は 4\.10% まで上がりました/);
  assert.equal(r3[4], '常設レポ (SRF) は直近20営業日のうち 1日 使われました (最大 20億ドル)');
});

test('通知: 不調な入札はメールで1回だけ。オフにできる', () => {
  const { gas, clock } = world({ props: MAIL });
  gas.ctx.usRecord_();
  assert.equal(gas.mails.length, 1);
  const m = gas.mails[0];
  assert.match(m.subject, /^【ポリマーケット】米国のお金の流れ: 10年国債の入札 \(11\/12\) が不調でした/);
  assert.match(m.body, /・10年国債の入札 \(11\/12\) が不調でした: 応札倍率 2\.3倍 \(前の回の平均 2\.5倍\)、利回り 4\.16% — 買い手が少なめで、金利が上がりやすくなります/);
  assert.doesNotMatch(m.body, /7\/9/, '1週間より前の不調は知らせない');
  assert.match(m.body, /■ いまの読み取り\n・財務省口座 \(TGA\) は 9,500億ドル/);
  // 同じ入札は2度と知らせない
  clock.tick(30 * 3600000); gas.ctx.usRecord_();
  assert.equal(gas.mails.length, 1);
  // オフ
  const z = world({ props: MAIL });
  z.gas.post({ action: 'pmConfig', notify: { us: false } });
  z.gas.ctx.usRecord_();
  assert.equal(z.gas.mails.length, 0);
  // 通知メール全体をオフ
  const z2 = world({ props: Object.assign({ PM_ALERT_ON: '0' }, MAIL) });
  z2.gas.ctx.usRecord_();
  assert.equal(z2.gas.mails.length, 0);
});

test('通知: SRF の利用・TGA の1営業日の大きな動き。24時間に1回・同じ日のデータは1回。基準は pmConfig で変えられる (10億ドル単位)', () => {
  const tga = (d, i, n) => (i === n - 1 ? 1000 : 940);   // 最後の日に +60
  const { gas, clock, w } = world({ props: MAIL, world: { auctions: [], tga, srf: { '2026-11-13': [5, 3] } } });
  gas.ctx.usRecord_();
  assert.equal(gas.mails.length, 1, '1回の実行で1通にまとめる');
  let b = gas.mails[0].body;
  assert.match(gas.mails[0].subject, /常設レポ \(SRF\) が 11\/13 に 80億ドル 使われました/);
  assert.match(b, /・常設レポ \(SRF\) が 11\/13 に 80億ドル 使われました \(基準 50億ドル 以上\) — 短期のお金がひっ迫した合図です/);
  assert.match(b, /・財務省口座 \(TGA\) が1営業日で \+600億ドル \(11\/13、1\.00兆ドル\) — 市場からお金が吸い上げられました \(基準 ±500億ドル\)/);
  // 24時間以内は送らない (取り直しても)
  clock.tick(4 * 3600000); gas.ctx.usRecord_();
  assert.equal(gas.mails.length, 1);
  // 24時間たっても、同じ日のデータなら送らない
  clock.tick(25 * 3600000); gas.ctx.usRecord_();
  assert.equal(gas.mails.length, 1);
  // 新しい日 (11/16) に SRF 8 と TGA −60 → 送る。ただし基準を SRF 10・TGA 100 にすると送らない
  w.days.push('2026-11-16');
  w.tga = (d, i, n) => (i === n - 1 ? 940 : i === n - 2 ? 1000 : 940);
  w.srf = { '2026-11-16': [8, 0] };
  gas.post({ action: 'pmConfig', notify: { srf: 10, tga: 100 } });
  clock.set('2026-11-17T10:00'); gas.ctx.usRecord_();
  assert.equal(gas.mails.length, 1, '基準より小さい');
  // 範囲の外は丸める (SRF は 1〜200、TGA は 10〜500)
  gas.post({ action: 'pmConfig', notify: { srf: 0.1, tga: 5 } });
  assert.deepEqual([gas.ctx.ntf_().srf, gas.ctx.ntf_().tga], [1, 10]);
  clock.tick(4 * 3600000); gas.ctx.usRecord_();
  assert.equal(gas.mails.length, 2);
  b = gas.mails[1].body;
  assert.match(b, /常設レポ \(SRF\) が 11\/16 に 80億ドル 使われました \(基準 10億ドル 以上\)/);
  assert.match(b, /財務省口座 \(TGA\) が1営業日で −600億ドル \(11\/16、9,400億ドル\) — 市場にお金が出てきました \(基準 ±100億ドル\)/);
});

test('毎朝のまとめ: 「■■ 米国のお金の流れ」をマクロ指標の一覧の後に。dUs をオフにすると載せない', () => {
  const { gas } = world({ props: MAIL });
  gas.ctx.pmDigest();
  const m = gas.mails[gas.mails.length - 1];
  const body = m.body;
  const sec = body.slice(body.indexOf('■■ 米国のお金の流れ'));
  assert.match(sec, /^■■ 米国のお金の流れ \(財務省・NY連銀\)\n・財務省口座 \(TGA\) は 9,500億ドル/);
  assert.match(sec, /■ 最新の値\n・財務省口座 \(TGA\): 9,500億ドル \(11\/13\) ／ 前の営業日比 \+100億ドル ／ 5営業日比 \+500億ドル\n・リバースレポ \(ON RRP\): 3億ドル \(11\/13\) ／ 前の営業日比 −12億ドル ／ 5営業日比 −12億ドル\n・日次の正味の流動性: 5\.63兆ドル \(11\/13\) ／ 前の営業日比 −88億ドル ／ 5営業日比 −688億ドル\n・SOFR: 3\.90% \(11\/13\) ／ 前の営業日比 \+0bp ／ 5営業日比 \+0bp\n・EFFR: 3\.88%/);
  assert.match(sec, /■ 最近の国債入札\n・11\/13 30年国債: 応札倍率 2\.6倍 \(前の回の平均 2\.35倍\)、利回り 4\.7%、海外などの間接入札 66\.7%、発行額 250億ドル 【好調】\n・11\/12 10年国債: .*【不調】\n・11\/9 13週の短期国債/);
  assert.match(sec, /■ これからの国債入札 \(7日以内\)\n・11\/17 52週の短期国債\n・11\/18 20年国債 \(130億ドル\)\n/);
  assert.match(m.htmlBody, /🏛 米国のお金の流れ \(財務省・NY連銀\)/);
  // 順番: マクロ指標の一覧 → 米国のお金の流れ → 記録の状況
  const iUs = body.indexOf('■■ 米国のお金の流れ');
  assert.ok(iUs > 0 && iUs < body.indexOf('■ 記録の状況'));
  gas.post({ action: 'pmConfig', notify: { dUs: false } });
  gas.ctx.pmDigest();
  assert.doesNotMatch(gas.mails[gas.mails.length - 1].body, /米国のお金の流れ/);
  // データが無い時は欄ごと出さない
  const z = world({ props: MAIL, world: { down: { all: true } } });
  z.gas.ctx.pmDigest();
  assert.doesNotMatch(z.gas.mails[z.gas.mails.length - 1].body, /米国のお金の流れ/);
});

test('レポート: 「## 10. 米国のお金の流れ」に日ごとの表と入札の表。既定の parts に入っている', () => {
  const { gas } = world();
  const t = gas.get({ action: 'report', days: '7', parts: 'us' }).text;
  assert.match(t, /## 10\. 米国のお金の流れ \(財務省・NY連銀、日次\)/);
  assert.match(t, /\| 日付 \| TGA \| ON RRP \| SRF \| 正味の流動性 \| SOFR \| EFFR \|/);
  assert.match(t, /\| 2026-11-13 \| 950 \| 0\.3 \| 0 \| 5629\.7 \| 3\.9 \| 3\.88 \|/);
  assert.match(t, /\| 2026-11-11 \| 930 \| - \| 0 \| 5648\.5 \|/, 'ON RRP の行が無い日は -');
  assert.doesNotMatch(t, /\| 2026-11-06 \|/, '7日より前は入れない');
  assert.match(t, /\| 2026-11-12 \| 10年国債 \| 42 \| 2\.3 \| 2\.5 \| 4\.16 \| 75 \| 不調 \|/);
  assert.match(t, /### これからの国債入札/);
  assert.equal(gas.C.GAS_VERSION, '2026.12.06');
  const all = gas.get({ action: 'report', days: '7' }).text;
  assert.match(all, /## 10\. 米国のお金の流れ/);
});

test('天気図: 日次のデータがあれば「正味の流動性」「TGA」「リバースレポ」は日次で計算し (4週の変化・基準は同じ)、無ければ週ごとのまま', () => {
  const src = fs.readFileSync(path.join(__dirname, 'macro.test.js'), 'utf8');
  const m = {};
  new Function('module', 'require', src.slice(0, src.indexOf("\ntest('")) + ';module.exports={macroFetch};')(m, p => require(p.startsWith('./') ? path.join(__dirname, p.slice(2)) : p));
  const clock0 = createClock('2026-11-14T10:00:00+09:00');
  const mf = m.exports.macroFetch(clock0.now).fetch;
  const { gas } = world({ macro: mf });
  const ev = (D, id) => vm.runInContext(`mcEval(MC_DEFS.find(d => d.id === ${JSON.stringify(id)}), __D)`, Object.assign(gas.ctx, { __D: D }));
  // 日次のデータがまだ無い → 週ごとの FRED
  const D0 = gas.get({ action: 'macro' }).macro;
  assert.equal(D0.us, undefined);
  const w0 = { netliq: ev(D0, 'netliq'), tga: ev(D0, 'tga'), rrp: ev(D0, 'rrp') };
  assert.doesNotMatch(w0.netliq.sub, /日次/);
  // 日次のデータを取る → 次の macro から D.us が付く
  gas.get({ action: 'us' });
  const D1 = gas.get({ action: 'macro' }).macro;
  assert.deepEqual(Object.keys(D1.us).sort(), ['at', 'netliq', 'rrp', 'tga']);
  const n = ev(D1, 'netliq');
  // FRED の偽物の WALCL は 6,600,000 のまま。11/13: 6600 − 950 − 0.3 = 5649.7、28日前 (10/16): 6600 − 900 − 1.5 = 5698.5 → −48.8 (±50 の内側なので 🟡)
  assert.equal(n.d, '2026-11-13');
  assert.equal(n.v, '5.65兆ドル');
  assert.equal(n.sub, '4週 -488億ドル ・ 日次');
  assert.equal(n.sig, 'y');
  assert.equal(n.s, D1.us.netliq, '推移も日次');
  const t = ev(D1, 'tga');
  assert.equal(t.sub, '4週 +500億ドル ・ 日次');
  assert.equal(t.sig, null, '±1,500億ドルの内側');
  assert.match(ev(D1, 'rrp').sub, /ほぼ使い切り ・ 日次/);
  // D.us を外すと、前と同じ週ごとの結果
  const D2 = JSON.parse(JSON.stringify(D1)); delete D2.us;
  assert.deepEqual(JSON.parse(JSON.stringify({ netliq: ev(D2, 'netliq'), tga: ev(D2, 'tga'), rrp: ev(D2, 'rrp') })), JSON.parse(JSON.stringify(w0)));
  // 日次が短すぎる (30日未満) 時も週ごとに戻す
  const D3 = JSON.parse(JSON.stringify(D1)); D3.us.netliq = D3.us.netliq.slice(-10);
  assert.doesNotMatch(ev(D3, 'netliq').sub, /日次/);
  // macro.json には入れない (毎回読み直す)
  const f = gas.drive.folderFiles('ポリマーケット記録').find(x => x.name === 'macro.json');
  assert.equal(JSON.parse(f.content).us, undefined);
});

test('見張り: pmRecord の後、米国のお金の流れは ok (1時間ごと・6時間まで)', () => {
  const { gas } = world({ pm: true, world: { auctions: [] } });
  gas.ctx.pmRecord();
  const h = gas.get({ action: 'health' }).health;
  const j = h.jobs.find(x => x.k === 'us');
  assert.equal(j.st, 'ok');
  assert.equal(j.every, '1時間ごと');
  assert.ok(usFile(gas));
});

test('アプリ: マクロのタブに 4枚のカード・読み取り・グラフ・入札の表 (不調/好調)・これからの入札。? で解説、↻ で取り直し、ホームにカード', async () => {
  const { gas, clock } = world({ world: { srf: { '2026-11-13': [1, 0.5] } } });
  const app = await openApp({ clock, gas, fetch: async () => { throw new TypeError('offline'); }, state: { settings: { gasUrl: GAS_URL, gasKey: 'secret-pass-12345', gasAuto: false } } });
  try {
    gas.props.setProperty('API_SECRET', 'secret-pass-12345');
    app.run('switchTab("btc")');
    for (let i = 0; i < 6; i++) await app.settle();
    assert.equal(app.doc.querySelectorAll('#usSum .mc-card').length, 4);
    const sum = app.text('#usSum');
    assert.match(sum, /財務省口座 \(TGA\)\?9,500億ドル1日 \+100億ドル ／ 5日 \+500億ドル11\/13 時点/);
    assert.match(sum, /リバースレポ \(ON RRP\)\?3億ドル1日 −12億ドル/);
    assert.match(sum, /正味の流動性 \(日次\)\?5\.63兆ドル1日 −88億ドル ／ 5日 −688億ドル/);
    assert.match(sum, /SOFR \(短期の金利\)\?3\.90%1日 \+0bp ／ 5日 \+0bpEFFR 3\.88% ・ SRF 15億ドル 利用/);
    assert.equal(app.doc.querySelectorAll('#usRead li').length, 6);
    assert.match(app.text('#usRead'), /常設レポ \(SRF\) が 11\/13 に 15億ドル 使われました/);
    assert.equal(app.doc.querySelectorAll('#usCharts .hl-chart').length, 4);
    assert.equal(app.doc.querySelectorAll('#usCharts svg').length, 4);
    assert.equal(app.doc.querySelectorAll('#usCharts svg path[stroke-dasharray]').length, 1, 'SOFR のグラフに EFFR の点線');
    const rows = [...app.doc.querySelectorAll('#usAuc tbody tr')];
    assert.equal(rows.length, 16);
    const weak = app.doc.querySelector('#usAuc tr.us-weak');
    assert.match(weak.textContent, /11\/12.*10年国債 不調.*420億ドル.*2\.3倍 \(平均 2\.5倍 より下\).*4\.16%.*75%/);
    assert.match(app.doc.querySelector('#usAuc tr.us-strong').textContent, /11\/13.*30年国債 好調/);
    assert.equal(app.doc.querySelectorAll('#usAuc .us-up').length, 2);
    assert.match(app.text('#usAuc'), /11\/17 \(火\)52週の短期国債発行額は未発表/);
    assert.match(app.text('#usAuc'), /11\/18 \(水\)20年国債発行額 130億ドル/);
    assert.match(app.text('#usInfo'), /時点$/);
    // ? で解説
    app.doc.querySelector('#usAuc [data-term="bidcover"]').click();
    assert.equal(app.doc.querySelector('#termSheet').hidden, false);
    assert.match(app.text('#termBody'), /応札倍率/);
    app.doc.querySelector('#usSum [data-term="srf"]').click();
    assert.match(app.text('#termBody'), /常設レポ \(SRF\)/);
    // ↻ でマクロと一緒に取り直す
    const before = app.requests.filter(r => /action=us&force=1/.test(r.url)).length;
    app.doc.querySelector('#mcReload').click();
    for (let i = 0; i < 4; i++) await app.settle();
    assert.equal(app.requests.filter(r => /action=us&force=1/.test(r.url)).length, before + 1);
    // ホームのカード
    app.run('switchTab("top")');
    for (let i = 0; i < 4; i++) await app.settle();
    const card = [...app.doc.querySelectorAll('#homeBody .hm-card')].find(c => /米国のお金の流れ/.test(c.querySelector('h3').textContent));
    assert.ok(card, 'ホームに米国のお金の流れのカード');
    assert.ok(card.classList.contains('hm-wide'));
    assert.match(card.textContent, /財務省口座 \(TGA\)9,500億ドル5日 \+500億ドルON RRP3億ドル5日 −12億ドル正味の流動性5\.63兆ドル5日 −688億ドル/);
    assert.match(card.textContent, /SOFR は 3\.90%/);
    assert.equal(card.querySelectorAll('.hm-row').length, 3);
    card.querySelector('.hm-more').click();
    assert.ok(app.doc.querySelector('#tab-btc').classList.contains('active'));
    // サーバーへの通信は合言葉つき
    const toGas = app.requests.filter(r => r.url.startsWith(GAS_URL));
    assert.ok(toGas.some(r => /action=us/.test(r.url)));
    for (const r of toGas) {
      const hasKey = /[?&]key=secret-pass-12345/.test(r.url) || (r.init && r.init.body && /secret-pass-12345/.test(r.init.body));
      assert.ok(hasKey, '合言葉なし: ' + r.url);
    }
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('アプリ: 一部取得できない時は「一部取得できず」。サーバーを登録していない時は案内', async () => {
  const { gas, clock } = world({ world: { down: { auctions: true } } });
  let app = await openApp({ clock, gas, fetch: async () => { throw new TypeError('offline'); }, state: { settings: { gasUrl: GAS_URL, gasAuto: false } } });
  try {
    app.run('switchTab("btc")');
    for (let i = 0; i < 6; i++) await app.settle();
    assert.match(app.text('#usInfo'), /一部取得できず \(国債入札\)/);
    assert.match(app.text('#usAuc'), /入札の結果を取得できませんでした/);
    assert.equal(app.doc.querySelectorAll('#usSum .mc-card').length, 4);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
  app = await openApp({ clock, fetch: async () => { throw new TypeError('offline'); } });
  try {
    app.run('switchTab("btc")');
    await app.settle();
    assert.match(app.text('#usSum'), /設定でサーバー \(Apps Script\) の URL を入れると表示されます/);
    app.run('switchTab("top")');
    await app.settle();
    const card = [...app.doc.querySelectorAll('#homeBody .hm-card')].find(c => /米国のお金の流れ/.test(c.textContent));
    assert.match(card.textContent, /設定でサーバー/);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});
