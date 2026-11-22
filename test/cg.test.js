'use strict';
/* 暗号資産の市場全体 (CoinGecko の公開 API・キー不要): 時価総額・ドミナンス・分野・注目の銘柄・企業の保有 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('./helpers/gas');
const { openApp, GAS_URL } = require('./helpers/app');
const { createClock } = require('./helpers/clock');
const { cgFetch } = require('./helpers/cg');
const { deribitFetch } = require('./helpers/deribit');

const M = 60000, H = 60 * M;
const ok = o => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify(o) });
const MAIL = { MAIL_TO: 'muse@example.com' };
const SIDE = ['opt', 'news', 'us', 'llama2', 'hl2', 'cg', 'okx'];
/** CoinGecko (と、まとめの順番を見るための Deribit) だけ答える世界。ev = 通信と待ち (sleep) の順番 */
function world(opts) {
  opts = opts || {};
  const clock = createClock(opts.at || '2026-11-14T10:00:00+09:00');
  const cg = cgFetch(clock, opts.world), dr = deribitFetch(clock), ev = [];
  const fetch = (url, params) => {
    const r = cg(url, params); if (r) { ev.push('fetch'); return r; }
    const d = dr(url); if (d) return d;
    if (/gamma-api\.polymarket\.com\/markets/.test(url)) return ok([]);
    if (/gamma-api|kalshi/.test(url)) return ok({ events: [] });
    throw new Error('使わない: ' + url);
  };
  const gas = loadGas({ clock, fetch, props: opts.props || {} });
  gas.ctx.Utilities.sleep = ms => { ev.push('sleep ' + ms); };
  return { clock, gas, w: cg.world, calls: cg.calls, ev };
}
const file = (gas, name) => { const f = gas.drive.folderFiles('ポリマーケット記録').find(x => x.name === name); return f ? JSON.parse(f.content) : null; };
const plain = x => JSON.parse(JSON.stringify(x));
/** 4日前の日ごとの行 (7日の変化を出すため) */
const seedHist = gas => gas.ctx.pmWrite_('cg-2026-11.json', JSON.stringify({ '2026-11-10': { btcDom: 57.5, ethDom: 12, stableDom: 8.2, mcap: 3.1e12 } }));
const health = gas => gas.get({ action: 'health' }).health.jobs.find(j => j.k === 'cg');
/** 定期の取得のうち cg だけが時間になっている状態で、pmSideJobs_ を1回動かす */
function runCgJob(gas) {
  const now = gas.clock.now, last = {};
  SIDE.forEach(k => { last[k] = k === 'cg' ? now - 3 * H : now; });
  gas.props.setProperty('SIDE_LAST', JSON.stringify(last));
  return gas.ctx.pmSideJobs_();
}

/* ---------- サーバー ---------- */
test('サーバー: /global・/search/trending・/coins/categories・企業の保有を読み、数をそろえる (ドミナンスは 0.01%、ステーブルコイン = USDT + USDC)', () => {
  const { gas, calls } = world();
  const r = gas.get({ action: 'cg' });
  assert.equal(r.ok, true);
  assert.equal(r.version, gas.C.GAS_VERSION);
  const d = r.cg;
  assert.deepEqual(plain(d.global), { mcap: 3.2e12, vol: 1.1e11, btcDom: 58.23, ethDom: 11.5, stableDom: 7.7, chg24: -1.23 });
  assert.equal(d.trend.length, 10, '10件まで');
  assert.deepEqual(plain(d.trend[0]), { n: 'Pepe', sym: 'PEPE', rank: 30, chg: 12.3 });
  assert.equal(d.trend[3].rank, null);
  assert.equal(d.trend[4].sym, 'ALP', '記号は大文字');
  assert.deepEqual(d.cats.up.map(c => [c.n, c.chg]), [['Meme', 8.1], ['RWA', 3.3], ['DeFi', 2]], '10億ドル未満 (Tiny Cat) と値動きが無いものは除く');
  assert.deepEqual(d.cats.down.map(c => [c.n, c.chg]), [['AI', -4.3], ['Gaming', -1], ['Smart Contract Platform', -0.5]]);
  assert.equal(d.cats.big[0].n, 'Smart Contract Platform');
  assert.equal(d.cats.big.length, 8, '名前の無いものは捨てる');
  assert.deepEqual(plain(d.treas.btc.top[0]), { n: 'Strategy', sym: 'MSTR.US', cty: 'US', h: 843738, usd: 6.45e10, pct: 4.018 });
  assert.equal(d.treas.btc.total, 1272129);
  assert.equal(d.treas.eth, undefined, '1回目は BTC だけ (1回に4つまで)');
  assert.deepEqual(d.errors, []);
  assert.deepEqual(calls.map(c => c.part), ['global', 'trend', 'cats', 'treasBtc']);
  assert.ok(calls.every(c => c.headers.accept === 'application/json'), 'accept: application/json を付ける');
  assert.ok(calls.every(c => !/key/i.test(c.url)), 'キーは使わない');
});

