'use strict';
/*
 * gas/appsscript.json の oauthScopes (権限) が、Code.gs で使っている Google のサービスとぴったり合っているか。
 * oauthScopes を書くと自動の判定は行われないので、1つでも足りないと、そのサービスを呼んだところで
 * 「〜を呼び出す権限がありません」で止まる。新しいサービスを使う時は下の表と appsscript.json の両方に足すこと。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const code = fs.readFileSync(path.join(root, 'gas', 'Code.gs'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');   // コメントの中の名前は数えない
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'gas', 'appsscript.json'), 'utf8'));

const S = 'https://www.googleapis.com/auth/';
/** Apps Script のサービス → 必要な権限 (null は権限不要)。stops: 足りない時に止まるもの */
const SERVICES = {
  DriveApp:          { scope: S + 'drive', stops: 'データの保存・読み込み (同期・Telegram・ゲーム・記録のすべて)、週ごとのバックアップ' },
  UrlFetchApp:       { scope: S + 'script.external_request', stops: 'Telegram の受信と返信、毎朝のクエスト、Gemini での案件化' },
  MailApp:           { scope: S + 'script.send_mail', stops: '毎朝8時のメール' },
  ScriptApp:         { scope: S + 'script.scriptapp', stops: 'setup() のトリガー登録 (毎朝のメール・Telegram確認・バックアップ)' },
  GmailApp:          { scope: S + 'gmail.modify', stops: '(未使用)' },
  SpreadsheetApp:    { scope: S + 'spreadsheets', stops: '(未使用)' },
  DocumentApp:       { scope: S + 'documents', stops: '(未使用)' },
  CalendarApp:       { scope: S + 'calendar', stops: '(未使用)' },
  FormApp:           { scope: S + 'forms', stops: '(未使用)' },
  Session:           { scope: S + 'userinfo.email', stops: '(未使用)' },
  PropertiesService: { scope: null }, LockService: { scope: null }, CacheService: { scope: null },
  ContentService: { scope: null }, HtmlService: { scope: null }, Utilities: { scope: null },
  Logger: { scope: null }, console: { scope: null }, MimeType: { scope: null },
};
const used = name => new RegExp('\\b' + name + '\\s*\\.').test(code);

test('appsscript.json: oauthScopes を明示している (自動判定に頼らない)', () => {
  assert.ok(Array.isArray(manifest.oauthScopes) && manifest.oauthScopes.length > 0);
  assert.equal(new Set(manifest.oauthScopes).size, manifest.oauthScopes.length, '重複なし');
});

test('Code.gs で使っているサービスに必要な権限が、すべて oauthScopes に入っている', () => {
  const missing = [];
  for (const [name, s] of Object.entries(SERVICES)) {
    if (s.scope && used(name) && !manifest.oauthScopes.includes(s.scope)) missing.push(`${name} → ${s.scope} (止まるもの: ${s.stops})`);
  }
  assert.deepEqual(missing, [], '足りない権限');
  // 少なくともこの4つは必要 (今の Code.gs が使っている)
  for (const n of ['DriveApp', 'UrlFetchApp', 'MailApp', 'ScriptApp']) {
    assert.ok(used(n), n + ' を使っている');
    assert.ok(manifest.oauthScopes.includes(SERVICES[n].scope), n);
  }
});

test('oauthScopes に、使っていないサービスの権限が入っていない (許可画面で余計なことを聞かない)', () => {
  const needed = new Set(Object.entries(SERVICES).filter(([n, s]) => s.scope && used(n)).map(([, s]) => s.scope));
  const extra = manifest.oauthScopes.filter(s => !needed.has(s));
  assert.deepEqual(extra, []);
});

test('Code.gs が、上の表に無い Google のサービスを使っていない (使う時は表と oauthScopes に足す)', () => {
  // 「〜App」「〜Service」で終わる名前と、よく使うサービス名を拾う
  const found = new Set(code.match(/\b[A-Z][A-Za-z]*(App|Service)\b(?=\s*\.)/g) || []);
  for (const n of ['Session', 'Drive', 'Gmail', 'Calendar', 'Sheets', 'People', 'YouTube', 'Tasks', 'AdminDirectory', 'Maps', 'Browser', 'Jdbc', 'XmlService', 'Charts']) {
    if (new RegExp('\\b' + n + '\\s*\\.').test(code)) found.add(n);
  }
  const unknown = [...found].filter(n => !(n in SERVICES));
  assert.deepEqual(unknown, [], '表に無いサービス');
});

test('テスト用の偽物 (test/helpers/gas.js) が、権限の要るサービスを全部用意している', () => {
  const helper = fs.readFileSync(path.join(root, 'test', 'helpers', 'gas.js'), 'utf8');
  for (const [n, s] of Object.entries(SERVICES)) {
    if (s.scope && used(n)) assert.match(helper, new RegExp('\\b' + n + '\\b'), n);
  }
});
