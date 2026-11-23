'use strict';
/* 週1回の AI 総まとめ: 毎週日曜の朝 (pmDigest の後)・Gemini 1回・ドライブに保存・doGet action=weekly・アプリのホームの囲み */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('./helpers/gas');
const { openApp, GAS_URL } = require('./helpers/app');
const { createClock } = require('./helpers/clock');
const { deribitFetch } = require('./helpers/deribit');
const { newsFetch, geminiFake } = require('./helpers/news');
const { usFetch } = require('./helpers/usflow');
const { cgFetch } = require('./helpers/cg');
const { okxFetch } = require('./helpers/okx');

const M = 60000, H = 60 * M;
const ok = o => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify(o) });
const SAMPLE = [
  '■ 今週の要点',
  '・BTC の占める割合は 58.23% で、先週の 57.5% から少し上がりました',
  '・暗号資産全体の時価総額は 3.2兆ドル (24時間で −1.2%)',
  '・FRB の FOMC の声明が出ました (公式発表)',
  '■ 分野ごと',
  '・予測市場: 大きな動きは記録にありません',
  '・マクロと米国のお金: 記録がありません',
  '・暗号資産の先物・オプション: BTC の予想変動率は落ち着いています (推測)',
  '・お金の流れ・資金調達: 分野では「Meme」が +8.1% と強めでした',
  '・ニュース: SEC がイーサリアムの ETF のオプションを承認しました',
  '■ 来週の注目',
  '・次の FOMC の日程と、利下げの確率がどう動くか',
].join('\n');
/** 週1回のまとめの偽 Gemini (システムの文に「今週のまとめ」がある時だけ答える)。ほかはニュースの偽物へ */
function weeklyGem(world) {
  const news = geminiFake(), calls = [];
  const gem = (url, params) => {
    if (!/generativelanguage\.googleapis\.com/.test(url)) return null;
    const body = JSON.parse(params.payload), sys = body.system_instruction.parts[0].text;
    if (!/今週のまとめ/.test(sys)) return news(url, params);
    calls.push({ sys, input: body.contents[0].parts[0].text, url });
    if (world.down) return { getResponseCode: () => 500, getContentText: () => '{"error":{"message":"internal"}}' };
    return ok({ candidates: [{ content: { parts: [{ text: JSON.stringify({ text: world.text == null ? SAMPLE : world.text }) }] } }] });
  };
  gem.calls = calls;
  return gem;
}
function world(opts) {
  opts = opts || {};
  const clock = createClock(opts.at || '2026-11-22T08:00:00+09:00');   // 日曜
  const w = opts.world || {};
  const gem = weeklyGem(w), dr = deribitFetch(clock), nw = newsFetch(clock), us = usFetch(clock, { auctions: [] }), cg = cgFetch(clock), okx = okxFetch(clock, { liq: {} });
  const fetch = (url, params) => {
    const r = gem(url, params) || dr(url) || nw(url, params) || us(url) || cg(url, params) || okx(url, params); if (r) return r;
    if (/gamma-api\.polymarket\.com\/markets/.test(url)) return ok([]);
    if (/gamma-api|kalshi/.test(url)) return ok({ events: [] });
    throw new Error('使わない: ' + url);
  };
  const props = Object.assign({ MAIL_TO: 'muse@example.com', GEMINI_KEY: 'AIza-test-gemini-key' }, opts.props || {});
  Object.keys(props).forEach(k => { if (props[k] == null) delete props[k]; });
  const gas = loadGas({ clock, fetch, props });
  return { clock, gas, gem, w };
}
/** 記録を少し貯める (ニュース・オプション・米国・CoinGecko・OKX) */
function seed(gas) {
  for (const fn of ['newsRecord_', 'optRecord_', 'usRecord_', 'okxRecord_']) { try { gas.ctx[fn](); } catch (e) { /* 一部は落ちてよい */ } }
  gas.get({ action: 'cg' }); gas.get({ action: 'cg' });
}
const weeklyMails = gas => gas.mails.filter(m => /今週のまとめ/.test(m.subject));
const file = (gas, name) => { const f = gas.drive.folderFiles('ポリマーケット記録').find(x => x.name === name); return f ? JSON.parse(f.content) : null; };
const health = gas => gas.get({ action: 'health' }).health.jobs.find(j => j.k === 'weekly');

