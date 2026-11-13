'use strict';
/* 旧データ (以前の予定管理) — 読み出し専用で残っていること / 以前の機能が取り除かれていること */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadGas, project } = require('./helpers/gas');
const { createClock } = require('./helpers/clock');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'gas', 'Code.gs'), 'utf8');

function env() {
  const clock = createClock('2026-11-14T10:00:00+09:00');
  return { clock, gas: loadGas({ clock }) };
}

test('旧データ: ドライブの「予定管理データ」に残っている案件を ?action=load で読める (書き換えない)', () => {
  const { clock, gas } = env();
  const list = Array.from({ length: 31 }, (_, i) => project(clock, { id: 'p' + i, name: '案件' + i }));
  gas.setLegacy(list, { gone: clock.iso() });
  const before = JSON.stringify([...gas.drive.items.values()]);
  const writes = gas.drive.writes;
  const r = gas.get({ action: 'load' });
  assert.equal(r.ok, true);
  assert.equal(r.count, 31);
  assert.deepEqual(r.projects.map(p => p.id), list.map(p => p.id));
  assert.deepEqual(Object.keys(r.deleted), ['gone']);
  assert.equal(r.version, gas.C.GAS_VERSION);
  assert.equal(gas.drive.writes, writes, 'ドライブへは書かない');
  assert.equal(JSON.stringify([...gas.drive.items.values()]), before);
});

test('旧データ: ドライブへ移す前 (Script Properties の分割保存) のままでも読める', () => {
  const { clock, gas } = env();
  const list = Array.from({ length: 200 }, (_, i) => project(clock, { id: "p" + i, name: "長い名前の案件".repeat(20) + i }));
  const str = JSON.stringify(list);
  assert.ok(str.length > 8000 * 2);
  const n = Math.ceil(str.length / 8000);
  for (let i = 0; i < n; i++) gas.props.setProperty('ALL_' + i, str.substr(i * 8000, 8000));
  gas.props.setProperty('ALL_N', String(n));
  const r = gas.get({ action: 'load' });
  assert.equal(r.count, 200);
  assert.equal(JSON.stringify(r.projects), str);
});

test('旧データ: 何も無ければ0件。ドライブが読めない時は空とみなさずエラーにする', () => {
  const a = env();
  const r0 = a.gas.get({ action: 'load' });
  assert.equal(r0.ok, true);
  assert.deepEqual(r0.projects, []);
  assert.deepEqual(r0.deleted, {});

  const b = env();
  b.gas.setLegacy([project(b.clock, { id: 'x', name: 'ある' })]);
  b.gas.drive.fail.read = true;
  const r = b.gas.get({ action: 'load' });
  assert.equal(r.ok, false);
  assert.equal(r.projects, undefined, '読めない時に0件と答えない');
  assert.match(r.error, /読み出し失敗/);
});

test('以前の操作 (案件の保存・Telegramの設定・受信箱) は受け付けず、旧データもプロパティも変わらない', () => {
  const { clock, gas } = env();
  gas.setLegacy([project(clock, { id: 'keep', name: '残す' })]);
  const propsBefore = JSON.stringify(gas.props.getProperties());
  const filesBefore = JSON.stringify([...gas.drive.items.values()]);
  for (const body of [
    { all: [project(clock, { id: 'new', name: '上書き' })], deleted: { keep: clock.iso() }, syncedAt: clock.iso() },
    { all: [], force: true },
    { projects: [] },
    { action: 'config', tgToken: 't', tgChat: '1', geminiKey: 'k' },
    { action: 'inboxClear' },
    {},
  ]) {
    for (const r of [gas.post(body), gas.postForm(body)]) {
      assert.equal(r.ok, false);
      assert.match(r.error, /予定管理の機能は終了しました/);
      assert.equal(r.version, gas.C.GAS_VERSION);
    }
  }
  assert.equal(JSON.stringify(gas.props.getProperties()), propsBefore);
  assert.equal(JSON.stringify([...gas.drive.items.values()]), filesBefore);
  assert.deepEqual(gas.get({ action: 'load' }).projects.map(p => p.id), ['keep']);
});

test('壊れた送信 (JSON でない) はエラーを返すだけで落ちない', () => {
  const { gas } = env();
  const r = JSON.parse(gas.ctx.doPost({ postData: { contents: '{こわれた' }, parameter: {} }).getContent());
  assert.equal(r.ok, false);
});

test('以前の予定管理のコード (Telegram・毎朝のメール・クエスト・ものがたり・バックアップ) は残っていない', () => {
  const { gas } = env();
  for (const fn of ['pollTelegram', 'sendDailyMail', 'checkDeadlines', 'weeklyBackup', 'sendDigest', 'handleCallback_', 'tgSend_',
    'saveBlob_', 'putProjects_', 'mergeProjects_', 'spawnRepeats', 'migrateToDrive_', 'gameSummary_', 'storyNotice_', 'logHist_']) {
    assert.equal(typeof gas.ctx[fn], 'undefined', fn + ' は無い');
  }
  assert.ok(!/api\.telegram\.org/.test(CODE), 'Telegram へは通信しない');
  assert.ok(!/setContent\(|setTrashed\(/.test(CODE.slice(0, CODE.indexOf('Polymarket の記録'))), '旧データを書き換える処理が無い');
  // 状況の応答に、以前の項目を入れない
  const st = gas.get();
  for (const k of ['count', 'pinned', 'telegram', 'pendingChats', 'inbox', 'game', 'mailTo', 'tgChats']) assert.equal(st[k], undefined, k);
});

test('setup: 以前のトリガーが残っていたら止め、記録のトリガー4つだけにする', () => {
  const clock = createClock('2026-11-14T10:00:00+09:00');
  const gas = loadGas({ clock, fetch: () => ({ getContentText: () => '[]', getResponseCode: () => 200 }) });
  const T = gas.ctx.ScriptApp;
  for (const fn of ['sendDailyMail', 'pollTelegram', 'checkDeadlines', 'weeklyBackup', 'pmRecord', 'someoneElse']) T.triggers.push({ fn, getHandlerFunction: () => fn });
  gas.ctx.setup();
  assert.deepEqual(T.triggers.map(t => t.getHandlerFunction()).sort(), ['pmAlert', 'pmDigest', 'pmRecord', 'pmResolve', 'someoneElse']);
  gas.ctx.setup();
  assert.equal(T.triggers.length, 5, '2回実行しても増えない');
});
