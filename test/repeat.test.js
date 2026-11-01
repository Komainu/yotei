'use strict';
/* 繰り返しの予定 (毎日・平日・毎週・毎月) — アプリとサーバーの両方 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadGas, project } = require('./helpers/gas');
const { createClock, jstLocal } = require('./helpers/clock');
const { openApp, GAS_URL } = require('./helpers/app');

const clone = x => JSON.parse(JSON.stringify(x));
const root = path.join(__dirname, '..');
const BEGIN = '/* ===== 繰り返しの予定 (この囲みの中は', END = '/* ===== 繰り返しの予定 ここまで ===== */';
const block = file => { const s = fs.readFileSync(path.join(root, file), 'utf8'); const i = s.indexOf(BEGIN), j = s.indexOf(END); assert.ok(i >= 0 && j > i, file); return s.slice(i, j); };

test('規則はアプリ (index.html) とサーバー (gas/Code.gs) でまったく同じ', () => {
  assert.equal(block('index.html'), block('gas/Code.gs'));
});

test('次回の日付: 毎日・平日・毎週・毎月 (月末・年末・うるう年)', () => {
  const { ctx } = loadGas();
  const next = (r, after) => ctx.repeatNextDate(r, after);
  const cases = [
    // 毎日
    [{ type: 'daily' }, '2026-11-02', '2026-11-03'],
    [{ type: 'daily' }, '2026-11-30', '2026-12-01'],
    [{ type: 'daily' }, '2026-12-31', '2027-01-01'],
    [{ type: 'daily' }, '2028-02-28', '2028-02-29'],   // うるう年
    [{ type: 'daily' }, '2027-02-28', '2027-03-01'],
    // 平日 (2026-11-06 は金曜)
    [{ type: 'weekdays' }, '2026-11-05', '2026-11-06'],
    [{ type: 'weekdays' }, '2026-11-06', '2026-11-09'],
    [{ type: 'weekdays' }, '2026-11-07', '2026-11-09'],
    [{ type: 'weekdays' }, '2026-11-08', '2026-11-09'],
    [{ type: 'weekdays' }, '2027-12-31', '2028-01-03'],   // 金曜の大みそか → 月曜
    // 毎週 (2026-11-02 は月曜)
    [{ type: 'weekly', dow: [1] }, '2026-11-02', '2026-11-09'],
    [{ type: 'weekly', dow: [1, 4] }, '2026-11-02', '2026-11-05'],
    [{ type: 'weekly', dow: [4, 1] }, '2026-11-05', '2026-11-09'],
    [{ type: 'weekly', dow: [0] }, '2026-12-26', '2026-12-27'],
    [{ type: 'weekly', dow: [0] }, '2026-12-27', '2027-01-03'],
    [{ type: 'weekly', dow: [6] }, '2028-02-26', '2028-03-04'],
    // 毎月
    [{ type: 'monthly', dom: 15 }, '2026-11-14', '2026-11-15'],
    [{ type: 'monthly', dom: 15 }, '2026-11-15', '2026-12-15'],
    [{ type: 'monthly', dom: 15 }, '2026-12-15', '2027-01-15'],   // 年末
    [{ type: 'monthly', dom: 31 }, '2026-01-31', '2026-02-28'],   // 2月は月末
    [{ type: 'monthly', dom: 31 }, '2026-02-28', '2026-03-31'],   // ずれずに31日へ戻る
    [{ type: 'monthly', dom: 31 }, '2026-04-30', '2026-05-31'],
    [{ type: 'monthly', dom: 31 }, '2026-03-31', '2026-04-30'],
    [{ type: 'monthly', dom: 31 }, '2026-12-31', '2027-01-31'],
    [{ type: 'monthly', dom: 31 }, '2028-01-31', '2028-02-29'],   // うるう年
    [{ type: 'monthly', dom: 29 }, '2027-01-29', '2027-02-28'],
    [{ type: 'monthly', dom: 29 }, '2028-01-29', '2028-02-29'],
    [{ type: 'monthly', dom: 30 }, '2027-02-28', '2027-03-30'],
    [{ type: 'monthly', dom: 1 }, '2026-12-01', '2027-01-01'],
  ];
  for (const [r, after, want] of cases) assert.equal(next(r, after), want, `${JSON.stringify(r)} ${after}`);
  // 正しくない繰り返しは日付を作らない
  assert.equal(next({ type: 'yearly' }, '2026-11-02'), '');
  assert.equal(next(null, '2026-11-02'), '');
  assert.equal(next({ type: 'daily' }, ''), '');
});

