'use strict';
/* AI に渡す記録: 日ごとの要約・マクロの日誌・急変の記録・レポート */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('./helpers/gas');
const { openApp, GAS_URL } = require('./helpers/app');
const { createClock } = require('./helpers/clock');

/** Gamma の偽物 (市場1: ウォッチ中・確率が日ごとに動く / 市場2: 決着する) と、マクロは取得失敗 */
function server() {
  const clock = createClock('2026-11-01T06:00:00+09:00');
  const st = { p1: 0.40, closed2: false };
  const mk = () => [
    { id: '1', question: 'Will the Fed cut rates in December?', slug: 'fed', outcomes: '["Yes","No"]', outcomePrices: JSON.stringify([String(st.p1), String(1 - st.p1)]),
      volume24hr: 500000, liquidityNum: 1000, closed: false, endDate: '2026-12-10T00:00:00Z', events: [{ id: 'fed', slug: 'fed-dec', title: 'Fed decision in December?' }] },
    { id: '2', question: 'Will BTC hit 100k by Nov 3?', slug: 'btc', outcomes: '["Yes","No"]', outcomePrices: st.closed2 ? '["0","1"]' : '["0.8","0.2"]',
      volume24hr: 300000, liquidityNum: 1000, closed: st.closed2, closedTime: '2026-11-03 12:00:00+00', endDate: '2026-11-03T00:00:00Z', events: [{ id: 'b', slug: 'btc', title: 'BTC 100k' }] },
  ];
  const fetch = url => {
    const u = new URL(url);
    if (u.host !== 'gamma-api.polymarket.com') throw new Error('このテストでは使わない: ' + url);
    const ids = u.searchParams.getAll('id');
    const all = mk();
    const list = ids.length ? all.filter(m => ids.includes(m.id)) : Number(u.searchParams.get('offset')) === 0 ? all.filter(m => !m.closed) : [];
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify(list) };
  };
  const gas = loadGas({ clock, fetch, props: { PM_WATCH: '["1"]' } });
  return { clock, gas, st };
}

test('記録: 毎晩、1時間ごとの記録を日ごとの要約 (始値・終値・高値・安値・出来高) にまとめる', () => {
  const { clock, gas, st } = server();
  // 11/1: 40% → 55% → 50%、11/2: 50% → 70%
  for (const [p, h] of [[0.40, 0], [0.55, 4], [0.50, 8]]) { st.p1 = p; gas.ctx.pmRecord(); clock.tick(4 * 3600000); }
  clock.set('2026-11-02T06:00'); st.p1 = 0.50; gas.ctx.pmRecord();
  clock.set('2026-11-02T12:00'); st.p1 = 0.70; gas.ctx.pmRecord();
  clock.set('2026-11-03T05:00'); gas.ctx.pmResolve();
  const file = gas.drive.folderFiles('ポリマーケット記録').find(f => f.name === 'daily-2026-11.json');
  const d = JSON.parse(file.content);
  assert.deepEqual(d['2026-11-01']['1'], [0.4, 0.5, 0.55, 0.4, 500000]);
  assert.deepEqual(d['2026-11-02']['1'], [0.5, 0.7, 0.7, 0.5, 500000]);
  assert.equal(gas.props.getProperty('PM_DAILY_DONE'), '2026-11-02');
  // もう一度動いても、同じ日はまとめ直さない
  gas.ctx.pmResolve();
  assert.equal(gas.props.getProperty('PM_DAILY_DONE'), '2026-11-02');
});

