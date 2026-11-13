'use strict';
/* アプリ本体 (index.html) を jsdom で開いて確かめる — 起動・設定・旧データのエクスポート・以前の機能が無いこと */
const test = require('node:test');
const assert = require('node:assert/strict');
const { openApp, HTML } = require('./helpers/app');
const { loadGas, project } = require('./helpers/gas');
const { createClock, jstLocal } = require('./helpers/clock');

const clone = x => JSON.parse(JSON.stringify(x));
const TABS = ['top', 'poly', 'btc', 'hl', 'flow', 'gloss', 'settings'];

/** 以前の予定管理を使っていた端末に残っている状態 */
function oldState(clock) {
  return {
    projects: [
      project(clock, { id: 'a1', name: '今日締切の案件', chain: 'ETH', deadline: jstLocal(clock, 0), memo: 'ブリッジする', sources: [{ url: 'https://example.com/a', title: '公式' }] }),
      project(clock, { id: 'a2', name: '期限切れの案件', chain: 'SOL', deadline: jstLocal(clock, -2), repeat: { type: 'weekly', dow: [1] } }),
      project(clock, { id: 'a3', name: '完了した案件', status: 'done', doneAt: new Date(clock.now - 86400000).toISOString() }),
    ],
    settings: { key: 'SECRET-GEMINI', tgToken: 'SECRET-TG', tgChat: '999', fredKey: 'SECRET-FRED', model: 'gemini-2.5-flash', gasMail: 'me@example.com', gasAuto: true, roomBg: true, theme: 'dark', gasKey: 'SECRET-PASSPHRASE-1' },
    deleted: { gone: new Date(clock.now).toISOString() },
    updatedAt: new Date(clock.now).toISOString(),
  };
}
function catchDownload(app) {
  const got = { blob: null, name: null };
  app.win.URL.createObjectURL = b => { got.blob = b; return 'blob:test'; };
  app.win.URL.revokeObjectURL = () => {};
  app.win.HTMLAnchorElement.prototype.click = function () { got.name = this.download; };
  return got;
}

