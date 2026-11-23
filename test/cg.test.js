'use strict';
/* 暗号資産の市場全体 (CoinGecko の公開 API・キー不要): 時価総額・ドミナンス・分野・注目の銘柄・企業の保有 */
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
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
/** 1回に2つまでなので、4つの部分をそろえるには2回取る (2回目は残りの「時間になった」部分だけ) */
const full = gas => { gas.get({ action: 'cg' }); return gas.get({ action: 'cg' }); };
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
  const r = full(gas);
  assert.equal(r.ok, true);
  assert.equal(r.version, gas.C.GAS_VERSION);
  const d = r.cg;
  assert.deepEqual(plain(d.global), { mcap: 3.2e12, vol: 1.1e11, btcDom: 58.23, ethDom: 11.5, stableDom: 7.7, chg24: -1.23, src: 'coingecko' });
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
  assert.equal(d.treas.eth, undefined, '1回目は BTC だけ (BTC と ETH は交互)');
  assert.deepEqual(d.errors, []);
  assert.deepEqual(calls.map(c => c.part), ['global', 'trend', 'cats', 'treasBtc']);
  assert.ok(calls.every(c => c.headers.accept === 'application/json'), 'accept: application/json を付ける');
  assert.ok(calls.every(c => !/key/i.test(c.url)), 'URL にキーは入れない');
  assert.ok(calls.every(c => !('x-cg-demo-api-key' in c.headers)), 'CG_KEY が無ければキーのヘッダーは付けない');
});

