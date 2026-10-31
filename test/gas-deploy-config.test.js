'use strict';
/* Apps Script への自動公開 (clasp) の設定ファイルを確かめる */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

test('gas/appsscript.json: 日本時間・V8・ウェブアプリは「自分として実行・全員がアクセス可」', () => {
  const m = JSON.parse(read('gas/appsscript.json'));
  assert.equal(m.timeZone, 'Asia/Tokyo');
  assert.equal(m.runtimeVersion, 'V8', 'Code.gs は const/let を使うので V8 が必要');
  assert.deepEqual(m.webapp, { executeAs: 'USER_DEPLOYING', access: 'ANYONE_ANONYMOUS' });
});

test('gas/.clasp.json: スクリプトIDだけを持ち、秘密情報を含まない', () => {
  const c = JSON.parse(read('gas/.clasp.json'));
  assert.equal(c.scriptId, '1jIJtHu-JHx0MD9WPtekTtz0402mcDQz5GpOKndoicF3KVlmlZo9FPcAP');
  assert.deepEqual(Object.keys(c).sort(), ['rootDir', 'scriptId']);
});

test('gas/.claspignore: 送るのは Code.gs と appsscript.json だけ', () => {
  const lines = read('gas/.claspignore').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  assert.deepEqual(lines, ['**/**', '!Code.gs', '!appsscript.json']);
});

test('認証情報 (.clasprc.json) はリポジトリに入れない', () => {
  assert.ok(read('.gitignore').split('\n').includes('.clasprc.json'));
  for (const f of ['.clasprc.json', 'gas/.clasprc.json']) assert.ok(!fs.existsSync(path.join(root, f)), f);
});

test('deploy-gas.yml: main の gas/ の変更で、テスト後に push → 既存デプロイを更新する', () => {
  const y = read('.github/workflows/deploy-gas.yml');
  assert.match(y, /branches: \[main\]/);
  assert.match(y, /- 'gas\/\*\*'/);
  assert.doesNotMatch(y, /pull_request/, 'PR (他人のフォーク) からは実行しない');
  assert.match(y, /needs: test/);
  assert.match(y, /run: npm test/);
  assert.match(y, /clasp push --force/);
  assert.match(y, /clasp deploy -i "\$GAS_DEPLOYMENT_ID"/, '新しいデプロイを作らず、既存のデプロイIDを更新する');
  assert.match(y, /\$\{\{ secrets\.CLASPRC_JSON \}\}/);
  assert.match(y, /\$\{\{ secrets\.GAS_DEPLOYMENT_ID \}\}/);
  assert.doesNotMatch(y, /AKfyc[\w-]{20,}/, 'デプロイIDを直接書かない');
  assert.doesNotMatch(y, /refresh_token|ya29\./, 'トークンを直接書かない');
});

test('公開後の確認で使う版数を Code.gs から読める', () => {
  const m = read('gas/Code.gs').match(/^const GAS_VERSION = '(.*)';/m);
  assert.ok(m);
  assert.match(m[1], /^\d{4}\.\d{2}\.\d{2}$/);
});
