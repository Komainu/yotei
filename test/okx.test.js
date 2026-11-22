'use strict';
/* 取引所の先物 (OKX の公開 API・キー不要): ロング・ショート比率・清算・成行の買い/売り */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('./helpers/gas');
const { openApp, GAS_URL } = require('./helpers/app');
const { createClock } = require('./helpers/clock');
const { okxFetch } = require('./helpers/okx');
const { cgFetch } = require('./helpers/cg');
const { deribitFetch } = require('./helpers/deribit');

const M = 60000, H = 60 * M, D = 24 * H;
const ok = o => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify(o) });
const MAIL = { MAIL_TO: 'muse@example.com' };
const SIDE = ['opt', 'news', 'us', 'llama2', 'hl2', 'cg', 'okx'];
/** OKX (と、まとめの順番を見るための CoinGecko・Deribit) だけ答える世界。ev = 通信と待ち (sleep) の順番 */
function world(opts) {
  opts = opts || {};
  const clock = createClock(opts.at || '2026-11-14T10:00:00+09:00');
  const okx = okxFetch(clock, opts.world), cg = cgFetch(clock), dr = deribitFetch(clock), ev = [];
  const fetch = (url, params) => {
    const r = okx(url, params); if (r) { ev.push('fetch'); return r; }
    const c = cg(url, params) || dr(url); if (c) return c;
    if (/gamma-api\.polymarket\.com\/markets/.test(url)) return ok([]);
    if (/gamma-api|kalshi/.test(url)) return ok({ events: [] });
    throw new Error('使わない: ' + url);
  };
  const gas = loadGas({ clock, fetch, props: opts.props || {} });
  gas.ctx.Utilities.sleep = ms => { ev.push('sleep ' + ms); };
  return { clock, gas, w: okx.world, calls: okx.calls, ev };
}
const file = (gas, name) => { const f = gas.drive.folderFiles('ポリマーケット記録').find(x => x.name === name); return f ? JSON.parse(f.content) : null; };
const plain = x => JSON.parse(JSON.stringify(x));
const health = gas => gas.get({ action: 'health' }).health.jobs.find(j => j.k === 'okx');
const liqMails = gas => gas.mails.filter(m => /先物の清算/.test(m.subject));
/** 定期の取得のうち okx だけが時間になっている状態で、pmSideJobs_ を1回動かす */
function runOkxJob(gas) {
  const now = gas.clock.now, last = {};
  SIDE.forEach(k => { last[k] = k === 'okx' ? now - 2 * H : now; });
  gas.props.setProperty('SIDE_LAST', JSON.stringify(last));
  return gas.ctx.pmSideJobs_();
}
const seedHist = gas => gas.ctx.pmWrite_('okx-2026-11.json', JSON.stringify({ '2026-11-12': { BTC: [2, 5e7, 1e7, 1.1], ETH: [1.4, 0, 0, 1] } }));