test('レポート: 期間と中身を選んで、依頼文つきの Markdown にする (ウォッチの推移・急変のその後・答え合わせ)', () => {
  const { clock, gas, st } = server();
  const day = (d, p) => { clock.set(d + 'T07:00'); st.p1 = p; gas.ctx.pmRecord(); clock.set(d + 'T20:00'); gas.ctx.pmRecord(); };
  day('2026-11-01', 0.40); day('2026-11-02', 0.42);
  // 急変を記録 (11/2 に 30% → 42%)
  gas.ctx.pmLogAlerts_([{ r: { id: '1', ev: 'fed', et: 'Fed decision in December?', g: '', q: 'Will the Fed cut rates in December?', p: 0.42, h1: 0.12, v24: 500000 }, why: { k: 'h1', d: 0.12, txt: '1時間で▲12pt' }, watched: true }]);
  day('2026-11-03', 0.55);
  st.closed2 = true;
  clock.set('2026-11-04T05:00'); gas.ctx.pmResolve();
  clock.set('2026-11-04T10:00');
  const r = gas.get({ action: 'report', days: '7', parts: 'watch,alerts,resolve' });
  assert.equal(r.ok, true);
  const t = r.text;
  assert.match(t, /^# ポリマーケット記録のレポート \(2026-10-28 〜 2026-11-04・7日間\)/);
  assert.match(t, /これを読んで考察してください/);
  assert.doesNotMatch(t, /## 1\. マクロ/, '選ばなかったものは入れない');
  assert.match(t, /### Will the Fed cut rates in December\?/);
  assert.match(t, /\| 2026-11-03 \| 55% \| 55% \| 55% \| 55% \| 500,000 \|/);
  assert.match(t, /大きく動いた日: 2026-11-03 \(42% → 55%\)/);
  assert.match(t, /## 3\. 急変の記録と、その後/);
  assert.match(t, /⭐ Will the Fed cut rates in December\? \| 1時間で▲12pt \| 30% \| 42% \| 55% \| さらに同じ方向 \|/);
  assert.match(t, /## 4\. 答え合わせ/);
  assert.match(t, /\| 2026-11-03 \| BTC 100k ― |\| 2026-11-03 \| Will BTC hit 100k by Nov 3\? \| No \| /);
  assert.match(t, /\| 80〜90% \| 1 \| 0% \|/, '1日前80%の市場が「いいえ」で決着');
  // 合言葉
  gas.props.setProperty('API_SECRET', 'secret-report-123');
  assert.equal(gas.get({ action: 'report' }).needKey, true);
});

test('アプリ: 「🤖 記録をAIに渡す」で期間と中身を選び、コピーかファイルで渡せる', async () => {
  const { clock, gas, st } = server();
  st.p1 = 0.5; gas.ctx.pmRecord();
  const app = await openApp({ clock, gas, fetch: async () => { throw new TypeError('offline'); }, state: { projects: [], settings: { gasUrl: GAS_URL, gasAuto: false }, deleted: {} } });
  try {
    let copied = '', downloaded = null;
    app.win.navigator.clipboard.writeText = async t => { copied = t; };
    app.win.URL.createObjectURL = b => { downloaded = b; return 'blob:x'; };
    app.win.URL.revokeObjectURL = () => {};
    app.doc.querySelector('#tab-poly [data-ai-report]').click();
    assert.equal(app.doc.querySelector('#repSheet').hidden, false);
    app.doc.querySelector('#repDays').value = '7';
    app.doc.querySelector('#repSheet input[value="macro"]').checked = false;
    app.doc.querySelector('#repMake').click();
    for (let i = 0; i < 5; i++) await app.settle();
    assert.match(app.text('#repOut'), /できました: .* 文字|できました:/);
    app.doc.querySelector('#repCopy').click();
    await app.settle();
    assert.match(copied, /## 2\. ウォッチ中の市場の推移/);
    assert.doesNotMatch(copied, /## 1\. マクロ/);
    app.doc.querySelector('#repFile').click();
    assert.ok(downloaded, 'ファイルとして保存');
    assert.match(app.text('#toast'), /polymarket-report-\d{4}-\d{2}-\d{2}\.md/);
    app.doc.querySelector('#repSheet .pm-x').click();
    assert.equal(app.doc.querySelector('#repSheet').hidden, true);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});