test('読み取り: ドミナンス (7日の変化と意味)・ステーブルコイン・全体・分野・注目の銘柄・企業の保有 (数は手で確かめた値)', () => {
  let z = world();
  let read = full(z.gas).cg.read;
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
  read = full(z.gas).cg.read;
  assert.equal(read[0], 'BTC の占める割合 (ドミナンス) は 58.23% (7日で +0.7pt)。上がっています: お金が BTC に集まり、ほかの銘柄 (アルトコイン) は弱めです');
  assert.equal(read[1], 'ステーブルコイン (USDT・USDC) の占める割合は 7.7% (7日で −0.5pt)。下がっています: ドルから暗号資産にお金が動いています');
  // 下がった時・変わらない時 (56.9 − 57.5 = −0.6pt、6 + 2.3 = 8.3 → +0.1pt)
  z = world({ world: { global: { data: { total_market_cap: { usd: 3e12 }, total_volume: { usd: 1e11 }, market_cap_percentage: { btc: 56.9, eth: 12, usdt: 6, usdc: 2.3 }, market_cap_change_percentage_24h_usd: 0.5 } } } });
  seedHist(z.gas);
  read = full(z.gas).cg.read;
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

const cgCalls = calls => calls.filter(c => c.part !== 'paprika');
const cgNext = gas => JSON.parse(gas.props.getProperty('CG_NEXT') || '{}');

test('回数の制限: 1回に CoinGecko は2つまで (いちばん待っているものから)・あいだに1.5秒。時間になっていない部分は取らない。force=1 も2つまでで、前回から10分以内は取りに行かない', () => {
  const { gas, clock, calls, ev } = world();
  gas.get({ action: 'cg' });
  assert.deepEqual(ev, ['fetch', 'sleep 1500', 'fetch'], '呼び出しのあいだに1.5秒');
  assert.deepEqual(calls.map(c => c.part), ['global', 'trend']);
  gas.get({ action: 'cg' });
  assert.deepEqual(calls.map(c => c.part), ['global', 'trend', 'cats', 'treasBtc'], '2回目は残りの2つ');
  gas.get({ action: 'cg' });
  assert.equal(calls.length, 4, '時間になった部分が無ければ取りに行かない');
  clock.tick(60 * M);
  assert.equal(runCgJob(gas), 'cg');
  assert.equal(calls.length, 4, '1時間後の定期の取得: まだどれも時間になっていない');
  assert.equal(health(gas).st, 'ok', '取りに行かなかった回も成功');
  gas.get({ action: 'cg', force: '1' });
  assert.equal(calls.length, 6, '強制は時間になっていなくても取る (2つまで)');
  clock.tick(5 * M);
  gas.get({ action: 'cg', force: '1' });
  assert.equal(calls.length, 6, '前回から5分なら強制でも取りに行かない');
  const n = cgNext(gas);
  assert.equal(n.t, clock.now - 5 * M, '最後に取りに行った時刻');
  assert.equal(n.cats, clock.now - 65 * M + 120 * M, '分野は2時間後');
  assert.equal(n.treas, clock.now - 65 * M + 720 * M, '企業の保有は12時間後');
});

test('部分ごとの予定: 1時間ごとの定期の取得を24時間回すと、全体・注目・分野は2時間ごと、企業の保有は12時間ごと (BTC と ETH を交互)。どの回も CoinGecko は2つまで', () => {
  const { gas, clock, calls } = world();
  const per = [];
  for (let i = 0; i < 25; i++) {
    const n0 = cgCalls(calls).length;
    runCgJob(gas);
    per.push(cgCalls(calls).length - n0);
    clock.tick(60 * M);
  }
  assert.ok(Math.max(...per) <= 2, '1回に2つまで: ' + per.join(','));
  const t0 = calls[0].t, at = part => calls.filter(c => c.part === part).map(c => (c.t - t0) / M);
  assert.deepEqual(at('global'), [0, 120, 240, 360, 480, 600, 720, 840, 960, 1080, 1200, 1320, 1440]);
  assert.deepEqual(at('trend'), at('global'));
  assert.deepEqual(at('cats'), [60, 180, 300, 420, 540, 660, 780, 900, 1020, 1140, 1260, 1380]);
  assert.deepEqual(calls.filter(c => /^treas/.test(c.part)).map(c => [c.part, (c.t - t0) / M]), [['treasBtc', 60], ['treasEth', 780]]);
  assert.equal(health(gas).st, 'ok');
});

test('429: その部分だけ失敗 (前回のまま・errors に名前と番号)、30分は取り直さない。直れば errors から消える。全部落ちたら前回のまま、前回も無ければ ok:false と見張りのエラー', () => {
  const { gas, clock, w, calls } = world();
  full(gas);
  const trend0 = plain(gas.get({ action: 'cg' }).cg.trend);
  clock.tick(2 * H);
  w.n429 = { trend: 1 };
  w.global = { data: { total_market_cap: { usd: 3.3e12 }, total_volume: { usd: 1e11 }, market_cap_percentage: { btc: 59, eth: 11, usdt: 5.5, usdc: 2 }, market_cap_change_percentage_24h_usd: 1 } };
  assert.equal(runCgJob(gas), 'cg');
  let r = { cg: file(gas, 'cg-latest.json') };
  assert.deepEqual(r.cg.errors, ['注目の銘柄 (HTTP 429)']);
  assert.equal(r.cg.global.btcDom, 59, '取れた部分は新しい');
  assert.deepEqual(plain(r.cg.trend), trend0, '落ちた部分は前回のまま');
  assert.equal(health(gas).st, 'ok', '一部だけの失敗は見張りのエラーにしない');
  assert.equal(cgNext(gas).trend, clock.now + 30 * M, '注目の銘柄は30分後');
  // 20分後: 分野 (時間になっている) だけ。注目の銘柄は休み中
  clock.tick(20 * M);
  let n0 = calls.length;
  runCgJob(gas);
  assert.deepEqual(calls.slice(n0).map(c => c.part), ['cats']);
  // 31分後: 注目の銘柄を取り直す → errors から消える
  clock.tick(11 * M);
  n0 = calls.length;
  gas.get({ action: 'cg' });
  assert.deepEqual(calls.slice(n0).map(c => c.part), ['trend']);
  r = gas.get({ action: 'cg' });
  assert.deepEqual(r.cg.errors, []);
  // 全部 429 → 前回のまま返し、理由も付ける。定期の取得は失敗 (見張りに HTTP の番号)
  const at = r.cg.at;
  clock.tick(2 * H);
  w.rate429 = true; w.paprikaDown = 429;
  r = gas.get({ action: 'cg' });
  assert.equal(r.ok, true);
  assert.equal(r.cg.at, at, '前回のまま');
  assert.equal(r.error, 'CoinGecko に接続できません (HTTP 429)。混み合っているため、しばらくしてから取り直します');
  assert.deepEqual(r.cg.errors, ['全体の時価総額 (HTTP 429)', '分野ごとの値動き (HTTP 429)'], 'いちばん待っている2つ');
  clock.tick(31 * M);
  assert.equal(runCgJob(gas), 'cg');
  let h = health(gas);
  assert.equal(h.st, 'error');
  assert.match(h.err, /CoinGecko に接続できません \(HTTP 429\)/);
  // 直れば ok
  w.rate429 = false; w.paprikaDown = false; clock.tick(2 * H);
  runCgJob(gas);
  assert.equal(health(gas).st, 'ok');
  // 前回も無ければ ok:false
  const z = world({ world: { all: 503, paprikaDown: true } });
  r = z.gas.get({ action: 'cg' });
  assert.equal(r.ok, false);
  assert.equal(r.cg, null);
  assert.equal(r.error, 'CoinGecko に接続できません (HTTP 503)。時間をおいて取り直します');
  z.clock.tick(31 * M);
  runCgJob(z.gas);
  h = health(z.gas);
  assert.equal(h.st, 'error');
  assert.match(h.err, /CoinGecko に接続できません \(HTTP 503\)/);
  assert.equal(file(z.gas, 'cg-latest.json'), null);
});

test('予備: /global が 429 なら CoinPaprika の全体の数 (src を控える。ETH とステーブルコインの割合は null)。両方だめなら前回のまま errors', () => {
  const { gas, clock, w, calls } = world({ world: { n429: { global: 1 } } });
  seedHist(gas);
  let r = full(gas);
  assert.deepEqual(plain(r.cg.global), { mcap: 3.15e12, vol: 9.8e10, btcDom: 56.23, ethDom: null, stableDom: null, chg24: 3.98, src: 'coinpaprika', upd: 1795000000000 });
  assert.deepEqual(r.cg.errors, [], '全体の数は取れた');
  assert.deepEqual(calls.map(c => c.part), ['global', 'paprika', 'trend', 'cats', 'treasBtc'], 'CoinPaprika は CoinGecko の2つに数えない');
  assert.ok(!('x-cg-demo-api-key' in calls[1].headers));
  assert.deepEqual(file(gas, 'cg-2026-11.json')['2026-11-14'], { btcDom: 56.23, ethDom: null, stableDom: null, mcap: 3.15e12 });
  assert.match(r.cg.read[0], /56\.23% \(7日で −1\.3pt\)/);
  // まとめ・レポートは「-」と元の名前
  const sec = gas.ctx.pmCgSection_().text;
  assert.match(sec, /BTC 56\.23% ／ ETH - ／ ステーブルコイン - \(全体の数は CoinPaprika から\)/);
  assert.match(gas.get({ action: 'report', days: '7', parts: 'cg' }).text, /CoinPaprika から/);
  // 30分後に CoinGecko が直れば、その日の行は CoinGecko の値で上書き
  clock.tick(31 * M);
  r = gas.get({ action: 'cg' });
  assert.equal(r.cg.global.src, 'coingecko');
  assert.deepEqual(file(gas, 'cg-2026-11.json')['2026-11-14'], { btcDom: 58.23, ethDom: 11.5, stableDom: 7.7, mcap: 3.2e12 });
  // 次は CoinPaprika だけ取れた: ETH などはその日の前の値を残す
  clock.tick(2 * H); w.n429 = { global: 1 };
  full(gas);
  assert.deepEqual(file(gas, 'cg-2026-11.json')['2026-11-14'], { btcDom: 56.23, ethDom: 11.5, stableDom: 7.7, mcap: 3.15e12 });
  // 両方だめ → 前回のまま、errors に名前
  clock.tick(2 * H); w.n429 = { global: 1 }; w.paprikaDown = true;
  r = full(gas);
  assert.equal(r.cg.global.mcap, 3.15e12);
  assert.deepEqual(r.cg.errors, ['全体の時価総額 (HTTP 429)']);
});

test('キー: CG_KEY があれば CoinGecko の全部の呼び出しに x-cg-demo-api-key (場所はいつもの api.coingecko.com)。キーは応答・ログ・まとめ・レポートに出さない', () => {
  const KEY = 'CG-demoKey1234567890xyz';
  const { gas, clock, w, calls } = world({ props: Object.assign({ CG_KEY: KEY }, MAIL), world: { n429: { cats: 1 } } });
  full(gas);
  clock.tick(31 * M);
  gas.get({ action: 'cg', force: '1' });
  assert.ok(cgCalls(calls).length >= 4);
  for (const c of cgCalls(calls)) {
    assert.equal(c.headers['x-cg-demo-api-key'], KEY);
    assert.match(c.url, /^https:\/\/api\.coingecko\.com\/api\/v3\//);
    assert.ok(!c.url.includes(KEY), 'URL には入れない');
  }
  w.rate429 = true; clock.tick(3 * H);
  gas.get({ action: 'cg', force: '1' });
  gas.ctx.pmDigest();
  const outs = [gas.get({}), gas.get({ action: 'cg' }), gas.get({ action: 'cg', force: '1' }), gas.get({ action: 'health' }), gas.get({ action: 'report', days: '7' }),
    gas.post({ action: 'pmConfig' }), gas.mails, gas.logs, gas.props.getProperty('CG_NEXT'), file(gas, 'cg-latest.json')];
  for (const o of outs) assert.ok(!JSON.stringify(o).includes(KEY), 'キーが出ていない');
  assert.equal(gas.get({}).pm.ai.cgKey, true, '状況は登録済みかどうかだけ');
});

test('設定: pmConfig の cgKey で保存・cgKeyClear で消す。返すのは登録済みかどうかだけ。形の違うキーは保存しない。合言葉が要る', () => {
  const { gas } = world();
  assert.equal(gas.get({}).pm.ai.cgKey, false);
  let r = gas.post({ action: 'pmConfig', cgKey: '  CG-abcdefGHIJ12345  ' });
  assert.equal(r.ok, true);
  assert.equal(r.ai.cgKey, true);
  assert.equal(gas.props.getProperty('CG_KEY'), 'CG-abcdefGHIJ12345', '前後の空白を除く');
  assert.ok(!JSON.stringify(r).includes('abcdefGHIJ'));
  r = gas.post({ action: 'pmConfig', profile: 'BTC' });
  assert.equal(gas.props.getProperty('CG_KEY'), 'CG-abcdefGHIJ12345', '空なら変えない');
  r = gas.post({ action: 'pmConfig', cgKey: 'bad key<script>' });
  assert.equal(r.ok, false);
  assert.match(r.error, /キーの形が正しくありません/);
  assert.equal(gas.props.getProperty('CG_KEY'), 'CG-abcdefGHIJ12345');
  r = gas.post({ action: 'pmConfig', cgKeyClear: true });
  assert.equal(r.ai.cgKey, false);
  assert.equal(gas.props.getProperty('CG_KEY'), null);
  // 合言葉
  gas.props.setProperty('API_SECRET', 'secret-pass-12345');
  r = gas.post({ action: 'pmConfig', cgKey: 'CG-zzzzzzzzzzzz' });
  assert.equal(r.ok, false); assert.equal(r.needKey, true);
  assert.equal(gas.props.getProperty('CG_KEY'), null);
  assert.equal(gas.get({}).pm, undefined, '合言葉なしでは状況も返さない');
  r = gas.post({ action: 'pmConfig', key: 'secret-pass-12345', cgKey: 'CG-zzzzzzzzzzzz' });
  assert.equal(r.ok, true); assert.equal(r.ai.cgKey, true);
});

test('アプリ: 設定「🔑 CoinGecko のキー (任意)」(登録済み/未登録・保存・消す。キーは画面に出さず、入力欄は空に戻す)。全体の数が CoinPaprika の時は「-」と元の名前', async () => {
  const { gas, clock } = world({ world: { n429: { global: 1 } } });
  full(gas);
  const app = await openApp({ clock, gas, fetch: async () => { throw new TypeError('offline'); }, state: { settings: { gasUrl: GAS_URL, gasAuto: false } } });
  try {
    const card = [...app.doc.querySelectorAll('#tab-settings .set-card')].find(c => /CoinGecko のキー/.test(c.querySelector('h3').textContent));
    assert.ok(card);
    assert.equal(card.querySelector('h3').textContent, '🔑 CoinGecko のキー (任意)');
    const prev = card.previousElementSibling;
    assert.match(prev.querySelector('h3').textContent, /和訳とあなた向け/, '和訳とあなた向けの次');
    assert.match(card.textContent, /無料の Demo キーを入れると、取得の失敗 \(混雑による制限\) が減ります。CoinGecko のサイトで無料登録すると発行されます/);
    const a = card.querySelector('a');
    assert.equal(a.getAttribute('href'), 'https://www.coingecko.com/en/api/pricing');
    assert.equal(a.getAttribute('target'), '_blank'); assert.equal(a.getAttribute('rel'), 'noopener');
    assert.equal(app.doc.querySelector('#cgKeyIn').type, 'password');
    app.run('switchTab("settings")');
    for (let i = 0; i < 4; i++) await app.settle();
    assert.match(app.text('#cgKeyState'), /未登録/);
    app.doc.querySelector('#cgKeyIn').value = 'CG-myDemoKey123456';
    app.doc.querySelector('#cgKeySave').click();
    for (let i = 0; i < 4; i++) await app.settle();
    assert.equal(gas.props.getProperty('CG_KEY'), 'CG-myDemoKey123456');
    assert.match(app.text('#cgKeyState'), /登録済み/);
    assert.equal(app.doc.querySelector('#cgKeyIn').value, '', '入力欄は空に戻す');
    assert.ok(!app.doc.body.innerHTML.includes('CG-myDemoKey123456'), 'キーは画面に出さない');
    assert.ok(!app.win.localStorage.getItem('sakiyomi_v1').includes('CG-myDemoKey123456'), '端末に残さない');
    app.doc.querySelector('#cgKeyClear').click();
    for (let i = 0; i < 4; i++) await app.settle();
    assert.equal(gas.props.getProperty('CG_KEY'), null);
    assert.match(app.text('#cgKeyState'), /未登録/);
    // CoinPaprika の時の表示
    app.run('switchTab("flow")');
    for (let i = 0; i < 6; i++) await app.settle();
    assert.match(app.text('#cgSum'), /ステーブルコインの占める割合\?-USDT/);
    assert.match(app.text('#cgSum'), /ETH の占める割合\?-/);
    assert.match(app.text('#cgInfo'), /全体の数: CoinPaprika/);
    assert.match(app.text('#cgRead'), /CoinPaprika から/);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('見張り・定期の取得: HEALTH_JOBS に「暗号資産の市場全体 (CoinGecko)」(1時間ごと・6時間まで)。SIDE_JOBS で動く', () => {
  const { gas, calls } = world();
  let h = health(gas);
  assert.equal(h.n, '暗号資産の市場全体 (CoinGecko)');
  assert.equal(h.every, '1時間ごと', '定期の取得は1時間ごと (中で部分ごとの予定を見る)');
  assert.equal(vm.runInContext('HEALTH_JOBS.find(j => j.k === "cg").max', gas.ctx), 6);
  assert.equal(vm.runInContext('SIDE_JOBS.find(j => j.k === "cg").every', gas.ctx), 60);
  assert.equal(runCgJob(gas), 'cg');
  assert.equal(calls.length, 2, '1回に2つまで');
  h = health(gas);
  assert.equal(h.st, 'ok');
  assert.ok(file(gas, 'cg-latest.json'));
});

test('毎朝のまとめ: 「■■ 暗号資産の市場全体 (CoinGecko)」(読み取り・数・上がった/下がった分野 5つまで・注目の銘柄 5つまで) をオプション市場の前に。dCg オフ・データなしは載せない', () => {
  const { gas } = world({ props: MAIL });
  full(gas);
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
  full(gas);
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
  full(gas);
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
    assert.match(app.text('#cgInfo'), /時点 ・ 全体の数: CoinGecko$/);
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
  full(z.gas);
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
  z = world({ world: { rate429: true, paprikaDown: true } });
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
    z.w.rate429 = false; z.clock.tick(31 * M);   // 落ちた部分は30分休む
    app.run('switchTab("flow")'); app.run('loadCg(true)');
    for (let i = 0; i < 4; i++) await app.settle();
    z.clock.tick(11 * M);
    app.run('loadCg(true)');
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