/* ---------- サーバー ---------- */
test('サーバー: 口座の数のロング・ショート比率 (いまと24時間前)・成行の買い/売り (24時間・ドル)・清算 (枚数 × 1枚の大きさ × 価格 = ドル、カバーする時間)', () => {
  const { gas, clock, calls } = world();
  const r = gas.get({ action: 'okx' });
  assert.equal(r.ok, true);
  assert.equal(r.version, gas.C.GAS_VERSION);
  assert.deepEqual(r.coins, ['BTC', 'ETH', 'SOL', 'HYPE']);
  const b = r.okx.coins.BTC;
  assert.equal(b.ls, 2.6);
  assert.equal(b.ls24, 1.5);
  assert.deepEqual(plain(b.taker), { buy24: 1.44e9, sell24: 1.2e9, ratio: 1.2, h: 24 });
  // 清算: 100件で約5時間 (いちばん古いのは 298分前)。買い 89件 × 120万ドル + 1件 400万ドル、売り 10件 × 20万ドル (最後の1件は片側モードの side=buy)
  assert.deepEqual(plain(b.liq), { long1h: 26.8e6, short1h: 0, long24: 110.8e6, short24: 2e6, n: 100, span: 5, last: clock.now - M,
    biggest: { side: 'long', usd: 4e6, px: 80000, t: clock.now - 16 * M } });
  const e = r.okx.coins.ETH;
  assert.equal(e.liq.span, 24, '100件に満たなければ24時間分');
  assert.equal(e.liq.n, 0, '26日前の清算は数えない');
  assert.equal(e.liq.last, clock.now - 26 * D);
  assert.equal(r.okx.coins.SOL.liq.n, 0);
  assert.equal(r.okx.coins.HYPE.liq.short24, 120000, '1万枚 × 0.1 × 40ドル × 3件');
  assert.equal(r.okx.coins.HYPE.ls, 0.55);
  assert.deepEqual(r.okx.errors, []);
  assert.equal(calls.length, 12, '1回に12回まで');
  assert.deepEqual(calls.slice(0, 3).map(c => c.part), ['ls', 'liq', 'taker']);
  assert.ok(calls.every(c => c.headers.accept === 'application/json'));
});

test('読み取り: 口座の傾き・清算 (直近N時間)・成行・偏りの注意 (数は手で確かめた値)。古い清算しか無い時はそう書く', () => {
  let z = world();
  assert.deepEqual(z.gas.get({ action: 'okx' }).okx.read, [
    'OKX の BTC 先物は、口座の数で見ると買い 2.6 : 売り 1 (24時間前は 1.5)。口座の多く (主に個人) は買いに傾いています',
    'BTC: 直近5時間で買いの清算 1.1億ドル・売りの清算 200万ドル: 値下がりで買いの人が強制的に手じまいさせられました',
    'OKX の ETH 先物は、口座の数で見ると買い 1.8 : 売り 1 (24時間前は 1.5)。口座の多く (主に個人) は買いに傾いています',
    'OKX の SOL 先物は、口座の数で見ると買い 1 : 売り 1 (24時間前は 1.1)。買いと売りはほぼ半々です',
    'OKX の HYPE 先物は、口座の数で見ると買い 0.55 : 売り 1 (24時間前は 0.7)。口座の多く (主に個人) は売りに傾いています',
    'BTC の24時間の成行の注文 (テイカー) は買い 1.2 : 売り 1 (買い 14.4億ドル・売り 12億ドル)。急いで買う人が多めです',
    'BTC・HYPE は片方に大きく偏っています。偏った側は、逆に動いた時に一気に清算 (踏み上げ・投げ売り) が起きやすくなります',
  ]);
  // 清算が古いものだけ (本物でも最後の清算が何週間も前のことがあった) → そう書く。売りの清算が多い時
  const { defaultLiq } = require('./helpers/okx');
  const now = Date.parse('2026-11-14T10:00:00+09:00'), L = defaultLiq(now);
  z = world({ world: { liq: { BTC: L.ETH, ETH: L.ETH, SOL: [], HYPE: [] }, taker: { BTC: [60e6, 50e6] } } });
  let read = z.gas.get({ action: 'okx' }).okx.read;
  assert.ok(read.includes('OKX の公開データでは、24時間以内の大きな清算は出ていません (最後の記録は 10/19)'));
  assert.ok(read.includes('BTC の24時間の成行の注文 (テイカー) は買い 0.83 : 売り 1 (買い 12億ドル・売り 14.4億ドル)。急いで売る人が多めです'));
  const sh = Array.from({ length: 20 }, (_, i) => ({ bkPx: '3000', posSide: 'short', side: 'buy', sz: '2000', ts: String(now - (i + 1) * H) }));   // 2000枚 × 0.1 × 3000 = 60万ドル × 20
  z = world({ world: { liq: { ETH: sh } } });
  read = z.gas.get({ action: 'okx' }).okx.read;
  assert.ok(read.includes('ETH: 24時間で買いの清算 0ドル・売りの清算 1,200万ドル: 値上がりで売りの人が強制的に手じまいさせられました'));
  for (const x of read) assert.doesNotMatch(x, /買いましょう|売りましょう|おすすめ/);
});

