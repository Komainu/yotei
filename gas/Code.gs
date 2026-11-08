/**
 * 予定管理 — クラウド同期 / Telegram登録 / 毎日のメール通知
 * ------------------------------------------------------------------
 * ・複数のPC/スマホから同じ案件データを共有
 * ・Telegramに情報を送るだけで案件を自動登録 (AIが構造化)
 * ・ピン留めした案件を毎朝メールで通知 (PCを閉じていてもOK)
 *
 * ■ セットアップ / 更新手順
 *  1. https://script.google.com のプロジェクトを開く
 *  2. コードを全選択(Ctrl+A)して削除し、このファイルの内容を貼り付け → Ctrl+S で保存
 *  3. 関数「setup」を選び ▶ 実行 (初回は権限の許可が必要)
 *  4. 「デプロイ」→「デプロイを管理」→ 鉛筆✏ → バージョン「新バージョン」→「デプロイ」
 *     ※「新しいデプロイ」ではなく「デプロイを管理」から更新すること (URLが変わらないため)
 *  5. アプリの設定で「📲 Telegram登録を有効化」を押す
 *
 * ■ Telegramの使い方 (有効化後)
 *     ・Botに文章やURLを送る/転送する → AIが解析して案件を自動登録
 *     ・/alert  今日のクエスト (毎朝9時にも自動で届く。ボタンで完了・XP獲得)
 *     ・/list   未完了の一覧
 *     ・/today  期限が近い案件
 *     ・/done 3 一覧の3番を完了にする
 *     ・/help   ヘルプ
 */

/** メール通知の時刻 (0-23, 日本時間) */
const SEND_HOUR = 8;

/** Telegram期限アラートの時刻 (0-23, 日本時間) */
const ALERT_HOUR = 9;

/** 週ごとのバックアップの時刻 (日曜日の 0-23時, 日本時間) */
const BACKUP_HOUR = 2;

/** 期限が何日以内なら「緊急」として強調するか */
const URGENT_DAYS = 7;

/** Telegramを何分おきに確認するか (1, 5, 10, 15, 30 のいずれか) */
const POLL_MINUTES = 1;   // ボタンの反応を早くするため1分おき

/** このスクリプトの版数 (アプリ側で古いかどうか判定するのに使う) */
const GAS_VERSION = '2026.11.23';

// =====================================================================
//  合言葉 (API_SECRET) — URLを知っているだけではデータを読み書きできないようにする
//  ・未設定の間は今まで通り誰でも使える (移行期間のため)
//  ・設定後は、GET の key / POST の JSON の key が一致した時だけ中身を返す
//  ・Telegram・毎朝のメール・トリガーは doGet/doPost を通らないので影響しない
// =====================================================================

const SECRET_MIN = 12;

function apiSecret_() {
  return PropertiesService.getScriptProperties().getProperty('API_SECRET') || '';
}

/** 合言葉が一致するか (未設定なら常に true)。比べる時間で中身が推測されないよう全文字を比べる */
function authOk_(key) {
  const secret = apiSecret_();
  if (!secret) return true;
  const k = String(key == null ? '' : key);
  let diff = k.length ^ secret.length;
  for (let i = 0; i < secret.length; i++) diff |= secret.charCodeAt(i) ^ (k.charCodeAt(i) || 0);
  return diff === 0;
}

/** 合言葉が違う時の応答。件数や案件は返さない (自動公開の確認用に版数だけ返す) */
function authError_() {
  return json({
    ok: false, needKey: true, version: GAS_VERSION,
    error: '合言葉が違います。アプリの設定「☁️ クラウド同期」に合言葉を入れてください',
  });
}

// =====================================================================
//  受信箱 — Telegramで行った変更を記録し、Web版AIへの引き継ぎに使う
//  (Web版AIが台帳の本体なので、Telegram側の変更をそちらへ戻す必要がある)
// =====================================================================

function getInbox_() {
  const raw = loadBlob_('INBOX');   // 読めない時は例外 (空とみなさない)
  try { return JSON.parse(raw || '[]'); } catch (e) { return []; }
}

function logInbox_(entry) {
  const list = getInbox_();
  entry.at = new Date().toISOString();
  list.push(entry);
  saveBlob_('INBOX', JSON.stringify(list.slice(-100)));
}

// =====================================================================
//  データの保存 / 読み出し
//  大きなデータ (ALL / DELETED / HIST / INBOX / GAME) は Google ドライブの
//  「予定管理データ」フォルダに JSON ファイルとして保存する (Script Properties の合計500KB上限を避ける)。
//  ・移行前 (STORE が 'drive' でない間) は、今まで通り Script Properties に8000文字ずつ分割して保存
//  ・移行は migrateToDrive_() が1回だけ行う (setup() から / pollTelegram が30分に1回まで試す)
//  ・小さな設定値 (TG_TOKEN 等) は Script Properties のまま
// =====================================================================

const DATA_KEYS = ['ALL', 'DELETED', 'HIST', 'INBOX', 'GAME'];
const DATA_FOLDER_NAME = '予定管理データ';
const BACKUP_FOLDER_NAME = '予定管理バックアップ';
const BACKUP_KEEP = 12;   // 週ごとのバックアップを何個残すか

/** 1回の実行の中だけで使う読み出しキャッシュ (ドライブを何度も読まないため) */
let BLOB_CACHE_ = {};
/** ロックを取った直後に呼ぶ: 待っている間に別の実行が書いた内容を読み直すため */
function blobCacheClear_() { BLOB_CACHE_ = {}; }

function useDrive_() {
  return PropertiesService.getScriptProperties().getProperty('STORE') === 'drive';
}

function saveBlob_(key, str) {
  str = String(str);
  if (useDrive_()) driveWrite_(key, str);
  else savePropBlob_(key, str);
  BLOB_CACHE_[key] = str;
}

function loadBlob_(key) {
  if (Object.prototype.hasOwnProperty.call(BLOB_CACHE_, key)) return BLOB_CACHE_[key];
  const v = useDrive_() ? driveRead_(key) : loadPropBlob_(key);
  BLOB_CACHE_[key] = v;
  return v;
}

/** 移行前の保存先: Script Properties に分割保存 (1件あたり9KB制限を回避) */
function savePropBlob_(key, str) {
  const props = PropertiesService.getScriptProperties();
  const CHUNK = 8000;
  const n = Math.ceil(str.length / CHUNK) || 1;
  const old = Number(props.getProperty(key + '_N') || 0);
  for (let i = 0; i < n; i++) props.setProperty(key + '_' + i, str.substr(i * CHUNK, CHUNK));
  for (let j = n; j < old; j++) props.deleteProperty(key + '_' + j);
  props.setProperty(key + '_N', String(n));
}

function loadPropBlob_(key) {
  const props = PropertiesService.getScriptProperties();
  const n = Number(props.getProperty(key + '_N') || 0);
  let out = '';
  for (let i = 0; i < n; i++) out += (props.getProperty(key + '_' + i) || '');
  return out;
}

/** 古いチャンクを消す。上限に当たって途中まで書かれた余分なチャンク (key_N より後ろ) も消す */
function deletePropBlob_(key) {
  const props = PropertiesService.getScriptProperties();
  const re = new RegExp('^' + key + '_(\\d+|N)$');
  props.getKeys().forEach(function (k) { if (re.test(k)) props.deleteProperty(k); });
}

/** ドライブの操作は一時的に失敗することがあるので、少し待って3回まで試す */
function driveRetry_(fn) {
  let err;
  for (let i = 0; i < 3; i++) {
    try { return fn(); } catch (e) { err = e; Utilities.sleep(500 * (i + 1)); }
  }
  throw err;
}

/** フォルダを1つ用意する (IDは Script Properties に控える。消されていたら作り直す) */
function driveFolder_(propKey, name) {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(propKey);
  if (id) {
    try { const f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) {}
  }
  const f = DriveApp.createFolder(name);
  props.setProperty(propKey, f.getId());
  return f;
}

/**
 * key のファイル (まだ作っていない・ゴミ箱に入っている時は null)。
 * 開けない時は、読む時 (forWrite=false) は例外にする (空のデータと取り違えないため)。書く時は作り直す
 */
function driveFile_(key, forWrite) {
  const id = PropertiesService.getScriptProperties().getProperty('FILE_' + key);
  if (!id) return null;
  let f;
  try { f = DriveApp.getFileById(id); }
  catch (e) { if (forWrite) return null; throw e; }
  return f.isTrashed() ? null : f;
}

function driveRead_(key) {
  return driveRetry_(function () {
    const f = driveFile_(key);
    return f ? f.getBlob().getDataAsString('UTF-8') : '';
  });
}

function driveWrite_(key, str) {
  driveRetry_(function () {
    const f = driveFile_(key, true);
    if (f) { f.setContent(str); return; }
    const nf = driveFolder_('DATA_FOLDER_ID', DATA_FOLDER_NAME).createFile(key + '.json', str, MimeType.PLAIN_TEXT);
    PropertiesService.getScriptProperties().setProperty('FILE_' + key, nf.getId());
  });
}

/**
 * Script Properties → ドライブへの移行 (1回だけ)。
 * ① ドライブへ書く → ② 読み直して一致を確認 → ③ STORE='drive' に切り替え → ④ 古いチャンクを削除。
 * ③より前で失敗した時は Script Properties の元データには一切触れていないので、そのまま今まで通り動く。
 * 戻り値: 移行した (または済んでいる) なら true
 */
function migrateToDrive_() {
  const props = PropertiesService.getScriptProperties();
  if (useDrive_()) return true;
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (useDrive_()) return true;
    blobCacheClear_();
    const src = {};
    DATA_KEYS.forEach(function (k) { src[k] = loadPropBlob_(k); });
    DATA_KEYS.forEach(function (k) { if (src[k] || driveFile_(k, true)) driveWrite_(k, src[k]); });
    DATA_KEYS.forEach(function (k) {
      const back = driveRead_(k);
      if (back !== src[k]) throw new Error(k + ' の確認に失敗しました (' + back.length + '/' + src[k].length + '文字)');
    });
    props.setProperty('STORE', 'drive');
    props.setProperty('STORE_AT', new Date().toISOString());
    props.deleteProperty('STORE_ERROR');
    DATA_KEYS.forEach(function (k) { try { deletePropBlob_(k); } catch (e) { Logger.log('古いデータの削除失敗 ' + k + ': ' + e); } });
    blobCacheClear_();
    Logger.log('ドライブへの移行が完了しました');
    return true;
  } catch (e) {
    props.setProperty('STORE_ERROR', new Date().toISOString() + ' ' + String(e).slice(0, 300));
    Logger.log('ドライブへの移行に失敗しました (元のデータはそのままです): ' + e);
    blobCacheClear_();
    return false;
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

/** まだ移行していなければ試す (失敗しても30分は待つ) */
function maybeMigrate_() {
  const props = PropertiesService.getScriptProperties();
  if (useDrive_()) return;
  const last = Date.parse(props.getProperty('STORE_TRIED') || '') || 0;
  if (Date.now() - last < 30 * 60000) return;
  props.setProperty('STORE_TRIED', new Date().toISOString());
  migrateToDrive_();
}

// =====================================================================
//  週ごとのバックアップ — 毎週日曜の深夜に「予定管理バックアップ」フォルダへ
// =====================================================================

/** バックアップの中身 (トークン・APIキー・合言葉は入れない) */
function backupData_() {
  const out = { app: 'yotei', version: GAS_VERSION, at: new Date().toISOString(), data: {} };
  DATA_KEYS.forEach(function (k) {
    const raw = loadBlob_(k);
    let v = null;
    if (raw) { try { v = JSON.parse(raw); } catch (e) { v = raw; } }
    out.data[k] = v;
  });
  const props = PropertiesService.getScriptProperties();
  out.props = {};
  ['MAIL_TO', 'SYNCED_AT', 'HIST_SINCE'].forEach(function (k) { out.props[k] = props.getProperty(k); });
  return out;
}

function weeklyBackup() {
  const name = 'yotei-backup-' + todayJst_() + '.json';
  const body = JSON.stringify(backupData_());
  driveRetry_(function () {
    const folder = driveFolder_('BACKUP_FOLDER_ID', BACKUP_FOLDER_NAME);
    const same = folder.getFilesByName(name);
    if (same.hasNext()) same.next().setContent(body);   // 同じ日にもう一度動いた時は上書き
    else folder.createFile(name, body, MimeType.PLAIN_TEXT);
    // 古いものは BACKUP_KEEP 個だけ残す (名前に日付が入っているので名前順 = 日付順)
    const files = [];
    const it = folder.getFiles();
    while (it.hasNext()) {
      const f = it.next();
      if (/^yotei-backup-\d{4}-\d{2}-\d{2}\.json$/.test(f.getName()) && !f.isTrashed()) files.push(f);
    }
    files.sort(function (a, b) { return a.getName() < b.getName() ? 1 : -1; });
    files.slice(BACKUP_KEEP).forEach(function (f) { f.setTrashed(true); });
  });
  PropertiesService.getScriptProperties().setProperty('BACKUP_LAST', new Date().toISOString());
  Logger.log('バックアップを保存しました: ' + name);
  return name;
}

function getProjects_() {
  const raw = loadBlob_('ALL');
  if (raw) { try { return JSON.parse(raw); } catch (e) {} }
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('PROJECTS') || '[]'); }
  catch (e) { return []; }
}

/** 削除した案件の記録 (id → 削除時刻)。複数端末の合体で「消したのに復活」を防ぐ */
function getTombs_() {
  const raw = loadBlob_('DELETED');
  try { return JSON.parse(raw || '{}') || {}; } catch (e) { return {}; }
}
function unionTombs_(a, b) {
  const out = {}, lim = Date.now() - 90 * 86400000;
  [a || {}, b || {}].forEach(function (t) {
    Object.keys(t).forEach(function (id) {
      const at = String(t[id] || '');
      if (Date.parse(at) > lim && (!out[id] || at > out[id])) out[id] = at;
    });
  });
  return out;
}
/** a を優先側として案件ごとに新しい方を採用する (アプリ側の mergeProjects と同じ規則) */
function mergeProjects_(a, b, tombs, base) {
  const T = tombs || {}, baseT = base ? Date.parse(base) - 60000 : 0;
  const ts = function (p) { return Date.parse(p.updatedAt || p.createdAt || 0) || 0; };
  const bm = {};
  (b || []).forEach(function (p) { if (p && p.id) bm[p.id] = p; });
  const out = [], seen = {};
  (a || []).forEach(function (p) {
    if (!p || !p.id || seen[p.id]) return;
    seen[p.id] = true;
    const q = bm[p.id];
    const w = (q && ts(q) > ts(p)) ? q : p;
    if (T[p.id] && Date.parse(T[p.id]) >= ts(w)) return;
    out.push(w);
  });
  (b || []).forEach(function (q) {
    if (!q || !q.id || seen[q.id]) return;
    seen[q.id] = true;
    if (T[q.id] && Date.parse(T[q.id]) >= ts(q)) return;
    if (!q.updatedAt && baseT && ts(q) <= baseT) return;   // 旧データ: 送信側で削除済み
    out.push(q);
  });
  return out;
}

function putProjects_(list) {
  saveBlob_('ALL', JSON.stringify(list));
  PropertiesService.getScriptProperties().setProperty('SYNCED_AT', new Date().toISOString());
}

function uid_() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* ===== 繰り返しの予定 (この囲みの中は index.html と gas/Code.gs でまったく同じ内容にする) =====
   repeat: { type: "daily" | "weekdays" | "weekly" | "monthly", dow: [0-6] (毎週: 曜日。0=日), dom: 1-31 (毎月: 日付) }
   ・完了すると、同じ内容で次の期限の新しい回を作る。id は「元の案件のid~次の日付」(どこで作っても同じidになり、二重にならない)
   ・元の案件の id を repeatOf に、作った次の回の id を完了した回の repeatNext に持たせる
   ・見送り (dropped) の時は作らない (繰り返しを止める)
   ・同じ繰り返しの未完了の回がすでにある時・次の回を削除した記録がある時も作らない */