test('次回の日付: アプリとサーバーが2026〜2028年のすべての日で同じ答えになる', async () => {
  const { ctx } = loadGas();
  const app = await openApp();
  try {
    const rules = [{ type: 'daily' }, { type: 'weekdays' }, { type: 'weekly', dow: [2] }, { type: 'weekly', dow: [0, 3, 6] }, { type: 'monthly', dom: 1 }, { type: 'monthly', dom: 29 }, { type: 'monthly', dom: 31 }];
    const days = [];
    for (let t = Date.UTC(2026, 0, 1); t <= Date.UTC(2028, 11, 31); t += 86400000) days.push(new Date(t).toISOString().slice(0, 10));
    const appAns = app.run(`(${JSON.stringify(rules)}).map(r => (${JSON.stringify(days)}).map(d => repeatNextDate(r, d)))`);
    rules.forEach((r, i) => days.forEach((d, j) => {
      const s = ctx.repeatNextDate(r, d);
      assert.equal(appAns[i][j], s, `${JSON.stringify(r)} ${d}`);
      assert.ok(s > d, '必ず後の日付');
      if (r.type === 'daily') assert.equal(Date.parse(s) - Date.parse(d), 86400000);
      if (r.type === 'weekdays') { const w = new Date(s + 'T00:00:00Z').getUTCDay(); assert.ok(w >= 1 && w <= 5); }
      if (r.type === 'weekly') assert.ok(r.dow.includes(new Date(s + 'T00:00:00Z').getUTCDay()));
      if (r.type === 'monthly') {
        const [y, m, dd] = s.split('-').map(Number);
        assert.equal(dd, Math.min(r.dom, new Date(Date.UTC(y, m, 0)).getUTCDate()), '指定日か、その月の月末');
      }
    }));
  } finally { app.close(); }
});

test('次の回の中身: 時刻は期限の時刻、id は「元のid~日付」、遅れて完了したら今日より後の回', () => {
  const { ctx } = loadGas();
  const base = { id: 'arc', name: 'Arc 毎日TX', chain: 'Arc', memo: 'TXを1回', sources: [{ url: 'https://example.com', title: '公式' }], pinned: true, status: 'done', repeat: { type: 'daily' } };
  // 期限どおりに完了
  let n = ctx.repeatNextOf(Object.assign({}, base, { deadline: '2026-11-02T21:30' }), '2026-11-02', 'NOW');
  assert.deepEqual(clone(n), {
    id: 'arc~2026-11-03', name: 'Arc 毎日TX', chain: 'Arc', memo: 'TXを1回', sources: [{ url: 'https://example.com', title: '公式' }],
    pinned: true, repeat: { type: 'daily' }, repeatOf: 'arc', status: 'open', deadline: '2026-11-03T21:30', createdAt: 'NOW', updatedAt: 'NOW',
  });
  // 早めに完了 (期限は明日) → 期限の次の日
  assert.equal(ctx.repeatNextOf(Object.assign({}, base, { deadline: '2026-11-03T21:30' }), '2026-11-02', 'NOW').deadline, '2026-11-04T21:30');
  // 3日遅れて完了 → 今日より後 (明日)
  assert.equal(ctx.repeatNextOf(Object.assign({}, base, { deadline: '2026-10-30T21:30' }), '2026-11-02', 'NOW').deadline, '2026-11-03T21:30');
  // 期限なし → 今日の次・23:59
  assert.equal(ctx.repeatNextOf(Object.assign({}, base, { deadline: '' }), '2026-11-02', 'NOW').deadline, '2026-11-03T23:59');
  // 2回目以降も元の id を repeatOf に持つ
  n = ctx.repeatNextOf(Object.assign({}, base, { id: 'arc~2026-11-03', repeatOf: 'arc', deadline: '2026-11-03T21:30' }), '2026-11-03', 'NOW');
  assert.equal(n.id, 'arc~2026-11-04');
  assert.equal(n.repeatOf, 'arc');
  // 毎週・毎月で曜日・日付を決めていない時は、期限の曜日・日付を使う (2026-11-05 は木曜)
  assert.deepEqual(clone(ctx.repeatNorm({ type: 'weekly' }, '2026-11-05')), { type: 'weekly', dow: [4] });
  assert.deepEqual(clone(ctx.repeatNorm({ type: 'monthly' }, '2026-11-05')), { type: 'monthly', dom: 5 });
  assert.deepEqual(clone(ctx.repeatNorm({ type: 'weekly', dow: [4, 1, 4, 9, 'x'] })), { type: 'weekly', dow: [1, 4] });
  assert.equal(ctx.repeatNorm({ type: 'hourly' }), null);
  // 表示
  assert.equal(ctx.repeatLabel({ type: 'daily' }), '毎日');
  assert.equal(ctx.repeatLabel({ type: 'weekdays' }), '平日');
  assert.equal(ctx.repeatLabel({ type: 'weekly', dow: [1, 4] }), '毎週 月・木');
  assert.equal(ctx.repeatLabel({ type: 'monthly', dom: 31 }), '毎月 31日');
  assert.equal(ctx.repeatLabel(null), '');
});