/* ---------- サーバー ---------- */
test('日曜の判定は日本時間: 土曜 23:30 (UTC) = 日曜 8:30 (日本時間)。日曜 15:30 (UTC) = 月曜 0:30 は日曜ではない', () => {
  const { gas } = world();
  const sun = t => gas.ctx.pmIsSundayJst_(Date.parse(t));
  assert.equal(sun('2026-11-21T23:30:00Z'), true);
  assert.equal(sun('2026-11-21T14:59:00Z'), false, '土曜 23:59 (日本時間)');
  assert.equal(sun('2026-11-21T15:00:00Z'), true, '日曜 0:00 (日本時間)');
  assert.equal(sun('2026-11-22T15:30:00Z'), false, '月曜 0:30 (日本時間)');
  assert.equal(gas.ctx.pmWeekLabel_('2026-11-16', '2026-11-22'), '11/16〜11/22');
});

test('pmDigest: 日曜はまとめメールの後に週1回のまとめを1通 (件名・本文・決まり文句)。同じ週は2回送らない。日曜以外は送らない', () => {
  const { gas, clock, gem } = world({ at: '2026-11-21T23:00:00Z' });   // 日曜 8:00 (日本時間)
  seed(gas);
  const n0 = gas.mails.length;
  gas.ctx.pmDigest();
  const sent = gas.mails.slice(n0);
  assert.equal(sent.length, 2, 'まとめ + 週1回のまとめ');
  assert.match(sent[0].subject, /2026-11-22のまとめ|のまとめ/);
  assert.doesNotMatch(sent[0].subject, /今週/);
  const m = sent[1];
  assert.equal(m.subject, '【ポリマーケット】今週のまとめ (11/16〜11/22)');
  assert.equal(m.to, 'muse@example.com');
  assert.ok(m.body.startsWith(SAMPLE + '\n\n――――\n'), 'AI の文 + 区切り');
  assert.match(m.body, /期間: 2026-11-16 〜 2026-11-22 \(日本時間\)/);
  assert.match(m.body, /使った記録の範囲: 2026-11-15 〜 2026-11-22 のレポート \([\d,]+文字/);
  assert.match(m.body, /※ AI が記録から書いたまとめです。数字は元の記録で確かめてください。売買の判断には使わないでください$/);
  assert.match(m.htmlBody, /font-weight:700;font-size:15px">■ 今週の要点</, '見出しは太字');
  assert.equal(gem.calls.length, 1, 'Gemini は1回');
  assert.equal(gas.props.getProperty('PM_WEEKLY_LAST'), '2026-11-22');
  assert.equal(health(gas).st, 'ok');
  // 同じ日にもう一度 → 送らない (Gemini も呼ばない)
  clock.tick(2 * H);
  gas.ctx.pmDigest();
  assert.equal(weeklyMails(gas).length, 1);
  assert.equal(gem.calls.length, 1);
  // 月曜〜土曜は送らない
  for (let i = 0; i < 6; i++) { clock.tick(24 * H); gas.ctx.pmDigest(); }
  assert.equal(weeklyMails(gas).length, 1);
  // 次の日曜は送る
  clock.tick(22 * H);
  gas.ctx.pmDigest();
  assert.equal(weeklyMails(gas).length, 2);
  assert.equal(weeklyMails(gas)[1].subject, '【ポリマーケット】今週のまとめ (11/23〜11/29)');
  assert.equal(gem.calls.length, 2, '1週に1回');
});

test('オフ (PM_WEEKLY_ON=0)・送り先なし → 送らない (見張りは「オフ」)。毎朝のまとめがオフでも、週1回のまとめは別に動く', () => {
  let z = world({ props: { PM_WEEKLY_ON: '0' } });
  z.gas.ctx.pmDigest();
  assert.equal(weeklyMails(z.gas).length, 0);
  assert.equal(z.gem.calls.length, 0);
  assert.equal(health(z.gas).st, 'off');
  assert.equal(health(z.gas).n, '週1回の AI 総まとめ');
  assert.equal(health(z.gas).every, '毎週日曜8時');
  // 設定から変える
  let r = z.gas.post({ action: 'pmConfig', weeklyOn: true });
  assert.equal(r.mail.weekly, true);
  assert.equal(z.gas.props.getProperty('PM_WEEKLY_ON'), '1');
  r = z.gas.post({ action: 'pmConfig', weeklyOn: false });
  assert.equal(r.mail.weekly, false);
  // 送り先なし
  z = world({ props: { MAIL_TO: null } });
  z.gas.ctx.pmDigest();
  assert.equal(z.gas.mails.length, 0);
  assert.equal(z.gem.calls.length, 0);
  // 毎朝のまとめだけオフ
  z = world({ props: { PM_DIGEST_ON: '0' } });
  z.gas.ctx.pmDigest();
  assert.deepEqual(z.gas.mails.map(m => m.subject), ['【ポリマーケット】今週のまとめ (11/16〜11/22)']);
  assert.equal(z.gas.post({ action: 'pmConfig' }).mail.weekly, true, '既定はオン');
});

test('Gemini のキーなし・1日の上限・Gemini の失敗 → 何も送らず、見張りにエラー (キーは出さない)。直れば ok', () => {
  let z = world({ props: { GEMINI_KEY: null } });
  z.gas.ctx.pmDigest();
  assert.equal(weeklyMails(z.gas).length, 0);
  let h = health(z.gas);
  assert.equal(h.st, 'error');
  assert.match(h.err, /Gemini のキーが登録されていない/);
  assert.equal(z.gas.props.getProperty('PM_WEEKLY_LAST'), null);
  // 上限
  z = world({ props: { PM_AI_DAY: JSON.stringify({ d: '2026-11-22', n: 400 }) } });
  z.gas.ctx.pmDigest();
  assert.equal(weeklyMails(z.gas).length, 0);
  assert.equal(z.gem.calls.length, 0);
  assert.match(health(z.gas).err, /上限 \(400回\)/);
  // 失敗
  z = world({ world: { down: true } });
  z.gas.ctx.pmDigest();
  assert.equal(weeklyMails(z.gas).length, 0);
  h = health(z.gas);
  assert.equal(h.st, 'error');
  assert.match(h.err, /Gemini でまとめを作れませんでした/);
  assert.ok(!JSON.stringify(z.gas.get({ action: 'health' })).includes('AIza-test-gemini-key'));
  assert.ok(!z.gas.logs.join('\n').includes('AIza-test-gemini-key'));
  // 次の日曜に直っていれば送る (失敗した週は控えない)
  z.w.down = false; z.clock.tick(7 * 24 * H);
  z.gas.ctx.pmDigest();
  assert.equal(weeklyMails(z.gas).length, 1);
  assert.equal(health(z.gas).st, 'ok');
  // Gemini の回数は1日の上限に数える
  assert.equal(JSON.parse(z.gas.props.getProperty('PM_AI_DAY')).n >= 1, true);
});

test('Gemini に渡すもの: 決まり (数字は記録だけ・推測・売買のすすめなし・1,800字・■と・) と、7日のレポートの節 (依頼文は外す)。長さに上限', () => {
  const { gas, gem } = world();
  seed(gas);
  const inp = gas.ctx.pmWeeklyInput_();
  const rep = gas.ctx.pmReport_({ days: 7 }).text;
  gas.ctx.pmWeeklyNow_();
  assert.equal(gem.calls.length, 1);
  const { sys, input } = gem.calls[0];
  for (const re of [/専門家ではない日本の人/, /売買はしません/, /■ 今週の要点\n・いちばん大事な変化を3〜5個。それぞれ数字を入れる/, /■ 分野ごと\n・予測市場: …\n・マクロと米国のお金: …\n・暗号資産の先物・オプション: …\n・お金の流れ・資金調達: …\n・ニュース: …/,
    /■ 来週の注目/, /■ 気になる食い違い/, /無ければこの見出しごと書かない/, /数字は入力にあるものだけを使う/, /「推測」と書く/, /買う・売るのすすめはしない/, /1,800字以内/, /見出しは「■」、箇条書きは「・」/, /JSON \{"text"/]) assert.match(sys, re);
  assert.equal(input, inp.text);
  assert.ok(input.startsWith('## '), 'レポートの節から');
  assert.doesNotMatch(input, /これを読んで考察してください/, '先頭の依頼文は外す');
  assert.match(input, /## 14\. 暗号資産の市場全体 \(CoinGecko\)/);
  assert.match(input, /## 9\. ニュースと公式発表/);
  assert.ok(rep.includes(input.slice(0, 2000)), 'レポートの中身そのまま');
  assert.ok(inp.chars <= gas.C.WEEKLY_IN_MAX || inp.chars <= 60000);
  console.log('# 週1回のまとめの入力 (テストの記録): ' + inp.chars + ' 文字 (レポート全体 ' + inp.raw + ' 文字・節 ' + inp.parts + ')');
  // 長い時の上限: 節ごと 9,000 字・全体 60,000 字
  const big = 'x'.repeat(20000);
  gas.ctx.pmReport_ = () => ({ text: '# t\n前書き\n' + Array.from({ length: 12 }, (_, i) => '## ' + (i + 1) + '. 節\n' + big).join('\n'), from: '2026-11-15', to: '2026-11-22' });
  const cut = gas.ctx.pmWeeklyInput_();
  assert.ok(cut.chars <= 60000, '全体 60,000 字まで: ' + cut.chars);
  assert.ok(cut.text.split(/\n(?=## )/).every(s => s.length <= 9000 + 40), '節ごと 9,000 字まで');
  assert.match(cut.text, /\(長いので、ここから先は省きました\)/);
  assert.ok(cut.cut > 0);
});

test('Gemini の文はエスケープ (HTML のメール)・長すぎれば切る・保存 (weekly-YYYY-MM-DD.json)・doGet action=weekly (最新・8週まで・date=)', () => {
  const { gas, clock, w } = world();
  w.text = '■ 今週の要点\n・<script>alert(1)</script> と <b>太字</b>\n・普通の行';
  gas.ctx.pmDigest();
  const m = weeklyMails(gas)[0];
  assert.doesNotMatch(m.htmlBody, /<script>|<b>太字/);
  assert.match(m.htmlBody, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(m.body, /<script>alert\(1\)<\/script>/, 'テキストの本文はそのまま');
  const f = file(gas, 'weekly-2026-11-22.json');
  assert.equal(f.from, '2026-11-16'); assert.equal(f.to, '2026-11-22'); assert.equal(f.at, clock.now);
  assert.equal(f.text, w.text);
  // 9週分 → 一覧は新しい順の8件
  w.text = 'あ'.repeat(5000);
  for (let i = 1; i <= 9; i++) { clock.tick(7 * 24 * H); gas.ctx.pmDigest(); }
  const r = gas.get({ action: 'weekly' });
  assert.equal(r.ok, true); assert.equal(r.version, gas.C.GAS_VERSION); assert.equal(r.ai, true);
  assert.equal(r.list.length, 8);
  assert.equal(r.list[0], '2027-01-24'); assert.equal(r.list[7], '2026-12-06');
  assert.equal(r.weekly.to, '2027-01-24');
  assert.ok(r.weekly.text.length <= 2400 + 20, '長すぎる文は切る');
  assert.match(r.weekly.text, /\(長いので省きました\)$/);
  const one = gas.get({ action: 'weekly', date: '2026-11-22' });
  assert.equal(one.weekly.text, '■ 今週の要点\n・<script>alert(1)</script> と <b>太字</b>\n・普通の行', '一覧から外れても date= で読める');
  assert.equal(gas.get({ action: 'weekly', date: '2025-01-01' }).weekly, null);
  assert.equal(gas.get({ action: 'weekly', date: '../x' }).weekly.to, '2027-01-24', '形の違う日付は最新');
  // 合言葉
  gas.props.setProperty('API_SECRET', 'secret-pass-12345');
  const locked = gas.get({ action: 'weekly' });
  assert.equal(locked.needKey, true); assert.equal(locked.weekly, undefined); assert.equal(locked.list, undefined);
  assert.ok(gas.get({ action: 'weekly', key: 'secret-pass-12345' }).weekly);
});

test('pmWeeklyNow (今すぐ作る): 日曜でなくても作る・合言葉が要る・10分に1回まで・1日の上限を守る。PM_WEEKLY_LAST は変えない', () => {
  const { gas, clock, gem } = world({ at: '2026-11-18T12:00:00+09:00' });   // 水曜
  gas.props.setProperty('API_SECRET', 'secret-pass-12345');
  let r = gas.post({ action: 'pmWeeklyNow' });
  assert.equal(r.needKey, true);
  assert.equal(gem.calls.length, 0);
  r = gas.post({ action: 'pmWeeklyNow', key: 'secret-pass-12345' });
  assert.equal(r.ok, true); assert.equal(r.sent, true);
  assert.equal(r.weekly.from, '2026-11-12'); assert.equal(r.weekly.to, '2026-11-18');
  assert.equal(weeklyMails(gas)[0].subject, '【ポリマーケット】今週のまとめ (11/12〜11/18)');
  assert.equal(gas.props.getProperty('PM_WEEKLY_LAST'), null, '日曜の分は別');
  clock.tick(5 * M);
  r = gas.post({ action: 'pmWeeklyNow', key: 'secret-pass-12345' });
  assert.equal(r.ok, false); assert.match(r.error, /続けて作れません。5分ほどあけてください/);
  assert.equal(gem.calls.length, 1);
  clock.tick(6 * M);
  gas.props.setProperty('PM_AI_DAY', JSON.stringify({ d: '2026-11-18', n: 400 }));
  r = gas.post({ action: 'pmWeeklyNow', key: 'secret-pass-12345' });
  assert.equal(r.ok, false); assert.match(r.error, /上限/);
  assert.equal(gem.calls.length, 1);
  clock.tick(24 * H);
  r = gas.post({ action: 'pmWeeklyNow', key: 'secret-pass-12345' });
  assert.equal(r.ok, true);
  assert.equal(gem.calls.length, 2);
});

/* ---------- アプリ ---------- */
test('アプリ: ホームの「今日の注目」の下に、閉じた「🗞 今週の AI まとめ」(期間・見出しと箇条書き・ほかの週を選ぶ)。文はエスケープ', async () => {
  const { gas, clock, w } = world();
  w.text = '■ 今週の要点\n・<img src=x onerror=alert(1)>BTC は 58.23%\n普通の文\n■ 来週の注目\n・FOMC';
  gas.ctx.pmDigest();
  w.text = SAMPLE;
  clock.tick(7 * 24 * H);
  gas.ctx.pmDigest();
  const app = await openApp({ clock, gas, fetch: async () => { throw new TypeError('offline'); }, state: { settings: { gasUrl: GAS_URL, gasAuto: false } } });
  try {
    for (let i = 0; i < 6; i++) await app.settle();
    const box = app.doc.querySelector('#wkBox');
    assert.equal(box.tagName, 'DETAILS'); assert.equal(box.hidden, false); assert.equal(box.open, false, '閉じておく');
    assert.ok(app.doc.querySelector('#hmHi').compareDocumentPosition(box) & 4, '今日の注目の下');
    assert.ok(box.compareDocumentPosition(app.doc.querySelector('#homeBody')) & 4, '天気図より上');
    assert.match(box.querySelector('summary').textContent, /^🗞 今週の AI まとめ \(11\/23〜11\/29\)$/);
    assert.match(app.text('#wkBody'), /期間: 2026-11-23 〜 2026-11-29/);
    assert.deepEqual([...app.doc.querySelectorAll('#wkBody .wk-h')].map(x => x.textContent), ['今週の要点', '分野ごと', '来週の注目']);
    assert.equal(app.doc.querySelectorAll('#wkBody .wk-ul li').length, 9);
    assert.match(app.text('#wkBody'), /売買の判断には使わないでください/);
    const opts = [...app.doc.querySelectorAll('#wkSel option')].map(o => [o.value, o.textContent]);
    assert.deepEqual(opts, [['2026-11-29', '11/23〜11/29'], ['2026-11-22', '11/16〜11/22']]);
    // 前の週を選ぶ
    const sel = app.doc.querySelector('#wkSel');
    sel.value = '2026-11-22';
    sel.dispatchEvent(new app.win.Event('change', { bubbles: true }));
    for (let i = 0; i < 4; i++) await app.settle();
    assert.match(app.text('#wkPeriod'), /11\/16〜11\/22/);
    assert.equal(app.doc.querySelectorAll('#wkBody img').length, 0, 'AI の文はエスケープ');
    assert.match(app.text('#wkBody'), /<img src=x onerror=alert\(1\)>BTC は 58\.23%/);
    assert.equal(app.doc.querySelectorAll('#wkBody .wk-p').length, 1);
    assert.ok(app.requests.some(r => /action=weekly&date=2026-11-22/.test(r.url)));
    // ホームを描き直しても、囲みの開き具合は変わらない
    box.open = true;
    app.run('renderTop()');
    assert.equal(app.doc.querySelector('#wkBox').open, true);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('アプリ: まだ無い時の案内・サーバー未登録は出さない・設定に「🗞 毎週日曜の AI 総まとめ」と「今すぐ作る (テスト)」', async () => {
  const { gas, clock } = world({ at: '2026-11-18T12:00:00+09:00' });
  const app = await openApp({ clock, gas, fetch: async () => { throw new TypeError('offline'); }, state: { settings: { gasUrl: GAS_URL, gasAuto: false } } });
  try {
    for (let i = 0; i < 6; i++) await app.settle();
    assert.match(app.text('#wkBody'), /まだありません。毎週日曜の朝8時に、1週間の記録から AI がまとめを作ります/);
    app.run('switchTab("settings")');
    for (let i = 0; i < 4; i++) await app.settle();
    const cb = app.doc.querySelector('#pmWeeklyOn');
    assert.match(cb.closest('label').textContent, /🗞 毎週日曜の AI 総まとめ/);
    assert.equal(cb.checked, true);
    cb.checked = false;
    app.doc.querySelector('#pmMailSave').click();
    for (let i = 0; i < 4; i++) await app.settle();
    assert.equal(gas.props.getProperty('PM_WEEKLY_ON'), '0');
    const btn = app.doc.querySelector('#pmWeeklyNow');
    assert.equal(btn.textContent, '今すぐ作る (テスト)');
    btn.click();
    for (let i = 0; i < 6; i++) await app.settle();
    assert.match(app.text('#pmMailResult'), /✅ 作りました \(メールも送りました\)/);
    assert.equal(weeklyMails(gas).length, 1, 'テストはオフでも作る');
    assert.match(app.text('#wkBody'), /期間: 2026-11-12 〜 2026-11-18/, 'ホームにも出る');
    btn.click();
    for (let i = 0; i < 4; i++) await app.settle();
    assert.match(app.text('#pmMailResult'), /❌ 続けて作れません/);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
  const app2 = await openApp({ clock, fetch: async () => { throw new TypeError('offline'); } });
  try {
    await app2.settle();
    assert.equal(app2.doc.querySelector('#wkBox').hidden, true, 'サーバー未登録なら出さない');
    assert.deepEqual(app2.errors, []);
  } finally { app2.close(); }
});