const REPEAT_TYPES = { daily: "毎日", weekdays: "平日", weekly: "毎週", monthly: "毎月" };
const REPEAT_DOW = "日月火水木金土";
function ymdParts(ymd) { const m = String(ymd || "").match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? [+m[1], +m[2], +m[3]] : null; }
function ymdFrom(t) { const d = new Date(t); return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0"); }
function ymdAdd(ymd, n) { const p = ymdParts(ymd); return ymdFrom(Date.UTC(p[0], p[1] - 1, p[2] + n)); }
function ymdDow(ymd) { const p = ymdParts(ymd); return new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay(); }
function ymdMonthDay(y, m, dom) { const last = new Date(Date.UTC(y, m, 0)).getUTCDate(); return ymdFrom(Date.UTC(y, m - 1, Math.min(dom, last))); }
/** 形を整えた repeat (正しくなければ null)。base = 曜日・日付を決めていない時に使う日付 */
function repeatNorm(r, base) {
  if (!r || typeof r !== "object" || !REPEAT_TYPES[r.type]) return null;
  const out = { type: r.type };
  if (r.type === "weekly") {
    const dow = (Array.isArray(r.dow) ? r.dow : []).map(Number).filter(function (x) { return x >= 0 && x <= 6 && x === Math.floor(x); });
    out.dow = dow.length ? dow.filter(function (x, i) { return dow.indexOf(x) === i; }).sort() : (base ? [ymdDow(base)] : [1]);
  }
  if (r.type === "monthly") {
    const dom = Math.floor(Number(r.dom));
    out.dom = dom >= 1 && dom <= 31 ? dom : (base ? ymdParts(base)[2] : 1);
  }
  return out;
}
function repeatLabel(r) {
  const n = repeatNorm(r);
  if (!n) return "";
  if (n.type === "weekly") return "毎週 " + n.dow.map(function (d) { return REPEAT_DOW[d]; }).join("・");
  if (n.type === "monthly") return "毎月 " + n.dom + "日";
  return REPEAT_TYPES[n.type];
}
/** after より後で、繰り返しに当てはまる最初の日付 ("YYYY-MM-DD")。毎月で月末より大きい日付は、その月の月末 */
function repeatNextDate(r, after) {
  const n = repeatNorm(r, after);
  if (!n || !ymdParts(after)) return "";
  if (n.type === "daily") return ymdAdd(after, 1);
  if (n.type === "monthly") {
    const p = ymdParts(after);
    const here = ymdMonthDay(p[0], p[1], n.dom);
    if (here > after) return here;
    return p[1] === 12 ? ymdMonthDay(p[0] + 1, 1, n.dom) : ymdMonthDay(p[0], p[1] + 1, n.dom);
  }
  for (let i = 1; i <= 7; i++) {
    const d = ymdAdd(after, i), w = ymdDow(d);
    if (n.type === "weekdays" ? (w >= 1 && w <= 5) : n.dow.indexOf(w) >= 0) return d;
  }
  return "";
}
/** 完了した回 p の次の回 (作れなければ null)。today = 今日 ("YYYY-MM-DD")。期限を過ぎてから完了した時は、今日より後の回にする */
function repeatNextOf(p, today, nowIso) {
  const base = String(p.deadline || "").slice(0, 10);
  const r = repeatNorm(p.repeat, base || today);
  if (!r) return null;
  const from = base && base > today ? base : today;
  const d = repeatNextDate(r, from);
  if (!d) return null;
  const time = String(p.deadline || "").slice(11, 16) || "23:59";
  const root = p.repeatOf || p.id;
  return {
    id: root + "~" + d, name: p.name, chain: p.chain || "", memo: p.memo || "",
    sources: (p.sources || []).map(function (s) { return { url: s.url || "", title: s.title || "" }; }),
    pinned: !!p.pinned, repeat: r, repeatOf: root, status: "open",
    deadline: d + "T" + time, createdAt: nowIso, updatedAt: nowIso,
  };
}
/** list の中で、完了したのにまだ次の回を作っていない繰り返しの予定について、次の回を list に足す。足した回を返す */
function spawnRepeats(list, tombs, today, nowIso) {
  const made = [], T = tombs || {};
  list.slice().forEach(function (p) {
    if (!p || !p.repeat || p.status !== "done" || p.dropped || p.repeatNext) return;
    const n = repeatNextOf(p, today, nowIso);
    if (!n) return;
    p.repeatNext = n.id;
    p.updatedAt = nowIso;
    const openExists = list.some(function (q) { return q && q !== p && q.status !== "done" && (q.repeatOf || q.id) === n.repeatOf; });
    const exists = list.some(function (q) { return q && q.id === n.id; });
    if (openExists || exists || T[n.id]) return;
    list.push(n);
    made.push(n);
  });
  return made;
}
/* ===== 繰り返しの予定 ここまで ===== */

/** サーバー側で次の回を作る (Telegram の完了・同期のたび)。作った回は記録と受信箱にも残す */
function spawnRepeats_(list, src) {
  const made = spawnRepeats(list, getTombs_(), todayJst_(), new Date().toISOString());
  made.forEach(function (n) {
    try { logHist_([histEntry_('add', n, src || 'tg', { rep: 1 })]); } catch (e) {}
    if (src !== 'app') logInbox_({ type: 'add', id: n.id, name: n.name, project: n });
  });
  return made;
}
/** 次の回のお知らせ (Telegram 用) */
function repeatNote_(made) {
  return made.length ? '\n🔁 次の回: ' + fmtDate(made[0].deadline).slice(5) : '';
}

// =====================================================================
//  アプリとの通信
// =====================================================================

function doPost(e) {
  // Polymarket の操作 (和訳など時間のかかるもの) は、予定データのロックを取らずに先に処理する
  try {
    const raw0 = (e && e.parameter && e.parameter.payload) ? e.parameter.payload : (e && e.postData ? e.postData.contents : '{}');
    const d0 = JSON.parse(raw0);
    if (d0 && typeof d0.action === 'string' && /^pm[A-Z]/.test(d0.action)) {
      if (!authOk_(d0.key != null ? d0.key : (e && e.parameter && e.parameter.key))) return authError_();
      return json(pmDoPost_(d0));
    }
  } catch (err) { /* 下の処理で改めてエラーにする */ }
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    blobCacheClear_();
    const raw = (e && e.parameter && e.parameter.payload)
      ? e.parameter.payload
      : (e && e.postData ? e.postData.contents : '{}');
    const data = JSON.parse(raw);
    const props = PropertiesService.getScriptProperties();

    // --- 合言葉の確認 (未設定なら素通り) ---
    if (!authOk_(data.key != null ? data.key : (e && e.parameter && e.parameter.key))) return authError_();

    // --- 合言葉を設定・変更する (未設定の時は誰でも / 設定済みなら今の合言葉が必要: 上で確認済み) ---
    if (data.action === 'setSecret') {
      const nk = String(data.newKey || '').trim();
      if (nk.length < SECRET_MIN || nk.length > 200) {
        return json({ ok: false, error: '合言葉は' + SECRET_MIN + '〜200文字にしてください' });
      }
      props.setProperty('API_SECRET', nk);
      return json({ ok: true, secretSet: true });
    }

    // --- Telegram連携の設定を受け取る ---
    if (data.action === 'config') {
      const split = function (v) { return String(v || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean); };
      // 空の値は「変更しない」。消すのは無効化 (clear) の時だけ
      if (data.tgToken !== undefined && (data.tgToken || data.clear)) props.setProperty('TG_TOKEN', data.tgToken || '');
      if (data.tgChat !== undefined) {
        // 別の端末(別アカウント)の通知先を消さないよう、既存のChat IDに追加する
        let ids = data.clear ? [] : split(props.getProperty('TG_CHAT'));
        split(data.tgChat).forEach(function (x) { if (ids.indexOf(x) < 0) ids.push(x); });
        props.setProperty('TG_CHAT', ids.join(','));
        // 登録済みになったチャットは保留リストから除く
        const now = ids;
        let pend = [];
        try { pend = JSON.parse(props.getProperty('TG_PENDING') || '[]'); } catch (e) {}
        props.setProperty('TG_PENDING', JSON.stringify(pend.filter(function (x) { return now.indexOf(x) < 0; })));
      }
      if (data.geminiKey !== undefined && (data.geminiKey || data.clear)) props.setProperty('GEMINI_KEY', data.geminiKey || '');
      if (data.geminiModel)             props.setProperty('GEMINI_MODEL', data.geminiModel);
      if (data.tgToken) {
        // 取りこぼしを防ぐため、現在の未読位置まで進めておく
        try { pollTelegram(); } catch (err) {}
      }
      return json({ ok: true, configured: !!props.getProperty('TG_TOKEN') });
    }

    // --- 受信箱を空にする (Web版AIへ引き継ぎ済み) ---
    if (data.action === 'inboxClear') {
      const before = data.before || new Date().toISOString();
      const rest = getInbox_().filter(function (x) { return x.at > before; });
      saveBlob_('INBOX', JSON.stringify(rest));
      return json({ ok: true, remaining: rest.length });
    }

    // --- 案件データの保存 ---
    const list = data.all || data.projects || [];
    // 中身のあるデータを空で上書きしない (古い端末や通信失敗による消失を防ぐ)
    const cur = getProjects_();
    if (!list.length && cur.length && !data.force) {
      return json({ ok: false, error: '空データでの上書きを拒否しました (' + cur.length + '件を保護)' });
    }
    let out = list, tombs = null;
    if (data.deleted && typeof data.deleted === 'object') {
      // 新しいアプリ: 案件ごとに新しい方を採用して合体 (他端末やTelegramの変更を消さない)
      tombs = unionTombs_(getTombs_(), data.deleted);
      out = mergeProjects_(list, cur, tombs, data.base);
      saveBlob_('DELETED', JSON.stringify(tombs));
      // 繰り返しの予定: 古いアプリなどで完了だけ届いた時も、次の回を作る (新しいアプリは作り済みなので何もしない)
      try { spawnRepeats(out, tombs, todayJst_(), new Date().toISOString()); } catch (e) { Logger.log('繰り返しの処理に失敗: ' + e); }
    }
    saveBlob_('ALL', JSON.stringify(out));
    try { awardTransitions_(cur, out); } catch (e) { Logger.log('XP計算失敗: ' + e); }
    try { diffHist_(cur, out); } catch (e) { Logger.log('記録失敗: ' + e); }
    props.setProperty('SYNCED_AT', data.syncedAt || new Date().toISOString());
    if (data.email) props.setProperty('MAIL_TO', data.email);

    let game = null;
    try { game = gameSummary_(); } catch (e) {}
    return json({ ok: true, count: out.length, projects: out, deleted: tombs || getTombs_(), game: game });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

function doGet(e) {
  if (!authOk_(e && e.parameter ? e.parameter.key : '')) return authError_();
  try { return doGetInner_(e); }
  catch (err) { return json({ ok: false, version: GAS_VERSION, error: String(err) }); }   // ドライブが読めない時など
}

function doGetInner_(e) {
  if (e && e.parameter && e.parameter.action === 'report') {
    return json(Object.assign({ version: GAS_VERSION }, pmReport_({ days: e.parameter.days, parts: String(e.parameter.parts || '').split(',').filter(Boolean) })));
  }
  if (e && e.parameter && e.parameter.action === 'macro') {
    return json({ ok: true, version: GAS_VERSION, macro: macroData_(e.parameter.force === '1') });
  }
  const props = PropertiesService.getScriptProperties();
  const list = getProjects_();
  const base = {
    ok: true,
    count: list.length,
    pinned: list.filter(function (p) { return p && p.pinned && p.status !== 'done'; }).length,
    syncedAt: props.getProperty('SYNCED_AT') || null,
    mailTo: props.getProperty('MAIL_TO') || null,
    telegram: !!props.getProperty('TG_TOKEN'),   // キー自体は返しません
    pendingChats: (function () {
      try { return JSON.parse(props.getProperty('TG_PENDING') || '[]'); } catch (e) { return []; }
    })(),
  };
  base.version = GAS_VERSION;
  base.locked = !!apiSecret_();
  base.store = useDrive_() ? 'drive' : 'props';   // データの保存先
  base.backupLast = props.getProperty('BACKUP_LAST') || null;   // 合言葉を設定済みか (合言葉そのものは返さない)
  base.tgChats = tgChats_().length;
  base.alertLastOk = props.getProperty('ALERT_LAST_OK') || null;
  try { base.tgLastSend = JSON.parse(props.getProperty('TG_LAST_SEND') || 'null'); } catch (e) { base.tgLastSend = null; }
  base.inbox = getInbox_();
  try { base.game = gameSummary_(); } catch (e) { base.game = null; }
  base.pm = pmStatus_();   // Polymarket の記録の状況
  base.pm.ai = pmAiStatus_();
  try { base.pm.mail = pmMailStatus_(); } catch (e) { base.pm.mail = null; }
  if (e && e.parameter && e.parameter.action === 'load') { base.projects = list; base.deleted = getTombs_(); }
  if (e && e.parameter && e.parameter.action === 'history') {
    base.hist = getHist_();
    const g = getGame_();
    base.qhist = g.qhist || [];
    base.histSince = props.getProperty('HIST_SINCE') || null;
  }
  return json(base);
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// =====================================================================
//  初期設定 — この関数を1回だけ実行してください
// =====================================================================

function setup() {
  // ① 大きなデータをドライブへ移す (初回だけ。失敗しても元のデータはそのまま)
  const moved = migrateToDrive_();
  // ② トリガーを登録し直す。予定管理の通知 (メール・Telegram・バックアップ) は止め、
  //    Polymarket の記録 (1時間ごと) と決着の取り込み (毎日5時) だけにする
  const ours = ['sendDailyMail', 'pollTelegram', 'checkDeadlines', 'weeklyBackup', 'pmRecord', 'pmResolve', 'pmAlert', 'pmDigest'];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (ours.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('pmRecord').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('pmResolve')
    .timeBased().atHour(PM_RESOLVE_HOUR).everyDays(1).inTimezone('Asia/Tokyo').create();
  ScriptApp.newTrigger('pmAlert').timeBased().everyMinutes(PM_ALERT_MINUTES).create();
  ScriptApp.newTrigger('pmDigest').timeBased().atHour(PM_DIGEST_HOUR).everyDays(1).inTimezone('Asia/Tokyo').create();
  // ③ 1回目の記録をすぐに行う
  pmRecord();
  const st = pmStatus_();
  Logger.log('Polymarket の記録 (1時間ごと)・決着の取り込み (毎日' + PM_RESOLVE_HOUR + '時)・急変の通知 (' + PM_ALERT_MINUTES + '分おき)・毎朝' + PM_DIGEST_HOUR + '時のまとめ を登録しました。'
    + (pmMailTo_() ? '通知メールの送り先: ' + pmMailTo_() + '。' : '⚠ 通知メールの送り先が未設定です (アプリの設定で入れてください)。')
    + 'メール・Telegram・週ごとのバックアップは止めました');
  Logger.log(st.error ? '⚠ 1回目の記録に失敗しました: ' + st.error
    : '1回目の記録: ' + st.lastCount + '件 (Googleドライブ「' + PM_FOLDER_NAME + '」)');
  if (!moved) Logger.log('⚠ 予定データのドライブへの移行に失敗しました (' + (PropertiesService.getScriptProperties().getProperty('STORE_ERROR') || '') + ')');
}

// =====================================================================
//  Telegram — 受信して案件を登録
// =====================================================================

function tgApi_(method, params) {
  const token = PropertiesService.getScriptProperties().getProperty('TG_TOKEN');
  if (!token) return null;
  const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(params || {}),
    muteHttpExceptions: true,
  });
  try { return JSON.parse(res.getContentText()); } catch (e) { return null; }
}

/** 許可されたChat IDの一覧 (カンマ区切りで複数アカウント対応) */
function tgChats_() {
  const raw = PropertiesService.getScriptProperties().getProperty('TG_CHAT') || '';
  return raw.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

/** chat を省略した場合は先頭のChat IDへ送る */
/**
 * 送信して成否を返す。失敗は TG_LAST_SEND に記録する (アプリの設定画面に表示)。
 * ・4096文字を超える場合は行単位で分割
 * ・HTMLの解釈に失敗した場合はタグを外して送り直す
 */
function tgSend_(text, chat, extra) {
  const to = chat || tgChats_()[0];
  if (!to) return false;
  const parts = splitMsg_(String(text || ''), 3900);
  let ok = true, err = '';
  parts.forEach(function (part, i) {
    // ボタン(reply_markup)は最後の分割にだけ付ける
    const more = (i === parts.length - 1 && extra) ? extra : {};
    let r = tgApi_('sendMessage', Object.assign({ chat_id: to, text: part, parse_mode: 'HTML', disable_web_page_preview: true }, more));
    if (!(r && r.ok) && r && /parse entities/i.test(r.description || '')) {
      const plain = part.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
      r = tgApi_('sendMessage', Object.assign({ chat_id: to, text: plain, disable_web_page_preview: true }, more));
    }
    if (!(r && r.ok)) { ok = false; err = (r && r.description) || '応答なし'; }
  });
  try {
    PropertiesService.getScriptProperties().setProperty('TG_LAST_SEND', JSON.stringify({
      at: new Date().toISOString(), ok: ok, error: err, chat: String(to).slice(-4),
    }));
  } catch (e) {}
  if (!ok) Logger.log('Telegram送信失敗 (' + to + '): ' + err);
  return ok;
}

function splitMsg_(text, max) {
  if (text.length <= max) return [text];
  const out = [];
  let cur = '';
  text.split('\n').forEach(function (line) {
    if ((cur + '\n' + line).length > max && cur) { out.push(cur); cur = line; }
    else cur = cur ? cur + '\n' + line : line;
  });
  if (cur) out.push(cur);
  return out;
}

/** 未登録のチャットから届いた場合、IDを控えて本人に案内を返す */
function rememberPending_(id) {
  const props = PropertiesService.getScriptProperties();
  let list = [];
  try { list = JSON.parse(props.getProperty('TG_PENDING') || '[]'); } catch (e) {}
  if (list.indexOf(id) >= 0) return;   // 案内は1回だけ
  list.push(id);
  props.setProperty('TG_PENDING', JSON.stringify(list.slice(-10)));
  tgApi_('sendMessage', {
    chat_id: id,
    text: '👋 このチャットはまだ登録されていません。\n\n'
      + 'アプリの設定タブで「自動取得」→「📲 Telegram登録を有効化」を押すと使えるようになります。\n\n'
      + 'Chat ID: ' + id,
    disable_web_page_preview: true,
  });
}

function pollTelegram() {
  const props = PropertiesService.getScriptProperties();
  try { maybeMigrate_(); } catch (e) { Logger.log('移行の確認に失敗: ' + e); }
  if (!props.getProperty('TG_TOKEN')) return;

  // 1日1回のダイジェスト。新着が無い時も確実に動くよう、受信処理より前で呼ぶ
  try { maybeRunDailyAlert_(); } catch (e) { Logger.log('ダイジェスト失敗: ' + e); }
  try { maybeNudge_(); } catch (e) { Logger.log('夜のお知らせ失敗: ' + e); }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  blobCacheClear_();
  try {
    const offset = Number(props.getProperty('TG_OFFSET') || 0);
    const res = tgApi_('getUpdates', { offset: offset, timeout: 0, limit: 20, allowed_updates: ['message', 'channel_post', 'callback_query'] });
    if (!res || !res.ok || !res.result || !res.result.length) return;

    const allow = tgChats_();
    let maxId = offset;

    res.result.forEach(function (u) {
      if (u.update_id >= maxId) maxId = u.update_id + 1;
      if (u.callback_query) {
        const cq = u.callback_query;
        const cf = String(cq.message && cq.message.chat ? cq.message.chat.id : '');
        if (allow.length && allow.indexOf(cf) < 0) return;
        try { handleCallback_(cq); } catch (err) { Logger.log('ボタン処理失敗: ' + err); }
        return;
      }
      const msg = u.message || u.channel_post;
      if (!msg) return;
      const from = String(msg.chat.id);
      if (allow.length && allow.indexOf(from) < 0) { rememberPending_(from); return; }

      const text = (msg.text || msg.caption || '').trim();
      if (!text) return;
      try {
        // 返信は送ってきた本人へ返す (複数アカウント対応)
        if (text.charAt(0) === '/') handleCommand_(text, from);
        else handleIngest_(text, from);
      } catch (err) {
        tgSend_('⚠️ 処理に失敗しました: ' + String(err).slice(0, 200), from);
      }
    });

    props.setProperty('TG_OFFSET', String(maxId));
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

/** その日まだ送っていなければ、指定時刻を過ぎた時点で期限アラートを送る */
function maybeRunDailyAlert_() {
  const props = PropertiesService.getScriptProperties();
  const now = new Date();
  const today = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd');
  if (props.getProperty('ALERT_LAST_RUN') === today) return;
  if (Number(Utilities.formatDate(now, 'Asia/Tokyo', 'H')) < ALERT_HOUR) return;
  // 送れなかった時は次の5分後に再挑戦する (1日6回まで)
  const triesKey = 'ALERT_TRIES_' + today;
  const tries = Number(props.getProperty(triesKey) || 0);
  if (tries >= 6) return;
  props.setProperty(triesKey, String(tries + 1));
  let sent = 0;
  try { sent = sendDigest(); } catch (e) { Logger.log('ダイジェスト失敗: ' + e); }
  if (sent > 0 || !tgChats_().length) {
    props.setProperty('ALERT_LAST_RUN', today);
    props.setProperty('ALERT_LAST_OK', new Date().toISOString());
  }
  // 古い試行回数の記録を片付ける
  props.getKeys().forEach(function (k) { if (k.indexOf('ALERT_TRIES_') === 0 && k !== triesKey) props.deleteProperty(k); });
}

/** 自由文から案件を作って登録する */
function handleIngest_(text, from) {
  const items = parseWithAi_(text);
  if (!items.length) { tgSend_('🤔 案件として認識できませんでした。もう少し情報を添えて送ってください。', from); return; }

  const list = getProjects_();
  const existing = {};
  list.forEach(function (p) { if (p && p.name) existing[String(p.name).trim().toLowerCase()] = true; });

  const added = [];
  const dups = [];
  items.forEach(function (it) {
    const key = String(it.name || '').trim().toLowerCase();
    if (!key) return;
    if (existing[key]) { dups.push(it.name); return; }
    existing[key] = true;
    const p = {
      id: uid_(),
      status: 'open',
      pinned: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      src: 'telegram',
      name: String(it.name),
      chain: String(it.chain || ''),
      deadline: String(it.deadline || ''),
      memo: String(it.memo || ''),
      sources: Array.isArray(it.sources)
        ? it.sources.filter(function (s) { return s && (s.url || s.title); })
                    .map(function (s) { return { url: String(s.url || ''), title: String(s.title || '') }; })
        : [],
    };
    list.push(p);
    added.push(p);
    logInbox_({ type: 'add', id: p.id, name: p.name, project: p });
    try { logHist_([histEntry_('add', p, 'tg')]); } catch (e) {}
  });

  if (added.length) putProjects_(list);

  let out = '';
  if (added.length) {
    out += '✅ <b>' + added.length + '件を登録しました</b>\n';
    added.forEach(function (p) {
      out += '\n• <b>' + esc(p.name) + '</b>' + (p.chain ? ' (' + esc(p.chain) + ')' : '');
      out += '\n  📅 ' + (p.deadline ? fmtDate(p.deadline) : '期限未定');
      if (p.memo) out += '\n  📝 ' + esc(p.memo.slice(0, 160));
    });
  }
  if (dups.length) out += (out ? '\n\n' : '') + '⏭ 登録済みのためスキップ: ' + esc(dups.join(', '));
  tgSend_(out, from);
}

/** AIで構造化。キーが無い / 失敗した場合は簡易解析にフォールバック */
function parseWithAi_(text) {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty('GEMINI_KEY');
  if (key) {
    try {
      const model = props.getProperty('GEMINI_MODEL') || 'gemini-2.5-flash';
      const now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
      const sys = 'あなたは雑多なテキストから暗号資産プロジェクト/キャンペーンの予定を抽出する専門家です。現在日時: ' + now + '\n'
        + '入力から予定を抽出し、次のスキーマのJSON配列のみを出力してください。\n'
        + '[{"name":"プロジェクト名","chain":"チェーンやカテゴリ(不明なら\\"不明\\")",'
        + '"deadline":"YYYY-MM-DDTHH:MM形式。不明なら空文字。時刻不明なら23:59。相対表現は現在日時から補完",'
        + '"memo":"やるべきタスク・条件の要約(日本語・簡潔)",'
        + '"sources":[{"url":"本文中のURL","title":"説明"}]}]\n'
        + 'ルール: 予定が1つでも配列で返す / URLが無ければsourcesは空配列 / JSON以外は一切出力しない\n'
        + '重要: 情報が乏しくてもURLが含まれていれば必ず1件は抽出すること。'
        + 'プロジェクト名が不明ならURLのドメインやアカウント名から推測し、memoに「詳細未確認」と記す。'
        + 'URLも無く予定と全く判断できない場合のみ [] を返す。';
      const res = UrlFetchApp.fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(key),
        {
          method: 'post', contentType: 'application/json', muteHttpExceptions: true,
          payload: JSON.stringify({
            system_instruction: { parts: [{ text: sys }] },
            contents: [{ role: 'user', parts: [{ text: text }] }],
            generationConfig: { temperature: 0.15, maxOutputTokens: 4096, responseMimeType: 'application/json' },
          }),
        });
      const d = JSON.parse(res.getContentText());
      const out = d && d.candidates && d.candidates[0] && d.candidates[0].content
        && d.candidates[0].content.parts.map(function (p) { return p.text; }).join('');
      if (out) {
        let arr;
        try { arr = JSON.parse(out); }
        catch (e) { const m = out.match(/\[[\s\S]*\]/); arr = m ? JSON.parse(m[0]) : []; }
        if (Array.isArray(arr)) {
          const items = arr.filter(function (x) { return x && x.name; });
          if (items.length) return items;
          // AIが抽出できなくてもURLがあれば取りこぼさない
        }
      }
    } catch (e) { /* フォールバックへ */ }
  }
  return fallbackParse_(text);
}

/** AIが使えない/抽出できない時の簡易解析: 1行目を名前、URLをソースにする */
function fallbackParse_(text) {
  const urls = text.match(/https?:\/\/\S+/g) || [];
  const lines = text.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
  let name = '';
  for (let i = 0; i < lines.length; i++) {
    if (!/^https?:\/\//.test(lines[i])) { name = lines[i]; break; }
  }
  if (!name && urls.length) name = nameFromUrl_(urls[0]);
  if (!name) return [];
  return [{
    name: name.slice(0, 80),
    chain: '不明',
    deadline: '',
    memo: (text.length > 40 ? text.slice(0, 600) : '詳細未確認 — アプリで内容を追記してください'),
    sources: urls.map(function (u) { return { url: u, title: '' }; }),
  }];
}

/** URLから案件名を推測する */
function nameFromUrl_(url) {
  try {
    const m = url.match(/^https?:\/\/([^\/]+)(\/[^?#]*)?/);
    if (!m) return url.slice(0, 40);
    const host = m[1].replace(/^www\./, '');
    const path = (m[2] || '').split('/').filter(Boolean);
    // X / Twitter は投稿者のハンドルを使う
    if (/^(x\.com|twitter\.com)$/.test(host) && path.length) return '@' + path[0] + ' の投稿';
    if (path.length) return host + ' / ' + path[0];
    return host;
  } catch (e) { return String(url).slice(0, 40); }
}

/** コマンド処理 */
function handleCommand_(text, from) {
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase().replace(/@.*$/, '');
  const props = PropertiesService.getScriptProperties();

  if (cmd === '/alert' || cmd === '/today2' || cmd === '/digest' || cmd === '/quest') {
    const g = getGame_();
    const list = getProjects_();
    ensureQuest_(g, list);
    putGame_(g);
    sendQuestTo_(from, g, list);
    return;
  }

  if (cmd === '/help' || cmd === '/start') {
    tgSend_('📋 <b>予定管理 Bot</b>\n\n'
      + '情報をそのまま送る/転送すると、AIが解析して案件を登録します。\n\n'
      + '<b>コマンド</b>\n'
      + '/alert — 今日のクエスト (ボタンで完了するとXP獲得)\n'
      + '/list — 未完了の一覧\n'
      + '/today — 期限が近い案件\n'
      + '/done 3 — 一覧の3番を完了にする\n'
      + '/pin 3 — 一覧の3番をピン留め切替\n'
      + '/help — このヘルプ', from);
    return;
  }

  if (cmd === '/list' || cmd === '/today') {
    const now = new Date();
    let list = getProjects_().filter(function (p) { return p && p.status !== 'done'; });
    list.forEach(function (p) {
      p._days = p.deadline ? jstDays_(p.deadline) : null;
    });
    if (cmd === '/today') {
      list = list.filter(function (p) { return p._days !== null && p._days <= URGENT_DAYS; });
    }
    list.sort(function (a, b) {
      return (a._days === null ? 99999 : a._days) - (b._days === null ? 99999 : b._days);
    });
    if (!list.length) { tgSend_(cmd === '/today' ? '📭 期限の近い案件はありません' : '📭 未完了の案件はありません', from); return; }

    // 番号の対応表はアカウントごとに保持する
    props.setProperty('TG_LASTLIST_' + from, JSON.stringify(list.map(function (p) { return p.id; })));
    let out = (cmd === '/today' ? '⏰ <b>期限が近い案件</b>\n' : '📋 <b>未完了の案件</b>\n');
    list.forEach(function (p, i) {
      let d = '期限未定';
      if (p._days !== null) d = p._days < 0 ? '⛔ ' + Math.abs(p._days) + '日超過' : 'あと' + p._days + '日';
      out += '\n' + (i + 1) + '. ' + (p.pinned ? '📌' : '') + '<b>' + esc(p.name) + '</b>'
          + (p.chain ? ' (' + esc(p.chain) + ')' : '') + '\n   ' + d;
    });
    out += '\n\n<i>/done 番号 で完了、/pin 番号 でピン留め</i>';
    tgSend_(out, from);
    return;
  }

  if (cmd === '/done' || cmd === '/pin') {
    const n = parseInt(parts[1], 10);
    if (!n) { tgSend_('番号を指定してください (例: ' + cmd + ' 3)', from); return; }
    let ids;
    try { ids = JSON.parse(props.getProperty('TG_LASTLIST_' + from) || '[]'); } catch (e) { ids = []; }
    const id = ids[n - 1];
    if (!id) { tgSend_('先に /list を送って番号を確認してください', from); return; }
    const list = getProjects_();
    const p = list.filter(function (x) { return x && x.id === id; })[0];
    if (!p) { tgSend_('対象が見つかりませんでした', from); return; }
    p.updatedAt = new Date().toISOString();
    if (cmd === '/done') {
      p.status = 'done'; p.doneAt = p.updatedAt;
      const made = spawnRepeats_(list, 'tg');
      const g = getGame_();
      const doneBefore = g.doneTotal || 0;
      const a = awardDone_(g, p);
      touchStreak_(g);
      const q = ensureQuest_(g, list);
      if (q.ids.indexOf(p.id) >= 0) q.res[p.id] = 'done';
      putGame_(g);
      tgSend_('✅ 完了にしました: <b>' + esc(p.name) + '</b>  +' + a.xp + 'XP 🔥' + g.streak + '日連続' + repeatNote_(made), from);
      const story = storyNotice_(doneBefore, g.doneTotal || 0);
      if (story) tgSend_(story, from);
    }
    else { p.pinned = !p.pinned; tgSend_((p.pinned ? '📌 ピン留めしました: ' : '📌 ピン留めを解除しました: ') + '<b>' + esc(p.name) + '</b>', from); }
    putProjects_(list);
    try { logHist_([histEntry_(cmd === '/done' ? 'done' : 'pin', p, 'tg')]); } catch (e) {}
    logInbox_(cmd === '/done'
      ? { type: 'done', id: p.id, name: p.name }
      : { type: 'pin', id: p.id, name: p.name, pinned: p.pinned });
    return;
  }

  tgSend_('不明なコマンドです。/help で一覧を表示します。', from);
}

// =====================================================================
//  Telegram — 期限アラート (3日前 / 前日 / 当日)
// =====================================================================

/** 通知する残り日数。変更可 (例: [7,3,1,0]) */
const ALERT_DAYS = [3, 1, 0];

/**
 * 毎朝のTelegramダイジェスト
 * ・ピン留め中の未完了案件を一覧表示
 * ・期限が近いもの / 過ぎたものを上に出して強調
 * force=true なら送信済み判定を無視して必ず返す (/alert 用)
 */
function buildDigest_() {
  const now = new Date();
  const list = getProjects_().filter(function (p) { return p && p.status !== 'done'; });
  const pinned = list.filter(function (p) { return p.pinned; });

  list.forEach(function (p) {
    p._days = p.deadline ? jstDays_(p.deadline) : null;
  });
  const soon = list.filter(function (p) { return p._days !== null && p._days <= URGENT_DAYS; })
                   .sort(function (a, b) { return a._days - b._days; });

  if (!pinned.length && !soon.length) return '📭 今日の対象はありません';

  let msg = '☀️ <b>今日の予定</b>  ' + Utilities.formatDate(now, 'Asia/Tokyo', 'M/d (E)') + '\n';

  if (soon.length) {
    msg += '\n<b>⏰ 期限が近い / 過ぎた案件</b>\n';
    soon.forEach(function (p) {
      const lbl = p._days < 0 ? '⛔ <b>' + Math.abs(p._days) + '日超過</b>'
                : p._days === 0 ? '🚨 <b>本日まで</b>'
                : p._days === 1 ? '⚠️ <b>明日まで</b>'
                : '📅 あと' + p._days + '日';
      msg += '\n' + lbl + ' — <b>' + esc(p.name) + '</b>';
      if (p.memo) msg += '\n　' + esc(String(p.memo).slice(0, 110));
    });
    msg += '\n';
  }

  if (pinned.length) {
    msg += '\n<b>📌 重要案件 (' + pinned.length + '件)</b>\n';
    pinned.forEach(function (p) {
      msg += '\n・<b>' + esc(p.name) + '</b>'
           + (p.chain ? ' <i>' + esc(p.chain) + '</i>' : '')
           + (p.deadline ? '  📅' + fmtDate(p.deadline).slice(0, 10) : '');
      if (p.memo) msg += '\n　' + esc(String(p.memo).slice(0, 110));
    });
    msg += '\n';
  }

  const noDl = list.filter(function (p) { return !p.deadline; }).length;
  msg += '\n<i>未完了 ' + list.length + '件 / うち期限未設定 ' + noDl + '件</i>';
  msg += '\n<i>/list 一覧 ・ /done 番号 完了 ・ /pin 番号 重要切替</i>';
  return msg;
}

function sendDigest() {
  if (!PropertiesService.getScriptProperties().getProperty('TG_TOKEN')) return;
  const g = getGame_();
  const list = getProjects_();
  ensureQuest_(g, list);
  putGame_(g);
  let sent = 0;
  tgChats_().forEach(function (c) { if (sendQuestTo_(c, g, list)) sent++; });
  Logger.log('ダイジェスト送信: ' + sent + '/' + tgChats_().length + '件成功');
  return sent;
}

function checkDeadlines() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('TG_TOKEN') || !tgChats_().length) return;

  let sentLog = {};
  try { sentLog = JSON.parse(props.getProperty('ALERT_SENT') || '{}'); } catch (e) {}

  const now = new Date();
  const today = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd');
  const hits = [];

  getProjects_().forEach(function (p) {
    if (!p || p.status === 'done' || !p.deadline) return;
    const d = jstDays_(p.deadline);
    if (ALERT_DAYS.indexOf(d) < 0) return;
    const key = p.id + '@' + d;          // 同じ案件・同じ残り日数は1回だけ
    if (sentLog[key]) return;
    sentLog[key] = today;
    p._days = d;
    hits.push(p);
  });

  if (!hits.length) { pruneAlertLog_(sentLog, props); return; }

  hits.sort(function (a, b) { return a._days - b._days; });
  const urgent = hits.filter(function (p) { return p._days <= 0; }).length;
  let msg = (urgent ? '🚨 <b>本日が期限の案件があります</b>' : '⏰ <b>締切が近づいています</b>') + '\n';

  hits.forEach(function (p) {
    const label = p._days === 0 ? '🚨 <b>本日まで</b>'
                : p._days === 1 ? '⚠️ <b>明日まで</b>'
                : '📅 あと' + p._days + '日';
    msg += '\n' + label + ' — <b>' + esc(p.name) + '</b>'
         + (p.chain ? ' (' + esc(p.chain) + ')' : '')
         + '\n　' + fmtDate(p.deadline);
    if (p.memo) msg += '\n　📝 ' + esc(String(p.memo).slice(0, 150));
    const url = (p.sources || []).filter(function (s) { return s && s.url; })[0];
    if (url) msg += '\n　🔗 ' + esc(url.url);
    msg += '\n';
  });
  msg += '\n<i>完了したら /list → /done 番号 で消せます</i>';

  tgChats_().forEach(function (c) { tgSend_(msg, c); });
  pruneAlertLog_(sentLog, props);
  Logger.log('期限アラートを送信: ' + hits.length + '件');
}

/** 古い送信記録を整理する (30日より前は捨てる) */
function pruneAlertLog_(log, props) {
  const limit = Utilities.formatDate(new Date(Date.now() - 30 * 86400000), 'Asia/Tokyo', 'yyyy-MM-dd');
  const out = {};
  Object.keys(log).forEach(function (k) { if (log[k] >= limit) out[k] = log[k]; });
  props.setProperty('ALERT_SENT', JSON.stringify(out));
}

// =====================================================================
//  毎日のメール送信
// =====================================================================

function sendDailyMail() {
  const props = PropertiesService.getScriptProperties();
  const to = props.getProperty('MAIL_TO');
  if (!to) { Logger.log('送信先メールアドレスが未設定です (アプリから同期してください)'); return; }

  const list = getProjects_().filter(function (p) {
    return p && p.pinned && p.status !== 'done';
  });
  if (!list.length) { Logger.log('通知対象の案件がありません'); return; }

  const now = new Date();
  const items = list.map(function (p) {
    p._days = p.deadline ? jstDays_(p.deadline) : null;
    return p;
  }).sort(function (a, b) {
    return (a._days === null ? 99999 : a._days) - (b._days === null ? 99999 : b._days);
  });

  const urgent = items.filter(function (p) { return p._days !== null && p._days <= URGENT_DAYS; });
  const subject = '【予定管理】ピン留め ' + items.length + '件'
    + (urgent.length ? ' / 要対応 ' + urgent.length + '件' : '');

  MailApp.sendEmail({
    to: to,
    subject: subject,
    htmlBody: buildHtml(items, urgent.length, props.getProperty('SYNCED_AT')),
  });
  Logger.log('送信しました: ' + to + ' (' + items.length + '件)');
}

function buildHtml(items, urgentCount, syncedAt) {
  const rows = items.map(function (p) {
    let color = '#6b7280', label = '期限未定';
    if (p._days !== null) {
      if (p._days < 0)        { color = '#dc2626'; label = '期限切れ ' + Math.abs(p._days) + '日経過'; }
      else if (p._days === 0) { color = '#dc2626'; label = '本日が期限'; }
      else if (p._days <= URGENT_DAYS) { color = '#d97706'; label = 'あと ' + p._days + '日'; }
      else                    { color = '#059669'; label = 'あと ' + p._days + '日'; }
    }
    const links = (p.sources || []).filter(function (s) { return s && s.url; })
      .map(function (s) {
        return '<a href="' + esc(s.url) + '" style="color:#2563eb;font-size:12px;">'
          + esc(s.title || 'ソース') + '</a>';
      }).join(' ・ ');

    return ''
      + '<tr><td style="padding:14px 16px;border-bottom:1px solid #e5e7eb;">'
      +   '<div style="font-size:16px;font-weight:700;color:#111827;">' + esc(p.name)
      +     (p.chain ? ' <span style="font-size:12px;font-weight:400;color:#6b7280;">(' + esc(p.chain) + ')</span>' : '')
      +   '</div>'
      +   '<div style="margin-top:5px;font-size:13px;color:' + color + ';font-weight:600;">'
      +     label + (p.deadline ? ' <span style="color:#9ca3af;font-weight:400;">' + fmtDate(p.deadline) + '</span>' : '')
      +   '</div>'
      +   (p.memo ? '<div style="margin-top:7px;font-size:13px;color:#4b5563;white-space:pre-wrap;">' + esc(p.memo) + '</div>' : '')
      +   (links ? '<div style="margin-top:7px;">' + links + '</div>' : '')
      + '</td></tr>';
  }).join('');

  return ''
    + '<div style="font-family:-apple-system,\'Hiragino Sans\',\'Yu Gothic UI\',sans-serif;'
    +   'max-width:640px;margin:0 auto;background:#f9fafb;padding:24px;">'
    +   '<div style="background:linear-gradient(135deg,#5b8cff,#38d9c0);border-radius:14px 14px 0 0;padding:20px 22px;">'
    +     '<div style="color:#fff;font-size:19px;font-weight:800;">📌 今日のピン留め案件</div>'
    +     '<div style="color:rgba(255,255,255,.9);font-size:13px;margin-top:4px;">'
    +       items.length + '件' + (urgentCount ? ' ／ うち要対応 ' + urgentCount + '件' : '')
    +     '</div>'
    +   '</div>'
    +   '<table style="width:100%;border-collapse:collapse;background:#fff;">' + rows + '</table>'
    +   '<div style="padding:14px 16px;background:#fff;border-radius:0 0 14px 14px;'
    +     'font-size:11px;color:#9ca3af;border-top:1px solid #e5e7eb;">'
    +     '予定管理アプリより自動送信' + (syncedAt ? ' ・ 最終同期 ' + fmtDate(syncedAt) : '')
    +   '</div>'
    + '</div>';
}

/** 残り日数を日本時間のカレンダー日付で数える (0=今日, 1=明日, -1=昨日) */
function jstDays_(iso) {
  if (!iso) return null;
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const t = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd').split('-');
  return Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(+t[0], +t[1] - 1, +t[2])) / 86400000);
}

function fmtDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (m) return m[1] + '/' + m[2] + '/' + m[3] + ' ' + m[4] + ':' + m[5];
  try {
    return Utilities.formatDate(new Date(iso), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
  } catch (e) { return String(iso); }
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// =====================================================================
//  ゲーム化 — 今日のクエスト / XP・レベル / 連続記録
//  ・毎朝9時に「今日のクエスト」(最大3件) をボタン付きで送る
//  ・ボタンで 完了 / 明日へ / 見送り。押すとXPが入り、メッセージが更新される
//  ・何か1つ操作した日は連続記録が伸びる。途切れそうな日は夜に1回だけお知らせ
// =====================================================================

/** 夜のお知らせ時刻 (連続記録が途切れそうな時だけ) */
const NUDGE_HOUR = 20;

const XP_ON_TIME = 20;   // 期限内に完了
const XP_DONE    = 10;   // 期限なし/期限後に完了
const XP_DROP    = 2;    // 見送り (片付けたことを評価)
const XP_CHECK   = 2;    // 確認しただけ
const XP_BONUS   = 30;   // 今日のクエストを全部片付けた

const LEVEL_TITLES = [
  [1, '見習いファーマー'], [3, 'ガス代の守り手'], [5, 'タスク職人'], [8, 'エアドロハンター'],
  [12, 'TGEの目利き'], [16, 'クジラ予備軍'], [20, '伝説のファーマー'],
];

function getGame_() {
  let g;
  const raw = loadBlob_('GAME');
  try { g = JSON.parse(raw || '{}') || {}; } catch (e) { g = {}; }
  // ものがたり用の完了数 (初回だけ、今ある完了済みの数から始める)
  if (g.doneTotal == null) g.doneTotal = getProjects_().filter(function (p) { return p && p.status === 'done' && !p.dropped; }).length;
  return g;
}
function putGame_(g) {
  // 古い記録を片付ける
  const lim = Utilities.formatDate(new Date(Date.now() - 90 * 86400000), 'Asia/Tokyo', 'yyyy-MM-dd');
  Object.keys(g.awarded || {}).forEach(function (k) { if (g.awarded[k] < lim) delete g.awarded[k]; });
  const lim14 = Utilities.formatDate(new Date(Date.now() - 14 * 86400000), 'Asia/Tokyo', 'yyyy-MM-dd');
  Object.keys(g.daily || {}).forEach(function (k) { if (k < lim14) delete g.daily[k]; });
  saveBlob_('GAME', JSON.stringify(g));
}
function todayJst_() { return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd'); }
function yesterdayJst_() { return Utilities.formatDate(new Date(Date.now() - 86400000), 'Asia/Tokyo', 'yyyy-MM-dd'); }

/** Lv.L に必要な累計XP = 25 × (L-1) × L  (Lv2=50, Lv3=150, Lv4=300, Lv5=500 …) */
function levelOf_(xp) { let lv = 1; while (25 * lv * (lv + 1) <= xp) lv++; return lv; }
function levelInfo_(xp) {
  xp = xp || 0;
  const lv = levelOf_(xp), base = 25 * (lv - 1) * lv, next = 25 * lv * (lv + 1);
  let title = LEVEL_TITLES[0][1];
  LEVEL_TITLES.forEach(function (t) { if (lv >= t[0]) title = t[1]; });
  return { lv: lv, title: title, cur: xp - base, need: next - base };
}
function bar_(cur, need) {
  const n = Math.max(0, Math.min(10, Math.round(cur / need * 10)));
  return '▰'.repeat(n) + '▱'.repeat(10 - n);
}

/** 今日の初めての操作なら連続記録を伸ばす */
function touchStreak_(g) {
  const t = todayJst_();
  if (g.last === t) return false;
  g.streak = (g.last === yesterdayJst_()) ? (g.streak || 0) + 1 : 1;
  g.best = Math.max(g.best || 0, g.streak);
  g.last = t;
  return true;
}
/** XPを足す。レベルが上がったら新しいレベルを返す */
function addXp_(g, n) {
  const before = levelOf_(g.xp || 0);
  g.xp = (g.xp || 0) + n;
  g.daily = g.daily || {};
  const t = todayJst_();
  g.daily[t] = (g.daily[t] || 0) + n;
  const after = levelOf_(g.xp);
  return after > before ? after : 0;
}
/** 完了のXP (同じ案件で二重にもらえないよう記録する) */
function awardDone_(g, p) {
  g.awarded = g.awarded || {};
  if (g.awarded[p.id]) return { xp: 0, up: 0 };
  g.awarded[p.id] = todayJst_();
  if (!p.dropped) g.doneTotal = (g.doneTotal || 0) + 1;
  let xp = XP_DONE;
  if (p.dropped) xp = XP_DROP;
  else if (p.deadline) { const d = jstDays_(p.deadline); if (d !== null && d >= 0) xp = XP_ON_TIME; }
  return { xp: xp, up: addXp_(g, xp) };
}

/** 今日のクエストを選ぶ: 期限が近い(3日超過〜7日以内) → ピン留め の順で最大3件 */
function pickQuest_(list) {
  const open = list.filter(function (p) { return p && p.id && p.status !== 'done'; });
  const dd = {};
  open.forEach(function (p) { dd[p.id] = p.deadline ? jstDays_(p.deadline) : null; });
  const near = open.filter(function (p) { return dd[p.id] !== null && dd[p.id] >= -3 && dd[p.id] <= 7; })
                   .sort(function (a, b) { return dd[a.id] - dd[b.id]; });
  const pins = open.filter(function (p) { return p.pinned && near.indexOf(p) < 0; })
                   .sort(function (a, b) { return (dd[a.id] === null ? 9999 : dd[a.id]) - (dd[b.id] === null ? 9999 : dd[b.id]); });
  // 繰り返しの予定は、毎日の分で埋まらないよう1日1件まで
  let rep = 0;
  return near.concat(pins).filter(function (p) { return !p.repeat || rep++ < 1; })
             .slice(0, 3).map(function (p) { return p.id; });
}
function ensureQuest_(g, list) {
  const t = todayJst_();
  if (!g.quest || g.quest.date !== t) {
    // 前の日のクエスト結果を振り返り用に残す (90日分)
    if (g.quest && g.quest.date) {
      const q = g.quest, res = q.res || {};
      const cnt = function (v) { return q.ids.filter(function (id) { return res[id] === v; }).length; };
      g.qhist = (g.qhist || []).filter(function (h) { return h.d !== q.date; });
      g.qhist.push({ d: q.date, n: q.ids.length, done: cnt('done'), drop: cnt('drop'), skip: cnt('skip'), b: !!q.bonus });
      g.qhist = g.qhist.slice(-90);
    }
    g.quest = { date: t, ids: pickQuest_(list), res: {}, bonus: false };
  }
  return g.quest;
}
function questCleared_(q) {
  return q.ids.length > 0 && q.ids.every(function (id) { return q.res[id] === 'done' || q.res[id] === 'drop'; });
}

function buildQuest_(g, list) {
  const q = ensureQuest_(g, list);
  const li = levelInfo_(g.xp);
  const byId = {};
  list.forEach(function (p) { if (p && p.id) byId[p.id] = p; });
  const streak = (g.last === todayJst_() || g.last === yesterdayJst_()) ? (g.streak || 0) : 0;
  let m = '🎮 <b>今日のクエスト</b>  ' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'M/d (E)') + '\n'
        + '🔥 <b>' + streak + '日連続</b>' + (g.last === todayJst_() ? ' ✔︎' : '') + ' ・ Lv.' + li.lv + ' ' + li.title + '\n'
        + bar_(li.cur, li.need) + ' ' + li.cur + '/' + li.need + 'XP\n';
  if (!q.ids.length) m += '\n今日のクエストはありません 🎉\n「👍 確認した」で連続記録を伸ばせます';
  q.ids.forEach(function (id, i) {
    const p = byId[id];
    if (!p) return;
    const r = q.res[id] || (p.status === 'done' ? 'done' : '');
    const mark = r === 'done' ? '✅' : r === 'skip' ? '⏭' : r === 'drop' ? '🙅' : '⬜';
    let line = '\n' + mark + ' ' + (i + 1) + '. ' + (r ? '<s>' + esc(p.name) + '</s>' : '<b>' + esc(p.name) + '</b>');
    if (!r) {
      const d = p.deadline ? jstDays_(p.deadline) : null;
      if (d !== null) line += d < 0 ? ' — ⛔' + (-d) + '日超過' : d === 0 ? ' — 🚨本日まで' : d === 1 ? ' — ⚠️明日まで' : ' — あと' + d + '日';
      else if (p.pinned) line += ' — 📌';
      if (p.memo) line += '\n    <i>' + esc(String(p.memo).slice(0, 80)) + '</i>';
    }
    m += line;
  });
  if (q.bonus) m += '\n\n🏆 <b>クエスト達成！</b> +' + XP_BONUS + 'XP';
  const open = list.filter(function (p) { return p && p.status !== 'done' && q.ids.indexOf(p.id) < 0; });
  let soon = 0, over = 0;
  open.forEach(function (p) {
    const d = p.deadline ? jstDays_(p.deadline) : null;
    if (d === null) return;
    if (d < 0) over++; else if (d <= 7) soon++;
  });
  if (soon || over) m += '\n\n<i>ほかに 7日以内 ' + soon + '件 ・ 期限切れ ' + over + '件 (/list)</i>';
  return m;
}

function questKeyboard_(g, list) {
  const q = ensureQuest_(g, list);
  const byId = {};
  list.forEach(function (p) { if (p && p.id) byId[p.id] = p; });
  const rows = [];
  q.ids.forEach(function (id, i) {
    const p = byId[id];
    if (!p || q.res[id] || p.status === 'done') return;
    rows.push([
      { text: '✅ ' + (i + 1) + ' 完了', callback_data: 'q:d:' + id },
      { text: '⏭ 明日へ', callback_data: 'q:s:' + id },
      { text: '🙅 見送り', callback_data: 'q:x:' + id },
    ]);
  });
  if (g.last !== todayJst_()) rows.push([{ text: '👍 確認した', callback_data: 'q:c' }]);
  return { inline_keyboard: rows };
}

/** クエストを送る (朝9時・/alert) */
function sendQuestTo_(chat, g, list) {
  return tgSend_(buildQuest_(g, list), chat, { reply_markup: questKeyboard_(g, list) });
}

/** ボタンが押された時 */
function handleCallback_(cq) {
  const chat = String(cq.message && cq.message.chat ? cq.message.chat.id : '');
  const parts = String(cq.data || '').split(':');
  const answer = function (t) { try { tgApi_('answerCallbackQuery', { callback_query_id: cq.id, text: t }); } catch (e) {} };
  if (parts[0] !== 'q') { answer(''); return; }

  const g = getGame_();
  const list = getProjects_();
  const q = ensureQuest_(g, list);
  const now = new Date().toISOString();
  const doneBefore = g.doneTotal || 0;
  let toast = '', changed = false, up = 0;

  if (parts[1] === 'c') {
    if (touchStreak_(g)) { up = addXp_(g, XP_CHECK) || up; toast = '👍 +' + XP_CHECK + 'XP 🔥' + g.streak + '日連続'; try { logHist_([{ t: new Date().toISOString(), k: 'check', s: 'tg' }]); } catch (e) {} }
    else toast = '今日は記録済みです 🔥' + g.streak + '日連続';
  } else {
    const id = parts[2];
    const p = list.filter(function (x) { return x && x.id === id; })[0];
    if (!p) toast = '案件が見つかりませんでした';
    else if (p.status === 'done' && parts[1] !== 's') { q.res[id] = q.res[id] || 'done'; toast = 'すでに完了しています'; }
    else if (parts[1] === 'd' || parts[1] === 'x') {
      p.status = 'done'; p.doneAt = now; p.updatedAt = now;
      if (parts[1] === 'x') p.dropped = true;
      const made = spawnRepeats_(list, 'tg');   // 見送りの時は作らない
      const a = awardDone_(g, p);
      up = a.up || up;
      touchStreak_(g);
      q.res[id] = parts[1] === 'x' ? 'drop' : 'done';
      changed = true;
      logInbox_({ type: 'done', id: p.id, name: p.name, dropped: parts[1] === 'x' || undefined });
      try { logHist_([histEntry_(parts[1] === 'x' ? 'drop' : 'done', p, 'tg')]); } catch (e) {}
      toast = (parts[1] === 'x' ? '🙅 見送りました' + (p.repeat ? ' (繰り返しを止めました)' : '') : '✅ 完了！') + ' +' + a.xp + 'XP' + repeatNote_(made).replace('\n', ' ');
    } else if (parts[1] === 's') {
      q.res[id] = 'skip';
      try { logHist_([histEntry_('skip', p, 'tg')]); } catch (e) {}
      touchStreak_(g);
      toast = '⏭ 明日のクエスト候補に回しました';
    }
  }
  if (!q.bonus && questCleared_(q)) {
    q.bonus = true;
    up = addXp_(g, XP_BONUS) || up;
    toast += ' 🏆 クエスト達成 +' + XP_BONUS + 'XP';
  }
  if (changed) putProjects_(list);
  putGame_(g);
  answer(toast.slice(0, 190));
  if (chat && cq.message) {
    tgApi_('editMessageText', {
      chat_id: chat, message_id: cq.message.message_id, text: buildQuest_(g, list),
      parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: questKeyboard_(g, list),
    });
  }
  if (up && chat) tgSend_('🎉 <b>レベルアップ！</b>\nLv.' + up + ' ' + levelInfo_(g.xp).title + ' になりました', chat);
  const story = storyNotice_(doneBefore, g.doneTotal || 0);
  if (story && chat) tgSend_(story, chat);
}

/** アプリなど別の場所で完了になった案件にもXPを付ける (同期のたびに呼ぶ) */
function awardTransitions_(before, after) {
  const was = {};
  (before || []).forEach(function (p) { if (p && p.id) was[p.id] = p.status; });
  const newly = (after || []).filter(function (p) { return p && p.id && p.status === 'done' && was[p.id] && was[p.id] !== 'done'; });
  if (!newly.length) return;
  const g = getGame_();
  const q = ensureQuest_(g, after);
  newly.forEach(function (p) {
    awardDone_(g, p);
    if (q.ids.indexOf(p.id) >= 0 && !q.res[p.id]) q.res[p.id] = p.dropped ? 'drop' : 'done';
  });
  touchStreak_(g);
  if (!q.bonus && questCleared_(q)) { q.bonus = true; addXp_(g, XP_BONUS); }
  putGame_(g);
}

/** 連続記録が途切れそうな日の夜に1回だけ知らせる */
function maybeNudge_() {
  const props = PropertiesService.getScriptProperties();
  const t = todayJst_();
  if (props.getProperty('NUDGE_LAST') === t) return;
  if (Number(Utilities.formatDate(new Date(), 'Asia/Tokyo', 'H')) < NUDGE_HOUR) return;
  props.setProperty('NUDGE_LAST', t);
  const g = getGame_();
  if (g.last === t || g.last !== yesterdayJst_() || !(g.streak > 0)) return;
  const kb = { inline_keyboard: [[{ text: '👍 確認した (連続記録を守る)', callback_data: 'q:c' }]] };
  tgChats_().forEach(function (c) {
    tgSend_('🔥 <b>' + g.streak + '日連続</b>が今日で途切れそうです\nボタン1回で継続できます。/alert で今日のクエストも見られます', c, { reply_markup: kb });
  });
}

/** アプリのHOME用 */
function gameSummary_() {
  const g = getGame_();
  const li = levelInfo_(g.xp);
  const t = todayJst_();
  const alive = g.last === t || g.last === yesterdayJst_();
  const q = g.quest && g.quest.date === t ? g.quest : null;
  const week = [];
  for (let i = 6; i >= 0; i--) {
    const k = Utilities.formatDate(new Date(Date.now() - i * 86400000), 'Asia/Tokyo', 'yyyy-MM-dd');
    week.push((g.daily || {})[k] || 0);
  }
  return {
    xp: g.xp || 0, lv: li.lv, title: li.title, cur: li.cur, need: li.need, doneTotal: g.doneTotal || 0,
    streak: alive ? (g.streak || 0) : 0, best: g.best || 0, todayDone: g.last === t,
    quest: q ? { total: q.ids.length, cleared: q.ids.filter(function (id) { return q.res[id] === 'done' || q.res[id] === 'drop'; }).length, bonus: !!q.bonus } : null,
    week: week,
  };
}

// =====================================================================
//  ものがたり — 完了数に応じて少しずつ進む (アプリにも同じ文章がある)
// =====================================================================
const STORY = [
  [1, "はじまりの部屋", "引っ越してきたばかりの、小さな部屋。手帳を一冊、机の上に置いた。ここから少しずつ、自分の場所にしていこう。"],
  [3, "窓辺の訪問者", "窓の外から、白いねこがこちらを見ていた。目が合うと、ゆっくりまばたきをして、どこかへ行ってしまった。"],
  [5, "ちいさな種", "窓辺に、見知らぬ植木鉢がひとつ。『水をあげてください』と、丸い字のメモが添えてあった。"],
  [8, "おとなりさん", "メモの主は、となりの部屋の人らしい。壁ごしに、ときどきピアノの音が聞こえてくる。"],
  [11, "芽が出た", "植木鉢から、小さな双葉が顔を出した。うれしくて、手帳のすみに日付を書きこんだ。"],
  [15, "ねこの名前", "あの白いねこが、今日は部屋の中まで入ってきた。首輪の札には『モカ』と書いてある。"],
  [19, "モカのお気に入り", "モカはラグの上が好きらしい。小さなクッションを置いてみたら、すぐにその上で丸くなった。"],
  [24, "返事の手紙", "おとなりさんに、植木鉢のお礼の手紙を書いた。ドアの下に、そっとすべりこませる。"],
  [29, "絵はがき", "翌朝、ドアの下に絵はがきが一枚。海の見える町の絵に『いつか行ってみたい場所』と書いてあった。"],
  [35, "つぼみ", "双葉はすっかり大きくなり、てっぺんに小さなつぼみ。モカが不思議そうに見上げている。"],
  [41, "雨の日の音楽", "雨の日、壁ごしにピアノが聞こえる。今日の曲は、いつもより少しだけ楽しそうだ。"],
  [48, "古い鍵", "本棚の奥から、古い真鍮の鍵が出てきた。どこの鍵だろう。ひとまず壁のフックに掛けておく。"],
  [55, "花が咲いた", "つぼみがひらいて、黄色い花が咲いた。おとなりさんにも見せたくて、短いメモを書いた。"],
  [63, "ねこの散歩道", "モカのあとをついていくと、廊下の突き当たりに小さな扉があった。古い鍵穴がひとつ。"],
  [71, "屋上へ", "あの鍵で、扉がひらいた。階段をのぼった先には、誰もいない屋上と、広い空が待っていた。"],
  [80, "屋上の付箋", "屋上の手すりに、『ここで星を見るのが好き』と書かれた付箋。見覚えのある、丸い字だ。"],
  [90, "夕焼けの写真", "屋上から見た夕焼けを撮って、写真立てに入れた。部屋が少しだけ、にぎやかになった。"],
  [100, "小さな灯り", "星を見る会を開こう。そう決めて、小さな電球のガーランドを窓に飾った。"],
  [112, "招待状", "おとなりさんへ、星を見る会の招待状を書いた。返事は『ぜひ』のひとことだけ。それで十分だった。"],
  [125, "星を見る夜", "屋上で、はじめておとなりさんと会った。思っていたより、ずっと気さくな人だった。モカも一緒に空を見ていた。"],
  [140, "いつもの部屋", "部屋に戻って、手帳の最初のページを見返した。何もなかった部屋は、もうすっかり自分の場所になっていた。（第1部 おわり）"]
];

/** 完了数が before → after に増えた時、新しく読めるようになったお話の文面を返す */
function storyNotice_(before, after) {
  const got = STORY.filter(function (s) { return before < s[0] && after >= s[0]; });
  if (!got.length) return '';
  const i = STORY.indexOf(got[got.length - 1]);
  const s = STORY[i];
  return '📖 <b>新しいお話が届きました</b>\n\n<b>第' + (i + 1) + '話「' + esc(s[1]) + '」</b>\n' + esc(s[2]);
}

// =====================================================================
//  操作の記録 (振り返り分析用)
//  k: add / done / drop / reopen / due(期限変更) / del / skip(明日へ) / check(確認した) / pin
//  s: tg(Telegram) / app(アプリ)
// =====================================================================
function getHist_() {
  const raw = loadBlob_('HIST');
  try { return JSON.parse(raw || '[]') || []; } catch (e) { return []; }
}
function logHist_(entries) {
  if (!entries || !entries.length) return;
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('HIST_SINCE')) props.setProperty('HIST_SINCE', new Date().toISOString());
  const lim = new Date(Date.now() - 180 * 86400000).toISOString();
  const h = getHist_().concat(entries).filter(function (e) { return e.t >= lim; });
  saveBlob_('HIST', JSON.stringify(h.slice(-1500)));
}
function histEntry_(k, p, src, extra) {
  const e = { t: new Date().toISOString(), k: k, id: p.id, n: String(p.name || '').slice(0, 60), c: String(p.chain || '').slice(0, 30), s: src };
  if (p.deadline) e.d = p.deadline;
  if (p.createdAt) e.ca = p.createdAt;
  if (extra) Object.keys(extra).forEach(function (x) { e[x] = extra[x]; });
  return e;
}
/** アプリから届いた変更を、前の状態と比べて記録する */
function diffHist_(before, after) {
  const was = {}, now = {}, out = [];
  (before || []).forEach(function (p) { if (p && p.id) was[p.id] = p; });
  (after || []).forEach(function (p) { if (p && p.id) now[p.id] = p; });
  Object.keys(now).forEach(function (id) {
    const a = now[id], b = was[id];
    if (!b) { out.push(histEntry_(a.status === 'done' ? 'done' : 'add', a, 'app')); return; }
    if (b.status !== 'done' && a.status === 'done') out.push(histEntry_(a.dropped ? 'drop' : 'done', a, 'app'));
    else if (b.status === 'done' && a.status !== 'done') out.push(histEntry_('reopen', a, 'app'));
    if ((b.deadline || '') !== (a.deadline || '')) out.push(histEntry_('due', a, 'app', { od: b.deadline || '' }));
  });
  Object.keys(was).forEach(function (id) { if (!now[id]) out.push(histEntry_('del', was[id], 'app')); });
  logHist_(out.slice(0, 200));
}

// =====================================================================
//  Polymarket の記録 — 確率と出来高を1時間ごとに保存し、決着した結果を1日1回取り込む
//  (あとで「答え合わせ」「急変のその後」を分析するための土台。売買は一切しない)
//  保存先: Googleドライブ「ポリマーケット記録」
//    catalog.json        … 市場の台帳 { v, m: { id: {q,s,e,et,o,end,f,l,r,ra} } }
//    snap-YYYY-MM-DD.json … その日の記録 { d, cols:[id,p,v24,liq], rows:[{t, m:[[...],...]}] }
// =====================================================================

const PM_TOP = 400;                 // 1時間ごとに記録する市場の数 (24時間出来高の多い順)
const PM_PAGE = 100;                // Gamma API の1回あたりの件数
const PM_FOLDER_NAME = 'ポリマーケット記録';
const PM_RESOLVE_HOUR = 5;          // 決着の取り込み (毎日5時)
const PM_RESOLVE_BATCH = 20;        // 決着の確認で1回に問い合わせる市場の数
const PM_RESOLVE_MAX = 800;         // 1回の実行で確認する市場の上限
const PM_TIME_BUDGET = 4.5 * 60000; // 1回の実行で使う時間の上限 (Apps Script は6分で止まるため)
const GAMMA_URL = 'https://gamma-api.polymarket.com';

/** Gamma API を呼ぶ (失敗したら少し待って3回まで) */
function pmFetch_(path) {
  let err;
  for (let i = 0; i < 3; i++) {
    try {
      const res = UrlFetchApp.fetch(GAMMA_URL + path, { muteHttpExceptions: true });
      const code = res.getResponseCode();
      if (code === 200) return JSON.parse(res.getContentText());
      err = new Error('Gamma API ' + code + ': ' + path);
    } catch (e) { err = e; }
    Utilities.sleep(1000 * (i + 1));
  }
  throw err;
}

function pmJsonArr_(s) {
  if (Array.isArray(s)) return s;
  try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}
const pmRound_ = (x, n) => { const k = Math.pow(10, n); return Math.round(Number(x || 0) * k) / k; };

/** Gamma の市場1件を、記録に使う形にする (使えない市場は null) */
function pmParse_(m) {
  if (!m || m.id == null) return null;
  const prices = pmJsonArr_(m.outcomePrices).map(Number);
  if (!prices.length || prices.some(isNaN)) return null;
  const ev = (m.events && m.events[0]) || {};
  return {
    id: String(m.id),
    p: pmRound_(prices[0], 4),
    prices: prices,
    v24: Math.round(Number(m.volume24hr || 0)),
    liq: Math.round(Number(m.liquidityNum != null ? m.liquidityNum : m.liquidity || 0)),
    closed: !!m.closed,
    closedTime: m.closedTime || null,
    meta: {
      q: String(m.question || ''),
      s: String(m.slug || ''),
      e: String(ev.slug || ''),
      et: String(ev.title || ''),
      g: String(m.groupItemTitle || ''),
      o: pmJsonArr_(m.outcomes).map(String),
      end: m.endDate || null,
    },
  };
}

/** 決着した結果 (まだなら null)。勝った選択肢の名前、引き分け扱いは "50-50" */
function pmResult_(parsed) {
  if (!parsed || !parsed.closed) return null;
  const pr = parsed.prices;
  const win = pr.findIndex(function (x) { return x >= 0.99; });
  if (win >= 0) return parsed.meta.o[win] || String(win);
  if (pr.length === 2 && Math.abs(pr[0] - 0.5) < 0.01 && Math.abs(pr[1] - 0.5) < 0.01) return '50-50';
  return null;
}

/* ---- ドライブ (フォルダ「ポリマーケット記録」の中のファイルを名前で読み書き) ---- */
function pmFolder_() { return driveFolder_('PM_FOLDER_ID', PM_FOLDER_NAME); }
function pmRead_(name) {
  return driveRetry_(function () {
    const it = pmFolder_().getFilesByName(name);
    return it.hasNext() ? it.next().getBlob().getDataAsString('UTF-8') : '';
  });
}
function pmWrite_(name, str) {
  driveRetry_(function () {
    const folder = pmFolder_();
    const it = folder.getFilesByName(name);
    if (it.hasNext()) it.next().setContent(str);
    else folder.createFile(name, str, MimeType.PLAIN_TEXT);
  });
}
function pmLoadCatalog_() {
  const s = pmRead_('catalog.json');
  if (!s) return { v: 1, m: {} };
  const c = JSON.parse(s);   // 壊れていたら例外にする (空の台帳で上書きしないため)
  if (!c || typeof c.m !== 'object') throw new Error('catalog.json の形が正しくありません');
  return c;
}
function pmWatchIds_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('PM_WATCH') || '[]').map(String); }
  catch (e) { return []; }
}
/** id をまとめて取得 (Gamma は id を複数指定できる) */
function pmFetchByIds_(ids) {
  if (!ids.length) return [];
  return pmFetch_('/markets?' + ids.map(function (id) { return 'id=' + encodeURIComponent(id); }).join('&')) || [];
}

/** 台帳に市場の情報を入れる (初めて見た時刻・最後に見た時刻も) */
function pmTouch_(cat, x, nowIso) {
  const old = cat.m[x.id] || { f: nowIso };
  const n = Object.assign({}, old, x.meta, { l: nowIso });
  if (!n.f) n.f = nowIso;
  cat.m[x.id] = n;
}

/** 1時間ごと: 出来高上位とウォッチ中の市場の確率・出来高を記録する */
function pmRecord() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  const props = PropertiesService.getScriptProperties();
  try {
    const now = new Date(), nowIso = now.toISOString();
    const seen = {}, rows = [];
    const add = function (m) {
      const x = pmParse_(m);
      if (!x || x.closed || seen[x.id]) return null;
      seen[x.id] = x; rows.push(x);
      return x;
    };
    for (let off = 0; off < PM_TOP; off += PM_PAGE) {
      const page = pmFetch_('/markets?closed=false&active=true&order=volume24hr&ascending=false&limit=' + PM_PAGE + '&offset=' + off);
      (page || []).forEach(add);
      if (!page || page.length < PM_PAGE) break;
    }
    const watch = pmWatchIds_().filter(function (id) { return !seen[id]; });
    for (let i = 0; i < watch.length; i += PM_RESOLVE_BATCH) pmFetchByIds_(watch.slice(i, i + PM_RESOLVE_BATCH)).forEach(add);
    if (!rows.length) throw new Error('市場を1件も取得できませんでした');

    // その日のファイルに1行足す
    const day = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd');
    const name = 'snap-' + day + '.json';
    const s = pmRead_(name);
    const snap = s ? JSON.parse(s) : { d: day, cols: ['id', 'p', 'v24', 'liq'], rows: [] };
    snap.rows.push({ t: nowIso, m: rows.map(function (x) { return [x.id, x.p, x.v24, x.liq]; }) });
    pmWrite_(name, JSON.stringify(snap));

    // 台帳
    const cat = pmLoadCatalog_();
    rows.forEach(function (x) { pmTouch_(cat, x, nowIso); });
    pmWrite_('catalog.json', JSON.stringify(cat));

    const ids = Object.keys(cat.m);
    props.setProperty('PM_LAST_RUN', nowIso);
    props.setProperty('PM_LAST_COUNT', String(rows.length));
    props.setProperty('PM_CAT_N', String(ids.length));
    props.setProperty('PM_RES_N', String(ids.filter(function (id) { return cat.m[id].r != null; }).length));
    if (!props.getProperty('PM_FIRST_DAY')) props.setProperty('PM_FIRST_DAY', day);
    props.deleteProperty('PM_LAST_ERROR');
  } catch (e) {
    props.setProperty('PM_LAST_ERROR', new Date().toISOString() + ' ' + String(e));
    Logger.log('ポリマーケットの記録に失敗: ' + e);
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
  macroRefresh();   // マクロの指標も1時間ごとに取り直しておく (アプリを開いた時にすぐ出るように)
}

/** 決着を確認する市場: 結果が未記録で、締切を過ぎたか・上位から外れて6時間以上たったもの (締切の古い順) */
function pmResolveTargets_(cat, nowMs) {
  return Object.keys(cat.m).filter(function (id) {
    const x = cat.m[id];
    if (x.r != null) return false;
    const ended = x.end && Date.parse(x.end) <= nowMs;
    const gone = x.l && nowMs - Date.parse(x.l) >= 6 * 3600000;
    return ended || gone;
  }).sort(function (a, b) {
    return (Date.parse(cat.m[a].end) || 0) - (Date.parse(cat.m[b].end) || 0);
  });
}

/** 1日1回: 決着した市場の結果を台帳に記録する */
function pmResolve() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  const props = PropertiesService.getScriptProperties();
  const t0 = Date.now();
  try {
    const cat = pmLoadCatalog_();
    const nowIso = new Date().toISOString();
    const targets = pmResolveTargets_(cat, Date.now()).slice(0, PM_RESOLVE_MAX);
    let done = 0;
    for (let i = 0; i < targets.length; i += PM_RESOLVE_BATCH) {
      if (Date.now() - t0 > PM_TIME_BUDGET) break;
      pmFetchByIds_(targets.slice(i, i + PM_RESOLVE_BATCH)).forEach(function (m) {
        const x = pmParse_(m);
        const r = pmResult_(x);
        if (!x || r == null || !cat.m[x.id]) return;
        cat.m[x.id].r = r;
        cat.m[x.id].ra = x.closedTime || nowIso;
        cat.m[x.id].rp = x.prices.map(function (v) { return pmRound_(v, 4); });
        done++;
      });
    }
    if (done) pmWrite_('catalog.json', JSON.stringify(cat));
    const ids = Object.keys(cat.m);
    props.setProperty('PM_RES_N', String(ids.filter(function (id) { return cat.m[id].r != null; }).length));
    props.setProperty('PM_RESOLVE_LAST', nowIso + ' ' + done + '件');
    Logger.log('決着を記録しました: ' + done + '件 (確認 ' + targets.length + '件)');
  } catch (e) {
    props.setProperty('PM_LAST_ERROR', new Date().toISOString() + ' 決着の確認: ' + String(e));
    Logger.log('決着の確認に失敗: ' + e);
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
  pmDailyJobs_();   // 日ごとの要約・マクロの日誌 (AI に渡す記録)
}

/** 記録の状況 (アプリの「状況を確認」用。台帳は読まずに控えの数字だけ返す) */
function pmStatus_() {
  const props = PropertiesService.getScriptProperties();
  return {
    lastRun: props.getProperty('PM_LAST_RUN') || null,
    lastCount: Number(props.getProperty('PM_LAST_COUNT') || 0),
    markets: Number(props.getProperty('PM_CAT_N') || 0),
    resolved: Number(props.getProperty('PM_RES_N') || 0),
    since: props.getProperty('PM_FIRST_DAY') || null,
    resolveLast: props.getProperty('PM_RESOLVE_LAST') || null,
    error: props.getProperty('PM_LAST_ERROR') || null,
    watch: pmWatchIds_().length,
  };
}

// =====================================================================
//  Polymarket — 和訳・あなた向けの判定・ルールの要約 (Gemini)。結果はドライブに保存して使い回す
//    tr.json    … { 原文: 訳 }
//    score.json … { イベントid: { s: 0〜3 (興味との関係), c: 分野, h: 興味プロフィールの控え } }
//    rule.json  … { 市場id: { ja: 要約, h: 原文の控え } }
// =====================================================================

/** 使う Gemini のモデル (上から順に試す。使えなかったら次へ。使えたものを PM_MODEL に覚える) */
const PM_AI_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3-flash-lite', 'gemini-2.5-flash-lite', 'gemini-2.5-flash'];
const PM_TR_BATCH = 40;          // 1回の Gemini で訳す数
const PM_SC_BATCH = 30;          // 1回の Gemini で判定するイベント数
const PM_AI_BUDGET = 25000;      // アプリからの1回の問い合わせで Gemini に使う時間の上限 (ms)
const PM_AI_DAY_MAX = 400;       // 1日に Gemini を呼ぶ回数の上限 (無料枠を超えないため)
const PM_CATS = ['暗号資産', '経済・金融', '政治', '選挙', '国際情勢', 'テクノロジー', 'スポーツ', 'eスポーツ', 'エンタメ', 'その他'];
const PM_DEFAULT_PROFILE = 'ビットコイン・HYPE など暗号資産の価格、FRBの金利と米国経済、暗号資産の規制・ETF、エアドロップやトークンの発行に関わるもの';

/** 訳語をそろえるための用語集 (足す時はここに1行) */
const PM_GLOSSARY = [
  ['Fed / Federal Reserve', 'FRB'], ['rate cut', '利下げ'], ['rate hike', '利上げ'], ['bps', 'bp'],
  ['interest rates', '政策金利'], ['FOMC', 'FOMC'], ['CPI', 'CPI (消費者物価指数)'], ['recession', '景気後退'],
  ['government shutdown', '政府機関の閉鎖'], ['tariff', '関税'], ['Bitcoin / BTC', 'ビットコイン'],
  ['Ethereum / ETH', 'イーサリアム'], ['Solana / SOL', 'ソラナ'], ['Hyperliquid / HYPE', 'Hyperliquid (HYPE)'],
  ['ETF', 'ETF'], ['airdrop', 'エアドロップ'], ['token launch / TGE', 'トークン発行 (TGE)'], ['FDV', 'FDV (完全希薄化時価総額)'],
  ['market cap', '時価総額'], ['all time high / ATH', '過去最高値'], ['Up or Down', '上がるか下がるか'],
  ['Yes', 'はい'], ['No', 'いいえ'], ['Other', 'その他'], ['Draw / Tie', '引き分け'], ['Over / Under', 'オーバー / アンダー'],
  ['election', '選挙'], ['presidential', '大統領'], ['Senate', '上院'], ['House', '下院'], ['Prime Minister', '首相'],
  ['nominee', '候補'], ['ceasefire', '停戦'], ['Trump', 'トランプ'], ['Winner', '勝者'], ['Champion', '優勝'],
  ['Game 1 Winner', '第1ゲームの勝者'], ['Map 1 Winner', '第1マップの勝者'], ['BO5 / BO3', 'BO5 / BO3'],
];

function pmAiDayOk_() {
  const props = PropertiesService.getScriptProperties();
  const day = todayJst_();
  let c = {};
  try { c = JSON.parse(props.getProperty('PM_AI_DAY') || '{}'); } catch (e) {}
  if (c.d !== day) c = { d: day, n: 0 };
  if (c.n >= PM_AI_DAY_MAX) return false;
  c.n++;
  props.setProperty('PM_AI_DAY', JSON.stringify(c));
  return true;
}

/** Gemini に JSON で答えさせる (配列/オブジェクトを返す。失敗したら例外) */
function pmGemini_(sys, input, maxTokens) {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty('GEMINI_KEY');
  if (!key) throw new Error('GEMINI_KEY がありません');
  if (!pmAiDayOk_()) throw new Error('今日の Gemini の上限 (' + PM_AI_DAY_MAX + '回) に達しました');
  const saved = props.getProperty('PM_MODEL');
  const models = (saved ? [saved] : []).concat(PM_AI_MODELS.filter(function (m) { return m !== saved; }));
  const payload = JSON.stringify({
    system_instruction: { parts: [{ text: sys }] },
    contents: [{ role: 'user', parts: [{ text: typeof input === 'string' ? input : JSON.stringify(input) }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: maxTokens || 8192, responseMimeType: 'application/json' },
  });
  let res = null, lastErr = '';
  for (let i = 0; i < models.length; i++) {
    res = UrlFetchApp.fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' + models[i] + ':generateContent?key=' + encodeURIComponent(key),
      { method: 'post', contentType: 'application/json', muteHttpExceptions: true, payload: payload });
    const code = res.getResponseCode();
    if (code === 200) { if (models[i] !== saved) props.setProperty('PM_MODEL', models[i]); break; }
    lastErr = 'Gemini ' + code + ' (' + models[i] + '): ' + String(res.getContentText()).slice(0, 160);
    // モデルが無い・使えない (404 / 400 の一部) 時だけ次のモデルを試す。キーの誤りや上限は止める
    if (!(code === 404 || (code === 400 && /model/i.test(res.getContentText())))) throw new Error(lastErr);
    res = null;
  }
  if (!res) throw new Error(lastErr || 'Gemini のモデルが見つかりません');
  const d = JSON.parse(res.getContentText());
  const out = d && d.candidates && d.candidates[0] && d.candidates[0].content
    && d.candidates[0].content.parts.map(function (p) { return p.text; }).join('');
  if (!out) throw new Error('Gemini の応答が空でした');
  try { return JSON.parse(out); }
  catch (e) { const m = out.match(/[\[{][\s\S]*[\]}]/); if (m) return JSON.parse(m[0]); throw e; }
}

function pmTrPrompt_() {
  return 'あなたは Polymarket (予測市場) の英語を日本語に訳す翻訳者です。\n'
    + '入力は JSON 配列 [{"i":番号,"t":"原文"}]。出力は JSON 配列 [{"i":番号,"ja":"訳"}] だけにしてください。\n'
    + 'ルール:\n'
    + '・文の形の質問は、自然な日本語の問いかけにする (例: "Will the Fed cut rates in December?" → 「FRBは12月に利下げするか？」)\n'
    + '・短い語句 (選択肢・人名・チーム名・項目名・イベント名) は問いかけにせず、名詞のまま訳す\n'
    + '・人名・団体名・チーム名は一般的なカタカナ表記。定着した英字表記 (NBA, ETF, OpenAI など) は英字のまま\n'
    + '・数字・金額・%・時刻は変えない。日付は「12月31日」の形にする。ET などの時間帯の表記は残す\n'
    + '・説明や補足は足さない。訳せない固有名詞は原文のまま\n'
    + '・用語集 (原文 → 訳):\n' + PM_GLOSSARY.map(function (g) { return '  ' + g[0] + ' → ' + g[1]; }).join('\n');
}

function pmProfile_() {
  return PropertiesService.getScriptProperties().getProperty('PM_PROFILE') || PM_DEFAULT_PROFILE;
}
function pmHash_(s) {
  let h = 0; s = String(s || '');
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return (h >>> 0).toString(36);
}
function pmScPrompt_(likes, dislikes) {
  return 'あなたは、利用者の興味に合う予測市場 (Polymarket) を選ぶ係です。\n'
    + '利用者の興味: ' + pmProfile_() + '\n'
    + (likes.length ? '利用者がウォッチに入れた例: ' + likes.join(' / ') + '\n' : '')
    + (dislikes.length ? '利用者が「興味なし」にした例: ' + dislikes.join(' / ') + '\n' : '')
    + '入力は JSON 配列 [{"i":番号,"t":"イベント名","m":"代表的な質問"}]。\n'
    + '出力は JSON 配列 [{"i":番号,"s":点数,"c":"分野"}] だけにしてください。\n'
    + '・s: 3=興味の中心そのもの / 2=関係が深い / 1=少し関係 / 0=関係なし\n'
    + '・c: 次から1つ: ' + PM_CATS.join(', ');
}
function pmRulePrompt_() {
  return 'Polymarket (予測市場) の決着ルールを、日本語で3〜5行の箇条書きに要約してください。\n'
    + '必ず含める: 何が起きたら「はい」か / 締切 (日付・時間帯) / 判定に使う情報源。\n'
    + '出力は JSON {"ja":"・…\\n・…"} だけ。用語集: ' + PM_GLOSSARY.map(function (g) { return g[0] + '→' + g[1]; }).join(', ');
}

function pmLoadJson_(name) { const s = pmRead_(name); return s ? JSON.parse(s) : {}; }
/** キャッシュに書き足す (読み直してから合わせて書く。ほかの実行の書き込みを消さないため) */
function pmMergeJson_(name, add) {
  if (!Object.keys(add).length) return;
  const lock = LockService.getScriptLock();
  const got = lock.tryLock(8000);
  try {
    const cur = pmLoadJson_(name);
    Object.keys(add).forEach(function (k) { cur[k] = add[k]; });
    pmWrite_(name, JSON.stringify(cur));
  } finally { if (got) try { lock.releaseLock(); } catch (e) {} }
}

/**
 * アプリから: 訳と「あなた向け」の点数をまとめて返す。
 * data.texts: 原文の配列 / data.events: [{id, t, m}] / data.likes, data.dislikes: 例 (イベント名)
 * 保存済みのものはすぐ返し、無いものは時間の許す範囲で Gemini に聞く
 */
function pmAi_(data) {
  const t0 = Date.now();
  const props = PropertiesService.getScriptProperties();
  const hasKey = !!props.getProperty('GEMINI_KEY');
  const texts = (Array.isArray(data.texts) ? data.texts : []).map(String).filter(function (s) { return s && s.length <= 600; }).slice(0, 400);
  const events = (Array.isArray(data.events) ? data.events : []).filter(function (e) { return e && e.id != null; }).slice(0, 200);
  const trAll = pmLoadJson_('tr.json'), scAll = pmLoadJson_('score.json');
  const h = pmHash_(pmProfile_());
  const tr = {}, sc = {}, trNew = {}, scNew = {};
  const needT = [], needE = [];
  texts.forEach(function (s) { if (trAll[s] != null) tr[s] = trAll[s]; else if (needT.indexOf(s) < 0) needT.push(s); });
  events.forEach(function (e) {
    const x = scAll[String(e.id)];
    if (x && x.h === h) sc[e.id] = { s: x.s, c: x.c }; else needE.push(e);
  });
  let error = null;
  if (hasKey) {
    try {
      for (let i = 0; i < needT.length && Date.now() - t0 < PM_AI_BUDGET; i += PM_TR_BATCH) {
        const chunk = needT.slice(i, i + PM_TR_BATCH);
        const out = pmGemini_(pmTrPrompt_(), chunk.map(function (t, j) { return { i: j, t: t }; }));
        (Array.isArray(out) ? out : []).forEach(function (o) {
          const src = chunk[Number(o && o.i)];
          if (src != null && o.ja) { tr[src] = String(o.ja); trNew[src] = String(o.ja); }
        });
      }
      const likes = (data.likes || []).map(String).slice(0, 15), dislikes = (data.dislikes || []).map(String).slice(0, 15);
      for (let i = 0; i < needE.length && Date.now() - t0 < PM_AI_BUDGET; i += PM_SC_BATCH) {
        const chunk = needE.slice(i, i + PM_SC_BATCH);
        const out = pmGemini_(pmScPrompt_(likes, dislikes), chunk.map(function (e, j) { return { i: j, t: String(e.t || ''), m: String(e.m || '') }; }), 4096);
        (Array.isArray(out) ? out : []).forEach(function (o) {
          const e = chunk[Number(o && o.i)];
          if (!e) return;
          const s = Math.max(0, Math.min(3, Math.round(Number(o.s) || 0)));
          const c = PM_CATS.indexOf(o.c) >= 0 ? o.c : 'その他';
          sc[e.id] = { s: s, c: c }; scNew[String(e.id)] = { s: s, c: c, h: h };
        });
      }
    } catch (e) { error = String(e); }
    pmMergeJson_('tr.json', trNew);
    pmMergeJson_('score.json', scNew);
  }
  const left = needT.filter(function (s) { return tr[s] == null; }).length + needE.filter(function (e) { return !sc[e.id]; }).length;
  return { ok: true, tr: tr, sc: sc, left: left, noKey: !hasKey, error: error };
}

/** アプリから: 決着ルールの日本語の要約 (市場ごとに保存) */
function pmRule_(data) {
  const id = String(data.id || ''), text = String(data.text || '').slice(0, 6000);
  if (!id || !text) return { ok: false, error: '市場の情報がありません' };
  const all = pmLoadJson_('rule.json');
  const h = pmHash_(text);
  if (all[id] && all[id].h === h) return { ok: true, ja: all[id].ja };
  if (!PropertiesService.getScriptProperties().getProperty('GEMINI_KEY')) return { ok: true, ja: null, noKey: true };
  try {
    const out = pmGemini_(pmRulePrompt_(), text, 2048);
    const ja = String(out && out.ja || '').trim();
    if (!ja) throw new Error('要約が空でした');
    const add = {}; add[id] = { ja: ja, h: h };
    pmMergeJson_('rule.json', add);
    return { ok: true, ja: ja };
  } catch (e) { return { ok: false, error: String(e) }; }
}

/** アプリから: 和訳・あなた向けの設定 (空の値は変更しない) */
function pmConfig_(data) {
  const props = PropertiesService.getScriptProperties();
  if (data.geminiKey) props.setProperty('GEMINI_KEY', String(data.geminiKey).trim());
  if (data.profile != null && String(data.profile).trim()) props.setProperty('PM_PROFILE', String(data.profile).trim().slice(0, 2000));
  if (data.model) props.setProperty('PM_MODEL', String(data.model));
  if (data.mailTo != null) {
    const to = String(data.mailTo).trim();
    if (to && !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(to)) return { ok: false, error: 'メールアドレスの形が正しくありません' };
    if (to) props.setProperty('MAIL_TO', to);
  }
  if (data.alertOn != null) props.setProperty('PM_ALERT_ON', data.alertOn ? '1' : '0');
  if (data.digestOn != null) props.setProperty('PM_DIGEST_ON', data.digestOn ? '1' : '0');
  return { ok: true, ai: pmAiStatus_(), mail: pmMailStatus_() };
}

/** アプリから: ウォッチ中の市場 (1時間ごとの記録に必ず入れる) */
function pmWatch_(data) {
  const ids = (Array.isArray(data.ids) ? data.ids : []).map(String).filter(function (x) { return /^\d+$/.test(x); }).slice(0, 200);
  PropertiesService.getScriptProperties().setProperty('PM_WATCH', JSON.stringify(ids));
  return { ok: true, watch: ids.length };
}

function pmMailStatus_() {
  const props = PropertiesService.getScriptProperties();
  return { to: props.getProperty('MAIL_TO') || '', alert: pmMailOn_('PM_ALERT_ON'), digest: pmMailOn_('PM_DIGEST_ON'),
    alertLast: props.getProperty('PM_ALERT_LAST') || null, digestLast: props.getProperty('PM_DIGEST_LAST') || null,
    scheduled: ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'pmAlert'; }) };
}
function pmAiStatus_() {
  const props = PropertiesService.getScriptProperties();
  let day = {};
  try { day = JSON.parse(props.getProperty('PM_AI_DAY') || '{}'); } catch (e) {}
  return { key: !!props.getProperty('GEMINI_KEY'), profile: pmProfile_(), today: day.d === todayJst_() ? day.n : 0, max: PM_AI_DAY_MAX };
}

