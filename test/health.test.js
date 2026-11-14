'use strict';
/* 記録の見張り: それぞれの記録が動いているかを控え、止まったら知らせる */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('./helpers/gas');
const { openApp, GAS_URL } = require('./helpers/app');
const { createClock } = require('./helpers/clock');
const { deribitFetch } = require('./helpers/deribit');

function world() {
  const clock = createClock('2026-11-12T10:00:00+09:00');
  const st = { hlDown: false };
  const ok = o => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify(o) });
  const deribit = deribitFetch(clock);
  const fetch = (url, params) => {
    const dr = deribit(url); if (dr) return dr;
    if (/gamma-api\.polymarket\.com\/markets/.test(url)) return ok(Number(new URL(url).searchParams.get('offset')) === 0 ? [{ id: '1', question: 'Q', outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]', volume24hr: 1, closed: false, events: [{ id: 'e', title: 'E', slug: 'e' }] }] : []);
    if (/gamma-api/.test(url)) return ok({ events: [] });
    if (/kalshi/.test(url)) return ok({ events: [] });
    if (/hyperliquid/.test(url)) { if (st.hlDown) throw new Error('Hyperliquid 503'); const b = JSON.parse(params.payload); return ok(b.type === 'metaAndAssetCtxs' ? [{ universe: [{ name: 'BTC' }] }, [{ markPx: '1', prevDayPx: '1', openInterest: '1', funding: '0', dayNtlVlm: '1', premium: '0' }]] : []); }
    throw new Error('取得できません: ' + url);   // FRED・DefiLlama など
  };
  const gas = loadGas({ clock, fetch, props: { MAIL_TO: 'muse@example.com' } });
  gas.ctx.setup();
  return { clock, gas, st };
}
const byKey = h => Object.fromEntries(h.jobs.map(j => [j.k, j]));

test('見張り: 動いた記録は ok、失敗は error、時間がたって動いていなければ stale、通知オフは off', () => {
  const { gas, clock, st } = world();
  let h = byKey(gas.get({ action: 'health' }).health);
  assert.equal(h.record.st, 'ok');
  assert.equal(h.fed.st, 'ok');
  assert.equal(h.hl.st, 'ok');
  assert.equal(h.resolve.st, 'never', 'まだ5時が来ていない');
  assert.equal(h.digest.st, 'never');
  gas.ctx.pmAlert();
  assert.equal(byKey(gas.get({ action: 'health' }).health).alert.st, 'ok');
  // Hyperliquid が落ちる → error (理由つき)
  clock.tick(3600000); st.hlDown = true; gas.ctx.pmRecord();
  h = byKey(gas.get({ action: 'health' }).health);
  assert.equal(h.hl.st, 'error');
  assert.match(h.hl.err, /Hyperliquid 503/);
  assert.equal(h.hl.late, false, '1回だけの失敗ではまだ知らせない');
  assert.equal(gas.mails.length, 0);
  // 直れば ok に戻る
  clock.tick(3600000); st.hlDown = false; gas.ctx.pmRecord();
  assert.equal(byKey(gas.get({ action: 'health' }).health).hl.st, 'ok');
  // トリガーが止まって4時間 → stale
  clock.tick(4 * 3600000);
  h = gas.get({ action: 'health' }).health;
  assert.equal(byKey(h).record.st, 'stale');
  assert.equal(h.ok, false);
  // 通知をオフにすると off
  gas.post({ action: 'pmConfig', alertOn: false });
  assert.equal(byKey(gas.get({ action: 'health' }).health).alert.st, 'off');
  // トリガーが消えていたら知らせる
  gas.ctx.ScriptApp.triggers = gas.ctx.ScriptApp.triggers.filter(t => t.fn !== 'pmResolve');
  assert.deepEqual(gas.get({ action: 'health' }).health.missing, ['pmResolve']);
});

test('見張り: 失敗が続いたらメールで知らせる (24時間に1回)。直ったら次に備える。毎朝のまとめにも載せる', () => {
  const { gas, clock, st } = world();
  st.hlDown = true;
  for (let i = 0; i < 5; i++) { clock.tick(3600000); gas.ctx.pmAlert(); gas.ctx.pmRecord(); }
  const m = gas.mails.filter(x => /記録が止まっています/.test(x.subject));
  assert.equal(m.length, 1, '3時間を過ぎてから1通だけ');
  assert.match(m[0].body, /Hyperliquid の建玉・ファンディング \(1時間ごと\): 失敗しています — .*Hyperliquid 503/);
  assert.match(m[0].body, /setup を実行/);
  // 毎朝のまとめにも
  gas.ctx.pmDigest();
  assert.match(gas.mails[gas.mails.length - 1].body, /⚠ 止まっている記録があります:\n・Hyperliquid/);
  // 直る → 次にまた止まったら、24時間たっていなくても知らせる
  st.hlDown = false; clock.tick(3600000); gas.ctx.pmAlert(); gas.ctx.pmRecord();
  assert.equal(gas.props.getProperty('HEALTH_MAILED'), null);
});

test('アプリ: ホームに記録の状態 (正常/止まっている)、設定の「状況を確認」に一覧', async () => {
  const { gas, clock, st } = world();
  let app = await openApp({ clock, gas, fetch: async () => { throw new TypeError('offline'); }, state: { projects: [], settings: { gasUrl: GAS_URL, gasAuto: false }, deleted: {} } });
  try {
    for (let i = 0; i < 8; i++) await app.settle();
    assert.match(app.text('#homeBody .hm-health'), /✅ 記録は正常に動いています \(\d+種類\)/);
    app.doc.querySelector('#homeBody .hm-health').click();
    assert.ok(app.doc.querySelector('#tab-settings').classList.contains('active'));
    app.doc.querySelector('#gasCheck').click();
    for (let i = 0; i < 4; i++) await app.settle();
    const rows = [...app.doc.querySelectorAll('#gasResult .hc-tbl tbody tr')];
    assert.equal(rows.length, 11);
    assert.match(rows.map(r => r.textContent).join('\n'), /オプション市場.*✅ 動いています/);
    assert.match(rows[0].textContent, /Polymarket の確率・出来高1時間ごと.*✅ 動いています/);
  } finally { app.close(); }
  st.hlDown = true; clock.tick(3600000); gas.ctx.pmRecord();
  app = await openApp({ clock, gas, fetch: async () => { throw new TypeError('offline'); }, state: { projects: [], settings: { gasUrl: GAS_URL, gasAuto: false }, deleted: {} } });
  try {
    for (let i = 0; i < 8; i++) await app.settle();
    const b = app.doc.querySelector('#homeBody .hm-health-bad');
    assert.match(b.textContent, /⚠ 記録が止まっています: Hyperliquid の建玉・ファンディング/);
    assert.equal(app.doc.querySelector('#homeBody').firstElementChild, b, '問題がある時は一番上に出す');
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});
