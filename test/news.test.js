'use strict';
/* ニュースと公式発表 (RSS): 取り込み・和訳と重要度・通知・毎朝のまとめ・急変メール・レポート・画面 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('./helpers/gas');
const { openApp, GAS_URL } = require('./helpers/app');
const { createClock } = require('./helpers/clock');
const { newsFetch, geminiFake } = require('./helpers/news');

const H = 3600000;
const ok = o => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify(o) });
/** ニュース (と Gemini・空の Polymarket) だけ答える世界 */
function world(opts) {
  opts = opts || {};
  const clock = createClock(opts.start || '2026-11-14T10:00:00+09:00');
  const nf = newsFetch(clock, opts.world), gem = geminiFake();
  const fetch = (url, params) => {
    const r = nf(url, params) || gem(url, params); if (r) return r;
    if (opts.markets && /gamma-api\.polymarket\.com\/markets/.test(url)) return opts.markets(url);
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
const plain = x => JSON.parse(JSON.stringify(x));   // vm の中の配列を、この中の配列にする

/* ---------- 読み取り ---------- */
test('読み取り: RSS と Atom・CDATA・文字参照・タグの除去・おかしな日付・リンクや題の無いもの', () => {
  const { gas } = world();
  const now = Date.parse('2026-11-14T01:00:00Z');
  const rss = `<rss><channel><title>ch</title>
    <item><title><![CDATA[A & B <b>bold</b>]]></title><link><![CDATA[https://a.example/1?x=1&y=2]]></link><pubDate>Fri, 13 Nov 2026 21:15:00 GMT</pubDate>
      <description>&lt;p&gt;Hello&amp;nbsp;&lt;i&gt;world&lt;/i&gt; &amp;amp; more&lt;/p&gt;   &#8220;q&#8221; &#x2014; it&#39;s</description></item>
    <item><title>Bad date</title><link>https://a.example/2</link><pubDate>someday</pubDate></item>
    <item><title>No link</title><description>x</description></item>
    <item><title>JS link</title><link>javascript:alert(1)</link></item>
    <item><title>  </title><link>https://a.example/3</link></item>
    <item><title>Long</title><link>https://a.example/4</link><description>${'word '.repeat(300)}</description></item>
  </channel></rss>`;
  const r = plain(gas.ctx.newsParse_(rss, now));
  assert.deepEqual(r.map(x => x.title), ['A & B bold', 'Bad date', 'Long']);
  assert.equal(r[0].link, 'https://a.example/1?x=1&y=2');
  assert.equal(r[0].t, Date.parse('2026-11-13T21:15:00Z'));
  assert.equal(r[0].desc, 'Hello world & more “q” — it\'s');
  assert.equal(r[1].t, now, 'おかしな日付は取得した時刻にする');
  assert.ok(r[2].desc.length <= 600 && r[2].desc.endsWith('…'), '説明は600文字まで');
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title>f</title><link rel="self" href="https://f.example/feed"/>
    <entry><title type="html">X &amp;amp; Y</title><link rel="enclosure" href="https://img.example/a.jpg"/><link rel="alternate" href="https://f.example/a"/>
      <published>2026-11-13T20:00:00Z</published><updated>2026-11-13T22:00:00Z</updated><summary type="html">&lt;p&gt;Sum &lt;b&gt;here&lt;/b&gt;&lt;/p&gt;</summary></entry>
    <entry><title>Only updated</title><link href="https://f.example/b"/><updated>2026-11-13T23:00:00+00:00</updated><content type="html"><![CDATA[<div>Body</div>]]></content></entry>
    <entry><title>No href</title><link rel="alternate"/></entry>
  </feed>`;
  const a = plain(gas.ctx.newsParse_(atom, now));
  assert.deepEqual(a.map(x => [x.title, x.link, x.t, x.desc]), [
    ['X & Y', 'https://f.example/a', Date.parse('2026-11-13T20:00:00Z'), 'Sum here'],
    ['Only updated', 'https://f.example/b', Date.parse('2026-11-13T23:00:00Z'), 'Body'],
  ]);
  assert.deepEqual(plain(gas.ctx.newsParse_('not xml at all', now)), []);
});

/* ---------- 記録 ---------- */
test('記録: 72時間以内の記事を月ごとのファイルと news-latest.json に残す。2回目は重ねない。説明文はどこにも保存しない', () => {
  const { gas, clock, w, nf } = world({ key: false });
  const r = gas.ctx.newsRecord_();
  assert.deepEqual(plain(r.errors), []);
  const L = latest(gas);
  assert.equal(L.items.length, 10, '72時間より前・リンクや題の無いもの・javascript: のリンクは入れない');
  assert.ok(!L.items.some(x => /discount rate|Click me|No link/.test(x.ti)));
  assert.deepEqual(L.errors, []);
  assert.equal(L.at, clock.now);
  assert.deepEqual(L.items.map(x => x.t), L.items.map(x => x.t).slice().sort((a, b) => b - a), '新しい順');
  const sec = byTitle(gas, /Spot Ether/);
  assert.equal(sec.ti, 'SEC Approves Options on Spot Ether ETFs & Sets Rules');
  assert.equal(sec.s, 'sec');
  assert.equal(sec.t, clock.now - 3 * H);
  assert.equal(byTitle(gas, /Hyperliquid/).ti, 'Hyperliquid tops “open interest” rankings');
  assert.equal(byTitle(gas, /Strategy/).ti, 'Strategy\'s Bitcoin Buying — What’s Next');
  assert.equal(byTitle(gas, /Louisiana/).t, clock.now, '日付の読めない記事は取り込んだ時刻');
  assert.equal(byTitle(gas, /Ethereum/).l, 'https://cointelegraph.com/news/eth-upgrade?utm_source=rss_feed&utm_medium=rss');
  const month = fileJson(gas, 'news-2026-11.json');
  assert.equal(Object.keys(month).length, 10);
  assert.deepEqual(Object.keys(month[sec.id]).sort(), ['l', 's', 't', 'ti']);
  // SEC などのために名乗る
  assert.ok(nf.calls.length >= 7 && nf.calls.every(c => /market-notes/.test(c.headers['User-Agent'])));
  // 1時間後: 同じ記事は重ねず、新しい記事だけ足す
  clock.tick(H);
  w.extra = [{ title: 'New story about Bitcoin ETF', link: 'https://decrypt.co/new-1', t: clock.now - 10 * 60000, desc: 'DESC_MARK_new1' }];
  gas.ctx.newsRecord_();
  assert.equal(Object.keys(fileJson(gas, 'news-2026-11.json')).length, 11);
  assert.equal(latest(gas).items.length, 11);
  assert.equal(latest(gas).items[0].ti, 'New story about Bitcoin ETF');
  assert.equal(byTitle(gas, /Louisiana/).t, clock.now - H, '一度入れた記事の時刻は変えない');
  // 説明文 (本文) はドライブのどこにも無い
  for (const f of files(gas)) assert.doesNotMatch(f.content, /DESC_MARK|Commission approved|maintain the target range/, f.name);
  assert.deepEqual(files(gas).map(f => f.name).sort(), ['news-2026-11.json', 'news-latest.json']);
});

test('記録: 月は記事の日本時間で分ける。news-latest.json は7日以内', () => {
  const { gas, clock, w } = world({ key: false, start: '2026-12-01T03:00:00+09:00' });
  gas.ctx.newsRecord_();
  const nov = fileJson(gas, 'news-2026-11.json'), dec = fileJson(gas, 'news-2026-12.json');
  assert.ok(Object.values(dec).some(x => /Louisiana/.test(x.ti)), '12/1 3:00 (日本時間) の記事は12月');
  assert.ok(Object.values(dec).some(x => /FOMC/.test(x.ti)), '12/1 1:00 (日本時間) の記事も12月');
  assert.ok(Object.values(nov).some(x => /Example Bank/.test(x.ti)), '11/30 22:00 (日本時間) の記事は11月');
  assert.equal(latest(gas).items.length, 10);
  // 8日たつと最新の一覧から外れる (月のファイルには残る)
  clock.tick(8 * 24 * H);
  w.base = clock.now - 100 * H;   // フィードの記事はどれも72時間より前
  gas.ctx.newsRecord_();
  assert.equal(latest(gas).items.length, 0);
  assert.ok(Object.keys(fileJson(gas, 'news-2026-11.json')).length >= 1);
});

test('記録: 1つのフィードが落ちても他は記録し、errors に残す。見張りは ok', () => {
  const { gas, w } = world({ key: false, world: { down: { sec: true } } });
  gas.ctx.hbRun_('news', gas.ctx.newsRecord_);
  const L = latest(gas);
  assert.deepEqual(L.errors, ['SEC']);
  assert.ok(L.items.length >= 8);
  assert.ok(!L.items.some(x => x.s === 'sec'));
  const j = gas.get({ action: 'health' }).health.jobs.find(x => x.k === 'news');
  assert.equal(j.st, 'ok');
  assert.equal(j.n, 'ニュースと公式発表');
  assert.equal(j.every, '1時間ごと');
  // 直れば errors は空に
  w.down = {};
  gas.ctx.newsRecord_();
  assert.deepEqual(latest(gas).errors, []);
});

test('記録: 全部のフィードが落ちたら投げる (見張りは error)。前の news-latest.json はそのまま', () => {
  const { gas, w, clock } = world({ key: false });
  gas.ctx.newsRecord_();
  const before = JSON.stringify(latest(gas));
  w.allDown = true; clock.tick(H);
  assert.throws(() => gas.ctx.newsRecord_(), /ニュースを1つも取得できませんでした/);
  gas.ctx.hbRun_('news', gas.ctx.newsRecord_);
  const j = gas.get({ action: 'health' }).health.jobs.find(x => x.k === 'news');
  assert.equal(j.st, 'error');
  assert.match(j.err, /1つも取得できませんでした/);
  assert.equal(JSON.stringify(latest(gas)), before);
});

/* ---------- AI ---------- */
test('AI: キーが無い時は和訳せず Gemini を呼ばない。キーを入れた後の実行で和訳する', () => {
  const { gas, gem, clock } = world({ key: false });
  gas.ctx.newsRecord_();
  assert.equal(gem.calls.length, 0);
  assert.ok(latest(gas).items.every(x => x.ja == null && x.sc == null));
  assert.equal(gas.get({ action: 'news' }).ai, false);
  gas.post({ action: 'pmConfig', geminiKey: 'k2' });
  clock.tick(H);
  gas.ctx.newsRecord_();
  assert.equal(newsCalls(gem).length, 1);
  assert.ok(latest(gas).items.every(x => x.ja && x.sum && x.sc != null && x.cat));
  assert.equal(gas.get({ action: 'news' }).ai, true);
});

test('AI: 日本語の題・要約・重要度・分野を付ける。1回に30件まで (15件ずつ)、済んだものは送り直さない', () => {
  const { gas, gem, clock } = world({ world: { many: 35 } });
  gas.ctx.newsRecord_();
  const c1 = newsCalls(gem);
  assert.deepEqual(c1.map(c => c.input.length), [15, 15]);
  const sent1 = c1.flatMap(c => c.input.map(x => x.t));
  assert.equal(sent1[0], 'CFTC Sues Louisiana Over Prediction Markets', '新しい順');
  assert.equal(c1[0].input[0].s, 'CFTC');
  assert.ok(c1[0].input.some(x => x.d === 'DESC_MARK_cd1 Analysts point to fund redemptions.'), '説明は AI に渡すだけ');
  const fomc = byTitle(gas, /FOMC/);
  assert.equal(fomc.ja, '和:Federal Reserve issues FOMC statement');
  assert.equal(fomc.sum, '要約:Federal Reserve issues F');
  assert.equal(fomc.sc, 3);
  assert.equal(fomc.cat, '金融政策');
  assert.equal(latest(gas).items.filter(x => x.ja).length, 30);
  // 次の実行で残り (15件) だけ
  clock.tick(H);
  gas.ctx.newsRecord_();
  const c2 = newsCalls(gem).slice(2);
  assert.deepEqual(c2.map(c => c.input.length), [15]);
  const sent2 = c2.flatMap(c => c.input.map(x => x.t));
  assert.ok(!sent2.some(t => sent1.includes(t)), '済んだものは送らない');
  assert.equal(latest(gas).items.filter(x => !x.ja).length, 0);
  clock.tick(H);
  gas.ctx.newsRecord_();
  assert.equal(newsCalls(gem).length, 3, '全部済んだら呼ばない');
  for (const f of files(gas)) assert.doesNotMatch(f.content, /DESC_MARK/, f.name);
});

test('AI: 1日の上限に達していたら呼ばない。Gemini が失敗しても記事は残り、次の実行で和訳する', () => {
  const a = world({ props: { PM_AI_DAY: JSON.stringify({ d: '2026-11-14', n: 400 }) } });
  a.gas.ctx.newsRecord_();
  assert.equal(a.gem.calls.length, 0, '上限なら呼ばない');
  assert.equal(latest(a.gas).items.length, 10);
  assert.ok(latest(a.gas).items.every(x => !x.ja));
  assert.match(latest(a.gas).aiErr, /上限/);
  const b = world();
  b.gem.down = true;
  b.gas.ctx.newsRecord_();
  assert.equal(newsCalls(b.gem).length, 1, '失敗したら、その回は打ち切る');
  assert.equal(latest(b.gas).items.length, 10, '記事は残す');
  assert.ok(latest(b.gas).items.every(x => !x.ja));
  assert.equal(b.gas.mails.length, 0);
  b.gem.down = false; b.clock.tick(H);
  b.gas.ctx.newsRecord_();
  assert.ok(latest(b.gas).items.every(x => x.ja));
  assert.equal(JSON.parse(b.gas.props.getProperty('PM_AI_DAY')).n, 2, '呼んだ回数を1日の上限に数える');
});

/* ---------- 通知 ---------- */
test('通知: 重要度3の記事を1通にまとめて知らせ、同じ記事は1回だけ。基準を2にすると増え、オフなら送らない', () => {
  const { gas, clock, w } = world();
  gas.ctx.newsRecord_();
  assert.equal(gas.mails.length, 1);
  const m = gas.mails[0];
  assert.equal(m.to, 'muse@example.com');
  assert.equal(m.subject, '【ポリマーケット】ニュース: 和:Federal Reserve issues FOMC statement');
  assert.match(m.body, /1\. \[FRB・公式\] 11\/14 08:00\n   和:Federal Reserve issues FOMC statement\n   要約:Federal Reserve issues F\n   原文: Federal Reserve issues FOMC statement\n   https:\/\/www\.federalreserve\.gov\/newsevents\/pressreleases\/monetary20261114a\.htm/);
  assert.match(m.body, /2\. \[The Block\] 11\/14 06:00\n   和:Hyperliquid tops/);
  assert.doesNotMatch(m.body, /Spot Ether|Bitcoin slides/, '重要度2は送らない (初期値)');
  assert.ok(m.htmlBody.includes('📰 ニュースと公式発表'));
  const month = fileJson(gas, 'news-2026-11.json');
  assert.equal(Object.values(month).filter(x => x.m).length, 2, '送った印');
  // 次の実行では同じ記事を送らない
  clock.tick(H); gas.ctx.newsRecord_();
  assert.equal(gas.mails.length, 1);
  // 基準を2にする → 新しく判定した重要度2の記事だけ
  gas.post({ action: 'pmConfig', notify: { newsMin: 2 } });
  assert.equal(gas.get({}).pm.mail.notify.newsMin, 2);
  w.extra = [{ title: 'Spot Bitcoin ETF sees record inflow', link: 'https://decrypt.co/etf-inflow', t: clock.now - 60000 }];
  clock.tick(H); gas.ctx.newsRecord_();
  assert.equal(gas.mails.length, 2);
  assert.match(gas.mails[1].subject, /和:Spot Bitcoin ETF sees record inflow/);
  assert.doesNotMatch(gas.mails[1].body, /FOMC/, '送った記事はもう送らない');
  // 範囲の外 (1) は 2 に丸める
  gas.post({ action: 'pmConfig', notify: { newsMin: 1 } });
  assert.equal(gas.get({}).pm.mail.notify.newsMin, 2);
  // オフ
  gas.post({ action: 'pmConfig', notify: { news: false } });
  w.extra.push({ title: 'Hyperliquid launches new vaults', link: 'https://decrypt.co/hl-vaults', t: clock.now });
  clock.tick(H); gas.ctx.newsRecord_();
  assert.equal(gas.mails.length, 2, 'オフの時は送らない');
  assert.ok(byTitle(gas, /new vaults/).ja, '和訳はする');
});

test('通知: 送り先が無い・急変の通知をオフにした時は送らない', () => {
  const a = world({ props: { MAIL_TO: '' } });
  a.gas.ctx.newsRecord_();
  assert.equal(a.gas.mails.length, 0);
  const b = world({ props: { PM_ALERT_ON: '0' } });
  b.gas.ctx.newsRecord_();
  assert.equal(b.gas.mails.length, 0);
});

/* ---------- 毎朝のまとめ ---------- */
test('毎朝のまとめ: 「■■ ニュースと公式発表 (直近24時間)」を Polymarket の後に。公式が先。dNews をオフ・記事が無ければ載せない', () => {
  const { gas, clock } = world();
  gas.ctx.pmDigest();
  assert.doesNotMatch(gas.mails[gas.mails.length - 1].body, /■■ ニュースと公式発表/, '記事が無ければ載せない');
  gas.ctx.newsRecord_();
  gas.ctx.pmDigest();
  const m = gas.mails[gas.mails.length - 1], body = m.body;
  const sec = body.slice(body.indexOf('■■ ニュースと公式発表 (直近24時間)'), body.indexOf('■ 記録の状況'));
  assert.ok(body.indexOf('■ 新しく出てきた市場') < body.indexOf('■■ ニュースと公式発表'), 'Polymarket の後');
  assert.ok(body.indexOf('■■ ニュースと公式発表') < body.indexOf('■ 記録の状況'));
  const lines = sec.split('\n').filter(l => l.startsWith('・'));
  assert.deepEqual(lines.slice(0, 4).map(l => l.match(/^・\[([^\]]+)\]/)[1]), ['FRB', 'CFTC', 'SEC', 'FRB'], '公式が先 (重要度の高い順、同じなら新しい順)');
  assert.equal(lines[0], '・[FRB] 和:Federal Reserve issues FOMC statement — 要約:Federal Reserve issues F');
  assert.match(sec, /・\[FRB\] 和:Federal Reserve issues FOMC statement — .*\n  https:\/\/www\.federalreserve\.gov\//);
  assert.match(lines[4], /^・\[The Block\] 和:Hyperliquid/, '公式の後は重要度の高い順');
  assert.equal(lines.length, 8, '公式か重要度2以上、24時間以内だけ');
  assert.doesNotMatch(sec, /Ethereum developers|NFT sales/, '重要度の低いものは入れない');
  assert.ok(m.htmlBody.includes('📰 ニュースと公式発表 (直近24時間)'));
  assert.ok(m.htmlBody.includes('href="https://www.federalreserve.gov/newsevents/pressreleases/monetary20261114a.htm"'));
  gas.post({ action: 'pmConfig', notify: { dNews: false } });
  gas.ctx.pmDigest();
  assert.doesNotMatch(gas.mails[gas.mails.length - 1].body, /■■ ニュースと公式発表/);
  // 25時間たつと、24時間の欄は空 → 載せない
  gas.post({ action: 'pmConfig', notify: { dNews: true } });
  clock.tick(25 * H);
  gas.ctx.pmDigest();
  assert.doesNotMatch(gas.mails[gas.mails.length - 1].body, /■■ ニュースと公式発表/);
});

/* ---------- 急変のメール ---------- */
test('急変のメール: 直近6時間のニュースを手がかりとして足す。ニュースが無くても・壊れていても送れる', () => {
  const fed = { id: '1', question: 'Will the Fed cut rates?', slug: 's1', outcomes: '["Yes","No"]', outcomePrices: '["0.72","0.28"]', oneHourPriceChange: 0.12, oneDayPriceChange: 0,
    volume24hr: 50000, volume1wk: 350000, closed: false, active: true, events: [{ id: 'fed', title: 'Fed decision', slug: 'fed' }] };
  const markets = url => { const u = new URL(url); return ok(Number(u.searchParams.get('offset') || 0) === 0 || u.searchParams.getAll('id').length ? [fed] : []); };
  const a = world({ markets });
  a.gas.ctx.pmAlert();
  assert.equal(a.gas.mails.length, 1, 'ニュースが無くても急変は送る');
  assert.doesNotMatch(a.gas.mails[0].body, /直近6時間のニュース/);
  const b = world({ markets });
  b.gas.ctx.newsRecord_();
  const before = b.gas.mails.length;
  b.gas.ctx.pmAlert();
  assert.equal(b.gas.mails.length, before + 1);
  const m = b.gas.mails[b.gas.mails.length - 1];
  assert.match(m.subject, /急変 1件/);
  const blk = m.body.slice(m.body.indexOf('■ 直近6時間のニュース (動いた理由の手がかり)'));
  assert.ok(m.body.indexOf('■ 直近6時間のニュース') > m.body.indexOf('polymarket.com/event/fed'));
  const lines = blk.split('\n').filter(l => l.startsWith('・'));
  assert.equal(lines.length, 5, '5件まで');
  assert.deepEqual(lines.map(l => l.match(/^・\[([^\]]+)\]/)[1]), ['FRB', 'CFTC', 'SEC', 'FRB', 'The Block']);
  assert.match(blk, /※ ポリマーケット記録アプリが10分おきに/);
  assert.ok(m.htmlBody.includes('直近6時間のニュース'));
  const c = world({ markets });
  c.gas.ctx.pmWrite_('news-latest.json', '{broken');
  c.gas.ctx.pmAlert();
  assert.equal(c.gas.mails.length, 1);
});

/* ---------- レポート・doGet ---------- */
test('レポート: 「## 9. ニュースと公式発表」に表 (公式と重要度2以上・新しい順)。既定の中身にも入る', () => {
  const { gas } = world();
  let t = gas.get({ action: 'report', days: '7', parts: 'news' }).text;
  assert.match(t, /## 9\. ニュースと公式発表/);
  assert.match(t, /この期間の記録はありません/);
  gas.ctx.newsRecord_();
  t = gas.get({ action: 'report', days: '7', parts: 'news' }).text;
  assert.match(t, /\| 日時 \(日本時間\) \| 出どころ \| 題 \| 要約 \| 重要度 \|/);
  assert.match(t, /\| 2026-11-14 08:00 \| FRB \(公式\) \| 和:Federal Reserve issues FOMC statement \(Federal Reserve issues FOMC statement\) \| 要約:Federal Reserve issues F \| 3 \|/);
  assert.match(t, /\| The Block \| 和:Polymarket volume hits record/);
  assert.doesNotMatch(t, /Ethereum developers|NFT sales/);
  const rows = t.split('\n').filter(l => /^\| 2026-/.test(l));
  assert.equal(rows.length, 8);
  assert.deepEqual(rows.map(r => r.slice(2, 18)), rows.map(r => r.slice(2, 18)).slice().sort().reverse(), '新しい順');
  assert.match(gas.get({ action: 'report', days: '7' }).text, /## 9\. ニュースと公式発表/);
});

test('doGet action=news: 既定は3日・最大7日。フィードの一覧を返し、合言葉で守られる', () => {
  const { gas, clock } = world();
  let r = gas.get({ action: 'news' });
  assert.equal(r.ok, true);
  assert.equal(r.version, gas.C.GAS_VERSION);
  assert.deepEqual(r.news, { at: null, items: [], errors: [] });
  assert.deepEqual(r.feeds.map(f => f.k), ['frb', 'sec', 'cftc', 'coindesk', 'theblock', 'ctg', 'decrypt']);
  assert.deepEqual(r.feeds.filter(f => f.off).map(f => f.n), ['FRB', 'SEC', 'CFTC']);
  assert.ok(!('url' in r.feeds[0]));
  gas.ctx.newsRecord_();
  clock.tick(3 * 24 * H - 30 * 60000);
  assert.equal(gas.get({ action: 'news' }).news.items.length, 1, '3日以内 (取り込み時刻の記事だけ)');
  assert.equal(gas.get({ action: 'news', days: '7' }).news.items.length, 10);
  assert.equal(gas.get({ action: 'news', days: '30' }).news.items.length, 10, '7日まで');
  gas.props.setProperty('API_SECRET', 'secret-pass-12345');
  r = gas.get({ action: 'news' });
  assert.equal(r.needKey, true);
  assert.equal(r.news, undefined);
  assert.equal(gas.get({ action: 'news', key: 'secret-pass-12345' }).news.items.length, 1);
});

test('見張り: pmRecord の後、ニュースの記録は ok', () => {
  const { gas } = world({ key: false, markets: () => ok([{ id: '1', question: 'Q', outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]', volume24hr: 1, closed: false, active: true, events: [{ id: 'e', title: 'E', slug: 'e' }] }]) });
  gas.ctx.pmRecord();
  const j = gas.get({ action: 'health' }).health.jobs.find(x => x.k === 'news');
  assert.equal(j.st, 'ok');
  assert.equal(latest(gas).items.length, 10);
});

/* ---------- 画面 ---------- */
async function openNews(gas, clock, storage) {
  const app = await openApp({ clock, gas, storage, fetch: async () => { throw new TypeError('offline'); }, state: { settings: { gasUrl: GAS_URL, gasKey: 'secret-pass-12345', gasAuto: false } } });
  for (let i = 0; i < 6; i++) await app.settle();
  return app;
}
const rowTitles = app => [...app.doc.querySelectorAll('#nwList .nw-row .nw-t')].map(x => x.textContent.trim());
const typeQ = (app, v) => { const q = app.doc.querySelector('#nwQ'); q.value = v; q.dispatchEvent(new app.win.Event('input', { bubbles: true })); };

test('アプリ: ニュースタブに記事 (時刻・出どころ・日本語の題・要約・分野・重要度)。絞り込み・出どころ・検索・原文・日の区切り', async () => {
  const { gas, clock } = world();
  gas.ctx.newsRecord_();
  gas.props.setProperty('API_SECRET', 'secret-pass-12345');
  const app = await openNews(gas, clock);
  try {
    app.run('switchTab("news")');
    for (let i = 0; i < 4; i++) await app.settle();
    assert.ok(app.doc.querySelector('nav button[data-tab="news"]').classList.contains('active'));
    assert.equal(app.doc.querySelector('nav.tabs button[data-tab="top"]').nextElementSibling.dataset.tab, 'news', 'ホームのすぐ後');
    // 既定は「あなた向け」(重要度2以上)
    assert.ok(app.doc.querySelector('#nwFilter [data-nwf="rel"]').classList.contains('active'));
    assert.equal(rowTitles(app).length, 7);
    const first = app.doc.querySelector('#nwList .nw-row');
    assert.equal(app.text('#nwList .nw-day'), '今日');
    assert.match(first.textContent.replace(/\s+/g, ' '), /🏛 CFTC\s*たった今 ・ 10:00\s*規制/);
    assert.equal(first.querySelector('.nw-t').textContent.trim(), '和:CFTC Sues Louisiana Over Prediction Markets');
    assert.equal(first.querySelector('.nw-sum').textContent, '要約:CFTC Sues Louisiana Over');
    assert.equal(first.querySelector('.nw-dots').getAttribute('title'), '重要度 2 / 3');
    const a = first.querySelector('a.nw-go');
    assert.equal(a.getAttribute('href'), 'https://www.cftc.gov/PressRoom/PressReleases/9326-26');
    assert.equal(a.getAttribute('target'), '_blank');
    assert.equal(a.getAttribute('rel'), 'noopener');
    const fomc = [...app.doc.querySelectorAll('#nwList .nw-row')].find(r => /FOMC/.test(r.textContent));
    assert.match(fomc.textContent.replace(/\s+/g, ' '), /🏛 FRB\s*2時間前 ・ 08:00\s*金融政策/);
    assert.ok(fomc.classList.contains('nw-hot'));
    // 原文の表示
    assert.equal(fomc.querySelector('.nw-orig'), null);
    fomc.querySelector('[data-nworig]').click();
    const fomc2 = [...app.doc.querySelectorAll('#nwList .nw-row')].find(r => /FOMC/.test(r.textContent));
    assert.equal(fomc2.querySelector('.nw-orig').textContent, 'Federal Reserve issues FOMC statement');
    assert.match(fomc2.querySelector('[data-nworig]').textContent, /原文を隠す/);
    // 公式発表だけ
    app.doc.querySelector('#nwFilter [data-nwf="off"]').click();
    assert.equal(rowTitles(app).length, 4);
    assert.ok([...app.doc.querySelectorAll('#nwList .nw-src')].every(x => x.classList.contains('off')));
    // すべて → 日の区切り (今日 / 昨日)
    app.doc.querySelector('#nwFilter [data-nwf="all"]').click();
    assert.equal(rowTitles(app).length, 10);
    assert.deepEqual([...app.doc.querySelectorAll('#nwList .nw-day')].map(x => x.textContent), ['今日', '昨日']);
    assert.equal(JSON.parse(app.win.localStorage.getItem('pm_ui_v1')).nw, 'all', '選んだ絞り込みを覚える');
    // 出どころ
    const chips = [...app.doc.querySelectorAll('#nwSrc [data-nwsrc]')].map(x => x.textContent);
    assert.deepEqual(chips, ['すべての出どころ', '🏛 FRB', '🏛 SEC', '🏛 CFTC', 'CoinDesk', 'The Block', 'Cointelegraph', 'Decrypt']);
    app.doc.querySelector('#nwSrc [data-nwsrc="theblock"]').click();
    assert.deepEqual(rowTitles(app), ['和:Hyperliquid tops “open interest” rankings', '和:Polymarket volume hits record']);
    app.doc.querySelector('#nwSrc [data-nwsrc=""]').click();
    // 検索 (日本語の題・原文・要約)
    typeQ(app, 'louisiana');
    assert.deepEqual(rowTitles(app), ['和:CFTC Sues Louisiana Over Prediction Markets']);
    typeQ(app, 'ないはずの言葉');
    assert.match(app.text('#nwList'), /条件に合うニュースはありません/);
    typeQ(app, '');
    assert.match(app.text('#nwInfo'), /今日 10:00 更新/);
    assert.equal(app.text('#nwNote'), '', 'キーがある時は案内を出さない');
    const toGas = app.requests.filter(r => r.url.startsWith(GAS_URL));
    assert.ok(toGas.some(r => /action=news/.test(r.url) && /[?&]key=secret-pass-12345/.test(r.url)));
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
  // 絞り込みは次に開いた時も同じ
  const app2 = await openNews(gas, clock, { pm_ui_v1: { nw: 'off', cat: 'all' } });
  try {
    app2.run('switchTab("news")');
    for (let i = 0; i < 4; i++) await app2.settle();
    assert.ok(app2.doc.querySelector('#nwFilter [data-nwf="off"]').classList.contains('active'));
    assert.equal(rowTitles(app2).length, 4);
    assert.deepEqual(app2.errors, []);
  } finally { app2.close(); }
});

test('アプリ: 未訳の印・キーが無い時の案内・あなた向けが空の時の案内・一部取得できず・http(s) 以外のリンクは出さない', async () => {
  const { gas, clock } = world({ key: false, world: { down: { decrypt: true } } });
  gas.ctx.newsRecord_();
  // ドライブに javascript: のリンクの記事を混ぜる (サーバーは入れないが、画面でも防ぐ)
  const L = latest(gas);
  L.items.unshift({ id: 'bad1', t: clock.now, s: 'coindesk', ti: 'Evil <img src=x onerror=alert(1)> link', l: 'javascript:alert(1)' });
  gas.ctx.pmWrite_('news-latest.json', JSON.stringify(L));
  const app = await openNews(gas, clock);
  try {
    app.run('switchTab("news")');
    for (let i = 0; i < 4; i++) await app.settle();
    assert.match(app.text('#nwList'), /あなた向け \(重要度2以上\) のニュースは今はありません。ほかに 10件 あります/);
    assert.match(app.text('#nwNote'), /設定「🈯 和訳とあなた向け」で Gemini のキーを登録すると始まります/);
    assert.match(app.text('#nwInfo'), /一部取得できず \(Decrypt\)/);
    app.doc.querySelector('#nwList [data-nwf="all"]').click();
    assert.ok(app.doc.querySelector('#nwFilter [data-nwf="all"]').classList.contains('active'));
    assert.equal(rowTitles(app).length, 10);
    const evil = [...app.doc.querySelectorAll('#nwList .nw-row')].find(r => /Evil/.test(r.textContent));
    assert.equal(evil.querySelector('a'), null, 'javascript: はリンクにしない');
    assert.equal(evil.querySelector('img'), null, '題はそのまま文字として出す');
    assert.match(evil.querySelector('.nw-t').textContent, /Evil <img src=x onerror=alert\(1\)> link\s*未訳/);
    assert.ok(evil.querySelector('.nw-mi'));
    assert.equal(evil.querySelector('[data-nworig]'), null, '未訳の時は原文ボタンを出さない');
    assert.equal(app.doc.querySelectorAll('#nwList a[href^="javascript"]').length, 0);
    assert.ok([...app.doc.querySelectorAll('#nwList a')].every(x => /^https:\/\//.test(x.getAttribute('href'))));
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('アプリ: ホームに「📰 ニュースと公式発表」(24時間以内の公式・あなた向けを4件)。押すとニュースタブへ。Polymarket の詳細に関連しそうなニュース', async () => {
  const { gas, clock } = world();
  gas.ctx.newsRecord_();
  const mkt = { id: '7', question: 'Will Hyperliquid flip Binance in open interest?', groupItemTitle: '', outcomes: '["Yes","No"]', outcomePrices: '["0.3","0.7"]', oneDayPriceChange: 0.01, oneHourPriceChange: 0,
    volume24hr: 1e5, volumeNum: 1e6, liquidityNum: 1e4, endDate: '2026-12-10T00:00:00Z', clobTokenIds: '["t7"]', closed: false, events: [{ id: 'hlx', title: 'Will Hyperliquid flip Binance?', slug: 'hlx' }] };
  const pmFetch = async url => {
    const u = new URL(url);
    const body = u.host === 'clob.polymarket.com' ? { history: [] }
      : u.pathname === '/markets' ? (Number(u.searchParams.get('offset') || 0) === 0 ? [mkt] : []) : { events: [] };
    return { ok: true, status: 200, json: async () => body };
  };
  const app = await openApp({ clock, gas, fetch: pmFetch, state: { settings: { gasUrl: GAS_URL, gasAuto: false } } });
  try {
    for (let i = 0; i < 10; i++) await app.settle();
    const card = [...app.doc.querySelectorAll('#homeBody .hm-card')].find(c => /ニュースと公式発表/.test(c.querySelector('h3').textContent));
    assert.ok(card, 'ホームにニュースのカード');
    assert.ok(card.classList.contains('hm-wide'), '7枚目なので横いっぱいにして並びをそろえる');
    assert.equal(app.doc.querySelectorAll('#homeBody .hm-card').length, 7);
    const rows = [...card.querySelectorAll('.hm-row')];
    assert.equal(rows.length, 4);
    assert.match(rows[0].textContent, /和:CFTC Sues Louisiana.*🏛 CFTC ・ たった今/);
    assert.match(rows[1].textContent, /和:Bitcoin slides below \$68,000/);
    rows[0].click();
    assert.ok(app.doc.querySelector('#tab-news').classList.contains('active'));
    for (let i = 0; i < 3; i++) await app.settle();
    assert.ok(rowTitles(app).length > 0);
    // Polymarket の詳細
    app.run('switchTab("poly")');
    for (let i = 0; i < 4; i++) await app.settle();
    app.run('pmOpen("hlx")');
    for (let i = 0; i < 3; i++) await app.settle();
    const rel = app.text('#pmSRelated');
    assert.match(rel, /📰 関連しそうなニュース/);
    assert.match(rel, /和:Hyperliquid tops “open interest” rankings/);
    assert.doesNotMatch(rel, /FOMC/);
    assert.equal(app.doc.querySelector('#pmSRelated a.rel-row').getAttribute('href'), 'https://www.theblock.co/news/1-hyperliquid');
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('アプリ: サーバーを登録していない時は案内を出す (タブ・ホーム)', async () => {
  const clock = createClock('2026-11-14T10:00:00+09:00');
  const app = await openApp({ clock, fetch: async () => { throw new TypeError('offline'); } });
  try {
    app.run('switchTab("news")');
    await app.settle();
    assert.match(app.text('#nwList'), /設定でサーバー \(Apps Script\) の URL を入れると表示されます/);
    app.run('switchTab("top")');
    await app.settle();
    const card = [...app.doc.querySelectorAll('#homeBody .hm-card')].find(c => /ニュースと公式発表/.test(c.textContent));
    assert.match(card.textContent, /設定でサーバー/);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('アプリ: 通知の設定に「📰 ニュース」(オン/オフと重要度の基準) と、毎朝のまとめの「ニュースと公式発表」。記録をAIに渡すにも', async () => {
  const { gas, clock } = world();
  const app = await openNews(gas, clock);
  try {
    const box = app.doc.querySelector('#ntfBox');
    assert.ok(box.querySelector('input[type="checkbox"][data-ntf="news"]'));
    const sel = box.querySelector('select[data-ntf="newsMin"]');
    assert.deepEqual([...sel.options].map(o => o.value), ['3', '2']);
    assert.ok(box.querySelector('input[type="checkbox"][data-ntf="dNews"]'));
    app.run('ntfRender({ news: true, newsMin: 2, dNews: false }, { news: true, newsMin: 3, dNews: true })');
    assert.equal(sel.value, '2');
    const out = app.run('ntfRead()');
    assert.equal(out.newsMin, 2, '数として送る');
    assert.equal(out.dNews, false);
    assert.ok(app.doc.querySelector('.rep-parts input[value="news"]').checked);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});