/** doPost の入口から呼ぶ (Polymarket の操作は予定データのロックを取らない) */
function pmDoPost_(data) {
  if (data.action === 'pmAi') return pmAi_(data);
  if (data.action === 'pmRule') return pmRule_(data);
  if (data.action === 'pmConfig') return pmConfig_(data);
  if (data.action === 'pmWatch') return pmWatch_(data);
  if (data.action === 'pmMailTest') return pmMailTest_();
  return { ok: false, error: '不明な操作です' };
}

// =====================================================================
//  Polymarket — 通知メール (MUSE が読む Gmail へ)
//    pmAlert  … 10分おき。あなた向け (点数2以上) とウォッチの市場が大きく動いたら1通にまとめて送る
//    pmDigest … 毎朝8時。前日の大きな動き・ウォッチの今・新しく出てきたあなた向けの市場
//  送り先は Script Properties の MAIL_TO。PM_ALERT_ON / PM_DIGEST_ON が '0' なら送らない
// =====================================================================

const PM_ALERT_MINUTES = 10;
const PM_DIGEST_HOUR = 8;
const PM_ALERT_H1 = 0.10;           // 1時間で10pt以上
const PM_ALERT_D1 = 0.15;           // 24時間で15pt以上
const PM_ALERT_WATCH_H1 = 0.05;     // ウォッチ中は1時間で5pt以上
const PM_ALERT_VOL_X = 3;           // 24時間出来高が普段 (1週間の平均) の3倍以上
const PM_ALERT_MIN_VOL = 10000;     // 出来高1万ドル以上の市場に限る
const PM_ALERT_COOLDOWN = 6 * 3600000;   // 同じ市場は6時間に1回まで
const PM_ALERT_PAGES = 3;           // 確認する市場 (出来高上位300件) + ウォッチ