test('日ごとの行: okx-YYYY-MM.json に { 銘柄: [比率, 買いの清算, 売りの清算, 成行の比率] }。doGet の hist に入る', () => {
  const { gas } = world();
  seedHist(gas);
  const r = gas.get({ action: 'okx' });
  const f = file(gas, 'okx-2026-11.json');
  assert.deepEqual(f['2026-11-14'], { BTC: [2.6, 110800000, 2000000, 1.2], ETH: [1.8, 0, 0, 0.9], SOL: [1, 0, 0, 1], HYPE: [0.55, 0, 120000, 1] });
  assert.ok(f['2026-11-12']);
  assert.deepEqual(Object.keys(r.hist).sort(), ['2026-11-12', '2026-11-14']);
});

test('回数の制限: 1回に12回まで・あいだに0.25秒。55分は取り直さない。force=1 でも前回から10分以内なら取りに行かない', () => {
  const { gas, clock, calls, ev } = world();
  gas.get({ action: 'okx' });
  assert.equal(ev.filter(x => x === 'fetch').length, 12);
  assert.equal(ev.filter(x => x === 'sleep 250').length, 11);
  assert.equal(ev[0], 'fetch');
  assert.ok(ev.every((x, i) => (i % 2 ? x === 'sleep 250' : x === 'fetch')), '呼び出しのあいだに待つ');
  clock.tick(54 * M);
  gas.get({ action: 'okx' });
  assert.equal(calls.length, 12, '54分はキャッシュ');
  clock.tick(M);
  gas.get({ action: 'okx' });
  assert.equal(calls.length, 24, '55分で取り直す');
  clock.tick(9 * M);
  gas.get({ action: 'okx', force: '1' });
  gas.ctx.okxRecord_();
  assert.equal(calls.length, 24, '前回から9分なら強制でも取りに行かない (定期の取得も同じ)');
  clock.tick(M);
  gas.get({ action: 'okx', force: '1' });
  assert.equal(calls.length, 36);
});

