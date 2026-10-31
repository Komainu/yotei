'use strict';
/* 合言葉 (API_SECRET) — アプリ (index.html) 側 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { openApp, GAS_URL } = require('./helpers/app');
const { loadGas, project } = require('./helpers/gas');
const { createClock } = require('./helpers/clock');

const clone = x => JSON.parse(JSON.stringify(x));
const state = (extra, projects) => ({ projects: projects || [], settings: Object.assign({ gasUrl: GAS_URL, gasAuto: false, gasMail: '' }, extra || {}), deleted: {} });
const keyOfGet = r => new URL(r.url).searchParams.get('key');
const keyOfPost = r => JSON.parse(r.init ? r.init.body : r.form).key;

async function setKeyByUi(app, newKey) {
  app.run('switchTab("settings")');
  app.doc.querySelector('#gasKeyNew').value = newKey;
  app.doc.querySelector('#gasKeySet').click();
  for (let i = 0; i < 5; i++) await app.settle();
  return app.text('#gasKeyResult');
}

test('設定画面: 合言葉が未設定なら「合言葉を設定」で設定でき、以後すべての通信に付く', async () => {
  const clock = createClock();
  const gas = loadGas({ clock });
  const A = await openApp({ clock, gas, state: state({}, [project(clock, { id: 'k1', name: '案件1' })]) });
  try {
    // 🎲 作る: 12文字以上のランダムな合言葉
    A.doc.querySelector('#gasKeyGen').click();
    const made = A.doc.querySelector('#gasKeyNew').value;
    assert.ok(made.length >= 12);
    A.doc.querySelector('#gasKeyGen').click();
    assert.notEqual(A.doc.querySelector('#gasKeyNew').value, made, '毎回ちがう');

    // 短すぎるとサーバーへ送らない
    const posts0 = () => A.requests.filter(r => r.init && r.init.method === 'POST').length;
    const before = posts0();
    assert.match(await setKeyByUi(A, 'short'), /12文字以上/);
    assert.equal(posts0(), before);

    assert.match(await setKeyByUi(A, made), /合言葉を設定しました/);
    assert.equal(gas.props.getProperty('API_SECRET'), made);
    assert.equal(A.run('state.settings.gasKey'), made);
    assert.equal(A.doc.querySelector('#gasKey').value, made, '入力欄にも入る');
    assert.equal(A.doc.querySelector('#gasKeyNew').value, '');

    // 同期・状況確認・振り返りの記録の読み込み — 全部に合言葉が付き、成功する
    A.requests.length = 0;
    clock.tick(60000);
    const res = await A.run('gasSync()');
    assert.equal(res.ok, true);
    await A.run('gasCheck()');
    await A.run('loadReviewData()');
    await A.run('gasConfig({ action:"config", tgChat:"111" })');
    const gets = A.requests.filter(r => !(r.init && r.init.method === 'POST'));
    const posts = A.requests.filter(r => r.init && r.init.method === 'POST');
    assert.ok(gets.length >= 3 && posts.length >= 2);
    for (const r of gets) assert.equal(keyOfGet(r), made, r.url.replace(/key=[^&]+/, 'key=***'));
    for (const r of posts) assert.equal(keyOfPost(r), made);
    assert.ok(A.requests.some(r => /action=history/.test(r.url)));
    assert.equal(gas.props.getProperty('TG_CHAT'), '111');
    assert.deepEqual(A.errors, []);
  } finally { A.close(); }
});

test('2台目の端末: 合言葉が無い/違うと同期できず知らせが出る。正しい合言葉を入れると同期できる', async () => {
  const clock = createClock();
  const gas = loadGas({ clock });
  const SECRET = 'shared-secret-0123456';
  gas.post({ all: [project(clock, { id: 'c1', name: 'クラウドの案件' })], deleted: {}, syncedAt: clock.iso() });
  gas.props.setProperty('API_SECRET', SECRET);

  for (const [label, key] of [['なし', ''], ['違う', 'wrong-secret-000000']]) {
    clock.tick(60000);
    const B = await openApp({ clock, gas, state: state({ gasKey: key }, [project(clock, { id: 'b1', name: '端末Bの案件' })]) });
    try {
      // 起動時の同期で合言葉の違いに気づける
      assert.match(B.run('state.settings.gasError'), /合言葉が違います/, label);
      B.run('renderHome()');
      assert.match(B.text('#hNotice'), /同期エラー/, label);
      // 同期は失敗し、クラウドは変わらない
      await assert.rejects(B.run('gasSync()'), /合言葉が違います/, label);
      assert.deepEqual(gas.projects().map(p => p.id), ['c1'], label);
      assert.ok(!B.requests.some(r => r.form), label + ': フォーム送信で再挑戦しない');
      // 状況を確認ボタンでも理由が分かる
      B.run('switchTab("settings")');
      B.doc.querySelector('#gasCheck').click();
      await B.settle();
      assert.match(B.text('#gasResult'), /合言葉が違います/, label);
      // 別の端末から合言葉を「設定」して乗っ取ることもできない
      assert.match(await setKeyByUi(B, 'attacker-secret-0000'), /合言葉が違います/, label);
      assert.equal(gas.props.getProperty('API_SECRET'), SECRET, label);
    } finally { B.close(); }
  }

  // 正しい合言葉を入れる
  clock.tick(60000);
  const B = await openApp({ clock, gas, state: state({ gasKey: 'wrong-secret-000000', gasError: '' }, [project(clock, { id: 'b1', name: '端末Bの案件' })]) });
  try {
    B.run('switchTab("settings")');
    const input = B.doc.querySelector('#gasKey');
    input.value = SECRET;
    input.dispatchEvent(new B.win.Event('input'));
    assert.equal(B.run('state.settings.gasKey'), SECRET, '入力するとすぐ保存される');
    B.doc.querySelector('#gasCheck').click();
    await B.settle();
    assert.match(B.text('#gasResult'), /クラウド側: 1件/);
    assert.match(B.text('#gasResult'), /合言葉: 設定済み/);
    assert.equal(B.run('state.settings.gasError'), '', '合言葉が合えば知らせは消える');
    clock.tick(60000);
    await B.run('gasSync()');
    assert.deepEqual(gas.projects().map(p => p.id).sort(), ['b1', 'c1']);
    assert.deepEqual(clone(B.run('state.projects')).map(p => p.id).sort(), ['b1', 'c1']);
    assert.deepEqual(B.errors, []);
  } finally { B.close(); }
});

test('合言葉の変更: 今の合言葉が入っていれば変えられ、古い合言葉の端末は同期できなくなる', async () => {
  const clock = createClock();
  const gas = loadGas({ clock });
  const OLD = 'old-secret-01234567', NEW = 'new-secret-76543210';
  gas.post({ all: [project(clock, { id: 'x1', name: 'x' })], deleted: {}, syncedAt: clock.iso() });
  gas.props.setProperty('API_SECRET', OLD);
  const A = await openApp({ clock, gas, state: state({ gasKey: OLD }, gas.projects()) });
  const C = await openApp({ clock, gas, state: state({ gasKey: OLD }, gas.projects()) });
  try {
    assert.match(await setKeyByUi(A, NEW), /合言葉を設定しました/);
    assert.equal(gas.props.getProperty('API_SECRET'), NEW);
    assert.equal(A.run('state.settings.gasKey'), NEW);
    clock.tick(60000);
    assert.equal((await A.run('gasSync()')).ok, true);
    await assert.rejects(C.run('gasSync()'), /合言葉が違います/, '古い合言葉の端末');
  } finally { A.close(); C.close(); }
});

test('サーバーが古い版で合言葉に対応していなければ、設定できたことにしない', async () => {
  const clock = createClock();
  // 合言葉を知らない古いサーバー: 何を送っても保存として扱い ok を返す
  const oldServer = async (url, init) => ({ ok: true, json: async () => (init && init.method === 'POST' ? { ok: true, count: 0, projects: [] } : { ok: true, count: 0, version: '2026.10.27' }) });
  const A = await openApp({ clock, state: state({ gasUrl: 'https://script.google.com/macros/s/OLD/exec' }), fetch: oldServer });
  try {
    assert.match(await setKeyByUi(A, 'some-secret-0123456'), /古い版/);
    assert.equal(A.run('state.settings.gasKey') || '', '');
  } finally { A.close(); }
});

test('フォーム送信 (fetch が通らない端末) にも合言葉が付き、合言葉を設定したサーバーへ保存できる', async () => {
  const clock = createClock();
  const gas = loadGas({ clock });
  const SECRET = 'form-secret-0123456';
  gas.post({ all: [project(clock, { id: 'f1', name: 'f1' })], deleted: {}, syncedAt: clock.iso() });
  gas.props.setProperty('API_SECRET', SECRET);
  const A = await openApp({ clock, gas, gasPostFails: true, state: state({ gasKey: SECRET }, gas.projects()) });
  try {
    clock.tick(60000);
    A.run(`state.projects.push(${JSON.stringify(project(clock, { id: 'f2', name: 'フォームで追加' }))}); save();`);
    clock.tick(1000);
    const res = await A.run('gasSync()');
    assert.equal(res.ok, true);
    const form = A.requests.find(r => r.form);
    assert.ok(form, 'フォーム送信に切り替わった');
    assert.equal(keyOfPost(form), SECRET);
    assert.deepEqual(gas.projects().map(p => p.id).sort(), ['f1', 'f2']);

    // 合言葉が違えばフォーム送信でも保存されない
    A.run('state.settings.gasKey = "wrong-secret-000000"');
    A.run(`state.projects.push(${JSON.stringify(project(clock, { id: 'f3', name: 'x' }))}); save();`);
    await assert.rejects(A.run('gasSync()'));
    assert.deepEqual(gas.projects().map(p => p.id).sort(), ['f1', 'f2']);
  } finally { A.close(); }
});

test('合言葉はエクスポートに含まれず、バックアップの読み込みでも消えない', async () => {
  const clock = createClock();
  const A = await openApp({ clock, state: state({ gasKey: 'export-secret-012345', gasUrl: '' }, [project(clock, { name: 'e' })]) });
  try {
    assert.ok(A.run('SECRET_KEYS').includes('gasKey'));
    let blob = null;
    A.win.URL.createObjectURL = b => { blob = b; return 'blob:test'; };
    A.win.URL.revokeObjectURL = () => {};
    A.win.HTMLAnchorElement.prototype.click = function () {};
    A.doc.querySelector('#btnExport').click();
    const txt = await blob.text();
    assert.ok(!txt.includes('export-secret-012345'));
    assert.equal(JSON.parse(txt).settings.gasKey, undefined);
    assert.equal(A.doc.querySelector('#gasKey').type, 'password', '画面では伏せ字');
    A.doc.querySelector('#gasKeyToggle').click();
    assert.equal(A.doc.querySelector('#gasKey').type, 'text');
  } finally { A.close(); }
});
