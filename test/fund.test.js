'use strict';
/* 資金調達 (ニュースから): ニュースの Gemini の答えの fund・後追い・まとめ・トークンの有無・読み取り・通知・まとめメール・レポート・画面 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('./helpers/gas');
const { openApp, GAS_URL } = require('./helpers/app');
const { createClock } = require('./helpers/clock');
const { newsFetch, geminiFake } = require('./helpers/news');

const H = 3600000, D = 24 * H;
const ok = o => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify(o) });
function world(opts) {
  opts = opts || {};
  const clock = createClock(opts.start || '2026-11-14T10:00:00+09:00');
  const nf = newsFetch(clock, Object.assign({ fund: opts.fund !== false }, opts.world)), gem = geminiFake();
  const fetch = (url, params) => {
    const r = nf(url, params) || gem(url, params); if (r) return r;
    if (/gamma-api\.polymarket\.com\/markets/.test(url)) return ok([]);
    throw new Error('使わない: ' + url);
  };
  const gas = loadGas({ clock, fetch, props: Object.assign({ MAIL_TO: 'muse@example.com' }, opts.key === false ? {} : { GEMINI_KEY: 'k' }, opts.props) });
  return { clock, gas, nf, gem, w: nf.world };
}
const files = gas => gas.drive.folderFiles('ポリマーケット記録');
const fileJson = (gas, name) => { const f = files(gas).find(x => x.name === name); return f ? JSON.parse(f.content) : null; };
const latest = gas => fileJson(gas, 'news-latest.json');
const byTitle = (gas, re) => latest(gas).items.find(x => re.test(x.ti));
const newsCalls = gem => gem.calls.filter(c => c.kind === 'news');
const plain = x => JSON.parse(JSON.stringify(x));
const fundMails = gas => gas.mails.filter(m => /資金調達:/.test(m.subject));
/** DefiLlama のプロトコルの控え (Acme は ACME あり・Lighter は未発行・Zeta は親が同じものにトークンあり) と、先物 DEX の候補 */
function seedLlama(gas) {
  gas.ctx.pmWrite_('llama-protocols.json', JSON.stringify({ at: gas.clock.now, m: {
    1: { n: 'Acme', sym: 'ACME', tvl: 1, par: '' },
    2: { n: 'Lighter', sym: '', tvl: 1, par: '' },
    3: { n: 'Zeta Perps', sym: '', tvl: 1, par: 'parent#zeta-network' },
    4: { n: 'Zeta Token', sym: 'ZET', tvl: 1, par: 'parent#zeta-network' },
  } }));
  gas.ctx.pmWrite_('llama-latest.json', JSON.stringify({ at: gas.clock.now, chains: [], perps: [
    { n: 'Beta Wallet', key: 'Beta Wallet', token: false, cat: 'Derivatives', ch: ['Arbitrum'] },
    { n: 'Off Thing', key: 'Off Thing', token: false, cat: 'Derivatives', ch: ['Off Chain'] },
  ] }));
}
/** この変更より前に和訳した記事 (fx が無い) をドライブに置く */
function seedOld(gas, rows) {
  const m = {};
  rows.forEach((r, i) => { m['old' + i] = Object.assign({ s: 'decrypt', l: 'https://decrypt.co/old/' + i, ja: '和:' + r.ti, sum: '要約', sc: 1 }, r); });
  gas.ctx.pmWrite_('news-2026-11.json', JSON.stringify(m));
}

