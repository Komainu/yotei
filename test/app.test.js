'use strict';
/* アプリ本体 (index.html) を jsdom で開いて確かめる */
const test = require('node:test');
const assert = require('node:assert/strict');
const { openApp } = require('./helpers/app');
const { loadGas, project } = require('./helpers/gas');
const { createClock, jstLocal } = require('./helpers/clock');

const clone = x => JSON.parse(JSON.stringify(x));

/** よくある状態: 今日まで・期限切れ・明日・ピン留め・完了済み */
function sampleState(clock) {
  return {
    projects: [
      project(clock, { id: 'a1', name: '今日締切の案件', chain: 'ETH', deadline: jstLocal(clock, 0), memo: 'ブリッジする', sources: [{ url: 'https://example.com/a', title: '公式' }] }),
      project(clock, { id: 'a2', name: '期限切れの案件', chain: 'SOL', deadline: jstLocal(clock, -2) }),
      project(clock, { id: 'a3', name: '明日締切の案件', deadline: jstLocal(clock, 1) }),
      project(clock, { id: 'a4', name: '重要な案件', pinned: true }),
      project(clock, { id: 'a5', name: '完了した案件', status: 'done', doneAt: new Date(clock.now - 86400000).toISOString() }),
    ],
    settings: { key: 'SECRET-GEMINI', tgToken: 'SECRET-TG', tgChat: '999', fredKey: 'SECRET-FRED', model: 'gemini-2.5-flash' },
    deleted: {},
  };
}

