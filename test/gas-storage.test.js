'use strict';
/* データの保存先 (Script Properties → Google ドライブ) の移行・読み書き・週ごとのバックアップ */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas, project } = require('./helpers/gas');
const { createClock, jstLocal } = require('./helpers/clock');
const { openApp, GAS_URL } = require('./helpers/app');

const LIMIT = 500 * 1024;   // Script Properties の合計上限
const DATA_KEYS = ['ALL', 'DELETED', 'HIST', 'INBOX', 'GAME'];
const clone = x => JSON.parse(JSON.stringify(x));
const chunkKeys = gas => [...gas.props.store.keys()].filter(k => /^(ALL|DELETED|HIST|INBOX|GAME)_(\d+|N)$/.test(k));

/** 今までの形 (Script Properties に分割保存) で、31件の案件と記録・ゲーム・受信箱を持っているサーバー */
function legacyServer(opts) {
  const clock = createClock('2026-11-01T10:00:00+09:00');
  const gas = loadGas(Object.assign({ clock, propsLimit: LIMIT }, opts || {}));
  gas.enableTelegram(['111']);
  const list = Array.from({ length: 31 }, (_, i) => project(clock, {
    id: 'L' + i, name: '既存の案件' + (i + 1) + ' — 日本語のメモ付き', chain: ['ETH', 'SOL', 'BTC'][i % 3],
    deadline: i % 4 ? jstLocal(clock, i - 5) : '', memo: 'メモ'.repeat(i * 10), pinned: i % 5 === 0,
    status: i % 6 === 0 ? 'done' : 'open', sources: [{ url: 'https://example.com/' + i, title: 'リンク' + i }],
  }));
  // 古い形のまま保存する (STORE は未設定)
  gas.post({ all: list, deleted: { gone1: clock.iso(), gone2: clock.iso() }, syncedAt: clock.iso(), email: 'me@example.com' });
  gas.ctx.logInbox_({ type: 'add', id: 'L1', name: '受信箱の記録' });
  gas.props.setProperty('API_SECRET', 'secret-for-backup-test');
  gas.props.setProperty('GEMINI_KEY', 'gemini-secret-value');
  gas.tg.pushButton('111', 'q:c'); gas.ctx.pollTelegram();   // ← この中で移行が試されないよう、下で STORE_TRIED を未来にしてある
  gas.newRun();
  const before = {};
  DATA_KEYS.forEach(k => { before[k] = gas.ctx.loadPropBlob_(k); });
  return { clock, gas, list, before };
}

test('移行: 既存の31件・削除記録・記録・受信箱・ゲームがドライブへ移り、そのまま読める。古いチャンクは消える', () => {
  const { gas, list, before } = legacyServer({ props: { STORE_TRIED: '2999-01-01T00:00:00Z' } });
  assert.equal(gas.props.getProperty('STORE'), null, 'まだ移行していない');
  assert.ok(chunkKeys(gas).length >= 10, '古い形で保存されている');
  for (const k of DATA_KEYS) assert.ok(before[k].length > 0, k + ' にデータがある');

  gas.ctx.setup();
  gas.newRun();

  assert.equal(gas.props.getProperty('STORE'), 'drive');
  assert.ok(gas.props.getProperty('STORE_AT'));
  assert.equal(gas.props.getProperty('STORE_ERROR'), null);
  assert.deepEqual(chunkKeys(gas), [], '古いチャンクは削除');
  // ドライブの「予定管理データ」フォルダに1つずつ
  const files = gas.drive.folderFiles('予定管理データ').map(f => f.name).sort();
  assert.deepEqual(files, ['ALL.json', 'DELETED.json', 'GAME.json', 'HIST.json', 'INBOX.json']);
  for (const k of DATA_KEYS) assert.equal(gas.ctx.loadBlob_(k), before[k], k + ' が1文字も変わらない');
  // 31件がそのまま読める
  assert.deepEqual(clone(gas.ctx.getProjects_()), clone(list));
  const st = gas.get({ key: 'secret-for-backup-test' });
  assert.equal(st.count, 31);
  assert.equal(st.store, 'drive');
  assert.equal(st.inbox.length, 1);
  assert.equal(st.game.streak, 1);
  const ld = gas.get({ key: 'secret-for-backup-test', action: 'load' });
  assert.deepEqual(clone(ld.projects), clone(list));
  assert.deepEqual(Object.keys(ld.deleted).sort(), ['gone1', 'gone2']);
  assert.ok(gas.get({ key: 'secret-for-backup-test', action: 'history' }).hist.length >= 31);
  // 小さな設定値は Script Properties のまま
  assert.equal(gas.props.getProperty('TG_TOKEN'), 'test-token');
  assert.equal(gas.props.getProperty('MAIL_TO'), 'me@example.com');

  // もう一度 setup() しても、移行はやり直さず、トリガーも二重にならない
  const writes = gas.drive.writes;
  gas.ctx.setup();
  assert.equal(gas.drive.writes, writes);
  const trig = gas.ctx.ScriptApp.triggers.map(t => t.fn).sort();
  assert.deepEqual(trig, ['pollTelegram', 'sendDailyMail', 'weeklyBackup']);
  const wb = gas.ctx.ScriptApp.triggers.find(t => t.fn === 'weeklyBackup');
  assert.equal(wb.weekDay, 'SUNDAY');
  assert.equal(wb.hour, 2, '日曜の深夜2時');
});

