'use strict';
/* 合言葉 (API_SECRET) — サーバー (gas/Code.gs) */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas, project } = require('./helpers/gas');
const { createClock } = require('./helpers/clock');

const SECRET = 'test-secret-ABCDEFG-123';
const CONTENT_KEYS = ['count', 'projects', 'deleted', 'pm', 'locked', 'macro', 'health', 'llama', 'snap', 'series', 'md'];
const GET_ACTIONS = [undefined, 'load', 'report', 'macro', 'hl', 'llama', 'llamaFees', 'health', 'compare'];

function withData(opts) {
  const clock = createClock('2026-11-02T10:00:00+09:00');
  const gas = loadGas({ clock });
  gas.setLegacy([project(clock, { id: 's1', name: '秘密の案件', pinned: true })], { gone: clock.iso() });
  gas.props.setProperty('MAIL_TO', 'me@example.com');
  gas.props.setProperty('GEMINI_KEY', 'AIza-secret-gemini');
  if (!opts || opts.secret !== false) gas.props.setProperty('API_SECRET', SECRET);
  return { clock, gas };
}

/** 合言葉が違う時の応答: 版数だけで、中身は1つも入っていない */
function assertLocked(r, label) {
  assert.equal(r.ok, false, label);
  assert.equal(r.needKey, true, label);
  assert.match(r.error, /合言葉が違います/, label);
  for (const k of CONTENT_KEYS) assert.equal(r[k], undefined, `${label}: ${k} を返さない`);
  const raw = JSON.stringify(r);
  assert.ok(!raw.includes('秘密の案件') && !raw.includes('me@example.com') && !raw.includes(SECRET), label);
}

test('合言葉: GET は「なし/違う」だと中身を返さず、版数だけ返す。「正しい」なら中身を返す', () => {
  const { gas } = withData();
  for (const [label, p] of [['なし', {}], ['違う', { key: 'wrong-key-0000000' }], ['空', { key: '' }], ['前方一致', { key: SECRET.slice(0, -1) }], ['後ろに余分', { key: SECRET + 'x' }]]) {
    for (const action of GET_ACTIONS) {
      const r = gas.get(Object.assign({}, p, action ? { action } : {}));
      assertLocked(r, `${label} action=${action}`);
      assert.equal(r.version, gas.C.GAS_VERSION, '自動公開の確認用に版数は返す');
    }
  }
  const st = gas.get({ key: SECRET });
  assert.equal(st.ok, true);
  assert.equal(st.locked, true, '合言葉を設定済みであることは分かる');
  assert.ok(st.pm, '記録の状況を返す');
  const raw = JSON.stringify(st);
  assert.ok(!raw.includes(SECRET), '合言葉そのものは返さない');
  assert.ok(!raw.includes('AIza-secret-gemini'), 'Gemini のキーは返さない');
  const ld = gas.get({ key: SECRET, action: 'load' });
  assert.deepEqual(ld.projects.map(p => p.id), ['s1']);
});

test('合言葉: POST は「なし/違う」だと設定を変えられない。「正しい」なら変えられる', () => {
  const { gas } = withData();
  const attempts = [
    { action: 'pmConfig', mailTo: 'evil@example.com', geminiKey: 'evil' },
    { action: 'pmWatch', ids: ['1'] },
    { action: 'pmHlWatch', coins: ['DOGE'] },
    { action: 'pmMailTest' },
    { action: 'setSecret', newKey: 'attacker-key-123456' },
    { all: [], force: true },
  ];
  for (const body of attempts) {
    for (const [label, key] of [['なし', undefined], ['違う', 'wrong-key-0000000']]) {
      const b = Object.assign({}, body, key !== undefined ? { key } : {});
      assertLocked(gas.post(b), `${label} ${body.action || '保存'}`);
      assertLocked(gas.postForm(b), `${label} ${body.action || '保存'} (フォーム送信)`);
    }
  }
  assert.equal(gas.props.getProperty('MAIL_TO'), 'me@example.com');
  assert.equal(gas.props.getProperty('GEMINI_KEY'), 'AIza-secret-gemini');
  assert.equal(gas.props.getProperty('API_SECRET'), SECRET, '合言葉は乗っ取られない');
  assert.equal(gas.mails.length, 0, 'テスト送信もされない');

  // 正しい合言葉 (JSON の key / フォーム送信) なら変えられる
  assert.equal(gas.post({ key: SECRET, action: 'pmConfig', mailTo: 'new@example.com' }).ok, true);
  assert.equal(gas.props.getProperty('MAIL_TO'), 'new@example.com');
  assert.equal(gas.postForm({ key: SECRET, action: 'pmConfig', mailTo: 'form@example.com' }).ok, true);
  assert.equal(gas.props.getProperty('MAIL_TO'), 'form@example.com');
});

