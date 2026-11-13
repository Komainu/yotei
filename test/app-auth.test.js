'use strict';
/* 合言葉 (API_SECRET) — アプリ (index.html) 側 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { openApp, GAS_URL } = require('./helpers/app');
const { loadGas } = require('./helpers/gas');
const { createClock } = require('./helpers/clock');

const state = extra => ({ settings: Object.assign({ gasUrl: GAS_URL }, extra || {}) });
const offline = async () => { throw new TypeError('offline'); };
const keyOfGet = r => new URL(r.url).searchParams.get('key');
const keyOfPost = r => JSON.parse(r.init.body).key;
const toGas = r => r.url.startsWith(GAS_URL);
const isPost = r => !!(r.init && r.init.method === 'POST');

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
  const A = await openApp({ clock, gas, state: state(), fetch: offline });
  try {
    // 🎲 作る: 12文字以上のランダムな合言葉
    A.doc.querySelector('#gasKeyGen').click();
    const made = A.doc.querySelector('#gasKeyNew').value;
    assert.ok(made.length >= 12);
    A.doc.querySelector('#gasKeyGen').click();
    assert.notEqual(A.doc.querySelector('#gasKeyNew').value, made, '毎回ちがう');

    // 短すぎるとサーバーへ送らない
    const posts0 = () => A.requests.filter(r => toGas(r) && isPost(r)).length;
    const before = posts0();
    assert.match(await setKeyByUi(A, 'short'), /12文字以上/);
    assert.equal(posts0(), before);

    assert.match(await setKeyByUi(A, made), /合言葉を設定しました/);
    assert.equal(gas.props.getProperty('API_SECRET'), made);
    assert.equal(A.run('state.settings.gasKey'), made);
    assert.equal(A.doc.querySelector('#gasKey').value, made, '入力欄にも入る');
    assert.equal(A.doc.querySelector('#gasKeyNew').value, '');

    // 状況確認・各タブの読み込み・設定の保存 — 全部に合言葉が付く
    A.requests.length = 0;
    await A.run('gasCheck()');
    await A.run('loadHealth()');
    await A.run('loadMacro(true)').catch(() => {});
    await A.run('loadHl()').catch(() => {});
    await A.run('loadFlow()').catch(() => {});
    A.doc.querySelector('#pmMailTo').value = 'me@example.com';
    A.doc.querySelector('#pmMailSave').click();
    for (let i = 0; i < 3; i++) await A.settle();
    const gets = A.requests.filter(r => toGas(r) && !isPost(r));
    const posts = A.requests.filter(r => toGas(r) && isPost(r));
    assert.ok(gets.length >= 5 && posts.length >= 1, `${gets.length} / ${posts.length}`);
    for (const r of gets) assert.equal(keyOfGet(r), made, r.url.replace(/key=[^&]+/, 'key=***'));
    for (const r of posts) assert.equal(keyOfPost(r), made);
    assert.equal(gas.props.getProperty('MAIL_TO'), 'me@example.com');
    assert.deepEqual(A.errors, []);
  } finally { A.close(); }
});

test('2台目の端末: 合言葉が無い/違うと記録を見られず知らせが出る。正しい合言葉を入れると見られる', async () => {
  const clock = createClock();
  const gas = loadGas({ clock });
  const SECRET = 'shared-secret-0123456';
  gas.props.setProperty('API_SECRET', SECRET);
  gas.props.setProperty('MAIL_TO', 'me@example.com');

  for (const [label, key] of [['なし', ''], ['違う', 'wrong-secret-000000']]) {
    const B = await openApp({ clock, gas, state: state({ gasKey: key }), fetch: offline });
    try {
      for (let i = 0; i < 3; i++) await B.settle();
      // 起動時の確認で合言葉の違いに気づける
      assert.match(B.run('state.settings.gasError'), /合言葉が違います/, label);
      B.run('switchTab("settings")');
      assert.match(B.text('#gasStatus'), /合言葉が違います/, label);
      // 状況を確認ボタンでも理由が分かる
      B.doc.querySelector('#gasCheck').click();
      await B.settle();
      assert.match(B.text('#gasResult'), /合言葉が違います/, label);
      // 別の端末から合言葉を「設定」して乗っ取ることも、設定を変えることもできない
      assert.match(await setKeyByUi(B, 'attacker-secret-0000'), /合言葉が違います/, label);
      B.doc.querySelector('#pmMailTo').value = 'evil@example.com';
      B.doc.querySelector('#pmMailSave').click();
      for (let i = 0; i < 3; i++) await B.settle();
      assert.equal(gas.props.getProperty('API_SECRET'), SECRET, label);
      assert.equal(gas.props.getProperty('MAIL_TO'), 'me@example.com', label);
    } finally { B.close(); }
  }

  // 正しい合言葉を入れる
  const B = await openApp({ clock, gas, state: state({ gasKey: 'wrong-secret-000000' }), fetch: offline });
  try {
    for (let i = 0; i < 3; i++) await B.settle();
    B.run('switchTab("settings")');
    const input = B.doc.querySelector('#gasKey');
    input.value = SECRET;
    input.dispatchEvent(new B.win.Event('input'));
    assert.equal(B.run('state.settings.gasKey'), SECRET, '入力するとすぐ保存される');
    B.doc.querySelector('#gasCheck').click();
    for (let i = 0; i < 3; i++) await B.settle();
    assert.match(B.text('#gasResult'), /記録/);
    assert.match(B.text('#gasResult'), /合言葉: 設定済み/);
    assert.equal(B.run('state.settings.gasError'), '', '合言葉が合えば知らせは消える');
    assert.equal(B.text('#gasStatus'), '');
    assert.deepEqual(B.errors, []);
  } finally { B.close(); }
});

test('合言葉の変更: 今の合言葉が入っていれば変えられ、古い合言葉の端末は見られなくなる', async () => {
  const clock = createClock();
  const gas = loadGas({ clock });
  const OLD = 'old-secret-01234567', NEW = 'new-secret-76543210';
  gas.props.setProperty('API_SECRET', OLD);
  const A = await openApp({ clock, gas, state: state({ gasKey: OLD }), fetch: offline });
  const C = await openApp({ clock, gas, state: state({ gasKey: OLD }), fetch: offline });
  try {
    assert.match(await setKeyByUi(A, NEW), /合言葉を設定しました/);
    assert.equal(gas.props.getProperty('API_SECRET'), NEW);
    assert.equal(A.run('state.settings.gasKey'), NEW);
    assert.equal((await A.run('gasCheck()')).ok, true);
    await assert.rejects(C.run('gasCheck()'), /合言葉が違います/, '古い合言葉の端末');
  } finally { A.close(); C.close(); }
});

test('サーバーが古い版で合言葉に対応していなければ、設定できたことにしない', async () => {
  const clock = createClock();
  // 合言葉を知らない古いサーバー: 何を送っても ok を返す
  const oldServer = async (url, init) => ({ ok: true, json: async () => (init && init.method === 'POST' ? { ok: true, count: 0, projects: [] } : { ok: true, count: 0, version: '2026.10.27' }) });
  const A = await openApp({ clock, state: state({ gasUrl: 'https://script.google.com/macros/s/OLD/exec' }), fetch: oldServer });
  try {
    assert.match(await setKeyByUi(A, 'some-secret-0123456'), /古い版/);
    assert.equal(A.run('state.settings.gasKey') || '', '');
  } finally { A.close(); }
});

test('合言葉は画面では伏せ字。「表示」で見える。旧データのエクスポートには入らない', async () => {
  const clock = createClock();
  const A = await openApp({ clock, state: { projects: [{ id: 'e', name: 'e', status: 'open' }], settings: { gasKey: 'export-secret-012345', gasUrl: '' } } });
  try {
    A.run('switchTab("settings")');
    let blob = null;
    A.win.URL.createObjectURL = b => { blob = b; return 'blob:test'; };
    A.win.URL.revokeObjectURL = () => {};
    A.win.HTMLAnchorElement.prototype.click = function () {};
    A.doc.querySelector('#btnExport').click();
    await A.settle();
    const txt = await blob.text();
    assert.ok(!txt.includes('export-secret-012345'));
    assert.equal(A.doc.querySelector('#gasKey').type, 'password', '画面では伏せ字');
    A.doc.querySelector('#gasKeyToggle').click();
    assert.equal(A.doc.querySelector('#gasKey').type, 'text');
  } finally { A.close(); }
});