test('読み取り: ドミナンス (7日の変化と意味)・ステーブルコイン・全体・分野・注目の銘柄・企業の保有 (数は手で確かめた値)', () => {
  let z = world();
  let read = z.gas.get({ action: 'cg' }).cg.read;
  assert.deepEqual(read, [
    'BTC の占める割合 (ドミナンス) は 58.23%です (記録が2日分たまると、7日の変化を出します)。上がる時はお金が BTC に集まり、ほかの銘柄 (アルトコイン) は弱い時です',
    'ステーブルコイン (USDT・USDC) の占める割合は 7.7%です。上がる時は、様子見でドルのまま置いている人が多い時です',
    '暗号資産全体の時価総額は 3.2兆ドル (24時間で −1.2%)',
    '今日の分野ごとの値動き (時価総額10億ドル以上): いちばん強いのは「Meme」(+8.1%)、いちばん弱いのは「AI」(−4.3%)',
    'CoinGecko で注目されている銘柄: Pepe (PEPE)、Sui (SUI)、Hyperliquid (HYPE)',
    '上場企業などの BTC の保有は合計 1,272,129 BTC (972億ドル)。いちばん多いのは Strategy (843,738 BTC)',
  ]);
  // 4日前の行があれば7日の変化: BTC 57.5 → 58.23 (+0.73 → +0.7pt)、ステーブルコイン 8.2 → 7.7 (−0.5pt)
  z = world();
  seedHist(z.gas);
  read = z.gas.get({ action: 'cg' }).cg.read;
  assert.equal(read[0], 'BTC の占める割合 (ドミナンス) は 58.23% (7日で +0.7pt)。上がっています: お金が BTC に集まり、ほかの銘柄 (アルトコイン) は弱めです');
  assert.equal(read[1], 'ステーブルコイン (USDT・USDC) の占める割合は 7.7% (7日で −0.5pt)。下がっています: ドルから暗号資産にお金が動いています');
  // 下がった時・変わらない時 (56.9 − 57.5 = −0.6pt、6 + 2.3 = 8.3 → +0.1pt)
  z = world({ world: { global: { data: { total_market_cap: { usd: 3e12 }, total_volume: { usd: 1e11 }, market_cap_percentage: { btc: 56.9, eth: 12, usdt: 6, usdc: 2.3 }, market_cap_change_percentage_24h_usd: 0.5 } } } });
  seedHist(z.gas);
  read = z.gas.get({ action: 'cg' }).cg.read;
  assert.match(read[0], /56\.9% \(7日で −0\.6pt\)。下がっています: アルトコインにお金が回っています$/);
  assert.match(read[1], /8\.3% \(7日で \+0\.1pt\)。大きな変化はありません$/);
  assert.equal(read[2], '暗号資産全体の時価総額は 3兆ドル (24時間で +0.5%)');
  for (const x of read) assert.doesNotMatch(x, /買いましょう|売りましょう|おすすめ/);
});

test('日ごとの行: cg-YYYY-MM.json に { btcDom, ethDom, stableDom, mcap } (その日の最後の値)。doGet の hist に入る', () => {
  const { gas, clock } = world();
  seedHist(gas);
  gas.get({ action: 'cg' });
  let f = file(gas, 'cg-2026-11.json');
  assert.deepEqual(f['2026-11-14'], { btcDom: 58.23, ethDom: 11.5, stableDom: 7.7, mcap: 3.2e12 });
  assert.ok(f['2026-11-10'], '前の行は残す');
  clock.tick(3 * H);
  const r = gas.get({ action: 'cg' });
  assert.deepEqual(Object.keys(r.hist).sort(), ['2026-11-10', '2026-11-14']);
  f = file(gas, 'cg-2026-11.json');
  assert.equal(Object.keys(f).length, 2, '同じ日は上書き');
});

