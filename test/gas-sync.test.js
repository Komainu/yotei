'use strict';
/* サーバー (gas/Code.gs) の同期の合体と、空データでの上書き防止 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas, project } = require('./helpers/gas');
const { createClock } = require('./helpers/clock');

const clone = x => JSON.parse(JSON.stringify(x));
const byId = list => Object.fromEntries(list.map(p => [p.id, p]));

test('同期の合体: 2台の端末とTelegramが別々に変更しても両方残り、削除した案件は復活しない', () => {
  const clock = createClock('2026-11-02T10:00:00+09:00');
  const gas = loadGas({ clock });
  gas.enableTelegram(['111']);

  // 最初の状態: 端末Aが4件を保存
  const p1 = project(clock, { id: 'p1', name: '案件1' });
  const p2 = project(clock, { id: 'p2', name: '案件2' });
  const p3 = project(clock, { id: 'p3', name: '案件3' });
  const p4 = project(clock, { id: 'p4', name: '案件4' });
  const t0 = clock.iso();
  let r = gas.post({ all: [p1, p2, p3, p4], deleted: {}, base: '', syncedAt: t0 });
  assert.equal(r.ok, true);
  assert.equal(r.count, 4);

  // 端末Aと端末Bは、どちらもこの時点のデータを持っている
  const devA = clone(r.projects), devB = clone(r.projects);

  // ① 端末A: 案件1の名前を変え、案件2を削除して同期
  clock.tick(60000);
  const tA = clock.iso();
  const a1 = devA.find(p => p.id === 'p1');
  a1.name = '案件1 (端末Aで変更)'; a1.updatedAt = tA;
  const listA = devA.filter(p => p.id !== 'p2');
  r = gas.post({ all: listA, deleted: { p2: tA }, base: t0, syncedAt: tA });
  assert.equal(r.ok, true);
  assert.deepEqual(r.projects.map(p => p.id).sort(), ['p1', 'p3', 'p4']);

  // ② Telegram: /list → /done 2 で「案件3」を完了 (一覧は期限なし同士なので登録順)
  clock.tick(60000);
  gas.ctx.handleCommand_('/list', '111');
  const order = JSON.parse(gas.props.getProperty('TG_LASTLIST_111'));
  const n = order.indexOf('p3') + 1;
  assert.ok(n > 0, '一覧に案件3がある');
  gas.ctx.handleCommand_('/done ' + n, '111');
  assert.equal(byId(gas.projects()).p3.status, 'done');
  // Telegramから新しい案件も登録 (Geminiキーなし → 簡易登録)
  clock.tick(1000);
  gas.ctx.handleIngest_('Telegramで見つけた案件\nhttps://example.com/x', '111');
  const tgNew = gas.projects().find(p => p.src === 'telegram');
  assert.ok(tgNew, 'Telegramの案件が登録された');

  // ③ 端末B: 古いデータのまま、案件4のメモを変え、新しい案件5を追加して同期
  clock.tick(60000);
  const tB = clock.iso();
  const b4 = devB.find(p => p.id === 'p4');
  b4.memo = '端末Bで追記'; b4.updatedAt = tB;
  devB.push(project(clock, { id: 'p5', name: '案件5 (端末Bで追加)' }));
  r = gas.post({ all: devB, deleted: {}, base: t0, syncedAt: tB });
  assert.equal(r.ok, true);

  const out = byId(r.projects);
  assert.equal(out.p1.name, '案件1 (端末Aで変更)', '端末Aの変更が残る');
  assert.equal(out.p2, undefined, '端末Aで削除した案件は、端末Bの古いデータから復活しない');
  assert.equal(out.p3.status, 'done', 'Telegramでの完了が残る');
  assert.equal(out.p4.memo, '端末Bで追記', '端末Bの変更が残る');
  assert.ok(out.p5, '端末Bで追加した案件が残る');
  assert.ok(out[tgNew.id], 'Telegramで追加した案件が残る');
  assert.ok(r.deleted.p2, '削除記録が返る');

  // ④ 端末Aがもう一度、古い手元データで同期しても、他の変更は消えない
  clock.tick(60000);
  const tA2 = clock.iso();
  r = gas.post({ all: listA, deleted: { p2: tA }, base: tA, syncedAt: tA2 });
  const out2 = byId(r.projects);
  assert.equal(out2.p3.status, 'done');
  assert.equal(out2.p4.memo, '端末Bで追記');
  assert.ok(out2.p5);
  assert.ok(out2[tgNew.id]);
  assert.equal(out2.p2, undefined);
  // 保存された内容も同じ
  assert.deepEqual(gas.projects().map(p => p.id).sort(), Object.keys(out2).sort());
});

test('同期の合体: 削除より後に変更された案件は残る / 同じ案件の変更は新しい方を採用する', () => {
  const clock = createClock();
  const gas = loadGas({ clock });
  const t = ms => new Date(clock.now + ms).toISOString();
  const a = [{ id: 'x', name: '新しい', createdAt: t(0), updatedAt: t(2000) }, { id: 'y', name: 'y', createdAt: t(0), updatedAt: t(5000) }];
  const b = [{ id: 'x', name: '古い', createdAt: t(0), updatedAt: t(1000) }, { id: 'z', name: 'z', createdAt: t(0), updatedAt: t(1000) }];
  const tombs = { y: t(3000), z: t(3000) };
  const out = gas.ctx.mergeProjects_(a, b, tombs, '');
  assert.deepEqual(clone(out.map(p => p.id + ':' + p.name)), ['x:新しい', 'y:y']);
  // b の方が新しければ b を採用
  const out2 = gas.ctx.mergeProjects_(b, a, {}, '');
  assert.equal(out2.find(p => p.id === 'x').name, '新しい');
  // 90日より古い削除記録は捨てる
  const tb = gas.ctx.unionTombs_({ old: new Date(clock.now - 91 * 86400000).toISOString() }, { neu: t(0) });
  assert.deepEqual(clone(Object.keys(tb)), ['neu']);
});

test('同期の合体: アプリ側の mergeProjects とサーバー側の mergeProjects_ が同じ結果になる', async () => {
  const { openApp } = require('./helpers/app');
  const clock = createClock();
  const gas = loadGas({ clock });
  const app = await openApp({ clock });
  try {
    const t = ms => new Date(clock.now + ms).toISOString();
    const a = [
      { id: 'a', name: 'A1', createdAt: t(0), updatedAt: t(3000) },
      { id: 'b', name: 'B1', createdAt: t(0), updatedAt: t(1000) },
      { id: 'c', name: 'C1', createdAt: t(0), updatedAt: t(1000) },
      { id: 'a', name: '重複', createdAt: t(0), updatedAt: t(9000) },
    ];
    const b = [
      { id: 'a', name: 'A2', createdAt: t(0), updatedAt: t(2000) },
      { id: 'b', name: 'B2', createdAt: t(0), updatedAt: t(4000) },
      { id: 'd', name: '旧データ', createdAt: t(-600000) },
      { id: 'e', name: '新規', createdAt: t(0), updatedAt: t(500) },
      { id: 'f', name: '削除済み', createdAt: t(0), updatedAt: t(500) },
    ];
    const tombs = { c: t(2000), f: t(1000) };
    const base = t(0);
    const server = gas.ctx.mergeProjects_(a, b, tombs, base);
    const appOut = app.run(`mergeProjects(${JSON.stringify(a)}, ${JSON.stringify(b)}, ${JSON.stringify(tombs)}, ${JSON.stringify(base)})`);
    assert.deepEqual(JSON.parse(JSON.stringify(appOut)), JSON.parse(JSON.stringify(server)));
    assert.deepEqual(clone(server.map(p => p.name)), ['A1', 'B2', '新規']);
  } finally { app.close(); }
});

test('空データでの上書きは拒否される (中身は守られる)', () => {
  const clock = createClock();
  const gas = loadGas({ clock });
  const list = [project(clock, { id: 'k1', name: '大事な案件' }), project(clock, { id: 'k2', name: 'もう1件' })];
  assert.equal(gas.post({ all: list, deleted: {}, syncedAt: clock.iso() }).ok, true);

  // 新しいアプリの形
  clock.tick();
  let r = gas.post({ all: [], deleted: {}, syncedAt: clock.iso() });
  assert.equal(r.ok, false);
  assert.match(r.error, /空データでの上書きを拒否/);
  assert.match(r.error, /2件/);
  // 古いアプリの形 (projects のみ) / フォーム送信でも同じ
  r = gas.post({ projects: [] });
  assert.equal(r.ok, false);
  r = gas.postForm({ all: [] });
  assert.equal(r.ok, false);
  r = gas.post({});
  assert.equal(r.ok, false);
  assert.deepEqual(gas.projects().map(p => p.id), ['k1', 'k2'], 'クラウドの中身は残っている');

  // force を付けた時だけ空にできる
  r = gas.post({ all: [], force: true });
  assert.equal(r.ok, true);
  assert.equal(gas.projects().length, 0);

  // もともと空なら空の保存は問題ない
  r = gas.post({ all: [], deleted: {} });
  assert.equal(r.ok, true);
});

test('doGet: 状態と ?action=load (秘密情報は返さない)', () => {
  const clock = createClock();
  const gas = loadGas({ clock });
  gas.enableTelegram(['111', '222']);
  gas.props.setProperty('GEMINI_KEY', 'secret-gemini');
  gas.post({ all: [project(clock, { id: 'g1', pinned: true })], deleted: { gone: clock.iso() }, syncedAt: clock.iso(), email: 'me@example.com' });
  const st = gas.get();
  assert.equal(st.ok, true);
  assert.equal(st.version, gas.C.GAS_VERSION);
  assert.equal(st.count, 1);
  assert.equal(st.pinned, 1);
  assert.equal(st.telegram, true);
  assert.equal(st.tgChats, 2);
  assert.equal(st.projects, undefined);
  const raw = JSON.stringify(st);
  assert.ok(!raw.includes('test-token') && !raw.includes('secret-gemini'), 'トークンやキーを返さない');
  const ld = gas.get({ action: 'load' });
  assert.deepEqual(ld.projects.map(p => p.id), ['g1']);
  assert.ok(ld.deleted.gone);
});

test('設定 (action=config): Chat IDは追加され、空の値は変更しない', () => {
  const gas = loadGas();
  gas.props.setProperty('TG_PENDING', JSON.stringify(['333']));
  let r = gas.post({ action: 'config', tgChat: '111' });
  assert.equal(r.ok, true);
  gas.post({ action: 'config', tgChat: '222, 333', tgToken: '', geminiKey: '' });
  assert.equal(gas.props.getProperty('TG_CHAT'), '111,222,333');
  assert.equal(gas.props.getProperty('TG_TOKEN'), null, '空のトークンでは変更しない');
  assert.deepEqual(JSON.parse(gas.props.getProperty('TG_PENDING')), [], '登録済みになったチャットは保留から外れる');
  gas.post({ action: 'config', tgChat: '', tgToken: '', clear: true });
  assert.equal(gas.props.getProperty('TG_CHAT'), '');
});

test('分割保存: 8000文字を超えるデータも元通りに読める', () => {
  const gas = loadGas();
  const big = 'あ'.repeat(20000);
  gas.ctx.saveBlob_('X', big);
  assert.equal(gas.props.getProperty('X_N'), '3');
  assert.equal(gas.ctx.loadBlob_('X'), big);
  gas.ctx.saveBlob_('X', 'short');
  assert.equal(gas.props.getProperty('X_N'), '1');
  assert.equal(gas.props.getProperty('X_2'), null, '余った分割は片付ける');
  assert.equal(gas.ctx.loadBlob_('X'), 'short');
});