function pmMailOn_(key) { return PropertiesService.getScriptProperties().getProperty(key) !== '0'; }
function pmMailTo_() { return PropertiesService.getScriptProperties().getProperty('MAIL_TO') || ''; }

/** 市場の一覧を取る (出来高上位 + ウォッチ)。Gamma の生のデータ */
function pmFetchTopRaw_(pages) {
  const out = [], seen = {};
  for (let i = 0; i < pages; i++) {
    const page = pmFetch_('/markets?closed=false&active=true&order=volume24hr&ascending=false&limit=' + PM_PAGE + '&offset=' + (i * PM_PAGE)) || [];
    page.forEach(function (m) { if (m && !seen[m.id]) { seen[m.id] = 1; out.push(m); } });
    if (page.length < PM_PAGE) break;
  }
  const watch = pmWatchIds_().filter(function (id) { return !seen[id]; });
  for (let i = 0; i < watch.length; i += PM_RESOLVE_BATCH) {
    pmFetchByIds_(watch.slice(i, i + PM_RESOLVE_BATCH)).forEach(function (m) { if (m && !seen[m.id]) { seen[m.id] = 1; out.push(m); } });
  }
  return out;
}

/** 通知に使う形 */
function pmAlertRow_(m) {
  const x = pmParse_(m);
  if (!x || x.closed) return null;
  const ev = (m.events && m.events[0]) || {};
  return {
    id: x.id, ev: String(ev.id != null ? ev.id : 'm' + x.id), et: String(ev.title || m.question || ''), es: String(ev.slug || m.slug || ''),
    q: String(m.question || ''), g: String(m.groupItemTitle || ''), o: x.meta.o, p: x.p,
    h1: m.oneHourPriceChange != null ? Number(m.oneHourPriceChange) : null,
    d1: m.oneDayPriceChange != null ? Number(m.oneDayPriceChange) : null,
    v24: Number(m.volume24hr) || 0, w1: Number(m.volume1wk) || 0, end: m.endDate || null,
  };
}