test('index.html: 空の状態で開いてもエラーが出ない', async () => {
  const app = await openApp();
  try {
    assert.deepEqual(app.errors, []);
    assert.equal(app.doc.title, '予定管理');
    assert.match(app.text('#hSay'), /登録されている案件はありません/);
    for (const t of ['projects', 'settings', 'home']) { app.run(`switchTab(${JSON.stringify(t)})`); await app.settle(); }
    assert.ok(app.doc.querySelector('#tab-home').classList.contains('active'));
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('index.html: 旧形式や壊れたデータで開いてもエラーが出ず、修復される', async () => {
  const clock = createClock();
  const app = await openApp({ clock, state: {
    projects: [{ name: 'idなし' }, null, { id: 'x', name: '危険なリンク', sources: [{ url: 'javascript:alert(1)', title: '' }] }, { id: 'y' }],
    settings: {}, chat: [{}],
  } });
  try {
    assert.deepEqual(app.errors, []);
    const ps = clone(app.run('state.projects'));
    assert.equal(ps.length, 2, '名前の無い案件・null は除く');
    assert.ok(ps.every(p => p.id && p.status === 'open' && Array.isArray(p.sources)));
    assert.equal(ps.find(p => p.id === 'x').sources[0].url, '', 'javascript: のURLは除く');
    assert.equal(app.run('state.chat'), undefined);
  } finally { app.close(); }
});

test('HOME: 締切・おしらせ・数字・今日やることの文面が作れる', async () => {
  const clock = createClock('2026-11-02T10:00:00+09:00');
  const app = await openApp({ clock, state: sampleState(clock) });
  try {
    assert.deepEqual(app.errors, []);
    assert.equal(app.text('#hDate'), '11/2 (月)');
    assert.equal(app.text('#hSay'), 'おはようございます。今日が締切の案件が1件あります。まずは「今日締切の案件」から片付けましょう');
    const notice = app.text('#hNotice');
    assert.match(notice, /本日まで今日締切の案件/);
    assert.match(notice, /明日まで明日締切の案件/);
    assert.match(notice, /2日超過期限切れの案件/);
    const metrics = [...app.doc.querySelectorAll('#hMetrics .metric')].map(m => m.textContent.replace(/\s+/g, ''));
    assert.deepEqual(metrics, ['未完了4', '7日以内・超過3', '期限未設定1', '7日間で完了1']);
    assert.equal(app.text('#hGaugeTxt'), '3 / 4 件 (75%)');
    const todo = [...app.doc.querySelectorAll('#hTodo .todo')].map(t => t.querySelector('.ntag').textContent + ':' + t.querySelector('.tname').textContent);
    assert.deepEqual(todo, ['本日まで:今日締切の案件', '2日超過:期限切れの案件', '明日まで:明日締切の案件', '重要:重要な案件']);
    assert.match(app.text('#hStory'), /第1話「はじまりの部屋」/, '完了1件で第1話');

    // 時間帯であいさつが変わる / 締切が無ければピン留めを勧める
    clock.set('2026-11-02T19:00');
    app.run('state.projects = state.projects.filter(p=>!p.deadline); renderHome()');
    assert.equal(app.text('#hSay'), 'こんばんは。急ぎの締切はありません。重要案件の「重要な案件」から進めましょう');
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('よてい一覧: グループ分け・絞り込み・検索ができ、ボタンで完了/ピン/削除できる', async () => {
  const clock = createClock('2026-11-02T10:00:00+09:00');
  const app = await openApp({ clock, state: sampleState(clock) });
  try {
    app.run('switchTab("projects")');
    const heads = () => [...app.doc.querySelectorAll('#projectList .grp-head')].map(h => h.textContent.replace(/\s+/g, ''));
    assert.deepEqual(heads(), ['⚠期限切れ・3日以内(3)', '📌重要(1)', '✓完了(1)']);
    const names = () => [...app.doc.querySelectorAll('#projectList .pname')].map(n => n.textContent);
    assert.ok(names().includes('今日締切の案件'));
    assert.equal(app.text('#stOpen'), '4');
    assert.equal(app.text('#stPin'), '1');
    assert.match(app.doc.querySelector('#projectList').innerHTML, /href="https:\/\/example.com\/a"/);

    // 検索
    app.doc.querySelector('#pSearch').value = 'sol';
    app.run('renderProjects()');
    assert.deepEqual(names(), ['期限切れの案件']);
    app.doc.querySelector('#pSearch').value = '';
    app.run('renderProjects()');
    assert.equal(names().length, 5);

    // ボタン: 完了にする → 完了日時と更新時刻が付く
    clock.tick(60000);
    app.doc.querySelector('.pcard[data-id="a3"] [data-act="toggle"]').click();
    let a3 = clone(app.run('state.projects.find(p=>p.id==="a3")'));
    assert.equal(a3.status, 'done');
    assert.ok(a3.doneAt);
    assert.equal(a3.updatedAt, clock.iso(), '変更した案件だけ更新時刻が変わる');
    assert.notEqual(clone(app.run('state.projects.find(p=>p.id==="a1")')).updatedAt, clock.iso());

    // ピン留め
    app.doc.querySelector('.pcard[data-id="a1"] [data-act="pin"]').click();
    assert.equal(app.run('state.projects.find(p=>p.id==="a1").pinned'), true);

    // 削除 → 削除記録が残る / localStorage にも保存される
    app.doc.querySelector('.pcard[data-id="a2"] [data-act="del"]').click();
    assert.equal(app.run('state.projects.some(p=>p.id==="a2")'), false);
    assert.ok(app.run('state.deleted.a2'));
    const saved = JSON.parse(app.win.localStorage.getItem('sakiyomi_v1'));
    assert.ok(saved.deleted.a2);
    assert.ok(!saved.projects.some(p => p.id === 'a2'));
    assert.ok(JSON.parse(app.win.localStorage.getItem('sakiyomi_backups')).length >= 1, '削除前に自動バックアップ');
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('設定: 画面が開け、入力欄に設定が入る。エクスポートに秘密情報が含まれない', async () => {
  const clock = createClock();
  const st = sampleState(clock);
  st.settings.gasUrl = '';
  const app = await openApp({ clock, state: st });
  try {
    app.run('switchTab("settings")');
    await app.settle();
    assert.ok(app.doc.querySelector('#tab-settings').classList.contains('active'));
    assert.equal(app.doc.querySelector('#tgToken').value, 'SECRET-TG');
    assert.equal(app.doc.querySelector('#tgToken').type, 'password');
    assert.match(app.text('#appVer'), /^v\d{4}\.\d{2}\.\d{2}$/);

    let blob = null;
    app.win.URL.createObjectURL = b => { blob = b; return 'blob:test'; };
    app.win.URL.revokeObjectURL = () => {};
    app.win.HTMLAnchorElement.prototype.click = function () {};
    app.doc.querySelector('#btnExport').click();
    assert.ok(blob, 'エクスポートのファイルが作られた');
    const txt = await blob.text();
    const out = JSON.parse(txt);
    assert.equal(out.projects.length, 5);
    for (const s of ['SECRET-GEMINI', 'SECRET-TG', 'SECRET-FRED', '"999"']) assert.ok(!txt.includes(s), s + ' を含まない');
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('🤖 AIに渡す: 用途ごとのプロンプトが作れる (振り返り分析を含む)', async () => {
  const clock = createClock('2026-11-02T10:00:00+09:00');
  const app = await openApp({ clock, state: sampleState(clock) });
  try {
    app.doc.querySelector('#btnAiExport').click();
    await app.settle();
    const sel = app.doc.querySelector('#aiPurpose');
    const prompts = {};
    for (const o of [...sel.options].map(o => o.value).filter(v => v !== 'review')) {
      sel.value = o;
      sel.dispatchEvent(new app.win.Event('change'));
      prompts[o] = app.doc.querySelector('#aiPrompt').value;
      assert.match(prompts[o], /## 案件一覧/, o);
      assert.match(prompts[o], /今日締切の案件/, o);
    }
    assert.ok(!prompts.table.includes('完了した案件'), '通常は未完了のみ');
    assert.ok(prompts.handover.includes('完了した案件'), '引き継ぎは完了済みも含む');
    for (const s of ['SECRET-GEMINI', 'SECRET-TG']) assert.ok(!Object.values(prompts).join('').includes(s));
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('📈 振り返り分析: サーバーの操作の記録から文面が作れる (案件名を伏せられる)', async () => {
  const clock = createClock('2026-11-02T10:00:00+09:00');
  const gas = loadGas({ clock });
  const app0 = sampleState(clock);
  // サーバー側に記録を作る: 追加 → 期限変更 → 完了 / 明日へ
  gas.enableTelegram(['111']);
  const list = clone(app0.projects);
  gas.post({ all: list, deleted: {}, syncedAt: clock.iso() });
  clock.tick(60000);
  list[2].deadline = jstLocal(clock, 5); list[2].updatedAt = clock.iso();
  list[3].status = 'done'; list[3].doneAt = list[3].updatedAt = clock.iso();
  gas.post({ all: list, deleted: {}, syncedAt: clock.iso() });
  gas.ctx.handleCallback_({ id: 'c', data: 'q:s:a1', message: { message_id: 1, chat: { id: 111 } } });

  const st = sampleState(clock);
  st.projects = clone(gas.projects());
  st.settings.gasUrl = 'https://script.google.com/macros/s/TEST/exec';
  st.settings.gasAuto = false;
  const app = await openApp({ clock, gas, state: st });
  try {
    app.doc.querySelector('#btnAiExport').click();
    const sel = app.doc.querySelector('#aiPurpose');
    sel.value = 'review';
    sel.dispatchEvent(new app.win.Event('change'));
    await app.settle();
    assert.ok(app.requests.some(r => /action=history/.test(r.url)), '記録をサーバーから読む');
    let p = app.doc.querySelector('#aiPrompt').value;
    for (const h of ['## お願いしたいこと', '## 全体の数字', '## 完了の質', '## 曜日・時間帯ごとの完了数', '## 分野ごと', '## 先送りが多い案件', '## 期限切れのまま残っている案件', '## 毎朝のクエストと連続記録', '## 操作の記録']) {
      assert.ok(p.includes(h), h);
    }
    assert.match(p, /\| 追加 \| 4 \|/, '最初から完了済みの1件は「完了」として記録される');
    assert.match(p, /\| 完了 \| 2 \|/);
    assert.match(p, /\| 期限変更 \| 1 \|/);
    assert.match(p, /\| 明日へ\(先送り\) \| 1 \|/);
    assert.match(p, /案件名は伏せています/);
    assert.ok(!p.includes('今日締切の案件'), '案件名を伏せる');
    assert.match(p, /案件A/);
    assert.match(p, /\| ETH \|/, '分野名は残す');

    // 伏せない設定
    const anon = app.doc.querySelector('#rvAnon');
    anon.checked = false;
    anon.dispatchEvent(new app.win.Event('change'));
    p = app.doc.querySelector('#aiPrompt').value;
    assert.ok(p.includes('今日締切の案件'));
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('振り返り分析: サーバー未設定でも、アプリの完了日時から文面が作れる', async () => {
  const clock = createClock('2026-11-02T10:00:00+09:00');
  const app = await openApp({ clock, state: sampleState(clock) });
  try {
    await app.run('loadReviewData()');
    const p = app.run('buildReviewPrompt()');
    assert.match(p, /\| 完了 \| 1 \|/);
    assert.match(p, /まだ記録がありません/);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('ものがたり: アプリとサーバーの文章が同じ。お話のダイアログが開ける', async () => {
  const clock = createClock();
  const gas = loadGas({ clock });
  const app = await openApp({ clock, state: sampleState(clock) });
  try {
    const appStory = clone(app.run('STORY')).map(s => [s.at, s.t, s.b]);
    assert.deepEqual(appStory, clone(gas.C.STORY));
    app.doc.querySelector('#storyOpen').click();
    assert.ok(app.doc.querySelector('#storyDlg').hasAttribute('open'));
    assert.match(app.text('#storyBody'), /第1話　はじまりの部屋/);
    assert.match(app.text('#storyBody'), /第2話）まで、あと2件/);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('アプリの保護: この端末が0件ならクラウドを上書きしない', async () => {
  const clock = createClock();
  const gas = loadGas({ clock });
  gas.post({ all: [project(clock, { id: 'keep', name: 'クラウドの案件' })], deleted: {}, syncedAt: clock.iso() });
  const app = await openApp({ clock, gas, state: { projects: [], settings: { gasUrl: 'https://script.google.com/macros/s/TEST/exec', gasAuto: false }, deleted: {} } });
  try {
    // 起動時: 手元が0件でクラウドにデータがあれば、上書きせずに読み込む
    assert.deepEqual(clone(app.run('state.projects')).map(p => p.id), ['keep']);
    assert.ok(!app.requests.some(r => r.init && r.init.method === 'POST'), '保存の送信をしない');
    // 0件のまま保存しようとしても中止される
    app.run('state.projects = []; save();');
    await assert.rejects(app.run('gasSync()'), /クラウドの1件を消さないため中止/);
    assert.deepEqual(gas.projects().map(p => p.id), ['keep']);
    assert.ok(!app.requests.some(r => r.init && r.init.method === 'POST'), '保存の送信をしない');
  } finally { app.close(); }
});

test('同期 (アプリ⇔サーバー): 2台の端末とTelegramの変更が全部残り、削除した案件は復活しない', async () => {
  const clock = createClock('2026-11-02T10:00:00+09:00');
  const gas = loadGas({ clock });
  gas.enableTelegram(['111']);
  const URL_ = 'https://script.google.com/macros/s/TEST/exec';
  const base = () => ({ projects: [], settings: { gasUrl: URL_, gasAuto: false, gasMail: '' }, deleted: {} });

  // 端末A: 3件を登録してクラウドへ
  const A = await openApp({ clock, gas, state: base() });
  // 端末B: 起動時にクラウドから読み込む
  let B;
  try {
    A.run(`state.projects.push(...${JSON.stringify([
      project(clock, { id: 'e1', name: '共通の案件' }),
      project(clock, { id: 'e2', name: '端末Aで消す案件' }),
      project(clock, { id: 'e3', name: 'Telegramで完了する案件' }),
    ])}); save();`);
    clock.tick(1000);
    await A.run('gasSync()');
    assert.equal(gas.projects().length, 3);

    clock.tick(1000);
    B = await openApp({ clock, gas, state: base() });
    await B.settle();
    assert.equal(B.run('state.projects.length'), 3, '端末Bは起動時にクラウドから読み込む');

    // 端末A: 案件を削除 (同期はまだ)
    clock.tick(60000);
    A.doc.querySelector('.pcard[data-id="e2"] [data-act="del"]').click();
    // 端末B: 名前を変更して新しい案件を追加 (同期はまだ)
    clock.tick(1000);
    B.run(`state.projects.find(p=>p.id==="e1").name = "端末Bで名前を変更"; state.projects.push(${JSON.stringify(project(clock, { id: 'e4', name: '端末Bの新しい案件' }))}); save();`);
    // Telegram: 完了
    clock.tick(1000);
    gas.ctx.handleCommand_('/list', '111');
    const ids = JSON.parse(gas.props.getProperty('TG_LASTLIST_111'));
    gas.ctx.handleCommand_('/done ' + (ids.indexOf('e3') + 1), '111');

    // 端末B → 端末A → 端末B の順で同期
    clock.tick(1000); await B.run('gasSync()');
    clock.tick(1000); await A.run('gasSync()');
    clock.tick(1000); await B.run('gasSync()');

    const summary = app => clone(app.run('state.projects')).map(p => p.id + ':' + p.name + ':' + p.status).sort();
    const expected = ['e1:端末Bで名前を変更:open', 'e3:Telegramで完了する案件:done', 'e4:端末Bの新しい案件:open'];
    assert.deepEqual(summary(A), expected, '端末A');
    assert.deepEqual(summary(B), expected, '端末B');
    assert.deepEqual(gas.projects().map(p => p.id + ':' + p.name + ':' + p.status).sort(), expected, 'クラウド');
    assert.ok(B.run('state.deleted.e2'), '端末Bにも削除記録が届く');
    assert.deepEqual(A.errors, []);
    assert.deepEqual(B.errors, []);
  } finally { A.close(); if (B) B.close(); }
});

test('サーバーの版: 古い版ならHOMEに「要更新」が出て、最新のサーバーにつなぐと消える', async () => {
  const clock = createClock();
  const st = () => ({ projects: [project(clock, { id: 'v1', name: 'x' })], settings: { gasUrl: 'https://script.google.com/macros/s/TEST/exec', gasAuto: false, gasVersion: '2000.01.01' }, deleted: {} });
  // サーバーにつながらない時は、前回の版のまま
  const off = await openApp({ clock, state: st() });
  try {
    off.run('renderHome()');
    assert.match(off.text('#hNotice'), /要更新/);
    assert.deepEqual(off.errors, [], '通信できなくてもエラーにしない');
  } finally { off.close(); }
  const gas = loadGas({ clock });
  const on = await openApp({ clock, state: st(), gas });
  try {
    on.run('renderHome()');
    assert.equal(on.run('state.settings.gasVersion'), gas.C.GAS_VERSION);
    assert.doesNotMatch(on.text('#hNotice'), /要更新/);
    assert.ok(on.run('MIN_GAS_VERSION') <= gas.C.GAS_VERSION, '今のサーバーはアプリが求める版を満たす');
    assert.deepEqual(on.errors, []);
  } finally { on.close(); }
});
