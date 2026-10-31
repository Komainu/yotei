'use strict';
/* 合言葉 (API_SECRET) — サーバー (gas/Code.gs) */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas, project } = require('./helpers/gas');
const { createClock, jstLocal } = require('./helpers/clock');

const SECRET = 'test-secret-ABCDEFG-123';
const CONTENT_KEYS = ['count', 'pinned', 'syncedAt', 'mailTo', 'telegram', 'pendingChats', 'tgChats', 'inbox', 'game', 'projects', 'deleted', 'hist', 'qhist', 'histSince', 'tgLastSend', 'alertLastOk'];

function withData(opts) {
  const clock = createClock('2026-11-02T10:00:00+09:00');
  const gas = loadGas({ clock });
  gas.enableTelegram(['111']);
  gas.post({ all: [project(clock, { id: 's1', name: '秘密の案件', pinned: true, deadline: jstLocal(clock, 1) })], deleted: { gone: clock.iso() }, syncedAt: clock.iso(), email: 'me@example.com' });
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

test('合言葉: GET は「なし/違う」だと中身を返さず、版数だけ返す。「正しい」なら今まで通り', () => {
  const { gas } = withData();
  for (const [label, p] of [['なし', {}], ['違う', { key: 'wrong-key-0000000' }], ['空', { key: '' }], ['前方一致', { key: SECRET.slice(0, -1) }], ['後ろに余分', { key: SECRET + 'x' }]]) {
    for (const action of [undefined, 'load', 'history']) {
      const r = gas.get(Object.assign({}, p, action ? { action } : {}));
      assertLocked(r, `${label} action=${action}`);
      assert.equal(r.version, gas.C.GAS_VERSION, '自動公開の確認用に版数は返す');
    }
  }
  const st = gas.get({ key: SECRET });
  assert.equal(st.ok, true);
  assert.equal(st.count, 1);
  assert.equal(st.locked, true, '合言葉を設定済みであることは分かる');
  assert.ok(!JSON.stringify(st).includes(SECRET), '合言葉そのものは返さない');
  const ld = gas.get({ key: SECRET, action: 'load' });
  assert.deepEqual(ld.projects.map(p => p.id), ['s1']);
  const hs = gas.get({ key: SECRET, action: 'history' });
  assert.ok(Array.isArray(hs.hist) && hs.hist.length >= 1);
});

test('合言葉: POST は「なし/違う」だと保存・設定・受信箱の操作ができない。「正しい」なら今まで通り', () => {
  const { clock, gas } = withData();
  const before = JSON.stringify(gas.projects());
  const tokenBefore = gas.props.getProperty('TG_TOKEN');
  gas.ctx.logInbox_({ type: 'add', id: 's1', name: '秘密の案件' });
  const inboxBefore = gas.ctx.getInbox_().length;
  clock.tick(60000);
  const attempts = [
    { all: [project(clock, { id: 'evil', name: '書きかえ' })], deleted: { s1: clock.iso() }, syncedAt: clock.iso() },
    { all: [], force: true },
    { action: 'config', tgToken: 'evil-token', tgChat: '999', geminiKey: 'evil' },
    { action: 'config', clear: true, tgToken: '', tgChat: '' },
    { action: 'inboxClear', before: clock.iso() },
    { action: 'setSecret', newKey: 'attacker-key-123456' },
  ];
  for (const body of attempts) {
    for (const [label, key] of [['なし', undefined], ['違う', 'wrong-key-0000000']]) {
      const b = Object.assign({}, body, key !== undefined ? { key } : {});
      assertLocked(gas.post(b), `${label} ${body.action || '保存'}`);
      assertLocked(gas.postForm(b), `${label} ${body.action || '保存'} (フォーム送信)`);
    }
  }
  assert.equal(JSON.stringify(gas.projects()), before, '案件はそのまま');
  assert.equal(gas.props.getProperty('TG_TOKEN'), tokenBefore);
  assert.equal(gas.props.getProperty('TG_CHAT'), '111');
  assert.equal(gas.props.getProperty('API_SECRET'), SECRET, '合言葉は乗っ取られない');
  assert.equal(gas.ctx.getInbox_().length, inboxBefore, '受信箱も消されない');
  assert.ok(inboxBefore > 0);

  // 正しい合言葉 (JSON の key / フォーム送信) なら保存できる
  clock.tick(60000);
  const p2 = project(clock, { id: 's2', name: '追加' });
  let r = gas.post({ key: SECRET, all: gas.projects().concat([p2]), deleted: {}, syncedAt: clock.iso() });
  assert.equal(r.ok, true);
  assert.deepEqual(r.projects.map(p => p.id).sort(), ['s1', 's2']);
  clock.tick(60000);
  r = gas.postForm({ key: SECRET, all: r.projects, deleted: { s2: clock.iso() }, syncedAt: clock.iso() });
  assert.equal(r.ok, true);
  assert.deepEqual(gas.projects().map(p => p.id), ['s1']);
  // 合言葉は保存データに残らない
  assert.ok(!JSON.stringify(gas.projects()).includes(SECRET));
  assert.ok(!JSON.stringify(gas.hist()).includes(SECRET));
});

test('合言葉が未設定の間は今まで通り (合言葉なしで読み書きでき、key を付けても動く)', () => {
  const { clock, gas } = withData({ secret: false });
  const st = gas.get();
  assert.equal(st.ok, true);
  assert.equal(st.count, 1);
  assert.equal(st.locked, false);
  assert.equal(gas.get({ key: 'anything-0000000' }).ok, true, '新しいアプリが合言葉を付けて送っても動く');
  clock.tick(60000);
  assert.equal(gas.post({ all: gas.projects(), deleted: {}, syncedAt: clock.iso() }).ok, true);
  assert.equal(gas.post({ key: 'x', all: gas.projects(), deleted: {}, syncedAt: clock.iso() }).ok, true);
  assert.equal(gas.post({ action: 'config', tgChat: '222' }).ok, true);
  assert.equal(gas.props.getProperty('TG_CHAT'), '111,222');
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

test('合言葉を設定した後も、Telegram・毎朝のクエスト・夜のお知らせ・毎朝のメールは動く', () => {
  const { clock, gas } = withData();
  // Telegram: 受信・コマンド・登録
  gas.tg.pushMessage('111', '/list');
  gas.tg.pushMessage('111', '新しい案件をTelegramから');
  gas.ctx.pollTelegram();
  assert.ok(gas.tg.texts('111').some(t => /未完了の案件/.test(t) && /秘密の案件/.test(t)));
  assert.ok(gas.tg.texts('111').some(t => /1件を登録しました/.test(t)));
  // 朝9時のクエストとボタン
  clock.set('2026-11-03T09:01');
  gas.ctx.pollTelegram();
  assert.ok(gas.tg.texts('111').some(t => /今日のクエスト/.test(t)));
  gas.tg.pushButton('111', 'q:d:s1');
  gas.ctx.pollTelegram();
  assert.equal(gas.projects().find(p => p.id === 's1').status, 'done');
  assert.ok(gas.game().xp > 0);
  // 夜20時のお知らせ
  clock.set('2026-11-04T20:00');
  gas.ctx.pollTelegram();
  assert.ok(gas.tg.texts('111').some(t => /途切れそう/.test(t)));
  // 毎朝のメール
  gas.setProjects([project(clock, { id: 'm1', name: 'メールの案件', pinned: true })]);
  gas.ctx.sendDailyMail();
  assert.equal(gas.mails.length, 1);
  assert.equal(gas.mails[0].to, 'me@example.com');
  assert.match(gas.mails[0].htmlBody, /メールの案件/);
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