/** 原文 → 日本語 (保存済みの訳。無ければ Gemini で訳して保存。だめなら原文) */
function pmJaMap_(texts) {
  const all = pmLoadJson_('tr.json'), out = {}, need = [];
  texts.forEach(function (t) { if (!t) return; if (all[t]) out[t] = all[t]; else if (need.indexOf(t) < 0) need.push(t); });
  if (need.length && PropertiesService.getScriptProperties().getProperty('GEMINI_KEY')) {
    try {
      const add = {};
      for (let i = 0; i < need.length && i < 120; i += PM_TR_BATCH) {
        const chunk = need.slice(i, i + PM_TR_BATCH);
        const r = pmGemini_(pmTrPrompt_(), chunk.map(function (t, j) { return { i: j, t: t }; }));
        (Array.isArray(r) ? r : []).forEach(function (o) { const src = chunk[Number(o && o.i)]; if (src != null && o.ja) { out[src] = String(o.ja); add[src] = String(o.ja); } });
      }
      pmMergeJson_('tr.json', add);
    } catch (e) { Logger.log('メール用の和訳に失敗: ' + e); }
  }
  texts.forEach(function (t) { if (t && !out[t]) out[t] = t; });
  return out;
}

/** あなた向けの点数 (保存済み。無いイベントは Gemini で判定して保存) */
function pmScoresFor_(rows) {
  const all = pmLoadJson_('score.json'), h = pmHash_(pmProfile_()), out = {}, need = [];
  rows.forEach(function (r) {
    const x = all[r.ev];
    if (x && x.h === h) out[r.ev] = x.s;
    else if (!need.some(function (n) { return n.id === r.ev; })) need.push({ id: r.ev, t: r.et, m: r.g || r.q });
  });
  if (need.length && PropertiesService.getScriptProperties().getProperty('GEMINI_KEY')) {
    try {
      const add = {};
      for (let i = 0; i < need.length && i < 60; i += PM_SC_BATCH) {
        const chunk = need.slice(i, i + PM_SC_BATCH);
        const r = pmGemini_(pmScPrompt_([], []), chunk.map(function (e, j) { return { i: j, t: e.t, m: e.m }; }), 4096);
        (Array.isArray(r) ? r : []).forEach(function (o) {
          const e = chunk[Number(o && o.i)]; if (!e) return;
          const s = Math.max(0, Math.min(3, Math.round(Number(o.s) || 0)));
          out[e.id] = s; add[e.id] = { s: s, c: PM_CATS.indexOf(o.c) >= 0 ? o.c : 'その他', h: h };
        });
      }
      pmMergeJson_('score.json', add);
    } catch (e) { Logger.log('メール用の判定に失敗: ' + e); }
  }
  return out;
}