test('index.html: 空の状態で開いてもエラーが出ない。タブは7つで、最初はホーム', async () => {
  const app = await openApp();
  try {
    assert.deepEqual(app.errors, []);
    assert.equal(app.doc.title, 'ポリマーケット記録');
    assert.deepEqual([...app.doc.querySelectorAll('nav.tabs button[data-tab]')].map(b => b.dataset.tab), TABS);
    assert.deepEqual([...app.doc.querySelectorAll('section.tab')].map(s => s.id), TABS.map(t => 'tab-' + t));
    assert.ok(app.doc.querySelector('#tab-top').classList.contains('active'), '最初はホーム');
    for (const t of TABS) {
      app.run(`switchTab(${JSON.stringify(t)})`); await app.settle();
      assert.ok(app.doc.querySelector('#tab-' + t).classList.contains('active'), t);
    }
    assert.match(app.text('#appVer'), /^v\d{4}\.\d{2}\.\d{2}$/);
    assert.match(app.text('#gasStatus'), /URLが未設定/);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('index.html: 壊れた保存データで開いてもエラーが出ない', async () => {
  for (const raw of ['{こわれた', 'null', '[]', '"文字"', '{"settings":null}', '{"settings":"x","projects":"y"}']) {
    const app = await openApp({ storage: { sakiyomi_v1: raw } });
    try {
      assert.deepEqual(app.errors, [], raw);
      assert.equal(typeof app.run('state.settings'), 'object', raw);
      app.run('switchTab("settings")'); await app.settle();
      assert.deepEqual(app.errors, [], raw);
    } finally { app.close(); }
  }
});

test('以前の予定データが端末に残っていても、消さずに持ち続ける。使わなくなった設定 (トークン類) は端末から消す', async () => {
  const clock = createClock();
  const st = oldState(clock);
  st.settings.gasUrl = '';
  const app = await openApp({ clock, state: st });
  try {
    assert.deepEqual(app.errors, []);
    assert.equal(app.doc.documentElement.dataset.theme, 'dark', '配色はそのまま');
    // 設定を保存しても、予定データはそのまま残る
    app.run('switchTab("settings")');
    app.doc.querySelector('#themeBtn').click();
    const saved = JSON.parse(app.win.localStorage.getItem('sakiyomi_v1'));
    assert.deepEqual(saved.projects, clone(st.projects), '案件は1文字も変えない');
    assert.deepEqual(saved.deleted, clone(st.deleted));
    assert.equal(saved.settings.theme, 'light');
    assert.equal(saved.settings.gasKey, 'SECRET-PASSPHRASE-1', '合言葉は残す');
    for (const k of ['key', 'tgToken', 'tgChat', 'fredKey', 'model', 'gasMail', 'gasAuto', 'roomBg']) assert.equal(saved.settings[k], undefined, k + ' は消す');
    const txt = JSON.stringify(saved);
    for (const s of ['SECRET-GEMINI', 'SECRET-TG', 'SECRET-FRED']) assert.ok(!txt.includes(s), s);
  } finally { app.close(); }
});

test('旧データのエクスポート: この端末に残っている分を書き出す。秘密情報は入れない', async () => {
  const clock = createClock();
  const st = oldState(clock);
  st.settings.gasUrl = '';
  const app = await openApp({ clock, state: st });
  try {
    app.run('switchTab("settings")');
    const got = catchDownload(app);
    app.doc.querySelector('#btnExport').click();
    await app.settle();
    assert.ok(got.blob, 'ファイルが作られた');
    assert.match(got.name, /^yotei_backup_\d{4}-\d{2}-\d{2}\.json$/);
    const txt = await got.blob.text();
    const out = JSON.parse(txt);
    assert.deepEqual(out.projects, clone(st.projects));
    assert.deepEqual(out.deleted, clone(st.deleted));
    assert.equal(out.source, 'この端末');
    assert.equal(out.settings, undefined, '設定は書き出さない');
    for (const s of ['SECRET-GEMINI', 'SECRET-TG', 'SECRET-FRED', 'SECRET-PASSPHRASE-1', '"999"']) assert.ok(!txt.includes(s), s + ' を含まない');
    assert.match(app.text('#exportResult'), /3件を書き出しました/);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('旧データのエクスポート: 端末に無くても、サーバー (ドライブ) に残っている分を書き出せる。サーバーは書き換えない', async () => {
  const clock = createClock();
  const gas = loadGas({ clock });
  const list = Array.from({ length: 31 }, (_, i) => project(clock, { id: 'c' + i, name: 'クラウドの案件' + i }));
  gas.setLegacy(list, { gone: clock.iso() });
  const legacyFiles = () => JSON.stringify(gas.drive.folderFiles('予定管理データ'));
  const before = legacyFiles();
  const app = await openApp({ clock, gas, state: { settings: { gasUrl: 'https://script.google.com/macros/s/TEST/exec' } } });
  try {
    app.run('switchTab("settings")');
    const got = catchDownload(app);
    app.doc.querySelector('#btnExport').click();
    for (let i = 0; i < 3; i++) await app.settle();
    const out = JSON.parse(await got.blob.text());
    assert.equal(out.projects.length, 31);
    assert.equal(out.source, 'サーバー');
    assert.deepEqual(Object.keys(out.deleted), ['gone']);
    assert.match(app.text('#exportResult'), /31件を書き出しました \(サーバーの内容\)/);
    assert.equal(legacyFiles(), before, 'サーバーの旧データには書かない');
    assert.equal(gas.drive.folderFiles('予定管理データ').length, 2);
    assert.ok(!app.requests.some(r => r.init && r.init.method === 'POST'), '何も送信しない');
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('旧データのエクスポート: どこにも無ければ、ファイルを作らずにそう伝える', async () => {
  const app = await openApp();
  try {
    app.run('switchTab("settings")');
    const got = catchDownload(app);
    app.doc.querySelector('#btnExport').click();
    await app.settle();
    assert.equal(got.blob, null);
    assert.match(app.text('#exportResult'), /見つかりませんでした/);
  } finally { app.close(); }
});

test('以前の予定管理の画面とコードは残っていない', async () => {
  const app = await openApp();
  try {
    for (const sel of ['#tab-home', '#tab-projects', '#pDialog', '#aiDialog', '#storyDlg', '#roomBg', '#tgToken', '#tgChat', '#setKey', '#gasSync', '#gasLoad', '#gasMail', '#btnImport', '#btnRestore', '.legacy']) {
      assert.equal(app.doc.querySelector(sel), null, sel);
    }
    for (const fn of ['renderHome', 'renderProjects', 'gasSync', 'gasLoad', 'mergeProjects', 'spawnRepeats', 'tgApi', 'renderRoom', 'drawRoom', 'buildReview', 'normalizeProjects', 'pushBackup', 'gasFormPost']) {
      assert.equal(app.run(`typeof ${fn}`), 'undefined', fn);
    }
    assert.ok(!/api\.telegram\.org/.test(HTML), 'Telegram へは通信しない');
    assert.ok(!/generativelanguage\.googleapis\.com/.test(HTML), 'アプリから Gemini を直接は呼ばない');
    assert.ok(!/class="[^"]*\blegacy\b/.test(HTML));
  } finally { app.close(); }
});

test('起動しただけでは、サーバーへ何も書き込まない (状況を読むだけ)', async () => {
  const clock = createClock();
  const gas = loadGas({ clock });
  gas.setLegacy([project(clock, { id: 'k', name: '残す' })]);
  const st = oldState(clock);
  st.settings.gasUrl = 'https://script.google.com/macros/s/TEST/exec';
  st.settings.gasKey = '';
  const app = await openApp({ clock, gas, state: st, fetch: async () => { throw new TypeError('offline'); } });
  try {
    for (let i = 0; i < 3; i++) await app.settle();
    assert.ok(app.requests.some(r => r.url.startsWith(app.GAS_URL)), 'サーバーには問い合わせる');
    assert.ok(!app.requests.some(r => r.url.startsWith(app.GAS_URL) && r.init && r.init.method === 'POST'), 'POST はしない');
    assert.deepEqual(gas.get({ action: 'load' }).projects.map(p => p.id), ['k']);
  } finally { app.close(); }
});

test('サーバーの版: 古い版なら設定に知らせが出て、最新のサーバーにつなぐと消える', async () => {
  const clock = createClock();
  const st = () => ({ settings: { gasUrl: 'https://script.google.com/macros/s/TEST/exec', gasVersion: '2000.01.01' } });
  // サーバーにつながらない時は、前回の版のまま
  const off = await openApp({ clock, state: st() });
  try {
    assert.match(off.text('#verInfo'), /古い版/);
    assert.doesNotMatch(off.text('#verInfo'), /gas-daily-mail/);
    assert.deepEqual(off.errors, [], '通信できなくてもエラーにしない');
  } finally { off.close(); }
  const gas = loadGas({ clock });
  const on = await openApp({ clock, state: st(), gas, fetch: async () => { throw new TypeError('offline'); } });
  try {
    for (let i = 0; i < 3; i++) await on.settle();
    assert.equal(on.run('state.settings.gasVersion'), gas.C.GAS_VERSION);
    assert.doesNotMatch(on.text('#verInfo'), /古い版/);
    assert.ok(on.run('MIN_GAS_VERSION') <= gas.C.GAS_VERSION, '今のサーバーはアプリが求める版を満たす');
  } finally { on.close(); }
});