test('二重に作らない: 何度呼んでも1件 / 見送りは作らない / 未完了の回がある・削除した記録がある時も作らない', () => {
  const { ctx } = loadGas();
  const mk = f => Object.assign({ id: 'r', name: 'r', status: 'done', deadline: '2026-11-02T09:00', repeat: { type: 'daily' } }, f);
  let list = [mk()];
  assert.equal(ctx.spawnRepeats(list, {}, '2026-11-02', 'NOW').length, 1);
  assert.equal(ctx.spawnRepeats(list, {}, '2026-11-02', 'NOW').length, 0, '2回目は作らない');
  assert.equal(list.length, 2);
  assert.equal(list[0].repeatNext, 'r~2026-11-03');
  // 完了 → 未完了に戻す → また完了 でも増えない
  list[0].status = 'open'; list[0].status = 'done';
  assert.equal(ctx.spawnRepeats(list, {}, '2026-11-02', 'NOW').length, 0);
  // 見送り
  list = [mk({ dropped: true })];
  assert.equal(ctx.spawnRepeats(list, {}, '2026-11-02', 'NOW').length, 0);
  assert.equal(list.length, 1);
  // 同じ繰り返しの未完了の回がもうある
  list = [mk(), { id: 'r~2026-11-05', repeatOf: 'r', status: 'open', name: 'r', repeat: { type: 'daily' } }];
  assert.equal(ctx.spawnRepeats(list, {}, '2026-11-02', 'NOW').length, 0);
  // 次の回を削除した記録がある
  list = [mk()];
  assert.equal(ctx.spawnRepeats(list, { 'r~2026-11-03': 'X' }, '2026-11-02', 'NOW').length, 0);
  // 未完了・繰り返しなしは対象外
  list = [mk({ status: 'open' }), mk({ id: 'n', repeat: undefined })];
  assert.equal(ctx.spawnRepeats(list, {}, '2026-11-02', 'NOW').length, 0);
});

/* ---------------- アプリ ---------------- */

const URL_ = GAS_URL;
async function appWith(clock, projects, gas) {
  return openApp({ clock, gas, state: { projects, settings: gas ? { gasUrl: URL_, gasAuto: false } : {}, deleted: {} } });
}
const series = (list, id) => clone(list).filter(p => (p.repeatOf || p.id) === id).map(p => p.id + ':' + p.status + ':' + p.deadline).sort();