test('回数の制限: 1回に4つまで・あいだに1.5秒。115分は取り直さない。force=1 でも前回から10分以内なら取りに行かない。企業の保有は BTC と ETH を交互に', () => {
  const { gas, clock, calls, ev } = world();
  gas.get({ action: 'cg' });
  assert.deepEqual(ev, ['fetch', 'sleep 1500', 'fetch', 'sleep 1500', 'fetch', 'sleep 1500', 'fetch'], '呼び出しのあいだに1.5秒');
  clock.tick(60 * M);
  gas.get({ action: 'cg' });
  assert.equal(calls.length, 4, '1時間後はキャッシュのまま');
  gas.get({ action: 'cg', force: '1' });
  assert.equal(calls.length, 8, '強制は前回から10分を過ぎていれば取り直す');
  assert.equal(calls[7].part, 'treasEth', '2回目の企業の保有は ETH');
  clock.tick(5 * M);
  gas.get({ action: 'cg', force: '1' });
  gas.ctx.cgRecord_();
  assert.equal(calls.length, 8, '前回から5分なら強制でも取りに行かない (定期の取得も同じ)');
  clock.tick(109 * M);
  gas.get({ action: 'cg' });
  assert.equal(calls.length, 8, '前回 (60分の時) から114分');
  clock.tick(M);
  const d = gas.get({ action: 'cg' }).cg;
  assert.equal(calls.length, 12, '115分で取り直す');
  assert.equal(calls[11].part, 'treasBtc', '古い方 (BTC) から');
  assert.ok(d.treas.btc && d.treas.eth, '両方の保有が残る');
  assert.ok(calls.length / 3 <= 4, '1回に4つまで');
});

