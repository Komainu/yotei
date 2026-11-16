'use strict';
/* Hyperliquid その2: HLP 金庫・大口のポジション・HYPE の買い戻し (支援基金)・上場オークション・自分で見張るアドレス */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('./helpers/gas');
const { openApp, GAS_URL } = require('./helpers/app');
const { createClock } = require('./helpers/clock');
const { hl2Fetch, HLP, AF, KID, addr, EVIL } = require('./helpers/hl2');

const M = 60000, H = 60 * M, DAY = 24 * H;
const MINE = '0x1111222233334444555566667777888899990000';
const MINE2 = '0x2222333344445555666677778888999900001111';
const ok = o => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify(o) });

function world(opts) {
  opts = opts || {};
  const clock = createClock(opts.at || '2026-11-12T10:00:00+09:00');
  const h2 = hl2Fetch(clock, opts.world);
  const fetch = (url, params) => {
    const r = h2(url, params); if (r) return r;
    if (/gamma-api\.polymarket\.com\/markets/.test(url)) return ok(Number(new URL(url).searchParams.get('offset')) === 0 ? [{ id: '1', question: 'Q', outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]', volume24hr: 1, closed: false, events: [{ id: 'e', title: 'E', slug: 'e' }] }] : []);
    if (/gamma-api/.test(url)) return ok({ events: [] });
    if (/kalshi/.test(url)) return ok({ events: [] });
    throw new Error('使わない: ' + url);
  };
  const props = Object.assign({ MAIL_TO: 'muse@example.com' }, opts.props || {});
  if (opts.wallets) props.HL_WALLETS = JSON.stringify(opts.wallets);
  const gas = loadGas({ clock, fetch, props });
  return { clock, gas, w: h2.world };
}
const calls = (w, t) => w.calls.filter(x => x === t).length;
const file = (gas, n) => { const f = gas.drive.folderFiles('ポリマーケット記録').find(x => x.name === n); return f ? JSON.parse(f.content) : null; };
const onlyHl2Due = gas => { const now = gas.clock.now; gas.props.setProperty('SIDE_LAST', JSON.stringify({ opt: now, news: now, us: now, llama2: now })); };

test('HLP 金庫: 預かり・1日/7日/30日/全期間の損益・年率・人数・30日の推移 (60点まで)', () => {
  const { gas } = world();
  const r = gas.get({ action: 'hl2' });
  assert.equal(r.ok, true);
  const h = r.hl2.hlp;
  assert.deepEqual([h.tvl, h.pnlD, h.pnlW, h.pnlM, h.pnlA, h.apr, h.followers], [3.9e8, 1.2e6, -7e5, 3.96e6, 6e7, 12.3, 2]);
  assert.equal(h.series.length, 60, '100点 → 60点に間引く');
  assert.deepEqual(h.series[0].slice(1), [3.6e8, 0]);
  assert.deepEqual(h.series[59].slice(1), [3.6e8 + 99 * 3e5, 99 * 40000], '最後の点は残す');
  assert.ok(h.series.every((p, i) => i === 0 || p[0] > h.series[i - 1][0]));
  assert.deepEqual(h.kids, [KID, '0x2e3d94f0562703b25c83308a05046ddaf9a8dd14']);
  assert.deepEqual(r.hl2.errors, []);
  assert.equal(r.hl2.snap, undefined, '通知用の控えは返さない');
  assert.equal(r.hl2.lb, undefined);
  assert.deepEqual(r.wallets, []);
});

test('大口: 口座の大きい順に20人 (金庫・支援基金・子金庫・仕組みのアドレス・今月の出来高 0 は除く)。口座は30まで', () => {
  const wallets = Array.from({ length: 10 }, (_, i) => ({ a: '0x' + (0xb00000 + i).toString(16) + '1'.repeat(28) + (0x2000 + i).toString(16) + '00', n: 'W' + i }));
  const { gas, w } = world({ wallets });
  const r = gas.get({ action: 'hl2' });
  const list = r.hl2.whales.list;
  const big = list.filter(x => x.lb).map(x => x.a);
  assert.deepEqual(big, Array.from({ length: 20 }, (_, i) => addr(i + 1)));
  for (const a of [HLP, AF, KID, '0x0000000000000000000000000000000000000000', '0x9999999999999999999999999999999999999999']) assert.ok(!list.some(x => x.a === a), a);
  assert.equal(list.filter(x => x.w && !x.lb).length, 10, '見張るアドレスは一覧に無くても入れる');
  assert.equal(calls(w, 'clearinghouseState'), 30, '口座は1回に30まで');
  assert.equal(calls(w, 'leaderboard'), 1);
  assert.equal(w.calls.length, 36, '金庫1・一覧1・口座30・支援基金2・オークション2');
  const one = list[0];
  assert.deepEqual([one.a, one.name, one.av, one.pnlD, one.pnlM, one.n], [addr(1), 'Whale One', 24e7 + 1e6, 1000, 10000, 11]);
  assert.deepEqual(one.pos.map(p => p.c), ['ETH', 'BTC', 'X8', 'X7', 'X6', 'HYPE'], '大きい順に6つ (HYPE と X5 は同じ500万ドル。先に並ぶ HYPE)');
  assert.deepEqual(one.pos[0], { c: 'ETH', side: 'S', v: 3e7, lev: 5, upnl: -6e5, entry: 3920, liq: 4800, sz: 7500 });
  assert.equal(list[1].name, EVIL, '名前はそのまま (画面で文字として出す)');
});

test('大口: 買い越し・売り越しの集計 (手で計算した値)・いちばん大きいポジション', () => {
  const { gas } = world();
  const wh = gas.get({ action: 'hl2' }).hl2.whales;
  const net = Object.fromEntries(wh.net.map(x => [x.c, x]));
  // BTC: 買い 11人×1000万 + 2.5億 = 3.6億 (12人)、売り 3人×2000万 = 6000万 → 3億の買い越し
  assert.deepEqual(net.BTC, { c: 'BTC', long: 3.6e8, short: 6e7, net: 3e8, nL: 12, nS: 3 });
  // ETH: 売り 5人×3000万 = 1.5億、買い 3人×1000万 = 3000万 → 1.2億の売り越し
  assert.deepEqual(net.ETH, { c: 'ETH', long: 3e7, short: 1.5e8, net: -1.2e8, nL: 3, nS: 5 });
  assert.deepEqual(net.SOL, { c: 'SOL', long: 0, short: 0, net: 0, nL: 0, nS: 0 });
  // HYPE: 1〜4番だけ (21〜24番は上位20人の外)
  assert.deepEqual(net.HYPE, { c: 'HYPE', long: 2e7, short: 0, net: 2e7, nL: 4, nS: 0 });
  assert.deepEqual(wh.net.map(x => x.c), ['BTC', 'ETH', 'SOL', 'HYPE', 'X8', 'X7', 'X6', 'X5', 'X4', 'X3']);
  assert.equal(wh.nLb, 20);
  assert.deepEqual(wh.top[0], { a: addr(3), name: null, c: 'BTC', side: 'L', v: 2.5e8, lev: 5 });
  assert.equal(wh.top.length, 5);
});

test('大口: 読めない口座は飛ばす (残りで集計)', () => {
  const { gas } = world({ world: { bad: [addr(3)] } });
  const wh = gas.get({ action: 'hl2' }).hl2.whales;
  assert.equal(wh.nLb, 19);
  assert.equal(wh.failed, 1);
  const btc = wh.net.find(x => x.c === 'BTC');
  assert.deepEqual([btc.long, btc.nL, btc.net], [1.1e8, 11, 5e7]);
  assert.ok(!wh.list.some(x => x.a === addr(3)));
});

test('見張るアドレスの保存: 形の違うアドレスは断る・重なりは1つに・10件まで・名前は20文字まで・合言葉が要る', () => {
  const { gas } = world();
  let r = gas.post({ action: 'pmHlWallets', wallets: [{ a: MINE, n: 'ok' }, { a: '0x1234', n: 'bad' }] });
  assert.equal(r.ok, false);
  assert.match(r.error, /アドレスの形が正しくありません/);
  assert.equal(gas.props.getProperty('HL_WALLETS'), null, '何も保存しない');
  r = gas.post({ action: 'pmHlWallets', wallets: [{ a: '0xZZ' + MINE.slice(4) }] });
  assert.equal(r.ok, false);
  r = gas.post({ action: 'pmHlWallets', wallets: [{ a: MINE.toUpperCase().replace('0X', '0x'), n: '  わたしの<b>財布</b>とても長い名前ですよねこれは  ' }, { a: MINE, n: '重なり' }, { a: MINE2 }] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.wallets, [{ a: MINE, n: 'わたしのb財布/bとても長い名前ですよね' }, { a: MINE2, n: '' }]);
  assert.equal(r.wallets[0].n.length, 20);
  assert.deepEqual(JSON.parse(gas.props.getProperty('HL_WALLETS')), r.wallets);
  const many = Array.from({ length: 13 }, (_, i) => ({ a: '0x' + String(i).padStart(2, '0') + 'ab'.repeat(19), n: 'n' + i }));
  r = gas.post({ action: 'pmHlWallets', wallets: many });
  assert.equal(r.wallets.length, 10);
  assert.equal(r.cut, true);
  assert.equal(gas.post({ action: 'pmHlWallets' }).ok, false, '一覧が無い');
  assert.deepEqual(gas.post({ action: 'pmHlWallets', wallets: [] }).wallets, [], '空にもできる');
  // 合言葉
  gas.props.setProperty('API_SECRET', 'secret-pass-12345');
  r = gas.post({ action: 'pmHlWallets', wallets: [{ a: MINE }] });
  assert.equal(r.needKey, true);
  assert.equal(gas.props.getProperty('HL_WALLETS'), '[]');
  assert.equal(gas.get({ action: 'hl2' }).needKey, true);
  assert.equal(gas.post({ key: 'secret-pass-12345', action: 'pmHlWallets', wallets: [{ a: MINE }] }).ok, true);
  assert.equal(gas.get({ key: 'secret-pass-12345', action: 'hl2' }).wallets[0].a, MINE);
});

test('大口の一覧が取れない: 見張るアドレスだけでも出す。前回の一覧があれば使う (一覧は6時間に1回)', () => {
  const wallets = [{ a: MINE, n: 'わたし' }];
  let z = world({ wallets, world: { down: { lb: true }, wallets: { [MINE]: [['BTC', 'S', 3e6, 10]] } } });
  let r = z.gas.get({ action: 'hl2' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.hl2.errors, ['大口の一覧']);
  assert.deepEqual(r.hl2.whales.list.map(x => [x.a, x.name, x.w, x.lb]), [[MINE, 'わたし', true, false]]);
  assert.equal(r.hl2.whales.nLb, 0);
  assert.ok(!r.hl2.read.some(s => /大口/.test(s)), '大口の文は出さない');
  // 一覧が取れてから落ちた → 前回の一覧の20人を見続ける
  z = world({ wallets, world: { wallets: { [MINE]: [['BTC', 'S', 3e6, 10]] } } });
  z.gas.get({ action: 'hl2' });
  z.clock.tick(H);
  r = z.gas.get({ action: 'hl2' });
  assert.equal(calls(z.w, 'leaderboard'), 1, '6時間たつまでは一覧を取り直さない');
  assert.equal(calls(z.w, 'vaultDetails'), 2, '55分を過ぎたので取り直した');
  z.w.down.lb = true; z.clock.tick(6 * H);
  r = z.gas.get({ action: 'hl2' });
  assert.equal(calls(z.w, 'leaderboard'), 3, '6時間たったので取りに行った (落ちていると2回試す)');
  assert.deepEqual(r.hl2.errors, ['大口の一覧']);
  assert.equal(r.hl2.whales.nLb, 20, '前回の一覧のまま');
});

test('保存の時間: 55分は取り直さない。force=1 なら取り直す', () => {
  const { gas, w, clock } = world();
  gas.get({ action: 'hl2' });
  const n = w.calls.length;
  clock.tick(50 * M);
  gas.get({ action: 'hl2' });
  assert.equal(w.calls.length, n);
  gas.get({ action: 'hl2', force: '1' });
  assert.equal(calls(w, 'vaultDetails'), 2);
  clock.tick(56 * M);
  gas.get({ action: 'hl2' });
  assert.equal(calls(w, 'vaultDetails'), 3);
});

test('失敗: 1つが落ちても他は新しくなり、落ちたものは前回の値のまま errors に名前。全部落ちて前回も無ければ ok:false と見張りのエラー', () => {
  const { gas, w, clock } = world();
  const a = gas.get({ action: 'hl2' }).hl2;
  clock.tick(H);
  w.down.af = true; w.down.auction = true;
  const b = gas.get({ action: 'hl2' }).hl2;
  assert.deepEqual(b.errors, ['買い戻し基金', '上場オークション']);
  assert.equal(b.af.at, a.af.at, '前回のまま');
  assert.equal(b.auction.at, a.auction.at);
  assert.equal(b.hlp.at, clock.now, 'ほかは新しい');
  // 全部落ちて、前回も無い
  const z = world({ world: { down: { all: true } } });
  const r = z.gas.get({ action: 'hl2' });
  assert.equal(r.ok, false);
  assert.match(r.error, /Hyperliquid から取得できませんでした \(HLP 金庫・大口のポジション・買い戻し基金・上場オークション\)/);
  onlyHl2Due(z.gas);
  assert.equal(z.gas.ctx.pmSideJobs_(), 'hl2');
  const h = z.gas.get({ action: 'health' }).health.jobs.find(j => j.k === 'hl2');
  assert.equal(h.n, 'Hyperliquid の金庫・大口・買い戻し');
  assert.equal(h.every, '1時間ごと');
  assert.equal(h.st, 'error');
  assert.match(h.err, /Hyperliquid から取得できませんでした/);
  // 直れば ok。前回があれば全部落ちても投げない
  z.w.down.all = false; z.clock.tick(H); onlyHl2Due(z.gas);
  z.gas.ctx.pmSideJobs_();
  assert.equal(z.gas.get({ action: 'health' }).health.jobs.find(j => j.k === 'hl2').st, 'ok');
  z.w.down.all = true; z.clock.tick(H); onlyHl2Due(z.gas);
  z.gas.ctx.pmSideJobs_();
  assert.equal(z.gas.get({ action: 'health' }).health.jobs.find(j => j.k === 'hl2').st, 'ok');
});

test('日ごとの記録: hl2-YYYY-MM.json に [預かり, 1日の損益]・[HYPE, ドル]・オークション・買い越し額。支援基金の1日/7日の増え方', () => {
  const { gas, w, clock } = world();
  let d = gas.get({ action: 'hl2' }).hl2;
  assert.equal(d.af.d1, null, '記録がまだ無い');
  gas.ctx.hl2Record_();
  const f = file(gas, 'hl2-2026-11.json');
  assert.deepEqual(f['2026-11-12'], { hlp: [3.9e8, 1.2e6], af: [32100000, 32100000 * 40], gas: 1516.13, net: { BTC: 3e8, ETH: -1.2e8, SOL: 0, HYPE: 2e7 } });
  for (let i = 1; i <= 8; i++) {
    clock.tick(DAY); w.afHype += 50000;
    if (i === 3) w.auctionOff = true;
    gas.ctx.hl2Record_();
  }
  const g = file(gas, 'hl2-2026-11.json');
  assert.equal(Object.keys(g).length, 9);
  assert.equal(g['2026-11-15'].gas, null, 'オークションが無い日は null');
  assert.deepEqual(g['2026-11-20'].af, [32500000, 32500000 * 40]);
  d = gas.get({ action: 'hl2' }).hl2;
  assert.deepEqual([d.af.hype, d.af.d1, d.af.d7, d.af.d1usd, d.af.d7usd], [32500000, 50000, 350000, 2e6, 1.4e7]);
  assert.match(d.read.join('\n'), /買い戻し基金 \(支援基金\) は HYPE を 3250万枚 \(約 13億ドル\) 持っています。1日で \+5万枚 \(約 200万ドル\)、7日で \+35万枚 増えました/);
  const hist = gas.get({ action: 'hl2' }).hist;
  assert.equal(Object.keys(hist).length, 9);
});

test('読み取りの文: HLP・大口の向き (BTC/ETH/HYPE)・いちばん大きいポジション・ヘッジの注意・買い戻し・オークション', () => {
  const { gas } = world();
  const read = gas.get({ action: 'hl2' }).hl2.read;
  assert.deepEqual(read, [
    'HLP 金庫の預かりは 3.9億ドル。損益は1日で +120万ドル、7日で −70万ドル (HLP が損をしている = 取引する人たちが全体としてもうけています)',
    '大口20人のうち12人が BTC を買い持ち、3人が売り持ち。合計で 3億ドルの買い越し',
    '大口20人のうち3人が ETH を買い持ち、5人が売り持ち。合計で 1.2億ドルの売り越し',
    '大口20人のうち4人が HYPE を買い持ち、0人が売り持ち。合計で 2,000万ドルの買い越し',
    'いちばん大きいポジションは (0xa000…1003) の BTC 買い 2.5億ドル (レバレッジ 5倍)',
    '※ 大口は他の取引所で反対の取引をして損を抑えている (ヘッジ) こともあるので、ここだけで向きは決められません',
    '買い戻し基金 (支援基金) は HYPE を 3210万枚 (約 12.8億ドル) 持っています',
    '新しいトークンの上場オークションは今 1,516.1 HYPE (約 6万ドル)。あと 21時間で 500 HYPE まで下がります (高いほど上場したい人が多い)',
  ]);
  assert.ok(!read.some(s => /買いましょう|売りましょう|おすすめ/.test(s)), '売買のすすめはしない');
});

test('通知: 見張るアドレスだけ。初めては覚えるだけ・新しく持った/閉じた/向きを変えた (基準以上)・基準未満やオフは送らない・大口の一覧の人は送らない', () => {
  const pos = { [MINE]: [['BTC', 'S', 3e6, 10], ['SOL', 'L', 5e6, 3], ['XRP', 'L', 2e6, 2]] };
  const { gas, w, clock } = world({ wallets: [{ a: MINE, n: 'わたし' }], world: { wallets: pos } });
  const run = () => { clock.tick(H); gas.ctx.hl2Record_(); return gas.mails.filter(m => /見張っているアドレス/.test(m.subject)); };
  assert.equal(run().length, 0, '初めて見たアドレスは覚えるだけ');
  assert.equal(run().length, 0, '変わらなければ送らない');
  // ETH を新しく買い・BTC を閉じる・SOL を売りに変える・DOGE は小さい (100万ドル未満)・XRP は少し大きくなっただけ
  w.wallets[MINE] = [['ETH', 'L', 2e6, 3], ['SOL', 'S', 4e6, 5], ['DOGE', 'L', 5e5, 2], ['XRP', 'L', 2.5e6, 2]];
  // 大口の一覧の人 (1番) のポジションも変わる → こちらは知らせない
  w.wallets[addr(1)] = [['BTC', 'S', 9e8, 20]];
  let m = run();
  assert.equal(m.length, 1, '1回に1通');
  assert.equal(m[0].to, 'muse@example.com');
  const body = m[0].body;
  assert.match(body, /・⭐ わたし \(0x1111…0000\): ETH を新しく買い持ち 200万ドル \(レバレッジ 3倍\)/);
  assert.match(body, /・⭐ わたし \(0x1111…0000\): BTC の売り持ち \(300万ドル\) を閉じました/);
  assert.match(body, /・⭐ わたし \(0x1111…0000\): SOL を買い持ちから売り持ちに変えました 400万ドル \(レバレッジ 5倍\)/);
  assert.doesNotMatch(body, /DOGE|XRP|0xa000/);
  assert.equal(body.split('\n').filter(l => l.startsWith('・⭐')).length, 3);
  // 基準を 5 (百万ドル) に → 400万ドルの変化は送らない
  assert.equal(gas.post({ action: 'pmConfig', notify: { hlwMin: 5 } }).ok, true);
  assert.equal(gas.ctx.ntf_().hlwMin, 5);
  w.wallets[MINE] = [['ETH', 'L', 2e6, 3], ['SOL', 'L', 4e6, 5]];
  assert.equal(run().length, 1, '基準未満');
  w.wallets[MINE] = [['ETH', 'L', 2e6, 3], ['SOL', 'S', 6e6, 5]];
  assert.equal(run().length, 2, '基準以上は送る');
  // オフ
  gas.post({ action: 'pmConfig', notify: { hlw: false } });
  w.wallets[MINE] = [['BTC', 'L', 9e7, 3]];
  assert.equal(run().length, 2, 'オフなら送らない');
  // 範囲の外は収める
  gas.post({ action: 'pmConfig', notify: { hlw: true, hlwMin: 1000 } });
  assert.equal(gas.ctx.ntf_().hlwMin, 100);
  gas.post({ action: 'pmConfig', notify: { hlwMin: 0.01 } });
  assert.equal(gas.ctx.ntf_().hlwMin, 0.1);
});

test('通知: 見張るアドレスから外したら控えも消す。読めなかった回は閉じたと見なさない', () => {
  const { gas, w, clock } = world({ wallets: [{ a: MINE, n: '' }], world: { wallets: { [MINE]: [['BTC', 'L', 3e6, 2]] } } });
  gas.ctx.hl2Record_();
  clock.tick(H); w.bad.push(MINE); gas.ctx.hl2Record_();
  clock.tick(H); w.bad.length = 0; gas.ctx.hl2Record_();
  assert.equal(gas.mails.length, 0, '一度読めなかっただけでは閉じた・開いたと言わない');
  gas.post({ action: 'pmHlWallets', wallets: [] });
  clock.tick(H); gas.ctx.hl2Record_();
  const raw = gas.drive.folderFiles('ポリマーケット記録').find(x => x.name === 'hl2-latest.json').content;
  assert.ok(!raw.includes(MINE));
});

test('毎朝のまとめ: 「■■ Hyperliquid の金庫・大口・買い戻し」(オプション市場の前)。dHl2 をオフにすると入れない', () => {
  const { gas } = world({ wallets: [{ a: MINE, n: 'わたし' }], world: { wallets: { [MINE]: [['BTC', 'S', 3e6, 10]] } } });
  gas.ctx.hl2Record_();
  gas.ctx.pmDigest();
  const m = gas.mails[gas.mails.length - 1];
  assert.match(m.subject, /のまとめ/);
  const t = m.body;
  const i = t.indexOf('■■ Hyperliquid の金庫・大口・買い戻し');
  assert.ok(i > 0);
  assert.ok(i < t.indexOf('■ 記録の状況'));
  const sec = t.slice(i, t.indexOf('■ 記録の状況'));
  assert.match(sec, /■ 大口の買い越し・売り越し \(20人\)\n・BTC: 買い 3\.6億ドル \(12人\) ／ 売り 6,000万ドル \(3人\) → 買い越し 3億ドル\n・ETH: 買い 3,000万ドル \(3人\) ／ 売り 1\.5億ドル \(5人\) → 売り越し 1\.2億ドル\n・SOL: .*\n・HYPE: /);
  assert.match(sec, /■ 大きいポジション \(上位5つ\)\n・\(0xa000…1003\) BTC 買い 2\.5億ドル ×5\n/);
  assert.match(sec, /■ 見張っているアドレス\n・⭐ わたし \(0x1111…0000\) 口座 500万ドル: BTC 売り 300万ドル ×10/);
  assert.match(sec, /・HLP 金庫: 預かり 3\.9億ドル ／ 損益 1日 \+120万ドル・7日 −70万ドル・30日 \+396万ドル ／ 年率 12\.3%/);
  assert.match(sec, /・買い戻し基金: HYPE 3210万枚 \(12\.8億ドル\)/);
  assert.match(sec, /・上場オークション: 今 1,516\.1 HYPE \(下限 500 HYPE\)/);
  assert.match(m.htmlBody, /🐋 Hyperliquid の金庫・大口・買い戻し/);
  assert.match(m.htmlBody, /&lt;img src=x onerror=alert\(1\)&gt;|0xa000…1003/);
  assert.doesNotMatch(m.htmlBody, /<img src=x/);
  // オフ
  gas.post({ action: 'pmConfig', notify: { dHl2: false } });
  gas.ctx.pmDigest();
  assert.doesNotMatch(gas.mails[gas.mails.length - 1].body, /Hyperliquid の金庫/);
});

test('毎朝のまとめ: データが無ければ入れない', () => {
  const { gas } = world({ world: { down: { all: true } } });
  gas.ctx.pmDigest();
  assert.doesNotMatch(gas.mails[gas.mails.length - 1].body, /Hyperliquid の金庫/);
});

test('レポート: 「## 12.」に日ごとの表・大口の集計・見張るアドレスのポジション。既定の parts に入っている', () => {
  const { gas, clock, w } = world({ wallets: [{ a: MINE, n: 'わたし' }], world: { wallets: { [MINE]: [['BTC', 'S', 3e6, 10]] } } });
  gas.ctx.hl2Record_();
  clock.tick(DAY); w.afHype += 50000; gas.ctx.hl2Record_();
  const t = gas.get({ action: 'report', days: '7', parts: 'hl2' }).text;
  assert.match(t, /## 12\. Hyperliquid の HLP 金庫・大口のポジション・HYPE の買い戻し・上場オークション/);
  assert.match(t, /\| 日付 \| HLP の預かり \| HLP の1日の損益 \| 買い戻し基金の HYPE \| その評価額 \| 上場オークションの価格 \(HYPE\) \| 大口の買い越し額 BTC \| ETH \| SOL \| HYPE \|/);
  assert.match(t, /\| 2026-11-12 \| 3\.9億ドル \| \+120万ドル \| 3210万 \| 12\.8億ドル \| 1516\.13 \| \+3億ドル \| −1\.2億ドル \| \+0ドル \| \+2,000万ドル \|/);
  assert.match(t, /\| 2026-11-13 \| 3\.9億ドル \| \+120万ドル \| 3215万 \|/);
  assert.match(t, /\| BTC \| 3\.6億ドル \| 12 \| 6,000万ドル \| 3 \| \+3億ドル \|/);
  assert.match(t, /\| わたし \(0x1111…0000\) \| BTC \| 売り \| 300万ドル \| 10倍 \| −6万ドル \| 98000 \| 120000 \|/);
  assert.match(gas.get({ action: 'report', days: '7' }).text, /## 12\. Hyperliquid/);
});

/* ---------------- アプリ (Hyperliquid のタブの中) ---------------- */
const offline = async () => { throw new TypeError('offline'); };
const appState = (o) => ({ projects: [], settings: Object.assign({ gasUrl: GAS_URL, gasAuto: false }, o || {}), deleted: {} });
/** アプリ用: ほかのタブが呼ぶ Hyperliquid (metaAndAssetCtxs など) にも最低限の答えを返す */
function appWorld(opts) {
  const z = world(opts);
  const inner = z.gas.ctx.UrlFetchApp.fetch;
  z.gas.ctx.UrlFetchApp.fetch = (url, params) => {
    if (/api\.hyperliquid\.xyz/.test(url) && params && params.payload) {
      const t = JSON.parse(params.payload).type;
      if (t === 'metaAndAssetCtxs') return ok([{ universe: [{ name: 'BTC' }] }, [{ markPx: '100000', prevDayPx: '99000', openInterest: '1', funding: '0', dayNtlVlm: '1', premium: '0' }]]);
      if (!['vaultDetails', 'clearinghouseState', 'spotClearinghouseState', 'allMids', 'spotDeployState', 'perpDeployAuctionStatus'].includes(t)) return ok([]);
    }
    return inner(url, params);
  };
  return z;
}
const open = async (z, st) => {
  const app = await openApp({ clock: z.clock, gas: z.gas, fetch: offline, state: st || appState() });
  for (let i = 0; i < 8; i++) await app.settle();
  return app;
};
const goHl = async app => { app.doc.querySelector('nav button[data-tab="hl"]').click(); for (let i = 0; i < 6; i++) await app.settle(); };

test('アプリ: Hyperliquid のタブに 読み取り・大口の買い越しの棒・口座の表 (押すと開く)・HLP・買い戻し・上場オークション。ホームに2行', async () => {
  const z = appWorld({ wallets: [{ a: MINE, n: 'わたし' }], world: { wallets: { [MINE]: [['BTC', 'S', 3e6, 10]] } } });
  z.gas.ctx.hl2Record_(); z.clock.tick(DAY); z.w.afHype += 50000; z.gas.ctx.hl2Record_();
  const app = await open(z);
  try {
    const home = app.text('#homeBody').replace(/\s+/g, '');
    assert.match(home, /🐋大口20人のBTC:12人が買い・3人が売り.*買い越し3\.0億ドル/);
    assert.match(home, /🏦HLP金庫の1日の損益プラス=取引する人たちが全体として損\+120万ドル/);
    await goHl(app);
    assert.equal(app.doc.querySelectorAll('#h2Read li').length, 8);
    assert.ok(app.doc.querySelector('#h2Read .term[data-term="hlp"]'), '用語に下線');
    assert.match(app.text('#h2Info'), /時点$/);
    // 買い越し・売り越しの棒
    const net = [...app.doc.querySelectorAll('#h2Net .h2-net-row')];
    assert.deepEqual(net.map(r => r.dataset.h2coin), ['BTC', 'ETH', 'SOL', 'HYPE', 'X8', 'X7', 'X6', 'X5', 'X4', 'X3']);
    assert.match(net[0].textContent, /売り 6,000万ドル \(3人\) ／ 買い 3\.6億ドル \(12人\) → 買い越し 3\.0億ドル/);
    assert.match(net[1].textContent, /売り越し 1\.2億ドル/);
    assert.equal(net[0].querySelector('.h2-half-l span').style.width, '100%', 'いちばん大きい BTC の買いが端まで');
    assert.equal(net[0].querySelector('.h2-half-s span').style.width, '16.7%', '6000万 ÷ 3.6億');
    assert.equal(net[1].querySelector('.h2-half-s span').style.width, '41.7%', '1.5億 ÷ 3.6億');
    // 口座の表
    let rows = [...app.doc.querySelectorAll('#h2Whales tr.h2-acct')];
    assert.equal(rows.length, 20);
    assert.match(rows[0].textContent.replace(/\s+/g, ' '), /Whale One 0xa000…1001📋2\.4億ドル\+1万ドル ETH 売り 3,000万ドル ×5BTC 買い 1,000万ドル ×5X8 買い 800万ドル ×5/);
    // 悪意のある名前は文字のまま
    assert.match(rows[1].textContent, /<img src=x onerror=alert\(1\)>/);
    assert.equal(app.doc.querySelector('#h2Area img'), null);
    assert.equal(app.doc.querySelector('#tab-hl img'), null);
    // 押すと開く
    rows[0].click();
    const det = app.doc.querySelector('#h2Whales tr.h2-detail');
    assert.ok(det);
    const pr = [...det.querySelectorAll('table.h2-pos > tbody > tr')];
    assert.equal(pr.length, 6);
    assert.deepEqual([...pr[0].querySelectorAll('td')].map(td => td.textContent), ['ETH', '売り', '3,000万ドル', '5倍', '−60万ドル', '$3,920', '$4,800']);
    assert.match(det.textContent, /ほかに小さいポジションが 5件あります/);
    app.doc.querySelector('#h2Whales tr.h2-acct').click();
    assert.equal(app.doc.querySelector('#h2Whales tr.h2-detail'), null, 'もう一度押すと閉じる');
    // アドレスのコピー
    let copied = null;
    Object.defineProperty(app.win.navigator, 'clipboard', { value: { writeText: async s => { copied = s; } }, configurable: true });
    app.doc.querySelector('#h2Whales [data-h2copy]').click();
    await app.settle();
    assert.equal(copied, addr(1));
    // 見張るアドレス
    assert.match(app.text('#h2Watch').replace(/\s+/g, ' '), /⭐ わたし 0x1111…0000📋500万ドル- BTC 売り 300万ドル ×10/);
    // HLP
    const hlp = app.text('#h2Hlp');
    assert.match(hlp, /預かり資産3\.9億ドル預けている人 2人以上/);
    assert.match(hlp, /1日の損益\+120万ドル/);
    assert.match(hlp, /7日の損益−70万ドル/);
    assert.match(hlp, /30日の損益\+396万ドル/);
    assert.match(hlp, /全期間の損益\+6,000万ドル年率 12\.3%/);
    assert.equal(app.doc.querySelectorAll('#h2Hlp svg').length, 2);
    // 買い戻し (2日分の記録)
    const af = app.text('#h2Af');
    assert.match(af, /持っている HYPE3215万枚HYPE \$40\.00/);
    assert.match(af, /1日で増えた量\+5万枚約 200万ドル/);
    assert.match(af, /7日で増えた量記録が8日分たまると出ます/);
    assert.ok(app.doc.querySelector('#h2Af svg'), '2日分あるのでグラフ');
    // 上場オークション
    const au = app.text('#h2Auc');
    assert.match(au, /いまの値段1,516\.1 HYPE \(約 6万ドル\)/);
    assert.match(au, /残り時間あと 21時間/);
    assert.match(au, /始まりの値段 → 下限2,000 → 500/);
    assert.match(au, /先物市場の登録 \(HIP-3\) のオークション: 今 500 HYPE/);
    assert.ok(app.doc.querySelector('#h2Auc svg'));
    // ? で解説
    app.doc.querySelector('#h2Area .gq[data-term="listauc"]').click();
    assert.match(app.text('#termBody'), /上場オークション/);
    // ↻ で取り直す (force=1)
    const before = app.requests.length;
    app.doc.querySelector('#hlReload').click();
    for (let i = 0; i < 4; i++) await app.settle();
    assert.ok(app.requests.slice(before).some(r => /action=hl2&force=1/.test(r.url)));
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('アプリ: 見張るアドレスの追加 (形の確かめ・重なり)・外す。サーバーに保存する', async () => {
  const z = appWorld({ wallets: [{ a: MINE, n: 'わたし' }] });
  z.gas.ctx.hl2Record_();
  const app = await open(z);
  try {
    await goHl(app);
    const posts = () => app.requests.filter(r => r.init && r.init.method === 'POST').length;
    const add = async (a, n) => { app.doc.querySelector('#h2Addr').value = a; app.doc.querySelector('#h2Label').value = n || ''; app.doc.querySelector('#h2Add').click(); for (let i = 0; i < 3; i++) await app.settle(); };
    await add('0x1234', 'だめ');
    assert.match(app.text('#h2Msg'), /❌ アドレスの形が違います/);
    assert.equal(posts(), 0, '形が違えば送らない');
    await add(MINE.toUpperCase().replace('0X', '0x'));
    assert.match(app.text('#h2Msg'), /もう入っています/);
    assert.equal(posts(), 0);
    await add(MINE2, '  <b>友だち</b>  ');
    assert.equal(posts(), 1);
    assert.match(app.text('#h2Msg'), /⭐ 追加しました/);
    assert.deepEqual(JSON.parse(z.gas.props.getProperty('HL_WALLETS')), [{ a: MINE, n: 'わたし' }, { a: MINE2, n: 'b友だち/b' }]);
    assert.match(app.text('#h2Watch'), /⭐ b友だち\/b 0x2222…1111📋 次の更新 \(1時間以内\) で表示されます/);
    assert.equal(app.doc.querySelector('#h2Addr').value, '');
    // 外す
    app.doc.querySelector(`#h2Watch [data-h2del="${MINE2}"]`).click();
    for (let i = 0; i < 3; i++) await app.settle();
    assert.equal(posts(), 2);
    assert.deepEqual(JSON.parse(z.gas.props.getProperty('HL_WALLETS')), [{ a: MINE, n: 'わたし' }]);
    assert.match(app.text('#h2Msg'), /見張るのをやめました/);
    assert.ok(!app.text('#h2Watch').includes('0x2222'));
    // 10件まで
    for (let i = 0; i < 9; i++) await add('0x' + String(i).padStart(2, '0') + 'cd'.repeat(19));
    assert.equal(JSON.parse(z.gas.props.getProperty('HL_WALLETS')).length, 10);
    await add(MINE2);
    assert.match(app.text('#h2Msg'), /見張れるのは 10件までです/);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('アプリ: 記録が1日分だけ・一部取得できず・サーバー未設定・取得できない時の表示', async () => {
  const z = appWorld();
  z.gas.ctx.hl2Record_();
  z.clock.tick(2 * H); z.w.down.af = true; z.gas.ctx.hl2Record_();
  let app = await open(z);
  try {
    await goHl(app);
    assert.match(app.text('#h2Info'), /一部取得できず \(買い戻し基金\)/);
    assert.match(app.text('#h2Af'), /1日で増えた量記録が2日分たまると出ます/);
    assert.match(app.text('#h2Af'), /記録が2日分以上たまると描きます/);
    assert.match(app.text('#h2Auc'), /記録が2日分以上たまると描きます/);
    assert.match(app.text('#h2Watch'), /まだありません/);
    assert.equal(app.doc.querySelector('#h2Af svg'), null);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
  // サーバー未設定
  app = await open(appWorld(), appState({ gasUrl: '' }));
  try {
    await goHl(app);
    assert.match(app.text('#h2Read'), /設定でサーバー \(Apps Script\) の URL を入れると、HLP 金庫・大口のポジション・買い戻しが表示されます/);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
  // 全部取得できない (前回も無い)
  const y = appWorld({ world: { down: { all: true } } });
  app = await open(y);
  try {
    await goHl(app);
    assert.match(app.text('#h2Read'), /取得できませんでした: .*Hyperliquid から取得できませんでした/);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('アプリ: 設定に通知 (hlw・hlwMin 百万ドル)・毎朝のまとめ (dHl2)・AI に渡す記録のチェック (hl2)', async () => {
  const z = appWorld();
  const app = await open(z);
  try {
    for (const k of ['hlw', 'hlwMin', 'dHl2']) assert.ok(app.doc.querySelector(`[data-ntf="${k}"]`), k);
    assert.match(app.doc.querySelector('[data-ntf="hlwMin"]').parentElement.textContent, /百万ドル/);
    const cb = app.doc.querySelector('input[type="checkbox"][value="hl2"]');
    assert.ok(cb);
    assert.match(cb.parentElement.textContent, /🐋 Hyperliquid の金庫・大口・買い戻し/);
    assert.equal(app.run('APP_VERSION'), '2026.12.12');
    assert.equal(app.run('MIN_GAS_VERSION'), z.gas.C.GAS_VERSION);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});