test('アプリ: 完了ボタンで次の回が1件だけでき、🔁 印が付く。戻して再び完了しても増えない', async () => {
  const clock = createClock('2026-11-02T10:00:00+09:00');
  const app = await appWith(clock, [project(clock, { id: 'arc', name: 'Arc 毎日TX', deadline: '2026-11-02T21:00', repeat: { type: 'daily' } })]);
  try {
    app.run('switchTab("projects")');
    assert.match(app.doc.querySelector('.pcard[data-id="arc"]').textContent, /🔁 毎日/);
    app.doc.querySelector('.pcard[data-id="arc"] [data-act="toggle"]').click();
    assert.deepEqual(series(app.run('state.projects'), 'arc'), ['arc:done:2026-11-02T21:00', 'arc~2026-11-03:open:2026-11-03T21:00']);
    assert.match(app.doc.querySelector('#toast').textContent, /次の回 \(2026\/11\/03 21:00\) を作りました/);
    const next = app.doc.querySelector('.pcard[data-id="arc~2026-11-03"]');
    assert.ok(next, '一覧に次の回');
    assert.match(next.textContent, /🔁 毎日/);
    // 戻して、また完了
    app.doc.querySelector('.pcard[data-id="arc"] [data-act="toggle"]').click();
    app.doc.querySelector('.pcard[data-id="arc"] [data-act="toggle"]').click();
    app.run('save(); save();');
    assert.equal(series(app.run('state.projects'), 'arc').length, 2, '増えない');
    // 次の回を完了すると、その次 (元の id のまま)
    clock.addDays(1);
    app.doc.querySelector('.pcard[data-id="arc~2026-11-03"] [data-act="toggle"]').click();
    assert.ok(app.run('state.projects.some(p=>p.id==="arc~2026-11-04" && p.repeatOf==="arc")'));
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('アプリ: 編集画面で繰り返しを選べる (毎週の曜日・毎月の日付・なし)', async () => {
  const clock = createClock('2026-11-02T10:00:00+09:00');
  const app = await appWith(clock, [project(clock, { id: 'w', name: '週の作業', deadline: '2026-11-05T20:00' })]);
  try {
    app.run('switchTab("projects")');
    const edit = () => app.doc.querySelector('.pcard[data-id="w"] [data-act="edit"]').click();
    const sel = () => app.doc.querySelector('#fRepeat');
    edit();
    assert.equal(sel().value, '');
    assert.equal(app.doc.querySelector('#fRepeatWeek').style.display, 'none');
    sel().value = 'weekly'; sel().dispatchEvent(new app.win.Event('change'));
    assert.equal(app.doc.querySelector('#fRepeatWeek').style.display, '');
    for (const d of [1, 4]) app.doc.querySelector(`#fRepeatWeek input[data-dow="${d}"]`).checked = true;
    app.doc.querySelector('#dlgSave').click();
    assert.deepEqual(clone(app.run('state.projects.find(p=>p.id==="w").repeat')), { type: 'weekly', dow: [1, 4] });
    assert.match(app.doc.querySelector('.pcard[data-id="w"]').textContent, /🔁 毎週 月・木/);

    // 開き直すと選んだ内容が入っている → 毎月 (日付を空にすると期限の日付)
    edit();
    assert.equal(sel().value, 'weekly');
    assert.equal(app.doc.querySelector('#fRepeatWeek input[data-dow="4"]').checked, true);
    sel().value = 'monthly'; sel().dispatchEvent(new app.win.Event('change'));
    app.doc.querySelector('#fRepeatDom').value = '';
    app.doc.querySelector('#dlgSave').click();
    assert.deepEqual(clone(app.run('state.projects.find(p=>p.id==="w").repeat')), { type: 'monthly', dom: 5 });

    // なし → 繰り返しが消える
    edit();
    sel().value = ''; sel().dispatchEvent(new app.win.Event('change'));
    app.doc.querySelector('#dlgSave').click();
    assert.equal(app.run('state.projects.find(p=>p.id==="w").repeat'), undefined);
    assert.doesNotMatch(app.doc.querySelector('.pcard[data-id="w"]').textContent, /🔁/);

    // 新しく追加する時も選べる
    app.doc.querySelector('#btnAdd').click();
    app.doc.querySelector('#fName').value = '平日の作業';
    app.doc.querySelector('#fDeadline').value = '2026-11-02T18:00';
    sel().value = 'weekdays';
    app.doc.querySelector('#dlgSave').click();
    assert.deepEqual(clone(app.run('state.projects.find(p=>p.name==="平日の作業").repeat')), { type: 'weekdays' });
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

/* ---------------- サーバー (Telegram) ---------------- */

function tgServer() {
  const clock = createClock('2026-11-02T10:00:00+09:00');
  const gas = loadGas({ clock });
  gas.enableTelegram(['111']);
  gas.setProjects([
    project(clock, { id: 'arc', name: 'Arc 毎日TX', deadline: '2026-11-02T21:00', repeat: { type: 'daily' } }),
    project(clock, { id: 'mon', name: '月例レポート', deadline: '2026-11-03T12:00', repeat: { type: 'monthly', dom: 3 } }),
  ]);
  return { clock, gas };
}

test('Telegram: /done でも次の回が1件だけでき、お知らせに次の日付が出る', () => {
  const { gas } = tgServer();
  gas.tg.pushMessage('111', '/list');
  gas.tg.pushMessage('111', '/done 1');   // 期限が近い順なので 1 = arc
  gas.ctx.pollTelegram();
  assert.deepEqual(series(gas.projects(), 'arc'), ['arc:done:2026-11-02T21:00', 'arc~2026-11-03:open:2026-11-03T21:00']);
  assert.ok(gas.tg.texts('111').some(t => /完了にしました/.test(t) && /🔁 次の回: 11\/03 21:00/.test(t)));
  // 同じ番号でもう一度 /done しても増えない
  gas.tg.pushMessage('111', '/done 1');
  gas.ctx.pollTelegram();
  assert.equal(series(gas.projects(), 'arc').length, 2);
  // 記録と受信箱にも残る
  assert.ok(gas.hist().some(e => e.k === 'add' && e.id === 'arc~2026-11-03' && e.rep === 1));
  assert.ok(gas.get().inbox.some(x => x.type === 'add' && x.id === 'arc~2026-11-03'));
});

test('Telegram: クエストのボタンで完了すると次の回、見送りは繰り返しを止める。二度押しても1件', () => {
  const { gas } = tgServer();
  gas.ctx.handleCommand_('/alert', '111');
  gas.tg.pushButton('111', 'q:d:arc');
  gas.tg.pushButton('111', 'q:d:arc');
  gas.ctx.pollTelegram();
  assert.deepEqual(series(gas.projects(), 'arc'), ['arc:done:2026-11-02T21:00', 'arc~2026-11-03:open:2026-11-03T21:00']);
  const toasts = gas.tg.calls.filter(c => c.method === 'answerCallbackQuery').map(c => c.body.text);
  assert.match(toasts[0], /🔁 次の回: 11\/03 21:00/);
  // 見送り
  gas.tg.pushButton('111', 'q:x:mon');
  gas.ctx.pollTelegram();
  assert.deepEqual(series(gas.projects(), 'mon'), ['mon:done:2026-11-03T12:00']);
  assert.match(gas.tg.calls.filter(c => c.method === 'answerCallbackQuery').pop().body.text, /繰り返しを止めました/);
});

test('毎朝のクエスト: 繰り返しの予定は1日1件まで', () => {
  const clock = createClock('2026-11-02T09:05:00+09:00');
  const gas = loadGas({ clock });
  gas.enableTelegram(['111']);
  gas.setProjects([
    project(clock, { id: 'd1', name: '毎日1', deadline: jstLocal(clock, 0, '10:00'), repeat: { type: 'daily' } }),
    project(clock, { id: 'd2', name: '毎日2', deadline: jstLocal(clock, 0, '11:00'), repeat: { type: 'daily' } }),
    project(clock, { id: 'd3', name: '毎日3', deadline: jstLocal(clock, 0, '12:00'), repeat: { type: 'weekdays' } }),
    project(clock, { id: 'n1', name: 'ふつう', deadline: jstLocal(clock, 3) }),
    project(clock, { id: 'p1', name: 'ピン', pinned: true }),
  ]);
  gas.ctx.pollTelegram();
  const ids = clone(gas.game().quest.ids);
  assert.deepEqual(ids, ['d1', 'n1', 'p1']);
});

/* ---------------- アプリとサーバーの間 ---------------- */

test('アプリで完了 → 同期: サーバーは次の回をもう1件作らない。Telegram と両方で完了しても1件', async () => {
  const { gas, clock } = tgServer();
  const A = await appWith(clock, gas.projects(), gas);
  try {
    // アプリで完了 (まだ同期しない) → Telegram でも同じ回を完了
    A.run('switchTab("projects")');
    A.doc.querySelector('.pcard[data-id="arc"] [data-act="toggle"]').click();
    clock.tick(60000);
    gas.ctx.handleCommand_('/list', '111');
    gas.ctx.handleCommand_('/done 1', '111');
    assert.equal(series(gas.projects(), 'arc').length, 2, 'サーバーにも次の回が1件');
    // 同期
    clock.tick(60000);
    await A.run('gasSync()');
    gas.newRun();
    const want = ['arc:done:2026-11-02T21:00', 'arc~2026-11-03:open:2026-11-03T21:00'];
    assert.deepEqual(series(gas.projects(), 'arc'), want, 'サーバー');
    assert.deepEqual(series(A.run('state.projects'), 'arc'), want, 'アプリ');

    // 次の回をアプリで完了 → 同期 → サーバーでも1件だけ
    clock.addDays(1);
    A.run('renderProjects()');
    A.doc.querySelector('.pcard[data-id="arc~2026-11-03"] [data-act="toggle"]').click();
    await A.run('gasSync()');
    await A.run('gasSync()');
    gas.newRun();
    assert.deepEqual(series(gas.projects(), 'arc').filter(x => /open/.test(x)), ['arc~2026-11-04:open:2026-11-04T21:00']);
    assert.deepEqual(A.errors, []);
  } finally { A.close(); }
});

test('古いアプリ (繰り返しを知らない) が完了だけ送ってきても、サーバーが次の回を作る', () => {
  const { gas, clock } = tgServer();
  clock.tick(60000);
  const list = gas.projects();
  const arc = list.find(p => p.id === 'arc');
  arc.status = 'done'; arc.doneAt = arc.updatedAt = clock.iso();
  const r = gas.post({ all: list, deleted: {}, syncedAt: clock.iso() });
  assert.deepEqual(series(r.projects, 'arc'), ['arc:done:2026-11-02T21:00', 'arc~2026-11-03:open:2026-11-03T21:00']);
  assert.equal(r.projects.find(p => p.id === 'arc').repeatNext, 'arc~2026-11-03');
  // もう一度送っても増えない
  clock.tick(60000);
  assert.equal(series(gas.post({ all: r.projects, deleted: {}, syncedAt: clock.iso() }).projects, 'arc').length, 2);
});

test('振り返り分析: 繰り返しの予定の達成率', async () => {
  const clock = createClock('2026-11-10T10:00:00+09:00');
  const R = { type: 'daily' };
  const inst = (d, f) => project(clock, Object.assign({ id: 'arc~2026-11-' + d, repeatOf: 'arc', name: 'Arc 毎日TX', chain: 'Arc', deadline: `2026-11-${d}T21:00`, repeat: R }, f));
  const app = await appWith(clock, [
    project(clock, { id: 'arc', name: 'Arc 毎日TX', chain: 'Arc', deadline: '2026-11-03T21:00', repeat: R, status: 'done', doneAt: '2026-11-03T20:00:00+09:00' }),
    inst('04', { status: 'done', doneAt: '2026-11-04T09:00:00+09:00' }),
    inst('05', { status: 'done', doneAt: '2026-11-06T09:00:00+09:00' }),   // 遅れて完了
    inst('06', { status: 'done', doneAt: '2026-11-06T22:00:00+09:00', dropped: true }),
    inst('08'),                                                           // やらずに過ぎた
    inst('10'),                                                           // 今日が期限 (まだ数えない)
  ]);
  try {
    await app.run('loadReviewData()');
    app.doc.querySelector('#rvAnon').checked = false;
    const p = app.run('buildReviewPrompt()');
    assert.match(p, /## 繰り返しの予定の達成率/);
    assert.match(p, /期限が来た回 5回のうち、期限内に完了 2回（40%）/);
    assert.match(p, /\| Arc 毎日TX \| Arc \| 毎日 \| 5 \| 2 \| 1 \| 1 \| 1 \| 40% \|/);
    app.doc.querySelector('#rvAnon').checked = true;
    assert.match(app.run('buildReviewPrompt()'), /\| 案件A \| Arc \| 毎日 \| 5 \|/, '案件名は伏せられる');
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});