test('移行後もアプリから31件を読み込め、同期・Telegram・メールが動く', async () => {
  const { gas, clock } = legacyServer({ props: { STORE_TRIED: '2999-01-01T00:00:00Z' } });
  gas.ctx.setup();
  gas.newRun();
  const app = await openApp({ clock, gas, state: { projects: [], settings: { gasUrl: GAS_URL, gasKey: 'secret-for-backup-test', gasAuto: false }, deleted: {} } });
  try {
    assert.equal(app.run('state.projects.length'), 31, '0件の端末は起動時にクラウドから読み込む');
    clock.tick(60000);
    app.run(`state.projects.find(p=>p.id==="L3").name = "アプリで変更"; save();`);
    await app.run('gasSync()');
    gas.newRun();
    assert.equal(gas.ctx.getProjects_().find(p => p.id === 'L3').name, 'アプリで変更');
    assert.deepEqual(chunkKeys(gas), [], 'Script Properties には書かない');
    // 設定の「状況を確認」で保存先が分かる
    app.run('switchTab("settings")');
    app.doc.querySelector('#gasCheck').click();
    await app.settle();
    assert.match(app.text('#gasResult'), /クラウド側: 31件/);
    assert.match(app.text('#gasResult'), /保存先: Googleドライブ/);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
  // Telegram
  gas.tg.pushMessage('111', 'Telegramからの案件');
  gas.tg.pushMessage('111', '/list');
  gas.ctx.pollTelegram();
  gas.newRun();
  assert.equal(gas.ctx.getProjects_().length, 32);
  assert.ok(gas.tg.texts('111').some(t => /未完了の案件/.test(t) && /アプリで変更/.test(t)));
  // 毎朝のメール
  gas.ctx.sendDailyMail();
  assert.equal(gas.mails.length, 1);
});

test('移行に失敗しても元のデータは残り、今まで通り動く。30分後に自動で再挑戦して成功する', () => {
  for (const fail of [{ write: 3 }, { read: true }]) {
    const { gas, clock, before } = legacyServer({ props: { STORE_TRIED: '2999-01-01T00:00:00Z' } });
    gas.drive.fail = fail;
    assert.equal(gas.ctx.migrateToDrive_(), false, JSON.stringify(fail));
    gas.newRun();
    assert.equal(gas.props.getProperty('STORE'), null, '切り替えない');
    assert.match(gas.props.getProperty('STORE_ERROR'), /失敗|確認/);
    for (const k of DATA_KEYS) assert.equal(gas.ctx.loadPropBlob_(k), before[k], k + ' の元データはそのまま');
    assert.equal(gas.ctx.getProjects_().length, 31);
    assert.equal(gas.get({ key: 'secret-for-backup-test' }).store, 'props');
    // 失敗したまま setup() しても、トリガーは登録される
    gas.ctx.setup();
    assert.ok(gas.ctx.ScriptApp.triggers.some(t => t.fn === 'weeklyBackup'));
    // 今まで通り保存できる
    clock.tick(60000);
    const r = gas.post({ key: 'secret-for-backup-test', all: gas.ctx.getProjects_().concat([project(clock, { id: 'N1' })]), deleted: {}, syncedAt: clock.iso() });
    assert.equal(r.ok, true);
    assert.equal(r.count, 32);

    // 30分たつまでは再挑戦しない
    gas.drive.fail = {};
    gas.props.setProperty('STORE_TRIED', new Date(clock.now).toISOString());
    clock.tick(10 * 60000);
    gas.ctx.pollTelegram();
    assert.equal(gas.props.getProperty('STORE'), null);
    // 30分後: pollTelegram が自動で移行する
    clock.tick(25 * 60000);
    gas.ctx.pollTelegram();
    gas.newRun();
    assert.equal(gas.props.getProperty('STORE'), 'drive');
    assert.deepEqual(chunkKeys(gas), []);
    assert.equal(gas.ctx.getProjects_().length, 32);
  }
});

test('移行後は Script Properties の500KB上限に関係なく保存できる (移行前は上限で止まる)', () => {
  const clock = createClock();
  const gas = loadGas({ clock, propsLimit: LIMIT, props: { STORE_TRIED: '2999-01-01T00:00:00Z' } });
  const big = Array.from({ length: 1200 }, (_, i) => project(clock, { id: 'B' + i, name: '大きな案件' + i, memo: 'あ'.repeat(200) }));
  assert.ok(Buffer.byteLength(JSON.stringify(big)) > LIMIT);
  // 移行前: 上限を超えて保存できない (今までの問題)
  let r = gas.post({ all: big, deleted: {}, syncedAt: clock.iso() });
  assert.equal(r.ok, false);
  assert.match(r.error, /Exceeded/);
  // 移行後: 保存できる
  gas.newRun();
  assert.equal(gas.ctx.migrateToDrive_(), true);
  clock.tick(60000);
  r = gas.post({ all: big, deleted: {}, syncedAt: clock.iso() });
  assert.equal(r.ok, true);
  assert.equal(r.count, 1200);
  gas.newRun();
  assert.equal(gas.ctx.getProjects_().length, 1200);
  // 操作の記録も上限 (1500件) まで増やせる
  gas.ctx.logHist_(Array.from({ length: 1500 }, (_, i) => ({ t: new Date(clock.now + i).toISOString(), k: 'add', id: 'B' + i, n: '記録'.repeat(20), s: 'app' })));
  gas.newRun();
  assert.equal(gas.ctx.getHist_().length, 1500);
  assert.ok(gas.props.bytes() < 20 * 1024, 'Script Properties には小さな値だけ (' + gas.props.bytes() + 'バイト)');
});

test('読み書き: 同じ実行の中ではキャッシュするが、ロックを取った後は読み直す。読めない時は空とみなさない', () => {
  const clock = createClock();
  const gas = loadGas({ clock });
  gas.ctx.migrateToDrive_();
  gas.post({ all: [project(clock, { id: 'r1', name: '1件目' })], deleted: {}, syncedAt: clock.iso() });
  assert.equal(gas.drive.folderFiles('予定管理データ').find(f => f.name === 'ALL.json').content.includes('1件目'), true);

  // キャッシュ: 同じ実行で何度読んでもドライブは1回
  gas.newRun();
  const calls = gas.drive.calls;
  for (let i = 0; i < 5; i++) gas.ctx.getProjects_();
  assert.equal(gas.drive.calls - calls, 1);

  // 別の実行 (例: Telegram) がドライブに書いた内容を、doPost はロックの後で読み直す
  const f = gas.drive.folderFiles('予定管理データ').find(x => x.name === 'ALL.json');
  const other = JSON.parse(f.content); other.push(project(clock, { id: 'r2', name: '別の実行で追加', createdAt: clock.iso(), updatedAt: clock.iso() }));
  f.content = JSON.stringify(other);
  clock.tick(60000);
  const r = gas.post({ all: [project(clock, { id: 'r1', name: '1件目を変更' })], deleted: {}, syncedAt: clock.iso() });
  assert.deepEqual(r.projects.map(p => p.id).sort(), ['r1', 'r2'], '別の実行の変更を消さない');

  // ドライブが読めない時: 空のデータとして扱わず、エラーにする (上書き事故を防ぐ)
  gas.newRun();
  const saved = f.content;
  gas.drive.fail = { read: true };
  const g = gas.get();
  assert.equal(g.ok === true && g.count === 0, false, '0件と答えない');
  const p = gas.post({ all: [project(clock, { id: 'zz' })], deleted: {}, syncedAt: clock.iso() });
  assert.equal(p.ok, false);
  assert.equal(f.content, saved, 'ドライブの中身は変わらない');
  gas.drive.fail = {};

  // ファイルが開けない時 (一時的なエラーなど) も、空とみなさない
  const fileId = gas.props.getProperty('FILE_ALL');
  const realGet = gas.drive.api.getFileById;
  gas.drive.api.getFileById = id => { if (id === fileId) throw new Error('テスト用: 開けません'); return realGet(id); };
  gas.newRun();
  assert.throws(() => gas.ctx.getProjects_(), /開けません/);
  assert.equal(gas.post({ all: [project(clock, { id: 'zz' })], deleted: {}, syncedAt: clock.iso() }).ok, false);
  gas.drive.api.getFileById = realGet;
  assert.equal(f.content, saved);

  // ゲーム・記録・受信箱・削除記録が読めない時も、空とみなして上書きしない (XPが消えない)
  gas.ctx.putGame_({ xp: 123, streak: 4, last: '2026-11-01', doneTotal: 9 });
  gas.ctx.logHist_([{ t: clock.iso(), k: 'add', id: 'h', s: 'app' }]);
  gas.ctx.logInbox_({ type: 'add', id: 'h', name: 'h' });
  const gameFile = gas.drive.folderFiles('予定管理データ').find(x => x.name === 'GAME.json');
  const gameSaved = gameFile.content;
  gas.newRun();
  gas.drive.fail = { read: true };
  for (const fn of ['getGame_', 'getTombs_', 'getHist_', 'getInbox_']) assert.throws(() => gas.ctx[fn](), /読み出し失敗/, fn);
  gas.tg.pushButton('111', 'q:c');
  gas.enableTelegram(['111']);
  gas.ctx.pollTelegram();
  gas.drive.fail = {};
  assert.equal(gameFile.content, gameSaved, 'GAME は上書きされない');
  gas.newRun();
  assert.equal(gas.ctx.getGame_().xp, 123);

  // ファイルがゴミ箱に入れられていたら作り直す
  f.trashed = true;
  gas.newRun();
  assert.deepEqual(clone(gas.ctx.getProjects_()), []);
  gas.ctx.putProjects_([project(clock, { id: 'r3' })]);
  gas.newRun();
  assert.deepEqual(clone(gas.ctx.getProjects_().map(x => x.id)), ["r3"]);
});

test('バックアップ: 日付付きJSONを「予定管理バックアップ」へ保存し、12週分だけ残す。秘密情報は入れない', () => {
  const { gas, clock, list } = legacyServer({ props: { STORE_TRIED: '2999-01-01T00:00:00Z' } });
  // 移行前でもバックアップできる
  clock.set('2026-11-01T02:00');   // 日曜の深夜2時
  assert.equal(gas.ctx.weeklyBackup(), 'yotei-backup-2026-11-01.json');
  gas.ctx.setup();
  gas.newRun();

  let files = gas.drive.folderFiles('予定管理バックアップ');
  assert.equal(files.length, 1);
  const b = JSON.parse(files[0].content);
  assert.equal(b.app, 'yotei');
  assert.deepEqual(b.data.ALL, clone(list));
  assert.deepEqual(Object.keys(b.data).sort(), [...DATA_KEYS].sort());
  assert.equal(b.data.INBOX.length, 1);
  assert.ok(b.data.HIST.length >= 31);
  assert.equal(b.props.MAIL_TO, 'me@example.com');
  for (const s of ['test-token', 'secret-for-backup-test', 'gemini-secret-value']) assert.ok(!files[0].content.includes(s), s + ' を含まない');

  // 同じ日にもう一度動いても1つのまま (上書き)
  gas.ctx.weeklyBackup();
  assert.equal(gas.drive.folderFiles('予定管理バックアップ').length, 1);

  // 15週続けると、新しい12週分だけ残る
  for (let w = 1; w < 15; w++) { clock.addDays(7); gas.newRun(); gas.ctx.weeklyBackup(); }
  files = gas.drive.folderFiles('予定管理バックアップ').map(f => f.name).sort();
  assert.equal(files.length, 12);
  assert.equal(files[0], 'yotei-backup-2026-11-22.json', '古い3週分は消える');
  assert.equal(files[11], 'yotei-backup-2027-02-07.json');
  assert.ok(gas.props.getProperty('BACKUP_LAST'));
  assert.ok(gas.get({ key: 'secret-for-backup-test' }).backupLast);
  // バックアップ以外のファイルは消さない
  assert.equal(gas.drive.folderFiles('予定管理データ').length, 5);
});