/* ---------- サーバー ---------- */
test('プロンプト: fund の形・資金調達でないもの・例2つ・分野に「資金調達」。Gemini はニュース1回の中で (別に呼ばない)', () => {
  const { gas, gem } = world();
  const p = gas.ctx.newsPrompt_();
  assert.match(p, /"fund":資金調達の情報 か null/);
  assert.match(p, /・cat: 次から1つ: .*資金調達.*「資金調達」/);
  for (const k of ['"p":', '"amt":', '"r":', '"inv":', '"oth":', '"val":', '"sec":', '"note":']) assert.ok(p.includes(k), k);
  assert.match(p, /seed \/ pre-seed \/ series A〜D \/ strategic \/ private round \/ token sale/);
  assert.match(p, /"\$12M" → 12000000/);
  assert.match(p, /上場していない会社・プロジェクトが、株・SAFE・トークンを投資家に売って/);
  assert.match(p, /次は資金調達ではない: 借入・融資・債務 \(debt\)・クレジットライン \(credit facility\)・転換社債や社債 \(convertible notes \/ bonds\)・上場企業の資金集め \(株の売り出し・ATM・上場企業の PIPE など、上場企業のものはすべて\)・企業の暗号資産の購入 \(トレジャリー\)・ETF の資金の出入り・ファンドの設立・買収や合併・助成金 \(grant\)・ハッキング・プロトコルの収益・訴訟/);
  assert.match(p, /"MARA raises \$185M in debt financing" → "fund":null/);
  assert.match(p, /例: "Acme raises \$12M seed round led by Paradigm" → .*"fund":\{"p":"Acme","amt":12000000/);
  assert.match(p, /"Bitcoin ETFs see \$500M outflows" → "fund":null/);
  gas.ctx.newsRecord_();
  assert.deepEqual(newsCalls(gem).map(c => c.input.length), [15, 1], '16件 = いつもの15件ずつ (資金調達のための呼び出しは無い)');
  assert.equal(gem.calls.length, 2);
});

test('確かめ: 型・金額の範囲・長い文字・4人以上の投資家 (切り詰める or null)', () => {
  const { gas } = world();
  const c = o => plain(gas.ctx.fundClean_(o));
  const good = { p: '  Acme   Labs ', amt: 12000000.4, r: 'Seed', inv: ['Paradigm', ' a16z ', 'paradigm', 'Sequoia', 'Pantera'], oth: 2, val: null, sec: 'DeFi' };
  assert.deepEqual(c(good), { p: 'Acme Labs', amt: 12000000, r: 'Seed', inv: ['Paradigm', 'a16z', 'Sequoia'], oth: 2, val: null, sec: 'DeFi' }, '空白をまとめ、同じ投資家は1つ、3人まで');
  for (const bad of [null, 'Acme', [good], 42, {}, { p: '' }, { p: '!!!' }, { p: 12 },
    Object.assign({}, good, { amt: '12000000' }), Object.assign({}, good, { amt: 0 }), Object.assign({}, good, { amt: -5 }), Object.assign({}, good, { amt: 5e10 }), Object.assign({}, good, { amt: Infinity }), Object.assign({}, good, { amt: NaN }),
    Object.assign({}, good, { r: 3 }), Object.assign({}, good, { inv: 'Paradigm' }), Object.assign({}, good, { oth: 1.5 }), Object.assign({}, good, { oth: -1 }), Object.assign({}, good, { val: 'big' }), Object.assign({}, good, { val: 1e14 })]) {
    assert.equal(gas.ctx.fundClean_(bad), null, JSON.stringify(bad));
  }
  const long = c({ p: 'X'.repeat(100), amt: null, r: 'R'.repeat(50), inv: ['I'.repeat(60), 7, null, ''], sec: 'S'.repeat(30), note: 'N'.repeat(80) });
  assert.equal(long.p.length, 60); assert.equal(long.r.length, 30); assert.deepEqual(long.inv, ['I'.repeat(40)]); assert.equal(long.sec.length, 20); assert.equal(long.note.length, 40);
  assert.equal(long.amt, null); assert.equal(long.oth, null);
  assert.deepEqual(c({ p: 'Solo' }), { p: 'Solo', amt: null, r: null, inv: [], oth: null, val: null, sec: 'その他' }, '名前だけでもよい (分野は「その他」)');
  assert.equal(c({ p: 'X', amt: 49999999999 }).amt, 49999999999);
});

test('記録: fund と fx を月ごとのファイルと news-latest.json に。資金調達でない記事 (ETF の流出) は fund なし。説明文は残さない', () => {
  const { gas } = world();
  gas.ctx.newsRecord_();
  const acme = byTitle(gas, /^Acme Labs/);
  assert.equal(acme.cat, '資金調達');
  assert.deepEqual(acme.fund, { p: 'Acme Labs', amt: 25000000, r: 'Series A', inv: ['Paradigm', 'a16z'], oth: 3, val: null, sec: 'DeFi' });
  assert.ok(!('fx' in acme), 'fx は月ごとのファイルだけ');
  const etf = byTitle(gas, /ETFs see \$500M/);
  assert.equal(etf.fund, undefined);
  assert.equal(etf.cat, 'ETF・機関投資家');
  const month = fileJson(gas, 'news-2026-11.json');
  assert.equal(month[acme.id].fx, 1);
  assert.deepEqual(month[acme.id].fund, acme.fund);
  assert.ok(Object.values(month).every(x => x.fx === 1), '新しく和訳した記事はすべて fx');
  assert.equal(latest(gas).items.filter(x => x.fund).length, 5);
  for (const f of files(gas)) assert.doesNotMatch(f.content, /DESC_MARK|lending markets|also joined/, f.name);
  // 壊れた答えは fund なし (でも fx は付く)
  const b = world();
  b.gem.fund = t => /Acme Labs/.test(t) ? { p: 'Acme', amt: 9e12 } : /Zeta/.test(t) ? 'garbage' : null;
  b.gas.ctx.newsRecord_();
  assert.equal(latest(b.gas).items.filter(x => x.fund).length, 0);
  const m2 = fileJson(b.gas, 'news-2026-11.json');
  assert.ok(Object.values(m2).every(x => x.fx === 1 && !x.fund));
});

test('後追い: 前に和訳した記事のうち7日以内・候補の分野・fx なしを15件ずつ送り直し、fx を付ける。48時間より古いものは知らせない', () => {
  const { gas, gem, clock } = world({ fund: false });
  const now = clock.now, rows = [];
  for (let i = 0; i < 20; i++) rows.push({ ti: 'Filler ' + i, t: now - 20 * H - i * 60000, cat: 'その他' });
  rows.push({ ti: 'Old Corp raises $100M Series C led by Paradigm', t: now - 60 * H, cat: 'DeFi・プロジェクト' });
  rows.push({ ti: 'Ancient raises $40M', t: now - 8 * D, cat: 'その他' });
  rows.push({ ti: 'Fed holds rates', t: now - 10 * H, cat: '金融政策' });
  rows.push({ ti: 'Done before', t: now - 10 * H, cat: 'その他', fx: 1 });
  seedOld(gas, rows);
  gas.ctx.newsRecord_();
  let c = newsCalls(gem);
  assert.deepEqual(c.map(x => x.input.length), [10, 15], 'いつもの10件のあとに、後追いの15件');
  assert.deepEqual(c[1].input.map(x => x.t), rows.slice(0, 15).map(r => r.ti), '新しい順');
  let m = fileJson(gas, 'news-2026-11.json');
  assert.equal(Object.values(m).filter(x => x.fx).length, 10 + 15 + 1);
  assert.equal(m.old0.ja, '和:Filler 0', '和訳はそのまま');
  clock.tick(H);
  gas.ctx.newsRecord_();
  c = newsCalls(gem);
  assert.deepEqual(c.slice(2).map(x => x.input.map(y => y.t)), [rows.slice(15, 21).map(r => r.ti)], '残りの6件だけ。7日より前・候補でない分野・fx 済みは送らない');
  m = fileJson(gas, 'news-2026-11.json');
  assert.equal(m.old20.fx, 1);
  assert.equal(m.old20.fund.p, 'Old Corp');
  assert.equal(m.old20.cat, '資金調達');
  assert.ok(!m.old21.fx && !m.old22.fx);
  assert.equal(fundMails(gas).length, 0, '60時間前の調達は知らせない');
  clock.tick(H);
  gas.ctx.newsRecord_();
  assert.equal(newsCalls(gem).length, 3, '済んだら呼ばない');
  assert.equal(JSON.parse(gas.props.getProperty('PM_AI_DAY')).n, 3, '後追いも1日の上限に数える');
});

test('借入は資金調達ではない: AI が fund を答えても、題・要約・原題に借入の言葉 (英語・日本語) があれば外す。ふつうの調達はそのまま', () => {
  const { gas, gem } = world({ world: { add: [
    { k: 'decrypt', title: 'MARA raises $185M in debt financing', link: 'https://decrypt.co/mara-debt', t: Date.parse('2026-11-14T08:00:00+09:00') },
    { k: 'decrypt', title: 'Miner Corp secures $50M credit facility', link: 'https://decrypt.co/miner-credit', t: Date.parse('2026-11-14T08:30:00+09:00') },
  ] } });
  const { fundJudge } = require('./helpers/news');
  gem.fund = t => /^MARA/.test(t) ? { p: 'MARA', amt: 185000000, r: null, inv: [], oth: null, val: null, sec: 'その他' }
    : /^Miner Corp/.test(t) ? { p: 'Miner Corp', amt: 50000000, r: 'Strategic', inv: [], oth: null, val: null, sec: 'インフラ' } : fundJudge(t);
  gas.ctx.newsRecord_();
  const mara = byTitle(gas, /^MARA/), miner = byTitle(gas, /^Miner Corp/);
  assert.equal(mara.fund, undefined, 'MARA の借入は資金調達にしない');
  assert.notEqual(mara.cat, '資金調達');
  assert.equal(miner.fund, undefined, 'credit facility も');
  assert.equal(byTitle(gas, /^Acme Labs/).fund.amt, 25000000, 'ふつうの調達はそのまま');
  assert.equal(byTitle(gas, /^Lighter/).fund.val, 1500000000);
  assert.ok(!fundMails(gas).some(m => /MARA|Miner/.test(m.subject + m.body)), '借入は知らせない');
  // 言葉の確かめ (日本語の題・要約も)
  const d = t => gas.ctx.fundDebt_([t]);
  for (const t of ['MARA raises $185M in debt financing', 'Firm closes $300M convertible notes offering', 'Strategy prices $2B senior notes', 'Miner gets $40M loan', 'Issuer sells $1B bonds',
    'MARA が債務で1.85億ドルを調達', '借入で資金を確保', '銀行から融資を受ける', '転換社債を発行', '社債の発行', '債券を売り出す']) assert.equal(d(t), true, t);
  for (const t of ['Acme Labs raises $25 million Series A led by Paradigm', 'Bondless raises $5M seed', 'Loanword Labs raises $3M', 'アクメが2,500万ドルを調達 (シリーズA)', 'トークンセールで1,000万ドル']) assert.equal(d(t), false, t);
  assert.equal(gas.ctx.fundDebt_([null, undefined, 3]), false);
});

test('読み直し (1回だけ・FUND_RECHECK_V2): 14日以内の fund のある記事を後追いで送り直し、間違った fund を外す。知らせない。2回目はしない', () => {
  const { gas, gem, clock } = world({ fund: false });
  const now = clock.now;
  const f = (p, amt) => ({ p, amt, r: null, inv: [], oth: null, val: null, sec: 'その他' });
  seedOld(gas, [
    { ti: 'Hut Holdings closes $185M financing', t: now - 3 * D, cat: '資金調達', fx: 1, fund: f('Hut Holdings', 185000000) },   // AI に聞き直すと null
    { ti: 'MARA raises $185M in debt financing', t: now - 2 * D, cat: '資金調達', fx: 1, fund: f('MARA', 185000000) },           // 言葉でその場で外す
    { ti: 'Beta Wallet raises $8M seed round', t: now - 10 * D, cat: '資金調達', fx: 1, fund: f('Beta Wallet', 8000000) },        // 聞き直しても調達のまま
    { ti: 'Old Corp raises $100M Series C led by Paradigm', t: now - 20 * D, cat: '資金調達', fx: 1, fund: f('Old Corp', 100000000) },   // 14日より前は触らない
  ]);
  gas.ctx.newsRecord_();
  const c = newsCalls(gem);
  assert.deepEqual(c.map(x => x.input.length), [10, 2], 'いつもの10件 + 読み直しの2件 (MARA は言葉で外したので送らない)');
  assert.deepEqual(c[1].input.map(x => x.t), ['Hut Holdings closes $185M financing', 'Beta Wallet raises $8M seed round']);
  let m = fileJson(gas, 'news-2026-11.json');
  assert.equal(m.old0.fund, undefined, '間違った fund を外す');
  assert.equal(m.old0.cat, 'その他');
  assert.equal(m.old0.fx, 1); assert.equal(m.old0.rk, undefined);
  assert.equal(m.old1.fund, undefined); assert.equal(m.old1.cat, 'その他');
  assert.equal(m.old2.fund.p, 'Beta Wallet', 'ふつうの調達は残る');
  assert.equal(m.old2.cat, '資金調達');
  assert.equal(m.old3.fund.p, 'Old Corp', '14日より前はそのまま');
  assert.equal(fundMails(gas).length, 0, '読み直したものは知らせない');
  assert.ok(gas.props.getProperty('FUND_RECHECK_V2'));
  assert.equal(gas.ctx.fundList_(30).some(x => /MARA|Hut/.test(x.p)), false, '一覧から消える');
  clock.tick(H);
  gas.ctx.newsRecord_();
  assert.equal(newsCalls(gem).length, 2, '2回目は読み直さない');
});

test('読み直し: 1日の Gemini の残りが少ない時は待つ (印は残し、余裕ができた日に送り直す)', () => {
  const { gas, gem, clock } = world({ fund: false, props: { PM_AI_DAY: JSON.stringify({ d: '2026-11-14', n: 359 }) } });
  seedOld(gas, [{ ti: 'Hut Holdings closes $185M financing', t: clock.now - 3 * D, cat: '資金調達', fx: 1, fund: { p: 'Hut Holdings', amt: 185000000, r: null, inv: [], oth: null, val: null, sec: 'その他' } }]);
  gas.ctx.newsRecord_();
  assert.deepEqual(newsCalls(gem).map(x => x.input.length), [10]);
  let m = fileJson(gas, 'news-2026-11.json');
  assert.equal(m.old0.rk, 1); assert.equal(m.old0.fund.p, 'Hut Holdings');
  clock.addDays(1);
  gas.ctx.newsRecord_();
  assert.deepEqual(newsCalls(gem).slice(-1).map(x => x.input.map(y => y.t)), [['Hut Holdings closes $185M financing']], '次の日に送り直す');
  m = fileJson(gas, 'news-2026-11.json');
  assert.equal(m.old0.fund, undefined);
});

test('後追い: 1日の上限の残りが少ない時 (40回以下) はしない。いつもの和訳は続ける', () => {
  const { gas, gem, clock } = world({ fund: false, props: { PM_AI_DAY: JSON.stringify({ d: '2026-11-14', n: 359 }) } });
  seedOld(gas, [{ ti: 'Filler', t: clock.now - 5 * H, cat: 'その他' }]);
  gas.ctx.newsRecord_();
  assert.deepEqual(newsCalls(gem).map(x => x.input.length), [10], '残り 400-360=40 なら後追いしない');
  assert.ok(!fileJson(gas, 'news-2026-11.json').old0.fx);
  const b = world({ fund: false, props: { PM_AI_DAY: JSON.stringify({ d: '2026-11-14', n: 358 }) } });
  seedOld(b.gas, [{ ti: 'Filler', t: b.clock.now - 5 * H, cat: 'その他' }]);
  b.gas.ctx.newsRecord_();
  assert.deepEqual(newsCalls(b.gem).map(x => x.input.length), [10, 1]);
  assert.equal(gas.ctx.pmAiDayLeft_(), 40, '数えるだけで増やさない');
  assert.equal(gas.ctx.pmAiDayLeft_(), 40);
});

test('まとめ: 同じ調達を書いた複数のサイトを1行に (大きい方の金額・投資家を合わせる・出どころとリンク)。14日より離れたら別', () => {
  const { gas } = world();
  gas.ctx.newsRecord_();
  const L = plain(gas.ctx.fundList_());
  assert.deepEqual(L.map(x => x.p), ['Acme Labs', 'Zeta Network', 'Beta Wallet', 'Lighter'], '新しい順・ETF の流出は入らない');
  const a = L[0];
  assert.equal(a.k, 'acme');
  assert.equal(a.amt, 25000000);
  assert.deepEqual(a.inv, ['Paradigm', 'a16z', 'Coinbase Ventures']);
  assert.deepEqual(a.src, ['The Block', 'CoinDesk']);
  assert.deepEqual(a.links, ['https://www.theblock.co/news/10-acme', 'https://www.coindesk.com/business/2026/11/14/acme']);
  assert.equal(a.val, 250000000); assert.equal(a.oth, 3); assert.equal(a.note, '貸し借りの市場');
  assert.equal(a.d, '2026-11-14');
  assert.equal(a.top, true);
  assert.equal(L[2].top, false, 'Small Capital は有名な VC ではない');
  assert.equal(L[3].top, true, 'Founders Fund');
  const k = n => gas.ctx.fundKey_(n);
  assert.equal(k('Acme Labs'), 'acme'); assert.equal(k('ACME Protocol'), 'acme'); assert.equal(k('acme.xyz'), 'acme'); assert.equal(k('Acme Finance'), 'acme');
  assert.equal(k('AcmeLabs'), 'acme'); assert.equal(k('Zeta Network Foundation'), 'zeta'); assert.equal(k('Radio'), 'radio'); assert.equal(k('Labs'), 'labs');
  const t0 = gas.clock.now, f = (p, amt, inv) => ({ p, amt, r: null, inv, oth: null, val: null, sec: 'その他' });
  const M = plain(gas.ctx.fundMerge_([
    { t: t0, s: 'theblock', l: 'https://a/1', f: f('Foo', 5e6, ['X']) },
    { t: t0 - 13 * D, s: 'coindesk', l: 'javascript:alert(1)', f: f('Foo Labs', 9e6, ['Y', 'x']) },
    { t: t0 - 28 * D, s: 'ctg', l: 'https://a/3', f: f('foo', 1e6, ['Z']) },
  ], { idx: {}, cand: {} }));
  assert.equal(M.length, 2, '14日以内はまとめ、離れたものは別の行');
  assert.equal(M[0].amt, 9e6); assert.deepEqual(M[0].inv, ['X', 'Y']); assert.deepEqual(M[0].links, ['https://a/1'], 'http(s) のリンクだけ');
  assert.deepEqual(M[1].src, ['Cointelegraph']);
});

test('トークンの有無: DefiLlama のプロトコル (sym) と照らす。あり / 未発行 / 不明。未発行か先物 DEX の候補なら cand', () => {
  const { gas } = world();
  seedLlama(gas);
  gas.ctx.newsRecord_();
  const L = plain(gas.ctx.fundList_());
  const by = n => L.find(x => x.p === n);
  assert.equal(by('Acme Labs').token, true);
  assert.equal(by('Lighter').token, false);
  assert.equal(by('Lighter').cand, true);
  assert.equal(by('Zeta Network').token, true, '親が同じプロトコルにトークンがあれば「あり」');
  assert.equal(by('Beta Wallet').token, null, '一覧に無いので不明');
  assert.equal(by('Beta Wallet').cand, true, 'トークン未発行の先物 DEX (エアドロップ候補) の名前と合う');
  assert.equal(by('Acme Labs').cand, false);
  // 控えが無い時は DefiLlama を取りに行き、失敗しても不明として進める
  const b = world();
  b.gas.ctx.newsRecord_();
  assert.ok(plain(b.gas.ctx.fundList_()).every(x => x.token === null && x.cand === false));
});

test('読み取り: 7日の件数と合計 (前の7日と比べて)・いちばん大きい調達・トークン未発行・30日によく主導した投資家', () => {
  const { gas, clock } = world();
  const now = clock.now;
  const r = (p, t, amt, inv, token, rr) => ({ p, t, amt, inv, token, r: rr || null, oth: null, src: ['The Block'], links: [] });
  const list = [
    r('Lighter', now - 1 * D, 68e6, ['Founders Fund', 'Ribbit Capital'], false, 'Series B'),
    r('Acme Labs', now - 2 * D, 25e6, ['Paradigm', 'a16z'], true, 'Series A'),
    r('Zeta Network', now - 3 * D, null, ['Paradigm'], null, 'Strategic'),
    r('Old One', now - 9 * D, 10e6, ['Paradigm'], null, 'Seed'),
    r('Older', now - 20 * D, 5e6, ['a16z'], false),
    r('Oldest', now - 40 * D, 5e6, ['Sequoia'], false),
  ];
  assert.deepEqual(plain(gas.ctx.fundRead_(list)), [
    '直近7日の資金調達は 3件・合計 9,300万ドル でした (その前の7日は 1件・合計 1,000万ドル)。金額が書かれていないものが 1件あり、合計には入っていません。',
    '今週いちばん大きいのは Lighter の 6,800万ドル (シリーズB・主導: Founders Fund・Ribbit Capital) です。',
    'トークン未発行: エアドロップ候補の手がかり — 今週は 1件 (Lighter) が、まだ自分のトークンを出していません。',
    'この30日によく主導した投資家: Paradigm ×3、a16z ×2、Founders Fund ×1。',
    'ニュースになった資金調達だけを数えています (すべての資金調達ではありません)。金額や投資家は AI が見出しから読み取ったものです。',
  ]);
  assert.deepEqual(plain(gas.ctx.fundRead_([])), ['直近14日に、ニュースになった資金調達はありませんでした。', 'ニュースになった資金調達だけを数えています (すべての資金調達ではありません)。金額や投資家は AI が見出しから読み取ったものです。']);
  assert.equal(gas.ctx.fundRoundJa_('Series A'), 'シリーズA'); assert.equal(gas.ctx.fundRoundJa_('series b extension'), 'シリーズB extension');
  assert.equal(gas.ctx.fundRoundJa_('Pre-Seed'), 'プレシード'); assert.equal(gas.ctx.fundRoundJa_('Strategic'), '戦略的出資'); assert.equal(gas.ctx.fundRoundJa_('Token sale'), 'Token sale');
});

test('doGet action=fund: { ok, version, fund: { at, list, read } }。days は既定60・最大180。合言葉で守られる', () => {
  const { gas, clock } = world();
  let r = gas.get({ action: 'fund' });
  assert.equal(r.ok, true); assert.equal(r.version, gas.C.GAS_VERSION); assert.equal(r.ai, true);
  assert.deepEqual(r.fund.list, []);
  assert.ok(Array.isArray(r.fund.read));
  gas.ctx.newsRecord_();
  r = gas.get({ action: 'fund' });
  assert.equal(r.fund.at, clock.now);
  assert.equal(r.fund.list.length, 4);
  assert.match(r.fund.read[0], /^直近7日の資金調達は 4件・合計 1億ドル でした \(その前の7日は 0件\)。金額が書かれていないものが 1件あり/);
  clock.tick(10 * D);
  assert.equal(gas.get({ action: 'fund', days: '7' }).fund.list.length, 0);
  assert.equal(gas.get({ action: 'fund', days: '999' }).fund.list.length, 4);
  assert.equal(gas.get({ action: 'fund' }).fund.list.length, 4);
  gas.props.setProperty('API_SECRET', 'secret-pass-12345');
  r = gas.get({ action: 'fund' });
  assert.equal(r.needKey, true); assert.equal(r.fund, undefined);
  assert.equal(gas.get({ action: 'fund', key: 'secret-pass-12345' }).fund.list.length, 4);
  assert.equal(world({ key: false }).gas.get({ action: 'fund' }).ai, false);
});

test('通知: 基準 (3,000万ドル) 以上か、金額なしで有名な VC が主導したものを1通に。同じ調達は1回だけ', () => {
  const { gas, clock, w } = world();
  seedLlama(gas);
  gas.ctx.newsRecord_();
  const M = fundMails(gas);
  assert.equal(M.length, 1);
  const m = M[0];
  assert.equal(m.to, 'muse@example.com');
  assert.equal(m.subject, '【ポリマーケット】資金調達: Lighter 6,800万ドル ほか1件');
  assert.match(m.body, /1\. Lighter 6,800万ドル \(シリーズB\)\n   主導: Founders Fund・Ribbit Capital\n   トークン未発行: エアドロップ候補の手がかり ・ 分野: 取引所\n   Cointelegraph: https:\/\/cointelegraph\.com\/news\/lighter-68m/);
  assert.match(m.body, /2\. Zeta Network 金額非公表 \(戦略的出資\)\n   主導: Paradigm\n   トークンあり/);
  assert.doesNotMatch(m.body, /Acme|Beta Wallet|ETF/, '2,500万ドル・800万ドルは基準未満 (金額があれば VC は見ない)');
  assert.match(m.htmlBody, /💰 資金調達/);
  // 別のサイトが同じ調達を書いても、もう送らない
  clock.tick(H);
  w.add = [{ k: 'decrypt', title: 'Lighter closes $68M Series B', link: 'https://decrypt.co/lighter', t: clock.now - 10 * 60000 }];
  gas.ctx.newsRecord_();
  assert.equal(fundMails(gas).length, 1);
  assert.ok(JSON.parse(gas.props.getProperty('PM_FUND_SENT')).lighter);
});

test('通知: 基準は pmConfig の notify (raiseMin・百万ドル、5〜1000) で変えられる。オフ・送り先なし・急変の通知オフでは送らない', () => {
  const a = world();
  assert.equal(a.gas.post({ action: 'pmConfig', notify: { raiseMin: 20 } }).ok, true);
  assert.equal(a.gas.ctx.ntf_().raiseMin, 20);
  a.gas.ctx.newsRecord_();
  const m = fundMails(a.gas)[0];
  assert.equal(m.subject, '【ポリマーケット】資金調達: Lighter 6,800万ドル ほか2件');
  assert.match(m.body, /Acme Labs 2,500万ドル \(シリーズA\)\n   主導: Paradigm・a16z・Coinbase Ventures ほか3社\n   トークンの有無は不明 ・ 分野: DeFi\n   The Block・CoinDesk: https:\/\/www\.theblock\.co\/news\/10-acme/, '2つのサイトを1行に');
  assert.match(m.body, /基準 2,000万ドル 以上/);
  a.gas.post({ action: 'pmConfig', notify: { raiseMin: 1 } });
  assert.equal(a.gas.ctx.ntf_().raiseMin, 5, '5 より小さくはできない');
  const b = world();
  b.gas.post({ action: 'pmConfig', notify: { raise: false } });
  b.gas.ctx.newsRecord_();
  assert.equal(fundMails(b.gas).length, 0);
  const c = world({ props: { MAIL_TO: '' } });
  c.gas.ctx.newsRecord_();
  assert.equal(c.gas.mails.length, 0);
  const d = world({ props: { PM_ALERT_ON: '0' } });
  d.gas.ctx.newsRecord_();
  assert.equal(fundMails(d.gas).length, 0);
  const def = plain(d.gas.ctx.ntfDefaults_());
  assert.equal(def.raise, true); assert.equal(def.raiseMin, 30); assert.equal(def.dFund, true);
  a.gas.post({ action: 'pmConfig', notify: { raiseMin: 5000 } });
  assert.equal(a.gas.ctx.ntf_().raiseMin, 1000, '1000 より大きくはできない');
});

test('毎朝のまとめ: 「■■ 資金調達 (ニュースから)」をニュースの直後に (読み取り + 48時間の調達)。dFund オフ・7日に無ければ載せない', () => {
  const { gas, clock } = world();
  gas.ctx.pmDigest();
  assert.doesNotMatch(gas.mails[gas.mails.length - 1].body, /資金調達 \(ニュースから\)/, '無ければ載せない');
  seedLlama(gas);
  gas.ctx.newsRecord_();
  gas.ctx.pmDigest();
  const m = gas.mails[gas.mails.length - 1], body = m.body;
  const i = body.indexOf('■■ 資金調達 (ニュースから)');
  assert.ok(i > body.indexOf('■■ ニュースと公式発表') && body.indexOf('■■ ニュースと公式発表') >= 0, 'ニュースの後');
  assert.ok(i < body.indexOf('■ 記録の状況'));
  const sec = body.slice(i, body.indexOf('\n\n', i));
  assert.match(sec, /^■■ 資金調達 \(ニュースから\)\n・直近7日の資金調達は 4件・合計 1億ドル でした \(その前の7日は 0件\)。/);
  assert.match(sec, /\n□ 直近48時間\n・Acme Labs 2,500万ドル ・ シリーズA ・ 主導: Paradigm・a16z・Coinbase Ventures ほか3社 ・ トークンあり ・ The Block・CoinDesk\n  https:\/\/www\.theblock\.co\/news\/10-acme/);
  assert.match(sec, /・Lighter 6,800万ドル ・ シリーズB ・ 主導: Founders Fund・Ribbit Capital ・ トークン未発行: エアドロップ候補の手がかり ・ Cointelegraph/);
  assert.match(sec, /・Zeta Network 金額非公表 ・ 戦略的出資/);
  assert.match(m.htmlBody, /💰 資金調達 \(ニュースから\)/);
  assert.match(m.htmlBody, /<a href="https:\/\/www\.theblock\.co\/news\/10-acme"/);
  gas.post({ action: 'pmConfig', notify: { dFund: false } });
  gas.ctx.pmDigest();
  assert.doesNotMatch(gas.mails[gas.mails.length - 1].body, /資金調達 \(ニュースから\)/);
  gas.post({ action: 'pmConfig', notify: { dFund: true } });
  clock.tick(3 * D);
  gas.ctx.pmDigest();
  assert.match(gas.mails[gas.mails.length - 1].body, /□ 直近48時間\n・直近48時間の新しい資金調達はありません/);
  clock.tick(5 * D);
  gas.ctx.pmDigest();
  assert.doesNotMatch(gas.mails[gas.mails.length - 1].body, /資金調達 \(ニュースから\)/, '7日に1件も無ければ載せない');
});

test('レポート: 「## 13. 資金調達 (ニュースから)」に表と主導した回数。既定の中身にも入る', () => {
  const { gas } = world();
  let t = gas.get({ action: 'report', days: '7', parts: 'fund' }).text;
  assert.match(t, /## 13\. 資金調達 \(ニュースから\)\n.*\n\(この期間の記録はありません\)/);
  seedLlama(gas);
  gas.ctx.newsRecord_();
  t = gas.get({ action: 'report', days: '7', parts: 'fund' }).text;
  assert.match(t, /\| 日付 \| 名前 \| ラウンド \| 金額 \| 分野 \| 主な投資家 \| トークン \| 出どころ \|/);
  assert.match(t, /\| 2026-11-14 \| Acme Labs \| シリーズA \| 2,500万ドル \| DeFi \| Paradigm・a16z・Coinbase Ventures ほか3社 \| あり \| The Block・CoinDesk \|/);
  assert.match(t, /\| 2026-11-14 \| Zeta Network \| 戦略的出資 \| 金額非公表 \| インフラ \| Paradigm \| あり \| Cointelegraph \|/);
  assert.match(t, /\| Lighter \| シリーズB \| 6,800万ドル \| 取引所 \| Founders Fund・Ribbit Capital \| 未発行 \|/);
  assert.match(t, /主導した回数 \(投資家ごと\)\n\| 投資家 \| 回数 \|\n.*\n\| Paradigm \| 2 \|/);
  const all = gas.get({ action: 'report', days: '7' }).text;
  assert.match(all, /## 13\. 資金調達 \(ニュースから\)/);
  assert.ok(all.indexOf('## 13.') > all.indexOf('## 12.'));
});

/* ---------- アプリ ---------- */
async function openFund(gas, clock) {
  const app = await openApp({ clock, gas, fetch: async () => { throw new TypeError('offline'); }, state: { settings: { gasUrl: GAS_URL, gasKey: 'secret-pass-12345', gasAuto: false } } });
  for (let i = 0; i < 6; i++) await app.settle();
  return app;
}
const fdNames = app => [...app.doc.querySelectorAll('#fdBody tbody tr td:nth-child(2) b')].map(x => x.textContent);

test('アプリ: お金の流れの DefiLlama の囲みの最初に「💰 資金調達」。読み取り・絞り込み (有名VCが主導 も)・検索・ラウンド・非公表・トークン・リンク', async () => {
  const { gas, clock } = world();
  seedLlama(gas);
  gas.ctx.newsRecord_();
  gas.props.setProperty('API_SECRET', 'secret-pass-12345');
  const app = await openFund(gas, clock);
  try {
    app.run('switchTab("flow")');
    for (let i = 0; i < 4; i++) await app.settle();
    const area = app.doc.querySelector('#fdArea');
    assert.equal(area.nextElementSibling.id, 'fmArea', 'ハッキング・ペッグなどの囲みより前');
    assert.match(area.querySelector('.hl-bar').textContent, /💰 資金調達 \(ニュースから\)/);
    assert.ok(app.doc.querySelector('#fdArea .gq[data-term="raise"]'));
    assert.match(app.text('#fdBody .op-read'), /今週いちばん大きいのは Lighter の 6,800万ドル/);
    assert.deepEqual(fdNames(app), ['Acme Labs', 'Zeta Network', 'Beta Wallet', 'Lighter']);
    const head = [...app.doc.querySelectorAll('#fdBody thead th')].map(x => x.textContent);
    assert.deepEqual(head, ['日付', '名前', 'ラウンド', '金額', '分野', '主な投資家', 'トークン', '出どころ']);
    const row = n => [...app.doc.querySelectorAll('#fdBody tbody tr')].find(tr => tr.children[1].textContent.startsWith(n)).children;
    const acme = row('Acme Labs');
    assert.equal(acme[0].textContent, '11/14');
    assert.equal(acme[2].textContent, 'シリーズA');
    assert.match(acme[3].textContent, /^2,500万ドル評価額 2\.5億ドル$/);
    assert.equal(acme[5].textContent, 'Paradigm・a16z・Coinbase Ventures +他3社');
    assert.equal(acme[6].textContent, 'あり');
    const links = [...acme[7].querySelectorAll('a')];
    assert.deepEqual(links.map(a => a.textContent), ['The Block', 'CoinDesk']);
    assert.deepEqual(links.map(a => a.getAttribute('href')), ['https://www.theblock.co/news/10-acme', 'https://www.coindesk.com/business/2026/11/14/acme']);
    assert.ok(links.every(a => a.target === '_blank' && a.rel === 'noopener'));
    assert.equal(row('Zeta Network')[3].textContent, '非公表');
    assert.equal(row('Zeta Network')[2].textContent, '戦略的出資');
    assert.equal(row('Beta Wallet')[2].textContent, 'シード');
    assert.equal(row('Beta Wallet')[6].textContent, '不明');
    assert.equal(row('Lighter')[6].textContent, '未発行');
    assert.match(app.text('#fdBody'), /ニュースになった資金調達だけです。金額や投資家は記事の見出しから AI が読み取ったもので、まちがいがあることもあります/);
    const chip = k => app.doc.querySelector(`#fdFilter [data-fdf="${k}"]`);
    assert.deepEqual([...app.doc.querySelectorAll('#fdFilter .chip')].map(x => x.textContent), ['すべて', 'トークン未発行', '1,000万ドル以上', '有名VCが主導']);
    chip('notok').click(); assert.deepEqual(fdNames(app), ['Lighter']);
    chip('big').click(); assert.deepEqual(fdNames(app), ['Acme Labs', 'Lighter']);
    chip('top').click(); assert.deepEqual(fdNames(app), ['Acme Labs', 'Zeta Network', 'Lighter']);
    assert.ok(chip('top').classList.contains('active'));
    chip('all').click();
    const q = app.doc.querySelector('#fdQ');
    q.value = 'ribbit'; q.dispatchEvent(new app.win.Event('input', { bubbles: true }));
    assert.deepEqual(fdNames(app), ['Lighter'], '投資家で探す');
    const q2 = app.doc.querySelector('#fdQ');
    assert.equal(q2.value, 'ribbit');
    q2.value = 'ウォレット'; q2.dispatchEvent(new app.win.Event('input', { bubbles: true }));
    assert.deepEqual(fdNames(app), ['Beta Wallet'], '分野で探す');
    const q3 = app.doc.querySelector('#fdQ'); q3.value = 'zzz'; q3.dispatchEvent(new app.win.Event('input', { bubbles: true }));
    assert.match(app.text('#fdBody'), /条件に合う資金調達はありません/);
    assert.ok(JSON.parse(app.win.localStorage.getItem('fd_cache_v1')).fund.list.length === 4, 'fd_cache_v1 に控える');
    // ↻ で取り直す
    const before = app.requests.filter(r => /action=fund/.test(r.url)).length;
    app.doc.querySelector('#flReload').click();
    await app.settle();
    assert.equal(app.requests.filter(r => /action=fund/.test(r.url)).length, before + 1);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('アプリ: 名前・投資家は AI の答えなのでエスケープ。http(s) 以外のリンクは出さない。30件のあと「もっと見る」', async () => {
  const { gas, clock } = world({ fund: false });
  const m = {};
  for (let i = 0; i < 35; i++) m['x' + i] = { t: clock.now - i * H, s: 'decrypt', ti: 'T' + i, l: i === 0 ? 'javascript:alert(1)' : 'https://decrypt.co/x' + i, ja: 'J', cat: '資金調達', fx: 1,
    fund: { p: i === 0 ? '<img src=x onerror=alert(1)>Evil' : 'Proj ' + i, amt: 1e6 * (i + 1), r: 'Seed', inv: i === 0 ? ['<b>Bad</b>'] : [], oth: null, val: null, sec: 'DeFi' } };
  gas.ctx.pmWrite_('news-2026-11.json', JSON.stringify(m));
  const app = await openFund(gas, clock);
  try {
    app.run('switchTab("flow")');
    for (let i = 0; i < 4; i++) await app.settle();
    const body = app.doc.querySelector('#fdBody');
    assert.equal(body.querySelector('img'), null);
    assert.equal(body.querySelector('tbody b b'), null);
    const first = body.querySelector('tbody tr').children;
    assert.equal(first[1].querySelector('b').textContent, '<img src=x onerror=alert(1)>Evil');
    assert.equal(first[5].textContent, '<b>Bad</b>');
    assert.equal(first[7].querySelector('a'), null, 'javascript: のリンクは出さない');
    assert.equal(first[7].textContent, 'Decrypt');
    assert.equal(body.querySelectorAll('tbody tr').length, 30);
    body.querySelector('[data-fdmore]').click();
    assert.equal(app.doc.querySelectorAll('#fdBody tbody tr').length, 35);
    assert.equal(app.doc.querySelector('#fdBody [data-fdmore]'), null);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('アプリ: ニュースタブに「💰 資金調達」の絞り込みと「💰 2,500万ドル調達」の印。ホームのお金の流れに今週いちばん大きい調達', async () => {
  const { gas, clock } = world();
  seedLlama(gas);
  gas.ctx.newsRecord_();
  const app = await openFund(gas, clock);
  try {
    app.run('switchTab("news")');
    for (let i = 0; i < 4; i++) await app.settle();
    app.doc.querySelector('#nwFilter [data-nwf="fund"]').click();
    const rows = [...app.doc.querySelectorAll('#nwList .nw-row')];
    assert.equal(rows.length, 5, '資金調達の記事だけ (Acme は2サイト)');
    assert.ok(rows.every(r => r.querySelector('.fd-raise')));
    const acme = rows.find(r => /Acme Labs/.test(r.textContent));
    assert.equal(acme.querySelector('.fd-raise').textContent, '💰 2,500万ドル調達');
    const zeta = rows.find(r => /Zeta/.test(r.textContent));
    assert.equal(zeta.querySelector('.fd-raise').textContent, '💰 資金調達', '金額が無い時');
    app.doc.querySelector('#nwFilter [data-nwf="all"]').click();
    const etf = [...app.doc.querySelectorAll('#nwList .nw-row')].find(r => /ETFs see/.test(r.textContent));
    assert.equal(etf.querySelector('.fd-raise'), null);
    // ホーム (お金の流れのカードがある時だけ)
    app.run('FL.data = { chains: [], perps: [] }; switchTab("top"); renderTop()');
    await app.settle();
    const card = [...app.doc.querySelectorAll('#homeBody .hm-card')].find(c => c.querySelector('h3').textContent === 'お金の流れ');
    const r = [...card.querySelectorAll('.hm-row')].find(x => /資金調達/.test(x.textContent));
    assert.match(r.textContent, /💰 今週いちばん大きい資金調達: Lighter/);
    assert.match(r.textContent, /シリーズB ・ 主導: Founders Fund・Ribbit Capital/);
    assert.match(r.textContent, /6,800万ドル 未発行/);
    assert.equal(r.dataset.jump, 'flow');
    assert.equal([...app.doc.querySelectorAll('#homeBody .hm-card')].filter(c => /資金調達/.test(c.querySelector('h3').textContent)).length, 0, '新しいカードは作らない');
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('アプリ: サーバー未登録・Gemini のキーが無い・古いサーバーの案内。設定の通知と毎朝のまとめ・記録をAIに渡す・用語', async () => {
  const clock = createClock('2026-11-14T10:00:00+09:00');
  const a = await openApp({ clock, fetch: async () => { throw new TypeError('offline'); } });
  try {
    a.run('switchTab("flow")'); await a.settle();
    assert.match(a.text('#fdBody'), /設定でサーバー \(Apps Script\) の URL を入れると表示されます/);
    assert.deepEqual(a.errors, []);
  } finally { a.close(); }
  const { gas } = world({ key: false });
  const b = await openFund(gas, clock);
  try {
    b.run('switchTab("flow")');
    for (let i = 0; i < 4; i++) await b.settle();
    assert.match(b.text('#fdBody'), /Gemini のキーを登録すると、ニュースの見出しから資金調達を読み取って/);
    const box = b.doc.querySelector('#ntfBox');
    assert.ok(box.querySelector('input[type="checkbox"][data-ntf="raise"]'));
    const min = box.querySelector('input[type="number"][data-ntf="raiseMin"]');
    assert.match(min.parentElement.textContent, /百万ドル以上 \(金額が書かれていない時は、有名VCが主導したもの\)/);
    assert.ok(box.querySelector('input[type="checkbox"][data-ntf="dFund"]'));
    b.run('ntfRender({ raise: false, raiseMin: 50, dFund: false }, { raise: true, raiseMin: 30, dFund: true })');
    const out = b.run('ntfRead()');
    assert.equal(out.raiseMin, 50); assert.equal(out.raise, false); assert.equal(out.dFund, false);
    const cb = b.doc.querySelector('.rep-parts input[value="fund"]');
    assert.ok(cb && cb.checked);
    assert.match(cb.parentElement.textContent, /💰 資金調達 \(ニュースから\)/);
    const G = b.run('GLOSS');
    assert.ok(G.raise && G.vc);
    assert.deepEqual([...G.raise.r], ['vc', 'airdrop', 'tge']);
    assert.deepEqual(b.errors, []);
  } finally { b.close(); }
  const c = await openApp({ clock, fetch: async u => { if (String(u).startsWith(GAS_URL)) return { ok: true, status: 200, json: async () => ({ ok: true, version: '2026.12.10' }) }; throw new TypeError('offline'); },
    state: { settings: { gasUrl: GAS_URL, gasKey: '', gasAuto: false } } });
  try {
    c.run('switchTab("flow")');
    for (let i = 0; i < 4; i++) await c.settle();
    assert.match(c.text('#fdBody'), /取得できませんでした: サーバーが古い版です/);
  } finally { c.close(); }
});
