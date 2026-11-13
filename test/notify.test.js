'use strict';
/* 通知の条件を設定で変えられる */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { openApp, GAS_URL } = require('./helpers/app');

function borrow(file, names) {
  const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const m = {};
  new Function('module', 'require', src.slice(0, src.indexOf("\ntest('")) + ';module.exports={' + names + '};')(m, p => require(p.startsWith('./') ? path.join(__dirname, p.slice(2)) : p));
  return m.exports;
}

test('サーバー: 条件を保存すると範囲に収め、初期値と違うものだけ残す。初期値に戻せる', () => {
  const { gas } = borrow('kalshi.test.js', 'world').world();
  let r = gas.post({ action: 'pmConfig', notify: { h1: 20, gap: 999, oi: 'abc', flo: -0.1, kalshi: false, unknown: 1 } });
  assert.equal(r.ok, true);
  const n = r.mail.notify;
  assert.deepEqual([n.h1, n.gap, n.oi, n.flo, n.kalshi, n.pm, n.d1], [20, 50, 20, -0.1, false, true, 15], '範囲の外は端に寄せ、数でないものは変えない');
  assert.deepEqual(JSON.parse(gas.props.getProperty('PM_NOTIFY')), { h1: 20, kalshi: false, gap: 50, flo: -0.1 });
  assert.equal(r.mail.notifyDef.h1, 10);
  r = gas.post({ action: 'pmConfig', notify: 'reset' });
  assert.equal(r.mail.notify.h1, 10);
  assert.equal(gas.props.getProperty('PM_NOTIFY'), null);
});

test('サーバー: 変えた条件で通知が決まる (Kalshi のずれ・先物の建玉・種類ごとのオフ)', () => {
  // Kalshi: ずれ 38pt。基準を 45pt にすると送らない → 30pt に下げると送る
  let w = borrow('kalshi.test.js', 'world').world();
  w.gas.post({ action: 'pmConfig', notify: { gap: 45, hl: false } });
  w.gas.ctx.pmRecord();
  assert.equal(w.gas.mails.length, 0, 'ずれが基準より小さい / 先物はオフ');
  assert.equal(w.gas.get({ action: 'compare' }).gapAlert, 0.45);
  w.gas.post({ action: 'pmConfig', notify: { gap: 30 } });
  w.clock.tick(3600000); w.gas.ctx.pmRecord();
  assert.equal(w.gas.mails.filter(m => /Kalshi とのずれ/.test(m.subject)).length, 1);
  assert.match(w.gas.mails[0].body, /30pt 以上/);
  // 先物: 建玉 +30%。基準 50% なら送らない
  w = borrow('kalshi.test.js', 'world').world();
  w.gas.post({ action: 'pmConfig', notify: { oi: 50, kalshi: false, flo: -1, health: false } });   // 見張りのメールもオフ
  w.gas.ctx.pmRecord(); w.clock.tick(24 * 3600000); w.st.oi = 1.3e9; w.gas.ctx.pmRecord();
  assert.equal(w.gas.mails.length, 0);
  // 基準 25% なら送る
  w = borrow('kalshi.test.js', 'world').world();
  w.gas.post({ action: 'pmConfig', notify: { oi: 25, kalshi: false, flo: -1, health: false } });
  w.gas.ctx.pmRecord(); w.clock.tick(24 * 3600000); w.st.oi = 1.3e9; w.gas.ctx.pmRecord();
  assert.ok(w.gas.mails.some(m => /BTC の建玉が24時間で \+30%/.test(m.body)));
});

test('サーバー: Polymarket の急変の基準 (1時間の pt・出来高の下限) を変えられ、種類ごとにオフにできる', () => {
  const src = fs.readFileSync(path.join(__dirname, 'gas-polymarket.test.js'), 'utf8');
  const a = src.indexOf('function alertServer'), b = src.indexOf("\ntest('", a);
  const m = {};
  new Function('module', 'require', "const { loadGas } = require('./helpers/gas'); const { createClock } = require('./helpers/clock');" + src.slice(a, b) + ';module.exports={alertServer};')(m, p => require(p.startsWith('./') ? path.join(__dirname, p.slice(2)) : p));
  // 初期値: Fed (▲12pt)・ウォッチの HYPE (6pt)・BTC (出来高8倍) の3件
  let { gas } = m.exports.alertServer();
  gas.post({ action: 'pmConfig', notify: { h1: 5, volx: 20 } });   // 5pt に下げる → ETH ETF (6pt) も入る / 出来高は20倍以上だけ
  gas.ctx.pmAlert();
  assert.match(gas.mails[0].subject, /急変 3件/);
  assert.match(gas.mails[0].body, /ETH ETF/);
  assert.doesNotMatch(gas.mails[0].body, /出来高が普段の/);
  ({ gas } = m.exports.alertServer());
  gas.post({ action: 'pmConfig', notify: { pm: false } });
  gas.ctx.pmAlert();
  assert.equal(gas.mails.length, 0, 'Polymarket の急変だけオフ');
});

test('アプリ: 設定の「通知の条件を変える」で数字とオン・オフを変えて保存できる。初期値に戻せる', async () => {
  const { gas, clock } = borrow('kalshi.test.js', 'world').world();
  const app = await openApp({ clock, gas, fetch: async () => { throw new TypeError('offline'); }, state: { projects: [], settings: { gasUrl: GAS_URL, gasAuto: false }, deleted: {} } });
  try {
    app.run('switchTab("settings")');
    for (let i = 0; i < 6; i++) await app.settle();
    const f = k => app.doc.querySelector(`#ntfBox [data-ntf="${k}"]`);
    assert.equal(f('h1').value, '10');
    assert.equal(f('flo').value, '-0.03');
    assert.equal(f('kalshi').checked, true);
    assert.equal(app.doc.querySelector('#ntfChanged').hidden, true);
    f('h1').value = '8'; f('hl').checked = false;
    app.doc.querySelector('#ntfBox').dispatchEvent(new app.win.Event('input'));
    assert.equal(app.doc.querySelector('#ntfChanged').hidden, false, '変更ありの印');
    app.doc.querySelector('#pmMailSave').click();
    for (let i = 0; i < 6; i++) await app.settle();
    assert.deepEqual(JSON.parse(gas.props.getProperty('PM_NOTIFY')), { h1: 8, hl: false });
    assert.match(app.text('#pmMailResult'), /保存しました/);
    // 初期値に戻す
    app.doc.querySelector('#ntfReset').click();
    assert.equal(f('h1').value, '10');
    assert.equal(f('hl').checked, true);
    app.doc.querySelector('#pmMailSave').click();
    for (let i = 0; i < 6; i++) await app.settle();
    assert.equal(gas.props.getProperty('PM_NOTIFY'), '{}');
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});