/** 通知する理由 (無ければ null) */
function pmAlertReason_(r, watched) {
  if (r.v24 < PM_ALERT_MIN_VOL && !watched) return null;
  const pt = function (d) { return (d > 0 ? '▲' : '▼') + Math.abs(Math.round(d * 1000) / 10) + 'pt'; };
  if (r.h1 != null && Math.abs(r.h1) >= (watched ? PM_ALERT_WATCH_H1 : PM_ALERT_H1)) return { k: 'h1', d: r.h1, txt: '1時間で' + pt(r.h1) };
  if (r.d1 != null && Math.abs(r.d1) >= PM_ALERT_D1) return { k: 'd1', d: r.d1, txt: '24時間で' + pt(r.d1) };
  const avg = r.w1 / 7;
  if (avg > 0 && r.v24 >= PM_ALERT_MIN_VOL && r.v24 >= avg * PM_ALERT_VOL_X) return { k: 'vol', d: 0, txt: '出来高が普段の' + Math.round(r.v24 / avg * 10) / 10 + '倍' };
  return null;
}

function pmMoneyJa_(v) {
  v = Number(v) || 0;
  if (v >= 1e8) return (Math.round(v / 1e7) / 10) + '億ドル';
  if (v >= 1e4) return Math.round(v / 1e4).toLocaleString() + '万ドル';
  return Math.round(v) + 'ドル';
}
function pmPctJa_(p) { const x = p * 100; return x > 0 && x < 1 ? '1%未満' : x > 99 && x < 100 ? '99%超' : Math.round(x) + '%'; }
function pmLabelJa_(r, ja) {
  const ev = ja[r.et] || r.et;
  if (r.g) return ev + ' ― ' + (ja[r.g] || r.g);
  return ja[r.q] || r.q;
}
function pmYesJa_(r, ja) { const o = r.o[0] || 'Yes'; return o === 'Yes' ? 'はい' : (ja[o] || o); }

/** 10分おき: 大きな動きがあればメール */
function pmAlert() {
  const props = PropertiesService.getScriptProperties();
  const to = pmMailTo_();
  if (!to || !pmMailOn_('PM_ALERT_ON')) return;
  try {
    const watchIds = pmWatchIds_();
    const rows = pmFetchTopRaw_(PM_ALERT_PAGES).map(pmAlertRow_).filter(Boolean);
    let sent = {};
    try { sent = JSON.parse(props.getProperty('PM_ALERT_SENT') || '{}'); } catch (e) {}
    const now = Date.now();
    let hits = rows.map(function (r) {
      const watched = watchIds.indexOf(r.id) >= 0;
      const why = pmAlertReason_(r, watched);
      return why && !(sent[r.id] && now - sent[r.id] < PM_ALERT_COOLDOWN) ? { r: r, why: why, watched: watched } : null;
    }).filter(Boolean);
    if (!hits.length) return;
    // あなた向け (点数2以上) とウォッチだけ
    const sc = pmScoresFor_(hits.filter(function (h) { return !h.watched; }).map(function (h) { return h.r; }));
    hits = hits.filter(function (h) { return h.watched || (sc[h.r.ev] || 0) >= 2; });
    // 同じイベントは一番大きく動いたもの1つに
    const best = {};
    hits.forEach(function (h) { const b = best[h.r.ev]; if (!b || Math.abs(h.why.d) > Math.abs(b.why.d)) best[h.r.ev] = h; });
    hits = Object.keys(best).map(function (k) { return best[k]; })
      .sort(function (a, b) { return (b.watched - a.watched) || (Math.abs(b.why.d) - Math.abs(a.why.d)); }).slice(0, 10);
    if (!hits.length) return;
    const ja = pmJaMap_([].concat.apply([], hits.map(function (h) { return [h.r.et, h.r.g, h.r.q].concat(h.r.o); })));
    const lines = hits.map(function (h) {
      const r = h.r, prev = h.why.k === 'h1' ? r.p - r.h1 : h.why.k === 'd1' ? r.p - r.d1 : null;
      return {
        title: pmLabelJa_(r, ja), en: r.g ? r.et + ' ― ' + r.g : r.q,
        now: pmYesJa_(r, ja) + ' ' + pmPctJa_(r.p), prev: prev != null ? pmPctJa_(Math.max(0, Math.min(1, prev))) : null,
        why: h.why.txt, vol: pmMoneyJa_(r.v24), watched: h.watched, url: 'https://polymarket.com/event/' + encodeURIComponent(r.es),
      };
    });
    const subject = '【ポリマーケット】急変 ' + lines.length + '件: ' + lines[0].title.slice(0, 40);
    const text = 'Polymarket で大きな動きがありました (' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'M/d HH:mm') + ' 日本時間)\n\n'
      + lines.map(function (l, i) {
        return (i + 1) + '. ' + (l.watched ? '⭐ ' : '') + l.title + '\n'
          + '   ' + (l.prev ? l.prev + ' → ' : '') + l.now + ' (' + l.why + ') 24時間の出来高 ' + l.vol + '\n'
          + '   原文: ' + l.en + '\n   ' + l.url;
      }).join('\n\n')
      + '\n\n※ ポリマーケット記録アプリが10分おきに確認しています。対象は「あなた向け」とウォッチ中の市場です。売買はしていません。';
    MailApp.sendEmail({ to: to, subject: subject, body: text, htmlBody: pmMailHtml_('⚡ 急変のお知らせ', lines.map(function (l) {
      return '<tr><td style="padding:10px 0;border-bottom:1px solid #e5e7eb">'
        + '<div style="font-weight:700;font-size:15px">' + (l.watched ? '⭐ ' : '') + esc(l.title) + '</div>'
        + '<div style="font-size:14px;margin-top:3px">' + (l.prev ? esc(l.prev) + ' → ' : '') + '<b>' + esc(l.now) + '</b> <span style="color:#b45309">(' + esc(l.why) + ')</span> ・ 出来高 ' + esc(l.vol) + '</div>'
        + '<div style="font-size:12px;color:#6b7280;margin-top:2px">' + esc(l.en) + ' ・ <a href="' + esc(l.url) + '">Polymarket</a></div></td></tr>';
    }).join('')) });
    hits.forEach(function (h) { sent[h.r.id] = now; });
    try { pmLogAlerts_(hits); } catch (e) { Logger.log('急変の記録に失敗: ' + e); }
    Object.keys(sent).forEach(function (k) { if (now - sent[k] > 2 * 86400000) delete sent[k]; });
    props.setProperty('PM_ALERT_SENT', JSON.stringify(sent));
    props.setProperty('PM_ALERT_LAST', new Date().toISOString() + ' ' + lines.length + '件');
  } catch (e) {
    props.setProperty('PM_LAST_ERROR', new Date().toISOString() + ' 急変の確認: ' + String(e));
    Logger.log('急変の確認に失敗: ' + e);
  }
}

function pmMailHtml_(head, rowsHtml) {
  return '<div style="font-family:-apple-system,Segoe UI,Hiragino Sans,Meiryo,sans-serif;max-width:640px;color:#111827">'
    + '<h2 style="font-size:17px;margin:0 0 6px">' + head + '</h2>'
    + '<table style="width:100%;border-collapse:collapse">' + rowsHtml + '</table>'
    + '<p style="font-size:11px;color:#9ca3af;margin-top:14px">ポリマーケット記録アプリから自動で送っています。売買はしていません。</p></div>';
}

/** 毎朝8時: まとめ */
function pmDigest() {
  const props = PropertiesService.getScriptProperties();
  const to = pmMailTo_();
  if (!to || !pmMailOn_('PM_DIGEST_ON')) return;
  try {
    const watchIds = pmWatchIds_();
    const rows = pmFetchTopRaw_(PM_ALERT_PAGES).map(pmAlertRow_).filter(Boolean);
    const sc = pmScoresFor_(rows.filter(function (r) { return watchIds.indexOf(r.id) < 0; }).slice(0, 150));
    const rel = function (r) { return watchIds.indexOf(r.id) >= 0 || (sc[r.ev] || 0) >= 2; };
    // ① あなた向けで24時間に大きく動いたもの (イベントごとに1つ・上位8)
    const best = {};
    rows.filter(function (r) { return rel(r) && r.d1 != null && Math.abs(r.d1) >= 0.05 && r.v24 >= 5000; })
      .forEach(function (r) { const b = best[r.ev]; if (!b || Math.abs(r.d1) > Math.abs(b.d1)) best[r.ev] = r; });
    const movers = Object.keys(best).map(function (k) { return best[k]; }).sort(function (a, b) { return Math.abs(b.d1) - Math.abs(a.d1); }).slice(0, 8);
    // ② ウォッチの今
    const watch = rows.filter(function (r) { return watchIds.indexOf(r.id) >= 0; });
    // ③ 新しく出てきたあなた向けの市場 (台帳で初めて見たのが24時間以内)
    let fresh = [];
    try {
      const cat = pmLoadCatalog_(), since = Date.now() - 86400000;
      const seenEv = {};
      fresh = rows.filter(function (r) {
        const c = cat.m[r.id];
        if (!c || !c.f || Date.parse(c.f) < since || (sc[r.ev] || 0) < 2 || seenEv[r.ev]) return false;
        seenEv[r.ev] = 1; return true;
      }).slice(0, 8);
    } catch (e) {}
    const st = pmStatus_();
    const ja = pmJaMap_([].concat.apply([], movers.concat(watch, fresh).map(function (r) { return [r.et, r.g, r.q].concat(r.o); })));
    const pt = function (d) { return d == null ? '' : (d >= 0 ? '▲' : '▼') + Math.abs(Math.round(d * 1000) / 10) + 'pt'; };
    const line = function (r) { return pmLabelJa_(r, ja) + ' … ' + pmYesJa_(r, ja) + ' ' + pmPctJa_(r.p) + (r.d1 != null ? ' (24時間 ' + pt(r.d1) + ')' : '') + ' ・ 出来高 ' + pmMoneyJa_(r.v24); };
    const sec = function (title, list, empty) { return '■ ' + title + '\n' + (list.length ? list.map(function (r) { return '・' + line(r) + '\n  https://polymarket.com/event/' + encodeURIComponent(r.es); }).join('\n') : '・' + empty) + '\n'; };
    const day = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'M月d日');
    let mac = null;
    try { mac = pmMacroSection_(); } catch (e) { Logger.log('天気図をまとめに入れられません: ' + e); }
    const text = day + ' のまとめ\n\n' + (mac ? mac.text + '\n' : '')
      + '■■ ポリマーケット (あなた向け・ウォッチ中の市場)\n\n'
      + sec('24時間で大きく動いた市場', movers, '大きな動きはありませんでした') + '\n'
      + sec('ウォッチ中の市場', watch, 'ウォッチ中の市場はありません (アプリで ☆ を押すと入ります)') + '\n'
      + sec('新しく出てきた市場', fresh, 'ありませんでした') + '\n'
      + '■ 記録の状況\n・台帳 ' + st.markets + '件 ／ 決着済み ' + st.resolved + '件' + (st.since ? ' ／ ' + st.since + ' から記録中' : '') + (st.error ? '\n・⚠ ' + st.error : '') + '\n\n'
      + '※ ポリマーケット記録アプリが毎朝' + PM_DIGEST_HOUR + '時に送っています。売買はしていません。';
    const h = function (title, list, empty) {
      return '<tr><td style="padding:14px 0 4px;font-weight:700;font-size:15px">' + title + '</td></tr>'
        + (list.length ? list.map(function (r) {
          return '<tr><td style="padding:6px 0;border-bottom:1px solid #f1f5f9;font-size:14px">' + esc(pmLabelJa_(r, ja))
            + '<div style="color:#374151">' + esc(pmYesJa_(r, ja)) + ' <b>' + pmPctJa_(r.p) + '</b> ' + (r.d1 != null ? '<span style="color:' + (r.d1 >= 0 ? '#15803d' : '#b91c1c') + '">' + pt(r.d1) + '</span>' : '')
            + ' ・ 出来高 ' + pmMoneyJa_(r.v24) + ' ・ <a href="https://polymarket.com/event/' + esc(encodeURIComponent(r.es)) + '">開く</a></div></td></tr>';
        }).join('') : '<tr><td style="color:#6b7280;font-size:13px">' + empty + '</td></tr>');
    };
    MailApp.sendEmail({
      to: to, subject: '【ポリマーケット】' + day + 'のまとめ' + (mac ? ' ' + mac.sky[1] + mac.sky[2] : '') + (movers.length ? ' — 大きな動き' + movers.length + '件' : ''), body: text,
      htmlBody: pmMailHtml_('🗞 ' + day + ' のまとめ', (mac ? '<tr><td style="padding:6px 0 2px;font-weight:700;font-size:15px">🌐 相場の天気図</td></tr>' + mac.html : '') + h('📈 24時間で大きく動いた市場', movers, '大きな動きはありませんでした')
        + h('⭐ ウォッチ中の市場', watch, 'ウォッチ中の市場はありません') + h('🆕 新しく出てきた市場', fresh, 'ありませんでした')),
    });
    props.setProperty('PM_DIGEST_LAST', new Date().toISOString());
  } catch (e) {
    props.setProperty('PM_LAST_ERROR', new Date().toISOString() + ' 毎朝のまとめ: ' + String(e));
    Logger.log('毎朝のまとめに失敗: ' + e);
  }
}

/** アプリの「テスト送信」 */
function pmMailTest_() {
  const to = pmMailTo_();
  if (!to) return { ok: false, error: '送り先のメールアドレスが未設定です' };
  MailApp.sendEmail({ to: to, subject: '【ポリマーケット】テスト送信', body: 'ポリマーケット記録アプリからのテストです。このメールが届いていれば、急変の通知と毎朝のまとめもここに届きます。',
    htmlBody: pmMailHtml_('✅ テスト送信', '<tr><td style="font-size:14px">このメールが届いていれば、急変の通知と毎朝のまとめもここに届きます。</td></tr>') });
  return { ok: true, to: to };
}

// =====================================================================
//  マクロ — 金利・お金の量・ドル・不安・物価景気・株商品・暗号資産の指標をまとめて取る
//  (ブラウザから直接取ると不安定なので、サーバーで取ってドライブ「ポリマーケット記録」の macro.json に保存)
//    FRED (fredgraph.csv, キー不要) / Hyperliquid (価格・ファンディング) / DefiLlama (ステーブルコイン) / alternative.me (恐怖と強欲指数)
// =====================================================================

const MACRO_FRED = ['DFF', 'DFEDTARU', 'SOFR', 'IORB', 'DGS2', 'DGS10', 'T10Y2Y', 'WALCL', 'RRPONTSYD', 'WRESBAL', 'WTREGEN',
  'DTWEXBGS', 'DEXJPUS', 'VIXCLS', 'BAMLH0A0HYM2', 'CPIAUCSL', 'CPILFESL', 'UNRATE', 'SP500', 'NASDAQCOM', 'DCOILWTICO'];
const MACRO_DAYS = 500;                 // 取る期間 (日)。前年比・200日平均・サームルール (15か月) に足りる長さ
const MACRO_FRED_TTL = 6 * 3600000;     // FRED は6時間ごとに取り直す (多くは1日1回の更新)
const MACRO_FAST_TTL = 30 * 60000;      // 価格などは30分ごと
const MACRO_COINS = ['BTC', 'ETH', 'HYPE', 'PAXG'];

function macroFetchText_(url, opt) {
  let err;
  for (let i = 0; i < 2; i++) {
    try {
      const res = UrlFetchApp.fetch(url, Object.assign({ muteHttpExceptions: true }, opt || {}));
      if (res.getResponseCode() === 200) return res.getContentText();
      err = new Error(res.getResponseCode() + ': ' + url);
    } catch (e) { err = e; }
    Utilities.sleep(800);
  }
  throw err;
}
/** FRED の CSV → [[日付, 値], ...] (空の値は飛ばす) */
function macroParseCsv_(text) {
  return String(text || '').split(/\r?\n/).slice(1).map(function (l) {
    const c = l.split(',');
    const v = Number(c[1]);
    return c[0] && c[1] && c[1] !== '.' && !isNaN(v) ? [c[0], v] : null;
  }).filter(Boolean);
}
function macroFred_(id) {
  const since = Utilities.formatDate(new Date(Date.now() - MACRO_DAYS * 86400000), 'Asia/Tokyo', 'yyyy-MM-dd');
  return macroParseCsv_(macroFetchText_('https://fred.stlouisfed.org/graph/fredgraph.csv?id=' + id + '&cosd=' + since));
}
function macroHl_(body) {
  return JSON.parse(macroFetchText_('https://api.hyperliquid.xyz/info', { method: 'post', contentType: 'application/json', payload: JSON.stringify(body) }));
}
/** 暗号資産: 日足の終値 (Hyperliquid) と、いまの価格・ファンディング */
function macroCrypto_() {
  const out = { series: {}, now: {} };
  const meta = macroHl_({ type: 'metaAndAssetCtxs' });
  const names = meta[0].universe.map(function (u) { return u.name; });
  MACRO_COINS.forEach(function (c) {
    const i = names.indexOf(c);
    if (i < 0) return;
    const x = meta[1][i];
    out.now[c] = { px: Number(x.markPx), prev: Number(x.prevDayPx), funding: Number(x.funding), oi: Number(x.openInterest) * Number(x.markPx) };
    try {
      const cs = macroHl_({ type: 'candleSnapshot', req: { coin: c, interval: '1d', startTime: Date.now() - MACRO_DAYS * 86400000, endTime: Date.now() } });
      out.series[c] = cs.map(function (k) { return [Utilities.formatDate(new Date(k.t), 'Asia/Tokyo', 'yyyy-MM-dd'), Number(k.c)]; });
    } catch (e) { Logger.log(c + ' の日足を取得できません: ' + e); }
  });
  return out;
}
function macroStable_() {
  const a = JSON.parse(macroFetchText_('https://stablecoins.llama.fi/stablecoincharts/all'));
  return a.slice(-MACRO_DAYS).map(function (r) {
    return [Utilities.formatDate(new Date(Number(r.date) * 1000), 'Asia/Tokyo', 'yyyy-MM-dd'), Math.round((r.totalCirculating || r.totalCirculatingUSD || {}).peggedUSD || 0)];
  }).filter(function (r) { return r[1] > 0; });
}
function macroFng_() {
  const d = JSON.parse(macroFetchText_('https://api.alternative.me/fng/?limit=' + MACRO_DAYS));
  return (d.data || []).map(function (r) { return [Utilities.formatDate(new Date(Number(r.timestamp) * 1000), 'Asia/Tokyo', 'yyyy-MM-dd'), Number(r.value)]; }).reverse();
}