test('合言葉が未設定の間は、合言葉なしで使える (key を付けても動く)', () => {
  const { gas } = withData({ secret: false });
  const st = gas.get();
  assert.equal(st.ok, true);
  assert.equal(st.locked, false);
  assert.equal(gas.get({ key: 'anything-0000000' }).ok, true, 'アプリが合言葉を付けて送っても動く');
  assert.equal(gas.post({ action: 'pmConfig', mailTo: 'a@example.com' }).ok, true);
  assert.equal(gas.post({ key: 'x', action: 'pmConfig', mailTo: 'b@example.com' }).ok, true);
  assert.equal(gas.props.getProperty('MAIL_TO'), 'b@example.com');
});

test('合言葉の設定・変更の流れ: 未設定なら合言葉なしで設定、設定済みなら今の合言葉が必要', () => {
  const { gas } = withData({ secret: false });
  // 短すぎる合言葉は受け付けない
  let r = gas.post({ action: 'setSecret', newKey: 'short' });
  assert.equal(r.ok, false);
  assert.match(r.error, /12〜200文字/);
  assert.equal(gas.props.getProperty('API_SECRET'), null);
  // 未設定 → 設定 (前後の空白は除く)
  r = gas.post({ action: 'setSecret', newKey: '  first-secret-0001  ' });
  assert.deepEqual(r, { ok: true, secretSet: true });
  assert.equal(gas.props.getProperty('API_SECRET'), 'first-secret-0001');
  assert.equal(gas.get().ok, false, '設定した直後から合言葉が必要');
  // 設定済み: 合言葉なし・違う合言葉では変えられない
  assertLocked(gas.post({ action: 'setSecret', newKey: 'second-secret-0002' }), 'なし');
  assertLocked(gas.post({ action: 'setSecret', key: 'wrong-secret-0000', newKey: 'second-secret-0002' }), '違う');
  assert.equal(gas.props.getProperty('API_SECRET'), 'first-secret-0001');
  // 今の合言葉があれば変えられる
  r = gas.post({ action: 'setSecret', key: 'first-secret-0001', newKey: 'second-secret-0002' });
  assert.equal(r.secretSet, true);
  assertLocked(gas.get({ key: 'first-secret-0001' }), '古い合言葉はもう使えない');
  assert.equal(gas.get({ key: 'second-secret-0002' }).ok, true);
  // 設定済みでも短い合言葉には変えられない
  r = gas.post({ action: 'setSecret', key: 'second-secret-0002', newKey: '' });
  assert.equal(r.ok, false);
  assert.equal(gas.props.getProperty('API_SECRET'), 'second-secret-0002');
});

test('合言葉を設定した後も、トリガーで動く記録 (pmRecord など) は合言葉なしで動く', () => {
  const clock = createClock('2026-11-02T10:00:00+09:00');
  const gas = loadGas({ clock, fetch: () => ({ getContentText: () => '[]', getResponseCode: () => 200 }) });
  gas.props.setProperty('API_SECRET', SECRET);
  gas.ctx.pmRecord();
  assert.ok(gas.props.getProperty('HB_record') || gas.props.getProperty('HBE_record'), '記録の処理が動いた跡が残る');
});

test('自動公開の確認: 合言葉なしの問い合わせでも、公開中の版数が分かる (deploy-gas.yml と同じ読み方)', () => {
  const { gas } = withData();
  const body = gas.ctx.doGet({ parameter: {} }).getContent();
  // deploy-gas.yml の node -e と同じ処理
  const d = JSON.parse(body);
  assert.equal(String(d.version || ''), gas.C.GAS_VERSION);
  // 問い合わせに使う URL に合言葉を付けていない
  const y = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '.github', 'workflows', 'deploy-gas.yml'), 'utf8');
  assert.match(y, /macros\/s\/\$\{GAS_DEPLOYMENT_ID\}\/exec"/);
});