test('失敗: 1つが落ちても他は新しくなり、落ちたものは前回のまま errors に HTTP の番号。全部 403 なら「サーバーの場所から使えない可能性」を doGet と見張りに', () => {
  const { gas, clock, w } = world();
  gas.get({ action: 'okx' });
  clock.tick(H);
  w.down = { 'ETH:liq': 503, SOL: 429 };
  w.ls = { BTC: [3, 2], ETH: [1.9, 1.5], SOL: [5, 5], HYPE: [1, 1] };
  let r = gas.get({ action: 'okx' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.okx.errors, ['ETH 清算 (HTTP 503)', 'SOL ロング・ショート比率 (HTTP 429)', 'SOL 清算 (HTTP 429)', 'SOL 成行の買い・売り (HTTP 429)']);
  assert.equal(r.okx.coins.BTC.ls, 3, '取れたものは新しい');
  assert.equal(r.okx.coins.ETH.liq.last, clock.now - H - 26 * D, '落ちた清算は前回のまま');
  assert.equal(r.okx.coins.SOL.ls, 1, 'SOL は前回のまま');
  // 全部 403 (米国の IP など)
  const at = r.okx.at;
  clock.tick(H);
  w.all = 403;
  r = gas.get({ action: 'okx' });
  assert.equal(r.ok, true, '前回の値があれば返す');
  assert.equal(r.okx.at, at);
  assert.equal(r.error, 'OKX に接続できません (HTTP 403)。サーバーの場所から使えない可能性があります');
  clock.tick(11 * M);
  assert.equal(runOkxJob(gas), 'okx');
  let h = health(gas);
  assert.equal(h.st, 'error');
  assert.match(h.err, /OKX に接続できません \(HTTP 403\)。サーバーの場所から使えない可能性があります/);
  w.all = 0; clock.tick(H);
  runOkxJob(gas);
  assert.equal(health(gas).st, 'ok', '直れば ok');
  // 前回も無ければ ok:false
  const z = world({ world: { all: 403 } });
  r = z.gas.get({ action: 'okx' });
  assert.equal(r.ok, false);
  assert.equal(r.okx, null);
  assert.equal(r.error, 'OKX に接続できません (HTTP 403)。サーバーの場所から使えない可能性があります');
  runOkxJob(z.gas);
  h = health(z.gas);
  assert.equal(h.n, '取引所の先物 (OKX)');
  assert.equal(h.every, '1時間ごと');
  assert.match(h.err, /HTTP 403/);
  // ほかの番号
  const y = world({ world: { all: 500 } });
  assert.equal(y.gas.get({ action: 'okx' }).error, 'OKX に接続できません (HTTP 500)。時間をおいて取り直します');
});

test('通知: 片方の清算が基準 (既定 100 百万ドル) 以上 → 読み取りつきで1通。同じ銘柄・向きは6時間に1回。基準は pmConfig (liqMin・10〜5000)。オフ・送り先なし・急変の通知オフでは送らない', () => {
  const { gas, clock } = world({ props: MAIL });
  gas.ctx.okxRecord_();
  let m = liqMails(gas);
  assert.equal(m.length, 1);
  assert.equal(m[0].subject, '【ポリマーケット】先物の清算: BTC 買いの清算 1.1億ドル (直近5時間)');
  assert.match(m[0].body, /基準 1億ドル 以上/);
  assert.match(m[0].body, /・BTC 買いの清算 1\.1億ドル \(直近5時間\) — 値下がりで買いの人が強制的に手じまいさせられました/);
  assert.match(m[0].body, /■ いまの読み取り\n・OKX の BTC 先物は、口座の数で見ると買い 2\.6 : 売り 1/);
  assert.doesNotMatch(m[0].body, /・(ETH|SOL|HYPE) (買い|売り)の清算/, '基準に届かない銘柄は入れない');
  // 1時間後: 同じ → 送らない (6時間に1回)
  clock.tick(H); gas.ctx.okxRecord_();
  assert.equal(liqMails(gas).length, 1);
  clock.tick(5 * H); gas.ctx.okxRecord_();
  assert.equal(liqMails(gas).length, 2, '6時間たてばまた送る');
  // 基準を上げる → 送らない。範囲に収める
  gas.post({ action: 'pmConfig', notify: { liqMin: 300 } });
  clock.tick(7 * H); gas.ctx.okxRecord_();
  assert.equal(liqMails(gas).length, 2);
  gas.post({ action: 'pmConfig', notify: { liqMin: 1 } });
  assert.equal(gas.ctx.ntf_().liqMin, 10, '10 より小さくはできない');
  gas.post({ action: 'pmConfig', notify: { liqMin: 99999 } });
  assert.equal(gas.ctx.ntf_().liqMin, 5000);
  // 売りの清算 (2百万ドル) は基準 10 でも届かない。オフ
  gas.post({ action: 'pmConfig', notify: { liqMin: 100, okx: false } });
  clock.tick(7 * H); gas.ctx.okxRecord_();
  assert.equal(liqMails(gas).length, 2, 'okx をオフ');
  gas.post({ action: 'pmConfig', notify: { okx: true }, alertOn: false });
  clock.tick(7 * H); gas.ctx.okxRecord_();
  assert.equal(liqMails(gas).length, 2, '急変の通知をオフ');
  const z = world();
  z.gas.ctx.okxRecord_();
  assert.equal(z.gas.mails.length, 0, '送り先なし');
});

test('毎朝のまとめ: 「■■ 取引所の先物 (OKX)」(読み取り + 銘柄ごとの1行) を CoinGecko・オプション市場の前に。dOkx オフ・データなしは載せない', () => {
  const { gas } = world({ props: MAIL });
  gas.get({ action: 'okx' });
  gas.get({ action: 'cg' });
  gas.ctx.pmDigest();
  const m = gas.mails[gas.mails.length - 1], body = m.body;
  const i = body.indexOf('■■ 取引所の先物 (OKX)');
  assert.ok(i > 0);
  const sec = body.slice(i);
  assert.match(sec, /^■■ 取引所の先物 \(OKX\)\n・OKX の BTC 先物は、口座の数で見ると買い 2\.6 : 売り 1/);
  assert.match(sec, /■ 銘柄ごと\n・BTC: ロング・ショート 2\.6 \(24時間前 1\.5\) ／ 清算 \(直近5時間\) 買い 1\.1億ドル・売り 200万ドル ／ 成行 買い÷売り 1\.2\n・ETH: ロング・ショート 1\.8 \(24時間前 1\.5\) ／ 清算 \(24時間\) 買い 0ドル・売り 0ドル ／ 成行 買い÷売り 0\.9\n/);
  assert.match(m.htmlBody, /🏦 取引所の先物 \(OKX\)/);
  // 順番: 取引所の先物 → 暗号資産の市場全体 → オプション市場 → 記録の状況
  const iCg = body.indexOf('■■ 暗号資産の市場全体'), iOpt = body.indexOf('■■ オプション市場');
  assert.ok(i < iCg && iCg < iOpt && iOpt < body.indexOf('■ 記録の状況'));
  gas.post({ action: 'pmConfig', notify: { dOkx: false } });
  gas.ctx.pmDigest();
  assert.doesNotMatch(gas.mails[gas.mails.length - 1].body, /取引所の先物/);
  const z = world({ props: MAIL });
  z.gas.ctx.pmDigest();
  assert.doesNotMatch(z.gas.mails[z.gas.mails.length - 1].body, /取引所の先物/);
  assert.equal(z.calls.length, 0, 'まとめでは取りに行かない');
});

test('レポート: parts=okx で「## 15. 取引所の先物 (OKX)」(銘柄ごとの日ごとの表)。既定の中身にも入る', () => {
  const { gas } = world();
  seedHist(gas);
  gas.get({ action: 'okx' });
  const t = gas.get({ action: 'report', days: '7', parts: 'okx' }).text;
  assert.match(t, /## 15\. 取引所の先物 \(OKX\)/);
  assert.match(t, /### BTC\n\| 日付 \| ロング・ショート比率 \| 買いの清算 \(ドル\) \| 売りの清算 \(ドル\) \| 成行の買い÷売り \|\n\|---\|---\|---\|---\|---\|\n\| 2026-11-12 \| 2 \| 50000000 \| 10000000 \| 1\.1 \|\n\| 2026-11-14 \| 2\.6 \| 110800000 \| 2000000 \| 1\.2 \|/);
  assert.match(t, /### HYPE\n/);
  assert.match(t, /いまの読み取り: OKX の BTC 先物は/);
  assert.match(gas.get({ action: 'report', days: '7' }).text, /## 15\. 取引所の先物 \(OKX\)/);
});

/* ---------- アプリ ---------- */
test('アプリ: Hyperliquid タブの要約の後に「🏦 ほかの取引所 (OKX)」(銘柄ごとの比率の2色の帯・24時間前・清算 (直近N時間)・成行・読み取り・推移)。↻ で取り直し、ホームに行', async () => {
  const { gas, clock } = world();
  seedHist(gas);
  gas.props.setProperty('API_SECRET', 'secret-pass-12345');
  const app = await openApp({ clock, gas, fetch: async () => { throw new TypeError('offline'); }, state: { settings: { gasUrl: GAS_URL, gasKey: 'secret-pass-12345', gasAuto: false } } });
  try {
    app.run('switchTab("hl")');
    for (let i = 0; i < 6; i++) await app.settle();
    const area = app.doc.querySelector('#okArea');
    assert.ok(app.doc.querySelector('#hlSum').compareDocumentPosition(area) & 4, '要約の後');
    assert.ok(area.compareDocumentPosition(app.doc.querySelector('#hlChartBox')) & 4);
    const cards = [...app.doc.querySelectorAll('#okBody .ok-coin')];
    assert.equal(cards.length, 4);
    const btc = cards[0];
    assert.match(btc.textContent, /^BTC買い 2\.6 : 売り 1買い 72%売り 28%24時間前買い 1\.5 : 売り 1清算 \(直近5時間\) \?買い 1\.1億ドル ・ 売り 200万ドル買い 98%売り 2%いちばん大きい清算買い 400万ドル \(80,000ドル\)成行の買い÷売り \(24時間\) \?1\.2$/);
    assert.equal(btc.querySelector('.ok-ls .l').style.width, '72%');
    assert.match(cards[1].textContent, /清算 \(24時間\)/);
    assert.doesNotMatch(cards[1].textContent, /いちばん大きい清算/, '清算が無ければ出さない');
    assert.equal(app.doc.querySelectorAll('#okRead li').length, 7);
    assert.match(app.text('#okRead'), /直近5時間で買いの清算 1\.1億ドル/);
    assert.equal(app.doc.querySelectorAll('#okChart svg').length, 1, '2日分あるので推移を描く');
    assert.match(app.text('#okInfo'), /時点$/);
    app.doc.querySelector('#okArea [data-term="lsratio"]').click();
    assert.match(app.text('#termBody'), /ロング・ショート比率/);
    app.doc.querySelector('#okBody [data-term="taker"]').click();
    assert.match(app.text('#termBody'), /テイカー/);
    // ↻
    const before = app.requests.filter(r => /action=okx&force=1/.test(r.url)).length;
    app.doc.querySelector('#hlReload').click();
    for (let i = 0; i < 4; i++) await app.settle();
    assert.equal(app.requests.filter(r => /action=okx&force=1/.test(r.url)).length, before + 1);
    assert.ok(JSON.parse(app.win.localStorage.getItem('okx_cache_v1')).okx.coins.BTC);
    // ホームの Hyperliquid のカード: 偏り (BTC 2.6) と大きな清算 (1.1億ドル) の2行まで
    app.run('switchTab("top")');
    for (let i = 0; i < 4; i++) await app.settle();
    const card = [...app.doc.querySelectorAll('#homeBody .hm-card')].find(c => /Hyperliquid/.test(c.querySelector('h3').textContent));
    const rows = [...card.querySelectorAll('.hm-row')].filter(r => /OKX/.test(r.textContent)).map(r => r.textContent);
    assert.deepEqual(rows, ['🏦 OKX の BTC: 買いの口座が大きく多いロング・ショート比率 (口座の数) ・ 24時間前 1.5買い 2.6 : 売り 1', '🏦 OKX の BTC: 買いの清算が多い (直近5時間)値下がりで買いの人が強制的に手じまいさせられました1.1億ドル']);
    for (const r of app.requests.filter(r => /action=okx/.test(r.url))) assert.match(r.url, /[?&]key=secret-pass-12345/);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('アプリ: 接続できない (HTTP 403) はそのままの案内・一部取得できず・前回の内容・エスケープ・サーバー未登録・ふつうの時はホームに行なし', async () => {
  // 全部 403 (前回なし)
  let z = world({ world: { all: 403 } });
  let app = await openApp({ clock: z.clock, gas: z.gas, fetch: async () => { throw new TypeError('offline'); }, state: { settings: { gasUrl: GAS_URL, gasAuto: false } } });
  try {
    app.run('switchTab("hl")');
    for (let i = 0; i < 6; i++) await app.settle();
    assert.match(app.text('#okBody'), /取得できませんでした: OKX に接続できません \(HTTP 403\)。サーバーの場所から使えない可能性があります/);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
  // 一部取得できず + 偏りも大きな清算も無い → ホームに行なし
  z = world({ world: { down: { 'ETH:liq': 503 }, ls: { BTC: [1.5, 1.5], ETH: [1, 1], SOL: [1, 1], HYPE: [1, 1] }, liq: {} } });
  app = await openApp({ clock: z.clock, gas: z.gas, fetch: async () => { throw new TypeError('offline'); }, state: { settings: { gasUrl: GAS_URL, gasAuto: false } } });
  try {
    app.run('switchTab("hl")');
    for (let i = 0; i < 6; i++) await app.settle();
    assert.match(app.text('#okInfo'), /一部取得できず \(ETH 清算 \(HTTP 503\)\)/);
    assert.match(app.text('#okChart'), /2日分たまると/);
    app.run('switchTab("top")');
    for (let i = 0; i < 4; i++) await app.settle();
    assert.doesNotMatch(app.text('#homeBody'), /OKX/);
    // 前回の内容のまま (全部 403 になった)
    z.w.all = 403; z.clock.tick(2 * H);
    app.run('loadOkx(true)');
    for (let i = 0; i < 4; i++) await app.settle();
    assert.equal(app.doc.querySelectorAll('#okBody .ok-coin').length, 4);
    assert.match(app.text('#okInfo'), /OKX に接続できません \(HTTP 403\).*\(前回の内容を表示しています\)/);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
  // サーバーから来た文はエスケープ
  z = world();
  z.gas.ctx.pmWrite_('okx-latest.json', JSON.stringify({ at: z.clock.now, coins: { BTC: { ls: 1, ls24: null, ct: 0.01 } }, read: ['<img src=x onerror=alert(1)>読み取り'], errors: ['<b>x</b>'] }));
  app = await openApp({ clock: z.clock, gas: z.gas, fetch: async () => { throw new TypeError('offline'); }, state: { settings: { gasUrl: GAS_URL, gasAuto: false } } });
  try {
    app.run('switchTab("hl")');
    for (let i = 0; i < 6; i++) await app.settle();
    assert.equal(app.doc.querySelectorAll('#okArea img, #okArea b b').length, 0);
    assert.match(app.text('#okRead'), /<img src=x onerror=alert\(1\)>読み取り/);
    assert.match(app.text('#okInfo'), /一部取得できず \(<b>x<\/b>\)/);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
  // サーバー未登録
  app = await openApp({ clock: z.clock, fetch: async () => { throw new TypeError('offline'); } });
  try {
    app.run('switchTab("hl")');
    await app.settle();
    assert.match(app.text('#okBody'), /設定でサーバー \(Apps Script\) の URL を入れると表示されます/);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('アプリ: 設定の通知 (okx・liqMin 百万ドル)・毎朝のまとめ (dOkx)・記録をAIに渡す (okx)。用語 (lsratio・taker・清算は既存の liq を使う)', async () => {
  const { gas, clock } = world({ props: MAIL });
  const app = await openApp({ clock, gas, fetch: async () => { throw new TypeError('offline'); }, state: { settings: { gasUrl: GAS_URL, gasAuto: false } } });
  try {
    const t = app.doc.querySelector('input[data-ntf="okx"]');
    assert.ok(t);
    assert.match(t.closest('label').textContent, /🏦 取引所の先物 \(OKX\)/);
    const g = t.closest('.ntf-g');
    assert.ok(g.querySelector('input[data-ntf="liqMin"]'));
    assert.match(g.textContent, /片方の清算が\s+百万ドル以上/);
    assert.ok(app.doc.querySelector('input[data-ntf="dOkx"]'));
    const cb = app.doc.querySelector('input[type="checkbox"][value="okx"]');
    assert.ok(cb && cb.checked);
    const G = app.run('GLOSS');
    assert.ok(G.lsratio && G.taker && G.liq);
    assert.ok(G.lsratio.r.every(r => G[r]) && G.taker.r.every(r => G[r]));
    assert.equal(Object.values(G).filter(x => /清算/.test(x.n)).length, 1, '清算の用語は1つだけ');
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});