/** 保存してあるものが古ければ取り直す。force なら必ず取り直す。失敗した部分は前回の値を使う */
function macroData_(force) {
  let cur = {};
  try { cur = pmLoadJson_('macro.json') || {}; } catch (e) { cur = {}; }
  const now = Date.now();
  const errors = [];
  let changed = false;
  if (force || !cur.fredAt || now - cur.fredAt > MACRO_FRED_TTL) {
    const fred = cur.fred || {};
    MACRO_FRED.forEach(function (id) {
      try { const s = macroFred_(id); if (s.length) fred[id] = s; } catch (e) { errors.push('FRED ' + id); }
    });
    try { const s = macroStable_(); if (s.length) cur.stable = s; } catch (e) { errors.push('ステーブルコイン'); }
    cur.fred = fred; cur.fredAt = now; changed = true;
  }
  if (force || !cur.fastAt || now - cur.fastAt > MACRO_FAST_TTL) {
    try { cur.crypto = macroCrypto_(); } catch (e) { errors.push('暗号資産 (Hyperliquid)'); }
    try { const f = macroFng_(); if (f.length) cur.fng = f; } catch (e) { errors.push('恐怖と強欲指数'); }
    cur.fastAt = now; changed = true;
  }
  if (errors.length) cur.errors = errors; else delete cur.errors;
  if (changed) { try { pmWrite_('macro.json', JSON.stringify(cur)); } catch (e) { Logger.log('macro.json を保存できません: ' + e); } }
  return cur;
}
/** トリガー (1時間ごとの記録) からも温めておく */
function macroRefresh() { try { macroData_(false); } catch (e) { Logger.log('マクロの取得に失敗: ' + e); } }
/* ===== マクロの計算 (この囲みの中は index.html と gas/Code.gs でまったく同じ内容にする。画面に関わるものは入れない) ===== */
const mcLast = s => s && s.length ? s[s.length-1] : null;
/** n日前 (以前で一番近い) の値 */
function mcAgo(s, days){
  if(!s || !s.length) return null;
  const t = Date.parse(mcLast(s)[0]) - days*86400000;
  for(let i=s.length-1;i>=0;i--) if(Date.parse(s[i][0]) <= t) return s[i];
  return null;
}
function mcYoY(s){ const l = mcLast(s), a = mcAgo(s, 360); return l && a ? (l[1]/a[1]-1)*100 : null; }
function mcMA(s, n){ if(!s || s.length < n) return null; let x = 0; for(let i=s.length-n;i<s.length;i++) x += s[i][1]; return x/n; }
/** 単位を「10億ドル」にそろえる (FRED は系列によって100万ドル単位) */
function mcBil(s){ if(!s || !s.length) return s; const v = Math.abs(mcLast(s)[1]); return v > 100000 ? s.map(r=>[r[0], r[1]/1000]) : s; }
function mcMoney(bil){
  if(bil == null || isNaN(bil)) return "-";
  const v = bil*1e9, a = Math.abs(v);
  if(a >= 1e12) return (v/1e12).toFixed(2) + "兆ドル";
  if(a >= 1e8) return Math.round(v/1e8).toLocaleString() + "億ドル";
  return Math.round(v).toLocaleString() + "ドル";
}
const mcPct = (x, d) => x == null || isNaN(x) ? "-" : (x >= 0 ? "+" : "") + x.toFixed(d == null ? 1 : d) + "%";
const mcBp = x => x == null || isNaN(x) ? "-" : (x >= 0 ? "+" : "") + Math.round(x*100) + "bp";
const mcNum = (x, d) => x == null || isNaN(x) ? "-" : Number(x).toLocaleString(undefined, { minimumFractionDigits: d||0, maximumFractionDigits: d||0 });
const mcDate = s => { const d = new Date(s + "T00:00:00Z"); return isNaN(d) ? "" : `${d.getUTCMonth()+1}/${d.getUTCDate()}`; };
/** 正味の流動性 = FRB総資産 − 財務省口座 − リバースレポ (週ごと) */
function mcNetLiq(f){
  const w = mcBil(f.WALCL), t = mcBil(f.WTREGEN), r = mcBil(f.RRPONTSYD);
  if(!w || !t || !r) return null;
  const at = (s, d) => { let v = null; for(const x of s){ if(x[0] <= d) v = x[1]; else break; } return v; };
  return w.map(([d, v])=>{ const a = at(t, d), b = at(r, d); return a == null || b == null ? null : [d, v - a - b]; }).filter(Boolean);
}
/* 指標の定義: id, テーマ, 名前, 用語, 計算 (データ → {v 値, sub 変化, s 推移, d 日付, sig 'g'|'y'|'r', why 理由}) */
const MC_THEMES = [["rate","🏦 金利"],["money","💧 お金の量"],["fx","💱 ドルと円"],["fear","😨 不安の度合い"],["econ","📊 物価と景気"],["mkt","📈 株と商品"],["crypto","🪙 暗号資産"]];
const MC_DEFS = [
  { id:"ff", th:"rate", n:"政策金利 (FF金利)", t:"ffrate", f:D=>{ const s = D.fred.DFF, l = mcLast(s), a = mcAgo(s, 91), up = mcLast(D.fred.DFEDTARU);
      return l && { v: l[1].toFixed(2) + "%", sub: (up ? `目標の上限 ${up[1].toFixed(2)}%` : "") + (a ? ` ／ 3か月 ${mcBp(l[1]-a[1])}` : ""), s, d: l[0] }; } },
  { id:"sofr", th:"rate", n:"SOFR − IORB", t:"sofr", f:D=>{ const s = D.fred.SOFR, i = mcLast(D.fred.IORB), l = mcLast(s); if(!l || !i) return null;
      const sp = l[1] - i[1];
      return { v: mcBp(sp), sub: `SOFR ${l[1].toFixed(2)}% ／ IORB ${i[1].toFixed(2)}%`, s, d: l[0],
        sig: sp > 0 ? "r" : sp > -0.05 ? "y" : "g", why: sp > 0 ? "SOFR が IORB を上回っている: 短期のお金がひっ迫気味" : sp > -0.05 ? "差が小さい: 短期のお金にやや余裕が少ない" : "短期のお金は落ち着いている" }; } },
  { id:"dgs2", th:"rate", n:"2年国債利回り", t:"yield", f:D=>{ const s = D.fred.DGS2, l = mcLast(s), a = mcAgo(s, 30);
      return l && { v: l[1].toFixed(2) + "%", sub: a ? `1か月 ${mcBp(l[1]-a[1])} (政策金利の予想を映す)` : "", s, d: l[0] }; } },
  { id:"dgs10", th:"rate", n:"10年国債利回り", t:"yield", f:D=>{ const s = D.fred.DGS10, l = mcLast(s), a = mcAgo(s, 30); if(!l) return null; const ch = a ? l[1]-a[1] : 0;
      return { v: l[1].toFixed(2) + "%", sub: a ? `1か月 ${mcBp(ch)}` : "", s, d: l[0],
        sig: ch > 0.3 ? "r" : ch < -0.3 ? "g" : "y", why: ch > 0.3 ? "1か月で大きく上昇: 株や暗号資産には逆風になりやすい" : ch < -0.3 ? "1か月で大きく低下: 借りる費用が下がる (景気不安の場合も)" : "大きな動きはない" }; } },
  { id:"curve", th:"rate", n:"長短金利差 (10年−2年)", t:"curve", f:D=>{ const s = D.fred.T10Y2Y, l = mcLast(s), a = mcAgo(s, 91); if(!l) return null;
      return { v: mcBp(l[1]).replace("+",""), sub: a ? `3か月前 ${Math.round(a[1]*100)}bp` : "", s, d: l[0],
        sig: l[1] < 0 ? "r" : l[1] < 0.5 ? "y" : "g", why: l[1] < 0 ? "逆イールド: 景気後退の前触れとされる形" : l[1] < 0.5 ? "差が小さい: 逆イールドからの戻り途中など、景気の転換点に注意" : "普通の形 (長期のほうが高い)" }; } },
  { id:"netliq", th:"money", n:"正味の流動性", t:"netliq", f:D=>{ const s = mcNetLiq(D.fred), l = mcLast(s), a = mcAgo(s, 28); if(!l) return null; const ch = a ? l[1]-a[1] : 0;
      return { v: mcMoney(l[1]), sub: a ? `4週 ${ch >= 0 ? "+" : ""}${mcMoney(ch)}` : "", s, d: l[0],
        sig: ch > 50 ? "g" : ch < -50 ? "r" : "y", why: ch > 50 ? "市場のお金が増えている: リスク資産に追い風" : ch < -50 ? "市場のお金が減っている: リスク資産に逆風" : "大きな変化はない" }; } },
  { id:"walcl", th:"money", n:"FRB 総資産", t:"walcl", f:D=>{ const s = mcBil(D.fred.WALCL), l = mcLast(s), a = mcAgo(s, 28); if(!l) return null;
      return { v: mcMoney(l[1]), sub: a ? `4週 ${l[1]-a[1] >= 0 ? "+" : ""}${mcMoney(l[1]-a[1])}` + (l[1] < a[1] ? " (量的引き締め中)" : "") : "", s, d: l[0] }; } },
  { id:"rrp", th:"money", n:"リバースレポ残高", t:"rrp", f:D=>{ const s = mcBil(D.fred.RRPONTSYD), l = mcLast(s), a = mcAgo(s, 30); if(!l) return null;
      return { v: mcMoney(l[1]), sub: a ? `1か月 ${l[1]-a[1] >= 0 ? "+" : ""}${mcMoney(l[1]-a[1])}` + (l[1] < 50 ? " ・ ほぼ使い切り" : "") : "", s, d: l[0] }; } },
  { id:"res", th:"money", n:"準備預金", t:"reserves", f:D=>{ const s = mcBil(D.fred.WRESBAL), l = mcLast(s), a = mcAgo(s, 28); if(!l) return null;
      return { v: mcMoney(l[1]), sub: a ? `4週 ${l[1]-a[1] >= 0 ? "+" : ""}${mcMoney(l[1]-a[1])}` : "", s, d: l[0] }; } },
  { id:"tga", th:"money", n:"財務省口座 (TGA)", t:"tga", f:D=>{ const s = mcBil(D.fred.WTREGEN), l = mcLast(s), a = mcAgo(s, 28); if(!l) return null; const ch = a ? l[1]-a[1] : 0;
      return { v: mcMoney(l[1]), sub: a ? `4週 ${ch >= 0 ? "+" : ""}${mcMoney(ch)}` : "", s, d: l[0],
        sig: ch > 150 ? "r" : ch < -150 ? "g" : null, why: ch > 150 ? "政府の口座にお金が集まり、市場から吸い上げている" : ch < -150 ? "政府の支払いで市場にお金が戻っている" : "" }; } },
  { id:"dxy", th:"fx", n:"ドル指数 (広義)", t:"dxy", f:D=>{ const s = D.fred.DTWEXBGS, l = mcLast(s), a = mcAgo(s, 30); if(!l) return null; const ch = a ? (l[1]/a[1]-1)*100 : 0;
      return { v: mcNum(l[1], 1), sub: a ? `1か月 ${mcPct(ch)}` : "", s, d: l[0],
        sig: ch > 2 ? "r" : ch < -2 ? "g" : "y", why: ch > 2 ? "ドル高が進んでいる: リスク資産に逆風" : ch < -2 ? "ドル安が進んでいる: リスク資産に追い風" : "大きな動きはない" }; } },
  { id:"jpy", th:"fx", n:"ドル円", t:"usdjpy", f:D=>{ const s = D.fred.DEXJPUS, l = mcLast(s), a = mcAgo(s, 30); if(!l) return null; const ch = a ? (l[1]/a[1]-1)*100 : 0;
      return { v: mcNum(l[1], 2) + "円", sub: a ? `1か月 ${mcPct(ch)} (${ch >= 0 ? "円安" : "円高"})` : "", s, d: l[0],
        sig: ch < -4 ? "r" : null, why: ch < -4 ? "急な円高: 円キャリートレードの巻き戻しで相場が揺れることがある" : "" }; } },
  { id:"vix", th:"fear", n:"VIX (恐怖指数)", t:"vix", f:D=>{ const s = D.fred.VIXCLS, l = mcLast(s); if(!l) return null;
      return { v: mcNum(l[1], 1), sub: "15以下: 落ち着き ／ 30超: 強い不安", s, d: l[0],
        sig: l[1] < 15 ? "g" : l[1] <= 25 ? "y" : "r", why: l[1] < 15 ? "市場は落ち着いている" : l[1] <= 25 ? "やや不安" : "強い不安 (リスクオフ)" }; } },
  { id:"hy", th:"fear", n:"ハイイールド債スプレッド", t:"hy", f:D=>{ const s = D.fred.BAMLH0A0HYM2, l = mcLast(s), a = mcAgo(s, 30); if(!l) return null;
      return { v: l[1].toFixed(2) + "%", sub: a ? `1か月 ${mcBp(l[1]-a[1])}` : "", s, d: l[0],
        sig: l[1] < 3.5 ? "g" : l[1] <= 5 ? "y" : "r", why: l[1] < 3.5 ? "倒産の心配は小さい" : l[1] <= 5 ? "やや心配が出ている" : "倒産の心配が強い (リスクオフ)" }; } },
  { id:"cpi", th:"econ", n:"CPI (前年比)", t:"cpi", f:D=>{ const s = D.fred.CPIAUCSL; if(!s || s.length < 14) return null;
      const y = s.slice(12).map((r,i)=>[r[0], (r[1]/s[i][1]-1)*100]), l = mcLast(y), p = y[y.length-2];
      return { v: l[1].toFixed(1) + "%", sub: p ? `前の月 ${p[1].toFixed(1)}% ／ FRB の目標 2%` : "", s: y, d: l[0], mon: true,
        sig: l[1] <= 2.5 ? "g" : l[1] <= 3.5 ? "y" : "r", why: l[1] <= 2.5 ? "物価は目標に近い" : l[1] <= 3.5 ? "目標よりやや高い" : "物価が高い: 利下げしにくい" }; } },
  { id:"core", th:"econ", n:"コアCPI (前年比)", t:"core", f:D=>{ const s = D.fred.CPILFESL; if(!s || s.length < 14) return null;
      const y = s.slice(12).map((r,i)=>[r[0], (r[1]/s[i][1]-1)*100]), l = mcLast(y), p = y[y.length-2];
      return { v: l[1].toFixed(1) + "%", sub: p ? `前の月 ${p[1].toFixed(1)}%` : "", s: y, d: l[0], mon: true }; } },
  { id:"unrate", th:"econ", n:"失業率", t:"unrate", f:D=>{ const s = D.fred.UNRATE; if(!s || s.length < 15) return null;
      const l = mcLast(s), avg3 = (s[s.length-1][1] + s[s.length-2][1] + s[s.length-3][1]) / 3;
      const min12 = Math.min(...s.slice(-15, -3).map(r=>r[1])), sahm = avg3 - min12;
      return { v: l[1].toFixed(1) + "%", sub: `サームルールの値 ${sahm >= 0 ? "+" : ""}${sahm.toFixed(2)} (0.5で景気後退のサイン)`, s, d: l[0], mon: true,
        sig: sahm >= 0.5 ? "r" : sahm >= 0.3 ? "y" : "g", why: sahm >= 0.5 ? "サームルールに達した: 景気後退のサイン" : sahm >= 0.3 ? "失業率がじわりと上昇" : "雇用は安定" }; } },
  ...[["sp500","S&P500","SP500","sp500"],["nasdaq","ナスダック","NASDAQCOM","nasdaq"]].map(([id,n,k,t])=>({ id, th:"mkt", n, t, f:D=>{
      const s = D.fred[k], l = mcLast(s), a = mcAgo(s, 30), ma = mcMA(s, 200); if(!l) return null;
      return { v: mcNum(l[1]), sub: (a ? `1か月 ${mcPct((l[1]/a[1]-1)*100)}` : "") + (ma ? ` ／ 200日平均 ${mcNum(ma)}` : ""), s, d: l[0],
        sig: ma ? (l[1] >= ma ? "g" : "r") : null, why: ma ? (l[1] >= ma ? "200日平均より上: 上昇の流れ" : "200日平均より下: 下落の流れ") : "" }; } })),
  { id:"wti", th:"mkt", n:"原油 (WTI)", t:"wti", f:D=>{ const s = D.fred.DCOILWTICO, l = mcLast(s), a = mcAgo(s, 30); if(!l) return null;
      return { v: "$" + mcNum(l[1], 2), sub: a ? `1か月 ${mcPct((l[1]/a[1]-1)*100)}` : "", s, d: l[0] }; } },
  ...[["btc","ビットコイン","BTC","btc"],["eth","イーサリアム","ETH","btc"],["hype","HYPE","HYPE","btc"],["gold","金 (PAXG)","PAXG","gold"]].map(([id,n,k,t])=>({ id, th: id === "gold" ? "mkt" : "crypto", n, t, f:D=>{
      const c = D.crypto || {}, s = (c.series||{})[k], now = (c.now||{})[k]; if(!s && !now) return null;
      const px = now ? now.px : mcLast(s)[1], a = mcAgo(s, 30), ma = mcMA(s, 200);
      const dd = now && now.prev ? (px/now.prev-1)*100 : null;
      return { v: "$" + mcNum(px, px < 100 ? 2 : 0), sub: [dd != null ? `24時間 ${mcPct(dd)}` : "", a ? `1か月 ${mcPct((px/a[1]-1)*100)}` : ""].filter(Boolean).join(" ／ "), s, d: s ? mcLast(s)[0] : "",
        sig: id === "gold" ? null : ma ? (px >= ma ? "g" : "r") : null, why: id === "gold" || !ma ? "" : px >= ma ? `200日平均 ($${mcNum(ma)}) より上: 上昇の流れ` : `200日平均 ($${mcNum(ma)}) より下: 下落の流れ` }; } })),
  { id:"stable", th:"crypto", n:"ステーブルコインの総額", t:"stable", f:D=>{ const s = D.stable && D.stable.map(r=>[r[0], r[1]/1e9]), l = mcLast(s), a = mcAgo(s, 30); if(!l) return null; const ch = a ? (l[1]/a[1]-1)*100 : 0;
      return { v: mcMoney(l[1]), sub: a ? `30日 ${mcPct(ch)}` : "", s, d: l[0],
        sig: ch > 1 ? "g" : ch < -1 ? "r" : "y", why: ch > 1 ? "暗号資産にお金が入ってきている" : ch < -1 ? "暗号資産からお金が出ていっている" : "大きな変化はない" }; } },
  { id:"fng", th:"crypto", n:"恐怖と強欲指数", t:"fng", f:D=>{ const s = D.fng, l = mcLast(s); if(!l) return null;
      const lab = l[1] <= 24 ? "極端な恐怖" : l[1] <= 44 ? "恐怖" : l[1] <= 55 ? "中立" : l[1] <= 74 ? "強欲" : "極端な強欲";
      return { v: l[1] + " " + lab, sub: "0: 極端な恐怖 〜 100: 極端な強欲", s, d: l[0],
        sig: l[1] <= 24 ? "y" : l[1] >= 75 ? "r" : "g", why: l[1] <= 24 ? "売られすぎの目安にされる水準 (逆張りの参考)" : l[1] >= 75 ? "買われすぎ・過熱" : "極端ではない" }; } },
  { id:"funding", th:"crypto", n:"ファンディングレート (BTC)", t:"funding", f:D=>{ const n = ((D.crypto||{}).now||{}).BTC; if(!n || n.funding == null) return null;
      const r8 = n.funding*8*100, yr = n.funding*24*365*100, h = ((D.crypto||{}).now||{}).HYPE, e = ((D.crypto||{}).now||{}).ETH;
      return { v: (r8 >= 0 ? "+" : "") + r8.toFixed(4) + "%", sub: `8時間あたり ／ 年率 ${mcPct(yr)}` + (e ? ` ／ ETH ${(e.funding*800).toFixed(4)}%` : "") + (h ? ` ／ HYPE ${(h.funding*800).toFixed(4)}%` : ""), d: "",
        sig: r8 > 0.03 ? "r" : r8 < 0 ? "y" : "g", why: r8 > 0.03 ? "買いが過熱気味" : r8 < 0 ? "売りが優勢" : "落ち着いた水準" }; } },
];
const MC_SIG = { g:"🟢", y:"🟡", r:"🔴" };
function mcEval(def, D){ try{ return def.f(D) || null; }catch(e){ return null; } }
/* ---- 相場の天気図: 信号を重み付きで足して、追い風 (リスクオン) か向かい風 (リスクオフ) かを出す ----
   🟢 = +1 / 🟡 = 0 / 🔴 = −1 に重みを掛けて平均 (−1〜+1)。重みは影響の大きさの目安 (お金の量・不安の度合いを重く) */
const MC_WEIGHT = { netliq:2, vix:2, hy:2, sp500:1.5, unrate:1.5, curve:1, sofr:1, dgs10:1, dxy:1, cpi:1, nasdaq:1, btc:1, stable:1, tga:1, jpy:1, eth:0.5, fng:0.5, funding:0.5 };
const MC_SKY = [
  [0.4, "☀️", "晴れ", "リスクオン (追い風が強い)"],
  [0.15, "🌤", "晴れ時々くもり", "やや追い風"],
  [-0.15, "⛅", "くもり", "中立 (追い風と向かい風が混在)"],
  [-0.4, "🌧", "雨", "やや向かい風"],
  [-Infinity, "⛈", "嵐", "リスクオフ (向かい風が強い)"],
];
function mcSky(score){ return MC_SKY.find(x=>score >= x[0]); }
function mcScore(ids, res){
  let sum = 0, w = 0, n = 0;
  for(const id of ids){
    const r = res[id], wt = MC_WEIGHT[id];
    if(!wt || !r || !r.sig) continue;
    sum += wt * ({ g:1, y:0, r:-1 }[r.sig]); w += wt; n++;
  }
  return w ? { s: sum / w, n } : null;
}
/** 天気図のまとめ: 全体の点数・空・追い風/向かい風の指標 (重みの大きい順に最大4つ) */
function mcSummary(res){
  const all = mcScore(Object.keys(MC_WEIGHT), res);
  if(!all) return null;
  const pick = sig => Object.keys(MC_WEIGHT).filter(id=>res[id] && res[id].sig === sig).sort((a,b)=>MC_WEIGHT[b]-MC_WEIGHT[a]).slice(0, 4);
  return { all, sky: mcSky(all.s), good: pick("g"), bad: pick("r") };
}
function mcName(id){ return (MC_DEFS.find(d=>d.id === id) || {}).n || id; }
/* ---- 📅 経済カレンダー (FOMC・CPI・雇用統計) と、関連する Polymarket の予想 ----
   日付は公式の発表予定 (federalreserve.gov / bls.gov、2026年11月に確認)。毎年1回、翌年分を足す */