test('失敗: 1つが落ちても他は新しくなり、落ちたものは前回のまま errors に HTTP の番号 (429 も)。全部落ちたら前回のまま、前回も無ければ ok:false と見張りのエラー', () => {
  const { gas, clock, w } = world();
  gas.get({ action: 'cg' });
  clock.tick(2 * H);
  w.down = { cats: 429, treasEth: true };
  w.global = { data: { total_market_cap: { usd: 3.3e12 }, total_volume: { usd: 1e11 }, market_cap_percentage: { btc: 59, eth: 11, usdt: 5.5, usdc: 2 }, market_cap_change_percentage_24h_usd: 1 } };
  let r = gas.get({ action: 'cg' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.cg.errors, ['分野ごとの値動き (HTTP 429)', '企業の保有 (ETH) (HTTP 503)']);
  assert.equal(r.cg.global.btcDom, 59, '取れたものは新しい');
  assert.equal(r.cg.cats.up[0].n, 'Meme', '落ちた分野は前回のまま');
  assert.equal(r.cg.treas.eth, undefined);
  assert.equal(r.cg.at, clock.now);
  // 全部 429 → 前回のまま返し、理由も付ける。定期の取得は失敗 (見張りに HTTP の番号)
  const at = r.cg.at;
  clock.tick(2 * H);
  w.rate429 = true;
  r = gas.get({ action: 'cg' });
  assert.equal(r.ok, true);
  assert.equal(r.cg.at, at, '前回のまま');
  assert.equal(r.error, 'CoinGecko に接続できません (HTTP 429)。混み合っているため、しばらくしてから取り直します');
  clock.tick(11 * M);
  assert.equal(runCgJob(gas), 'cg');
  let h = health(gas);
  assert.equal(h.st, 'error');
  assert.match(h.err, /CoinGecko に接続できません \(HTTP 429\)/);
  // 直れば ok
  w.rate429 = false; clock.tick(2 * H);
  runCgJob(gas);
  assert.equal(health(gas).st, 'ok');
  // 前回も無ければ ok:false
  const z = world({ world: { all: 503 } });
  r = z.gas.get({ action: 'cg' });
  assert.equal(r.ok, false);
  assert.equal(r.cg, null);
  assert.equal(r.error, 'CoinGecko に接続できません (HTTP 503)。時間をおいて取り直します');
  runCgJob(z.gas);
  h = health(z.gas);
  assert.equal(h.st, 'error');
  assert.match(h.err, /CoinGecko に接続できません \(HTTP 503\)/);
  assert.equal(file(z.gas, 'cg-latest.json'), null);
});

test('見張り・定期の取得: HEALTH_JOBS に「暗号資産の市場全体 (CoinGecko)」(2時間ごと・8時間まで)。SIDE_JOBS で動く', () => {
  const { gas, calls } = world();
  let h = health(gas);
  assert.equal(h.n, '暗号資産の市場全体 (CoinGecko)');
  assert.equal(h.every, '2時間ごと');
  assert.equal(runCgJob(gas), 'cg');
  assert.equal(calls.length, 4);
  h = health(gas);
  assert.equal(h.st, 'ok');
  assert.ok(file(gas, 'cg-latest.json'));
});

test('毎朝のまとめ: 「■■ 暗号資産の市場全体 (CoinGecko)」(読み取り・数・上がった/下がった分野 5つまで・注目の銘柄 5つまで) をオプション市場の前に。dCg オフ・データなしは載せない', () => {
  const { gas } = world({ props: MAIL });
  gas.get({ action: 'cg' });
  gas.ctx.pmDigest();
  const m = gas.mails[gas.mails.length - 1], body = m.body;
  const i = body.indexOf('■■ 暗号資産の市場全体 (CoinGecko)');
  assert.ok(i > 0);
  const sec = body.slice(i);
  assert.match(sec, /^■■ 暗号資産の市場全体 \(CoinGecko\)\n・BTC の占める割合 \(ドミナンス\) は 58\.23%/);
  assert.match(sec, /\n・時価総額の合計 3\.2兆ドル \(24時間 −1\.2%\) ／ BTC 58\.23% ／ ETH 11\.5% ／ ステーブルコイン 7\.7%\n/);
  assert.match(sec, /■ 上がった分野\n・Meme \+8\.1% \(時価総額 800億ドル\)\n・RWA \+3\.3% \(時価総額 200億ドル\)\n・DeFi \+2% \(時価総額 1000億ドル\)\n/);
  assert.match(sec, /■ 下がった分野\n・AI −4\.3% \(時価総額 300億ドル\)\n・Gaming −1% \(時価総額 15億ドル\)\n/);
  assert.match(sec, /■ 注目されている銘柄\n・Pepe \(PEPE\) 24時間 \+12\.3% ・ 時価総額 30位\n・Sui \(SUI\) 24時間 −3\.2% ・ 時価総額 15位\n・Hyperliquid \(HYPE\) 24時間 \+5\.5% ・ 時価総額 12位\n・<img src=x onerror=alert\(1\)>Evil \(EVIL\)\n・Alpha \(ALP\) 24時間 \+1% ・ 時価総額 100位\n\n/);
  assert.doesNotMatch(sec.split('■ 記録の状況')[0], /Beta \(BET\)/, '5つまで');
  assert.match(m.htmlBody, /🧭 暗号資産の市場全体 \(CoinGecko\)/);
  assert.doesNotMatch(m.htmlBody, /<img src=x/, 'HTML ではエスケープ');
  assert.match(m.htmlBody, /&lt;img src=x/);
  // 順番: … → 暗号資産の市場全体 → オプション市場 → 記録の状況
  const iOpt = body.indexOf('■■ オプション市場');
  assert.ok(iOpt > i, 'オプション市場の前');
  assert.ok(i < body.indexOf('■ 記録の状況'));
  gas.post({ action: 'pmConfig', notify: { dCg: false } });
  gas.ctx.pmDigest();
  assert.doesNotMatch(gas.mails[gas.mails.length - 1].body, /暗号資産の市場全体/);
  // データが無い時は欄ごと出さない (まとめでは取りに行かない)
  const z = world({ props: MAIL });
  z.gas.ctx.pmDigest();
  assert.doesNotMatch(z.gas.mails[z.gas.mails.length - 1].body, /暗号資産の市場全体/);
  assert.equal(z.calls.length, 0);
});

test('レポート: parts=cg で「## 14. 暗号資産の市場全体 (CoinGecko)」(日ごとのドミナンスの表と、いまの分野)。既定の中身にも入る', () => {
  const { gas } = world();
  seedHist(gas);
  gas.get({ action: 'cg' });
  const t = gas.get({ action: 'report', days: '7', parts: 'cg' }).text;
  assert.match(t, /## 14\. 暗号資産の市場全体 \(CoinGecko\)/);
  assert.match(t, /\| 日付 \| BTC \(%\) \| ETH \(%\) \| ステーブルコイン \(%\) \| 時価総額の合計 \|/);
  assert.match(t, /\| 2026-11-10 \| 57\.5 \| 12 \| 8\.2 \| 3100 \|\n\| 2026-11-14 \| 58\.23 \| 11\.5 \| 7\.7 \| 3200 \|/);
  assert.match(t, /\| Meme \| 8\.1 \| 80 \| 10 \|/);
  assert.match(t, /\| AI \| -4\.3 \| 30 \| 5 \|/);
  assert.match(t, /いまの読み取り: BTC の占める割合/);
  assert.match(gas.get({ action: 'report', days: '7' }).text, /## 14\. 暗号資産の市場全体/);
});

/* ---------- アプリ ---------- */
test('アプリ: お金の流れタブの最初に「🧭 暗号資産の市場全体」(4枚のカード・読み取り・推移・分野・注目の銘柄・企業の保有)。↻ で取り直し、ホームに1行', async () => {
  const { gas, clock } = world();
  seedHist(gas);
  gas.props.setProperty('API_SECRET', 'secret-pass-12345');
  const app = await openApp({ clock, gas, fetch: async () => { throw new TypeError('offline'); }, state: { settings: { gasUrl: GAS_URL, gasKey: 'secret-pass-12345', gasAuto: false } } });
  try {
    app.run('switchTab("flow")');
    for (let i = 0; i < 6; i++) await app.settle();
    const area = app.doc.querySelector('#cgArea');
    assert.ok(area.compareDocumentPosition(app.doc.querySelector('#flSum')) & 4, 'チェーンの囲みより上');
    assert.equal(app.doc.querySelectorAll('#cgSum .mc-card').length, 4);
    const sum = app.text('#cgSum');
    assert.match(sum, /時価総額の合計\?3\.20兆ドル24時間 −1\.2% ・ 出来高 1,100億ドル/);
    assert.match(sum, /BTC の占める割合 \(ドミナンス\)\?58\.23%7日で \+0\.7pt/);
    assert.match(sum, /ステーブルコインの占める割合\?7\.7%USDT と USDC ・ 7日で −0\.5pt/);
    assert.match(sum, /ETH の占める割合\?11\.5%7日で −0\.5pt/);
    assert.equal(app.doc.querySelectorAll('#cgRead li').length, 6);
    assert.match(app.text('#cgRead'), /いちばん強いのは「Meme」\(\+8\.1%\)/);
    assert.equal(app.doc.querySelectorAll('#cgChart svg').length, 3, '2日分あるので推移を描く');
    const up = [...app.doc.querySelectorAll('#cgCats .cg-cols > div:first-child .cg-bar')].map(x => x.textContent);
    assert.deepEqual(up, ['Meme+8.1%800億ドル', 'RWA+3.3%200億ドル', 'DeFi+2.0%1,000億ドル']);
    assert.equal(app.doc.querySelectorAll('#cgCats .cg-dn').length, 3);
    assert.equal(app.doc.querySelector('#cgCats .cg-bar .op-bar i').style.width, '100%', 'いちばん大きい動きが一杯');
    assert.equal(app.doc.querySelectorAll('#cgTrend .cg-chip').length, 10);
    assert.match(app.text('#cgTrend'), /^Pepe PEPE \+12\.3% 30位Sui SUI −3\.2% 15位/);
    assert.equal(app.doc.querySelectorAll('#cgTrend img').length, 0, '銘柄の名前はエスケープ');
    assert.match(app.text('#cgTrend'), /<img src=x onerror=alert\(1\)>Evil/);
    assert.notEqual(app.doc.querySelector('#cgTreasBox').style.display, 'none');
    assert.equal(app.doc.querySelectorAll('#cgTreas tbody tr').length, 2);
    assert.match(app.text('#cgTreas'), /BTC: 合計 1,272,129 BTC \(972億ドル\).*Strategy MSTR\.USUS843,738 BTC645億ドル4\.018%/);
    assert.match(app.text('#cgInfo'), /時点$/);
    // ? で解説 (ドミナンス)
    app.doc.querySelector('#cgSum [data-term="dominance"]').click();
    assert.match(app.text('#termBody'), /ドミナンス/);
    // ↻ で取り直す (サーバーは10分以内なら取りに行かない)
    const before = app.requests.filter(r => /action=cg&force=1/.test(r.url)).length;
    app.doc.querySelector('#flReload').click();
    for (let i = 0; i < 4; i++) await app.settle();
    assert.equal(app.requests.filter(r => /action=cg&force=1/.test(r.url)).length, before + 1);
    // 端末に控える
    assert.ok(JSON.parse(app.win.localStorage.getItem('cg_cache_v1')).cg.global);
    // ホームのお金の流れのカードに1行
    app.run('switchTab("top")');
    for (let i = 0; i < 4; i++) await app.settle();
    const card = [...app.doc.querySelectorAll('#homeBody .hm-card')].find(c => /お金の流れ/.test(c.querySelector('h3').textContent));
    assert.match(card.textContent, /🧭 BTC の占める割合 58\.23% \(7日で \+0\.7pt\)ステーブルコイン 7\.7% ・ 全体の時価総額 3\.20兆ドル/);
    // サーバーへの通信は合言葉つき
    for (const r of app.requests.filter(r => /action=cg/.test(r.url))) assert.match(r.url, /[?&]key=secret-pass-12345/);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('アプリ: 一部取得できず・全部落ちた (HTTP の番号つきの案内)・前回の内容のまま・サーバー未登録・企業の保有が無ければ隠す', async () => {
  // 一部取得できず + 企業の保有なし
  let z = world({ world: { down: { cats: 429, treasBtc: 401 } } });
  let app = await openApp({ clock: z.clock, gas: z.gas, fetch: async () => { throw new TypeError('offline'); }, state: { settings: { gasUrl: GAS_URL, gasAuto: false } } });
  try {
    app.run('switchTab("flow")');
    for (let i = 0; i < 6; i++) await app.settle();
    assert.match(app.text('#cgInfo'), /一部取得できず \(分野ごとの値動き \(HTTP 429\)、企業の保有 \(BTC\) \(HTTP 401\)\)/);
    assert.match(app.text('#cgCats'), /分野ごとの値動きを取得できませんでした/);
    assert.equal(app.doc.querySelector('#cgTreasBox').style.display, 'none');
    assert.equal(app.doc.querySelectorAll('#cgChart svg').length, 0, '1日分では描かない');
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
  // 全部落ちた (前回なし)
  z = world({ world: { rate429: true } });
  app = await openApp({ clock: z.clock, gas: z.gas, fetch: async () => { throw new TypeError('offline'); }, state: { settings: { gasUrl: GAS_URL, gasAuto: false } } });
  try {
    app.run('switchTab("flow")');
    for (let i = 0; i < 6; i++) await app.settle();
    assert.match(app.text('#cgSum'), /取得できませんでした: CoinGecko に接続できません \(HTTP 429\)。混み合っているため、しばらくしてから取り直します/);
    // ホームは読み込み中のままにならない
    app.run('switchTab("top")');
    for (let i = 0; i < 3; i++) await app.settle();
    assert.doesNotMatch(app.text('#homeBody'), /BTC の占める割合/);
    // 直ってから、また全部落ちた → 前回の内容のまま、理由つき
    z.w.rate429 = false;
    app.run('switchTab("flow")'); app.run('loadCg(true)');
    for (let i = 0; i < 4; i++) await app.settle();
    assert.match(app.text('#cgSum'), /58\.23%/);
    z.w.rate429 = true; z.clock.tick(3 * H);
    app.run('loadCg(true)');
    for (let i = 0; i < 4; i++) await app.settle();
    assert.match(app.text('#cgSum'), /58\.23%/);
    assert.match(app.text('#cgInfo'), /CoinGecko に接続できません \(HTTP 429\).*\(前回の内容を表示しています\)/);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
  // サーバー未登録
  app = await openApp({ clock: z.clock, fetch: async () => { throw new TypeError('offline'); } });
  try {
    app.run('switchTab("flow")');
    await app.settle();
    assert.match(app.text('#cgSum'), /設定でサーバー \(Apps Script\) の URL を入れると表示されます/);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('アプリ: 設定の毎朝のまとめに dCg、記録をAIに渡すに cg。用語 (ドミナンス・アルトコイン・分野)', async () => {
  const { gas, clock } = world();
  const app = await openApp({ clock, gas, fetch: async () => { throw new TypeError('offline'); }, state: { settings: { gasUrl: GAS_URL, gasAuto: false } } });
  try {
    assert.ok(app.doc.querySelector('input[data-ntf="dCg"]'));
    assert.match(app.doc.querySelector('input[data-ntf="dCg"]').closest('label').textContent, /暗号資産の市場全体/);
    const cb = app.doc.querySelector('input[type="checkbox"][value="cg"]');
    assert.ok(cb && cb.checked);
    const G = app.run('GLOSS');
    for (const k of ['dominance', 'altcoin', 'sector']) assert.ok(G[k], k);
    assert.ok(G.dominance.r.every(r => G[r]));
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});