const MC_CAL = [
  // FOMC: 2日目の米東部時間14:00に発表 (日付は2日目)
  ...["2026-12-09","2027-01-27","2027-03-17","2027-04-28","2027-06-09","2027-07-28","2027-09-15","2027-10-27","2027-12-08"].map(d=>({ d, k:"fomc", h:14, m:0 })),
  // CPI: 米東部時間8:30 (ref = 対象の月)
  ...[["2026-11-10","2026-10"],["2026-12-10","2026-11"],["2027-01-13","2026-12"],["2027-02-11","2027-01"],["2027-03-10","2027-02"],["2027-04-13","2027-03"],["2027-05-12","2027-04"],
      ["2027-06-10","2027-05"],["2027-07-14","2027-06"],["2027-08-11","2027-07"],["2027-09-14","2027-08"],["2027-10-14","2027-09"],["2027-11-10","2027-10"],["2027-12-10","2027-11"]].map(([d,ref])=>({ d, ref, k:"cpi", h:8, m:30 })),
  // 雇用統計: 米東部時間8:30
  ...[["2026-11-06","2026-10"],["2026-12-04","2026-11"],["2027-01-08","2026-12"],["2027-02-05","2027-01"],["2027-03-05","2027-02"],["2027-04-02","2027-03"],["2027-05-07","2027-04"],
      ["2027-06-04","2027-05"],["2027-07-02","2027-06"],["2027-08-06","2027-07"],["2027-09-03","2027-08"],["2027-10-08","2027-09"],["2027-11-05","2027-10"],["2027-12-03","2027-11"]].map(([d,ref])=>({ d, ref, k:"jobs", h:8, m:30 })),
];
const MC_CAL_KIND = { fomc:["🏦","FOMC (政策金利の発表)","fomc"], cpi:["🛒","CPI (物価)","cpi"], jobs:["👷","雇用統計","unrate"] };
const MC_MON_EN = ["January","February","March","April","May","June","July","August","September","October","November","December"];
/** 米東部時間 → 発表の時刻 (Date)。夏時間は3月の第2日曜〜11月の第1日曜 */
function mcEtTime(d, h, m){
  const [y, mo, da] = d.split("-").map(Number);
  const nthSun = (mon, n) => { const f = new Date(Date.UTC(y, mon, 1)).getUTCDay(); return 1 + ((7 - f) % 7) + 7*(n-1); };
  const day = Date.UTC(y, mo-1, da);
  const dst = day >= Date.UTC(y, 2, nthSun(2, 2)) && day < Date.UTC(y, 10, nthSun(10, 1));
  return new Date(Date.UTC(y, mo-1, da, h + (dst ? 4 : 5), m));
}
function mcCalUpcoming(n){
  const now = Date.now();
  return MC_CAL.map(e=>Object.assign({ at: mcEtTime(e.d, e.h, e.m) }, e))
    .filter(e=>e.at.getTime() > now - 3*3600000).sort((a,b)=>a.at - b.at).slice(0, n || 6);
}
function mcCalLabel(e){
  const k = MC_CAL_KIND[e.k];
  return e.ref ? `${k[1]} ${Number(e.ref.slice(5))}月分` : k[1];
}
function mcUntil(t){
  const ms = t - Date.now();
  if(ms <= 0) return "発表済み";
  const h = ms/3600000;
  if(h < 24) return "あと" + Math.max(1, Math.round(h)) + "時間";
  return "あと" + Math.floor(h/24) + "日";
}
/* Polymarket で関連する予想市場を探す (日付が近く、言葉が合うイベント) */
function mcCalQueries(e){
  const mon = MC_MON_EN[Number((e.ref || e.d).slice(5,7)) - 1];
  if(e.k === "fomc") return ["Fed decision in " + mon, "Fed interest rates " + mon];
  if(e.k === "cpi") return [mon + " Inflation US", "CPI YoY - " + mon];
  return [mon + " jobs report", "Unemployment rate in " + mon, "US unemployment " + mon];
}
/** public-search の結果から、その発表に合う市場を選ぶ (日付が4日以内・言葉が合う・他の国は除く)。{id,t,s,opts} か null */
function mcCalPick(evs, e){
  const re = { fomc:/fed|interest rate|fomc/i, cpi:/inflation us|cpi/i, jobs:/unemployment|jobs report|payroll/i }[e.k];
  const other = /\b(uk|china|argentina|canada|euro|eurozone|japan|germany|india|brazil|turkey|australia)\b|jolts|pce|ppi/i;
  /* 同じ日に複数ある時の優先: CPI は前年比 (Annual) を、FOMC は「Fed Decision」を先に */
  const prefer = ev => e.k === "cpi" ? (/annual/i.test(ev.title) ? 2 : /yoy/i.test(ev.title) ? 1 : 0) : e.k === "fomc" ? (/fed decision/i.test(ev.title) ? 1 : 0) : 0;
  const day = Date.parse(e.d + "T12:00:00Z");
  const cand = evs.filter(ev=> re.test(ev.title || "") && !other.test(ev.title || "") && !ev.closed && Math.abs((Date.parse(ev.endDate) || 0) - day) <= 4*86400000)
    .sort((a,b)=> prefer(b) - prefer(a) || (Number(b.volume)||0) - (Number(a.volume)||0));
  const ev = cand[0];
  if(!ev) return null;
  const opts = (ev.markets || []).filter(m=>!m.closed).map(m=>{ let p = m.outcomePrices; try{ p = typeof p === "string" ? JSON.parse(p) : p; }catch(x){ p = []; }
      return { id: String(m.id), g: String(m.groupItemTitle || m.question || ""), p: Number((p || [])[0]) }; })
    .filter(o=>!isNaN(o.p)).sort((a,b)=>b.p - a.p);
  return { id: String(ev.id), t: String(ev.title || ""), s: String(ev.slug || ""), opts };
}
/* ===== マクロの計算 ここまで ===== */

// =====================================================================
//  毎朝のまとめに入れる「相場の天気図」と「これからの予定」
// =====================================================================

const MC_JA_DOW = '日月火水木金土';
function mcJstWhen_(d) {
  const t = new Date(d.getTime() + 9 * 3600000);
  return (t.getUTCMonth() + 1) + '/' + t.getUTCDate() + '(' + MC_JA_DOW[t.getUTCDay()] + ') '
    + String(t.getUTCHours()).padStart(2, '0') + ':' + String(t.getUTCMinutes()).padStart(2, '0');
}
/** 天気図と予定の文 (失敗したら null)。昨日から変わった信号も出す */
function pmMacroSection_() {
  const D = macroData_(false);
  D.fred = D.fred || {};
  const res = {};
  MC_DEFS.forEach(function (d) { res[d.id] = mcEval(d, D); });
  const sum = mcSummary(res);
  if (!sum) return null;
  const props = PropertiesService.getScriptProperties();
  const now = {};
  Object.keys(res).forEach(function (id) { if (res[id] && res[id].sig) now[id] = res[id].sig; });
  let prev = null;
  try { prev = JSON.parse(props.getProperty('PM_MC_SIG') || 'null'); } catch (e) {}
  const changed = prev && prev.sig ? Object.keys(now).filter(function (id) { return prev.sig[id] && prev.sig[id] !== now[id]; }) : [];
  props.setProperty('PM_MC_SIG', JSON.stringify({ t: Date.now(), sig: now }));
  const reason = function (id) { return mcName(id) + ' (' + (res[id].why || '') + ')'; };
  // これから7日の予定と、3日以内のものは Polymarket の予想
  const cal = mcCalUpcoming(10).filter(function (e) { return e.at.getTime() - Date.now() <= 7 * 86400000; });
  const odds = {};
  cal.forEach(function (e) {
    if (e.at.getTime() - Date.now() > 3 * 86400000) return;
    try {
      const evs = [], seen = {};
      mcCalQueries(e).forEach(function (q) {
        const r = pmFetch_('/public-search?q=' + encodeURIComponent(q) + '&limit_per_type=10&events_status=active');
        ((r && r.events) || []).forEach(function (ev) { if (!seen[ev.id]) { seen[ev.id] = 1; evs.push(ev); } });
      });
      odds[e.k + e.d] = mcCalPick(evs, e);
    } catch (err) { Logger.log('予定の予想市場を探せません: ' + err); }
  });
  const ja = pmJaMap_([].concat.apply([], Object.keys(odds).map(function (k) { return odds[k] ? odds[k].opts.slice(0, 3).map(function (o) { return o.g; }) : []; })));
  const oddsTxt = function (e) {
    const o = odds[e.k + e.d];
    return o && o.opts.length ? ' — Polymarket: ' + o.opts.slice(0, 3).map(function (x) { return (ja[x.g] || x.g) + ' ' + pmPctJa_(x.p); }).join(' ／ ') : '';
  };
  const sky = sum.sky;
  const text = '■ 相場の天気図: ' + sky[1] + ' ' + sky[2] + ' — ' + sky[3] + '\n'
    + (sum.good.length ? '・追い風: ' + sum.good.map(reason).join('、') + '\n' : '')
    + (sum.bad.length ? '・向かい風: ' + sum.bad.map(reason).join('、') + '\n' : '')
    + (changed.length ? '・昨日から変わった信号: ' + changed.map(function (id) { return mcName(id) + ' ' + MC_SIG[prev.sig[id]] + '→' + MC_SIG[now[id]]; }).join('、') + '\n' : '')
    + '\n■ これから7日の予定 (日本時間)\n'
    + (cal.length ? cal.map(function (e) { return '・' + mcJstWhen_(e.at) + ' ' + mcCalLabel(e) + oddsTxt(e); }).join('\n') : '・大きな発表はありません') + '\n';
  const html = '<tr><td style="padding:4px 0 10px"><div style="font-size:22px">' + sky[1] + ' <b>' + esc(sky[2]) + '</b></div>'
    + '<div style="color:#4b5563;font-size:13px">' + esc(sky[3]) + '</div>'
    + (sum.good.length ? '<div style="font-size:13px;margin-top:6px">🟢 追い風: ' + esc(sum.good.map(reason).join('、')) + '</div>' : '')
    + (sum.bad.length ? '<div style="font-size:13px;margin-top:4px">🔴 向かい風: ' + esc(sum.bad.map(reason).join('、')) + '</div>' : '')
    + (changed.length ? '<div style="font-size:13px;margin-top:4px">🔄 昨日から変わった信号: ' + esc(changed.map(function (id) { return mcName(id) + ' ' + MC_SIG[prev.sig[id]] + '→' + MC_SIG[now[id]]; }).join('、')) + '</div>' : '')
    + '</td></tr>'
    + '<tr><td style="padding:10px 0 4px;font-weight:700;font-size:15px">📅 これから7日の予定 (日本時間)</td></tr>'
    + (cal.length ? cal.map(function (e) { return '<tr><td style="padding:4px 0;font-size:14px;border-bottom:1px solid #f1f5f9">' + esc(mcJstWhen_(e.at) + ' ' + mcCalLabel(e)) + '<span style="color:#4b5563">' + esc(oddsTxt(e)) + '</span></td></tr>'; }).join('')
      : '<tr><td style="color:#6b7280;font-size:13px">大きな発表はありません</td></tr>');
  return { text: text, html: html, sky: sky };
}

// =====================================================================
//  AI に渡す記録 — 毎日まとめて残し、期間を選んで1つの文章 (Markdown) にする
//    daily-YYYY-MM.json … 市場ごとのその日の 始値・終値・高値・安値・24時間出来高 (1時間ごとの記録から毎晩作る)
//    macro-log.json     … 日ごとの天気図 (点数・空・信号・主な値)
//    alerts.json        … 急変の通知の記録 (1年分)
// =====================================================================

function pmJstDay_(t) { return Utilities.formatDate(new Date(t), 'Asia/Tokyo', 'yyyy-MM-dd'); }
function pmDayAdd_(ymd, n) { const p = ymd.split('-').map(Number); const d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)); return d.toISOString().slice(0, 10); }

/** 毎日 (決着の取り込みの後): まだ要約していない日の記録をまとめ、マクロの日誌に今日の1行を足す */
function pmDailyJobs_() {
  const props = PropertiesService.getScriptProperties();
  try {
    const today = pmJstDay_(Date.now());
    let day = props.getProperty('PM_DAILY_DONE');
    day = day ? pmDayAdd_(day, 1) : (props.getProperty('PM_FIRST_DAY') || today);
    let n = 0;
    while (day < today && n < 7) {   // 1回に7日分まで (止まっていた分も追いつく)
      pmSummarizeDay_(day);
      props.setProperty('PM_DAILY_DONE', day);
      day = pmDayAdd_(day, 1); n++;
    }
  } catch (e) { Logger.log('日ごとの要約に失敗: ' + e); }
  try { pmMacroLog_(); } catch (e) { Logger.log('マクロの日誌に失敗: ' + e); }
}
function pmSummarizeDay_(day) {
  const s = pmRead_('snap-' + day + '.json');
  if (!s) return;
  const snap = JSON.parse(s), out = {};
  (snap.rows || []).forEach(function (row) {
    (row.m || []).forEach(function (r) {
      const id = r[0], p = r[1], v = r[2];
      const x = out[id];
      if (!x) out[id] = [p, p, p, p, v];
      else { x[1] = p; if (p > x[2]) x[2] = p; if (p < x[3]) x[3] = p; x[4] = v; }
    });
  });
  const name = 'daily-' + day.slice(0, 7) + '.json';
  const cur = pmLoadJson_(name);
  cur[day] = out;   // [始値, 終値, 高値, 安値, 24時間出来高]
  pmWrite_(name, JSON.stringify(cur));
}
function pmMacroLog_() {
  const D = macroData_(false);
  D.fred = D.fred || {};
  const res = {};
  MC_DEFS.forEach(function (d) { res[d.id] = mcEval(d, D); });
  const sum = mcSummary(res);
  if (!sum) return;
  const sig = {}, v = {};
  MC_DEFS.forEach(function (d) { const r = res[d.id]; if (!r) return; if (r.sig) sig[d.id] = r.sig; v[d.id] = r.v; });
  const add = {};
  add[pmJstDay_(Date.now())] = { s: Math.round(sum.all.s * 100) / 100, sky: sum.sky[2], sig: sig, v: v };
  pmMergeJson_('macro-log.json', add);
}
function pmLogAlerts_(hits) {
  const cur = pmRead_('alerts.json');
  let list = cur ? JSON.parse(cur) : [];
  const now = new Date().toISOString();
  hits.forEach(function (h) {
    const r = h.r, prev = h.why.k === 'h1' ? r.p - r.h1 : h.why.k === 'd1' ? r.p - r.d1 : null;
    list.push({ t: now, id: r.id, ev: r.ev, et: r.et, g: r.g, q: r.q, p: r.p, prev: prev != null ? pmRound_(prev, 4) : null, why: h.why.txt, w: h.watched ? 1 : 0, v24: r.v24 });
  });
  const since = new Date(Date.now() - 365 * 86400000).toISOString();
  list = list.filter(function (x) { return x.t >= since; });
  pmWrite_('alerts.json', JSON.stringify(list));
}

/* ---- レポート ---- */
function pmDailyRange_(from, to) {
  const out = {};
  let m = from.slice(0, 7);
  while (m <= to.slice(0, 7)) {
    const f = pmLoadJson_('daily-' + m + '.json');
    Object.keys(f).forEach(function (d) { if (d >= from && d <= to) out[d] = f[d]; });
    const p = m.split('-').map(Number); m = p[1] === 12 ? (p[0] + 1) + '-01' : p[0] + '-' + String(p[1] + 1).padStart(2, '0');
  }
  return out;
}
const pmMdCell_ = function (x) { return String(x == null ? '' : x).replace(/\|/g, '／').replace(/\n/g, ' '); };
function pmMdTable_(head, rows) {
  if (!rows.length) return '(該当なし)\n';
  return '| ' + head.join(' | ') + ' |\n|' + head.map(function () { return '---'; }).join('|') + '|\n'
    + rows.map(function (r) { return '| ' + r.map(pmMdCell_).join(' | ') + ' |'; }).join('\n') + '\n';
}
const pmP_ = function (p) { return p == null || isNaN(p) ? '-' : (Math.round(p * 1000) / 10) + '%'; };

/**
 * AI に渡すレポート (Markdown)。opt: { days, parts: ['macro','watch','alerts','resolve'] }
 */
function pmReport_(opt) {
  const days = Math.max(1, Math.min(365, Number(opt.days) || 30));
  const parts = Array.isArray(opt.parts) && opt.parts.length ? opt.parts : ['macro', 'watch', 'alerts', 'resolve'];
  const to = pmJstDay_(Date.now()), from = pmDayAdd_(to, -days);
  const cat = pmLoadCatalog_();
  const ja = pmLoadJson_('tr.json');
  const title = function (id) {
    const c = cat.m[id] || {};
    const en = c.g ? (c.et || c.q) + ' ― ' + c.g : (c.q || id);
    const j = c.g ? (ja[c.et] || c.et || c.q) + ' ― ' + (ja[c.g] || c.g) : (ja[c.q] || c.q);
    return j && j !== en ? j + ' (' + en + ')' : en;
  };
  const daily = (parts.indexOf('watch') >= 0 || parts.indexOf('resolve') >= 0 || parts.indexOf('alerts') >= 0) ? pmDailyRange_(pmDayAdd_(from, -10), to) : {};
  const dayKeys = Object.keys(daily).sort();
  const closeOn = function (id, d) {   // その日以前で一番近い日の終値
    for (let i = dayKeys.length - 1; i >= 0; i--) if (dayKeys[i] <= d && daily[dayKeys[i]][id]) return daily[dayKeys[i]][id][1];
    return null;
  };
  const lines = [];
  lines.push('# ポリマーケット記録のレポート (' + from + ' 〜 ' + to + '・' + days + '日間)');
  lines.push('');
  lines.push('次のデータは、私が自分のアプリ (ポリマーケット記録) で自動で記録したものです。これを読んで考察してください。');
  lines.push('・マクロ環境の変化と、予測市場の確率の動きに関係はありそうか');
  lines.push('・ウォッチ中の市場で、確率が大きく動いた日と、そのきっかけになりそうな出来事');
  lines.push('・急変のあと、確率はそのまま進んだか・戻ったか (急変を信じてよい場面・よくない場面)');
  lines.push('・答え合わせから見た、予測市場の当たりやすさ・外れやすさの傾向');
  lines.push('・今後注目すべき点');
  lines.push('数字は表のとおりです。分からないことは推測と分かるように書いてください。日付は日本時間です。');
  lines.push('');

  if (parts.indexOf('macro') >= 0) {
    const log = pmLoadJson_('macro-log.json');
    const ds = Object.keys(log).filter(function (d) { return d >= from && d <= to; }).sort();
    lines.push('## 1. マクロ環境と天気図の推移');
    lines.push('天気図の点数は、各指標の信号 (🟢+1・🟡0・🔴−1) を影響の大きさで重み付けした平均 (−1 〜 +1、プラスほどリスク資産に追い風)。');
    const keys = ['vix', 'hy', 'dgs10', 'curve', 'netliq', 'dxy', 'sp500', 'btc', 'fng'];
    lines.push(pmMdTable_(['日付', '空', '点数', '🔴の指標'].concat(keys.map(mcName)),
      ds.map(function (d) { const x = log[d]; return [d, x.sky, x.s, Object.keys(x.sig || {}).filter(function (k) { return x.sig[k] === 'r'; }).map(mcName).join('・')].concat(keys.map(function (k) { return (x.v || {})[k] || ''; })); })));
    if (!ds.length) lines.push('※ マクロの日誌は、この機能を入れた日から毎朝1行ずつ貯まります。');
    lines.push('');
  }

  if (parts.indexOf('watch') >= 0) {
    const ids = pmWatchIds_();
    lines.push('## 2. ウォッチ中の市場の推移 (日ごと)');
    lines.push('確率は「はい」(または最初の選択肢) の値段。出来高は24時間の取引額 (ドル)。');
    if (!ids.length) lines.push('(ウォッチ中の市場はありません)');
    ids.forEach(function (id) {
      const rows = dayKeys.filter(function (d) { return d >= from && daily[d][id]; }).map(function (d) { const x = daily[d][id]; return [d, pmP_(x[0]), pmP_(x[1]), pmP_(x[2]), pmP_(x[3]), Math.round(x[4] || 0).toLocaleString()]; });
      const c = cat.m[id] || {};
      lines.push('### ' + title(id));
      lines.push('締切: ' + (c.end || '不明') + (c.r != null ? ' ／ 決着: ' + c.r : '') + (c.e ? ' ／ https://polymarket.com/event/' + c.e : ''));
      lines.push(pmMdTable_(['日付', '始値', '終値', '高値', '安値', '24時間出来高'], rows));
      // 大きく動いた日 (終値が前日から5pt以上)
      const big = [];
      for (let i = 1; i < rows.length; i++) { const a = parseFloat(rows[i - 1][2]), b = parseFloat(rows[i][2]); if (Math.abs(b - a) >= 5) big.push(rows[i][0] + ' (' + rows[i - 1][2] + ' → ' + rows[i][2] + ')'); }
      if (big.length) lines.push('大きく動いた日: ' + big.join('、'));
      lines.push('');
    });
  }

  if (parts.indexOf('alerts') >= 0) {
    const al = (pmRead_('alerts.json') ? JSON.parse(pmRead_('alerts.json')) : []).filter(function (a) { return a.t.slice(0, 10) >= from; });
    lines.push('## 3. 急変の記録と、その後');
    lines.push('「あなた向け」とウォッチ中の市場で通知した急変。「いま」は直近の記録 (決着していれば結果)。');
    lines.push(pmMdTable_(['日時 (UTC)', '市場', '動き', '前', '急変時', 'いま', 'その後'],
      al.map(function (a) {
        const c = cat.m[a.id] || {};
        const nowP = c.r != null ? null : closeOn(a.id, to);
        const after = c.r != null ? '決着: ' + c.r : nowP == null ? '記録なし' : (a.prev != null && (a.p - a.prev) * (nowP - a.p) > 0 ? 'さらに同じ方向' : Math.abs(nowP - a.p) < 0.03 ? 'ほぼそのまま' : '戻った');
        return [a.t.slice(0, 16).replace('T', ' '), (a.w ? '⭐ ' : '') + title(a.id), a.why, pmP_(a.prev), pmP_(a.p), c.r != null ? c.r : pmP_(nowP), after];
      })));
    lines.push('');
  }

  if (parts.indexOf('resolve') >= 0) {
    const res = Object.keys(cat.m).filter(function (id) { const c = cat.m[id]; return c.r != null && c.ra && String(c.ra).slice(0, 10) >= from; });
    lines.push('## 4. 答え合わせ (この期間に決着した市場)');
    lines.push('決着の1日前・7日前の確率 (記録がある時) と、実際の結果。');
    const rows = [], buckets = {};
    res.forEach(function (id) {
      const c = cat.m[id], d = String(c.ra).slice(0, 10);
      const p1 = closeOn(id, pmDayAdd_(d, -1)), p7 = closeOn(id, pmDayAdd_(d, -7));
      const yes = (c.o || [])[0] && c.r === c.o[0];
      rows.push([d, title(id), c.r, pmP_(p7), pmP_(p1)]);
      if (p1 != null && (c.o || []).length === 2 && c.r !== '50-50') {
        const b = Math.min(9, Math.floor(p1 * 10));
        buckets[b] = buckets[b] || { n: 0, y: 0 };
        buckets[b].n++; if (yes) buckets[b].y++;
      }
    });
    lines.push(pmMdTable_(['決着日', '市場', '結果', '7日前', '1日前'], rows.slice(0, 200)));
    if (rows.length > 200) lines.push('(ほか ' + (rows.length - 200) + '件は省略)');
    lines.push('### 確率の当たり具合 (決着1日前の確率ごと、2択の市場)');
    lines.push(pmMdTable_(['1日前の確率', '件数', '実際に「' + 'はい (最初の選択肢)' + '」だった割合'],
      Object.keys(buckets).sort(function (a, b) { return a - b; }).map(function (b) { const x = buckets[b]; return [(b * 10) + '〜' + (b * 10 + 10) + '%', x.n, Math.round(x.y / x.n * 100) + '%']; })));
    lines.push('');
  }
  const text = lines.join('\n');
  return { ok: true, text: text, chars: text.length, from: from, to: to };
}
