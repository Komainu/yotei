/**
 * マーケット記録 — Polymarket・マクロ・Hyperliquid・お金の流れ の記録と通知
 * ------------------------------------------------------------------
 * ・Polymarket の確率を1時間ごとに記録し、決着を毎日取り込む
 * ・急変の通知 (10分おき) と毎朝8時のまとめをメールで送る
 * ・マクロ指標・Hyperliquid・DefiLlama の数字を記録する
 * ・記録は Google ドライブの「ポリマーケット記録」フォルダに置く
 *
 * ■ セットアップ / 更新手順
 *  ・GitHub の main に gas/ の変更が入ると自動で反映される (docs/deploy.md)
 *  ・トリガーを登録し直す時だけ、関数「setup」を選び ▶ 実行
 *
 * ※ 以前の予定管理 (案件・Telegram・毎朝のメール・クエスト) は取り除いた。
 *    ドライブの「予定管理データ」フォルダの中身は消さずに残してあり、
 *    アプリの「旧データ (予定) をエクスポート」から読み出せる (読み出し専用)。
 */

/** このスクリプトの版数 (アプリ側で古いかどうか判定するのに使う) */
const GAS_VERSION = '2026.12.03';

// =====================================================================
//  合言葉 (API_SECRET) — URLを知っているだけではデータを読み書きできないようにする
//  ・未設定の間は誰でも使える
//  ・設定後は、GET の key / POST の JSON の key が一致した時だけ中身を返す
//  ・トリガーは doGet/doPost を通らないので影響しない
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

/** 合言葉が違う時の応答。中身は返さない (自動公開の確認用に版数だけ返す) */
function authError_() {
  return json({
    ok: false, needKey: true, version: GAS_VERSION,
    error: '合言葉が違います。アプリの設定「☁️ サーバー」に合言葉を入れてください',
  });
}

// =====================================================================
//  ドライブの共通処理 / 旧データ (予定) の読み出し
//  旧データは「予定管理データ」フォルダの ALL.json / DELETED.json。読むだけで、書き換えない。
//  (ドライブへ移す前のまま止まっている場合に備えて、Script Properties の分割保存も読める)
// =====================================================================

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

function legacyBlob_(key) {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('STORE') === 'drive') {
    const id = props.getProperty('FILE_' + key);
    if (!id) return '';
    return driveRetry_(function () {
      const f = DriveApp.getFileById(id);
      return f.isTrashed() ? '' : f.getBlob().getDataAsString('UTF-8');
    });
  }
  const n = Number(props.getProperty(key + '_N') || 0);
  let out = '';
  for (let i = 0; i < n; i++) out += (props.getProperty(key + '_' + i) || '');
  return out;
}

/** 旧データ (予定) — アプリのエクスポート用。読めない時は例外 (空とみなさない) */
function legacyData_() {
  let projects = [], deleted = {};
  try { projects = JSON.parse(legacyBlob_('ALL') || '[]') || []; } catch (e) { if (!(e instanceof SyntaxError)) throw e; }
  try { deleted = JSON.parse(legacyBlob_('DELETED') || '{}') || {}; } catch (e) { if (!(e instanceof SyntaxError)) throw e; }
  return { projects: projects, deleted: deleted };
}

// =====================================================================
//  アプリとの通信
// =====================================================================

function doPost(e) {
  try {
    const raw = (e && e.parameter && e.parameter.payload)
      ? e.parameter.payload
      : (e && e.postData ? e.postData.contents : '{}');
    const data = JSON.parse(raw) || {};

    // --- 合言葉の確認 (未設定なら素通り) ---
    if (!authOk_(data.key != null ? data.key : (e && e.parameter && e.parameter.key))) return authError_();

    // --- Polymarket などの操作 (和訳・設定・ウォッチ) ---
    if (typeof data.action === 'string' && /^pm[A-Z]/.test(data.action)) return json(pmDoPost_(data));

    // --- 合言葉を設定・変更する (未設定の時は誰でも / 設定済みなら今の合言葉が必要: 上で確認済み) ---
    if (data.action === 'setSecret') {
      const nk = String(data.newKey || '').trim();
      if (nk.length < SECRET_MIN || nk.length > 200) {
        return json({ ok: false, error: '合言葉は' + SECRET_MIN + '〜200文字にしてください' });
      }
      const lock = LockService.getScriptLock();
      lock.waitLock(20000);
      try { PropertiesService.getScriptProperties().setProperty('API_SECRET', nk); }
      finally { try { lock.releaseLock(); } catch (x) {} }
      return json({ ok: true, secretSet: true });
    }

    // 予定の保存など、以前の操作は受け付けない (古い画面が開いたままの端末から届くことがある)
    return json({ ok: false, version: GAS_VERSION, error: '予定管理の機能は終了しました。アプリを開き直してください' });
  } catch (err) {
    return json({ ok: false, version: GAS_VERSION, error: String(err) });
  }
}

function doGet(e) {
  if (!authOk_(e && e.parameter ? e.parameter.key : '')) return authError_();
  try { return doGetInner_(e); }
  catch (err) { return json({ ok: false, version: GAS_VERSION, error: String(err) }); }   // ドライブが読めない時など
}

function doGetInner_(e) {
  const action = e && e.parameter ? e.parameter.action : '';
  if (action === 'report') {
    return json(Object.assign({ version: GAS_VERSION }, pmReport_({ days: e.parameter.days, parts: String(e.parameter.parts || '').split(',').filter(Boolean) })));
  }
  if (action === 'llamaFees') {
    return json(Object.assign({ version: GAS_VERSION }, llamaFeesHist_(e.parameter.slug)));
  }
  if (action === 'llama') {
    const d = llamaData_(e.parameter.force === '1');
    return json({ ok: !!(d && d.chains), version: GAS_VERSION, llama: d });
  }
  if (action === 'hl') {
    let snap = null, err = null;
    try { snap = hlSnapshot_(); } catch (x) { err = String(x); }
    return json({ ok: !!snap, version: GAS_VERSION, error: err, snap: snap, series: hlSeries_(Number(e.parameter.hours) || 192), watch: hlWatch_(), fixed: HL_COINS });
  }
  if (action === 'health') {
    return json({ ok: true, version: GAS_VERSION, health: pmHealth_() });
  }
  if (action === 'compare') {
    return json(Object.assign({ version: GAS_VERSION }, fedCompareLatest_()));
  }
  if (action === 'macro') {
    const mac = macroData_(e.parameter.force === '1');
    try { mac.hl = hlSeries_(192); } catch (err) { mac.hl = null; }
    return json({ ok: true, version: GAS_VERSION, macro: mac });
  }
  if (action === 'load') {
    // 旧データ (予定) のエクスポート用
    const old = legacyData_();
    return json({ ok: true, version: GAS_VERSION, count: old.projects.length, projects: old.projects, deleted: old.deleted });
  }
  const base = { ok: true, version: GAS_VERSION };
  base.locked = !!apiSecret_();   // 合言葉を設定済みか (合言葉そのものは返さない)
  base.pm = pmStatus_();          // Polymarket の記録の状況
  base.pm.ai = pmAiStatus_();
  try { base.pm.health = pmHealth_(); } catch (x) { base.pm.health = null; }
  try { base.pm.mail = pmMailStatus_(); } catch (x) { base.pm.mail = null; }
  return json(base);
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// =====================================================================
//  初期設定 — トリガーを登録し直す時に実行する
// =====================================================================

/** 以前の予定管理で使っていたトリガー (残っていたら setup で止める) */
const OLD_TRIGGERS = ['sendDailyMail', 'pollTelegram', 'checkDeadlines', 'weeklyBackup'];

function setup() {
  const ours = OLD_TRIGGERS.concat(HEALTH_TRIGGERS);
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (ours.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('pmRecord').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('pmResolve')
    .timeBased().atHour(PM_RESOLVE_HOUR).everyDays(1).inTimezone('Asia/Tokyo').create();
  ScriptApp.newTrigger('pmAlert').timeBased().everyMinutes(PM_ALERT_MINUTES).create();
  ScriptApp.newTrigger('pmDigest').timeBased().atHour(PM_DIGEST_HOUR).everyDays(1).inTimezone('Asia/Tokyo').create();
  // 1回目の記録をすぐに行う
  pmRecord();
  const st = pmStatus_();
  Logger.log('Polymarket の記録 (1時間ごと)・決着の取り込み (毎日' + PM_RESOLVE_HOUR + '時)・急変の通知 (' + PM_ALERT_MINUTES + '分おき)・毎朝' + PM_DIGEST_HOUR + '時のまとめ を登録しました。'
    + (pmMailTo_() ? '通知メールの送り先: ' + pmMailTo_() + '。' : '⚠ 通知メールの送り先が未設定です (アプリの設定で入れてください)。'));
  Logger.log(st.error ? '⚠ 1回目の記録に失敗しました: ' + st.error
    : '1回目の記録: ' + st.lastCount + '件 (Googleドライブ「' + PM_FOLDER_NAME + '」)');
}

// =====================================================================
//  共通の小さな関数
// =====================================================================

function todayJst_() { return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd'); }

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
    hbOk_('record');
    props.setProperty('PM_LAST_COUNT', String(rows.length));
    props.setProperty('PM_CAT_N', String(ids.length));
    props.setProperty('PM_RES_N', String(ids.filter(function (id) { return cat.m[id].r != null; }).length));
    if (!props.getProperty('PM_FIRST_DAY')) props.setProperty('PM_FIRST_DAY', day);
    props.deleteProperty('PM_LAST_ERROR');
  } catch (e) {
    props.setProperty('PM_LAST_ERROR', new Date().toISOString() + ' ' + String(e));
    hbErr_('record', e);
    Logger.log('ポリマーケットの記録に失敗: ' + e);
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
  hbRun_('macro', function () { macroData_(false); });   // マクロの指標も1時間ごとに取り直しておく (アプリを開いた時にすぐ出るように)
  hbRun_('fed', fedCompareRecord_);
  hbRun_('hl', hlRecord_);
  try { pmHealthMail_(); } catch (e) { Logger.log('記録の見張りに失敗: ' + e); }
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
    hbOk_('resolve');
    Logger.log('決着を記録しました: ' + done + '件 (確認 ' + targets.length + '件)');
  } catch (e) {
    props.setProperty('PM_LAST_ERROR', new Date().toISOString() + ' 決着の確認: ' + String(e));
    hbErr_('resolve', e);
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
  if (data.notify === 'reset') props.deleteProperty('PM_NOTIFY');
  else if (data.notify && typeof data.notify === 'object') ntfSave_(data.notify);
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
    scheduled: ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'pmAlert'; }),
    notify: ntf_(), notifyDef: ntfDefaults_() };
}
function pmAiStatus_() {
  const props = PropertiesService.getScriptProperties();
  let day = {};
  try { day = JSON.parse(props.getProperty('PM_AI_DAY') || '{}'); } catch (e) {}
  return { key: !!props.getProperty('GEMINI_KEY'), profile: pmProfile_(), today: day.d === todayJst_() ? day.n : 0, max: PM_AI_DAY_MAX };
}

/** doPost の入口から呼ぶ */
function pmDoPost_(data) {
  if (data.action === 'pmAi') return pmAi_(data);
  if (data.action === 'pmRule') return pmRule_(data);
  if (data.action === 'pmConfig') return pmConfig_(data);
  if (data.action === 'pmWatch') return pmWatch_(data);
  if (data.action === 'pmMailTest') return pmMailTest_();
  if (data.action === 'pmHlWatch') {
    const coins = (Array.isArray(data.coins) ? data.coins : []).map(String).filter(function (c) { return /^[A-Za-z0-9:_\-]{1,20}$/.test(c); }).slice(0, 30);
    PropertiesService.getScriptProperties().setProperty('HL_WATCH', JSON.stringify(coins));
    return { ok: true, watch: coins };
  }
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
  const N = ntf_();
  if (r.v24 < N.minvol && !watched) return null;
  const pt = function (d) { return (d > 0 ? '▲' : '▼') + Math.abs(Math.round(d * 1000) / 10) + 'pt'; };
  if (r.h1 != null && Math.abs(r.h1) >= (watched ? N.wh1 : N.h1) / 100 - 1e-9) return { k: 'h1', d: r.h1, txt: '1時間で' + pt(r.h1) };
  if (r.d1 != null && Math.abs(r.d1) >= N.d1 / 100 - 1e-9) return { k: 'd1', d: r.d1, txt: '24時間で' + pt(r.d1) };
  const avg = r.w1 / 7;
  if (avg > 0 && r.v24 >= N.minvol && r.v24 >= avg * N.volx) return { k: 'vol', d: 0, txt: '出来高が普段の' + Math.round(r.v24 / avg * 10) / 10 + '倍' };
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
    hbOk_('alert');
    const NT = ntf_(), cool = NT.cool * 3600000;
    if (!NT.pm) return;
    let sent = {};
    try { sent = JSON.parse(props.getProperty('PM_ALERT_SENT') || '{}'); } catch (e) {}
    const now = Date.now();
    let hits = rows.map(function (r) {
      const watched = watchIds.indexOf(r.id) >= 0;
      const why = pmAlertReason_(r, watched);
      return why && !(sent[r.id] && now - sent[r.id] < cool) ? { r: r, why: why, watched: watched } : null;
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
    hbErr_('alert', e);
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
// ---- 毎朝のまとめに足す欄: マクロ指標の一覧 / お金の流れ ----
const pmSigned_ = function (x, unit) { return x == null || isNaN(x) ? '' : (x >= 0 ? '+' : '−') + Math.abs(Math.round(x * 10) / 10) + (unit || '%'); };
const pmMailHead_ = function (t) { return '<tr><td style="padding:16px 0 4px;font-weight:700;font-size:15px">' + t + '</td></tr>'; };
const pmMailSub_ = function (t) { return '<tr><td style="padding:10px 0 2px;font-weight:700;font-size:13px;color:#374151">' + esc(t) + '</td></tr>'; };
const pmMailRow_ = function (main, sub) {
  return '<tr><td style="padding:5px 0;border-bottom:1px solid #f1f5f9;font-size:14px">' + main + (sub ? '<div style="color:#6b7280;font-size:12.5px">' + esc(sub) + '</div>' : '') + '</td></tr>';
};

/** マクロ指標の一覧 (テーマごとに全部)。res = 指標ごとの計算結果 (pmMacroSection_ が返す) */
function pmMacroList_(res) {
  let text = '■■ マクロ指標の一覧 (🟢 追い風 / 🟡 中立 / 🔴 向かい風)\n', html = pmMailHead_('📋 マクロ指標の一覧'), n = 0;
  MC_THEMES.forEach(function (th) {
    const rows = MC_DEFS.filter(function (d) { return d.th === th[0] && res[d.id] && res[d.id].v != null; });
    if (!rows.length) return;
    text += '\n■ ' + th[1] + '\n';
    html += pmMailSub_(th[1]);
    rows.forEach(function (d) {
      const r = res[d.id], sig = r.sig ? MC_SIG[r.sig] + ' ' : '・';
      const sub = [r.sub, r.why].filter(Boolean).join(' ／ ').replace(/\s+/g, ' ').trim();
      text += sig + d.n + ': ' + r.v + (sub ? ' (' + sub + ')' : '') + '\n';
      html += pmMailRow_((r.sig ? MC_SIG[r.sig] + ' ' : '') + esc(d.n) + ' <b>' + esc(r.v) + '</b>', sub);
      n++;
    });
  });
  return n ? { text: text, html: html, n: n } : null;
}

/** お金の流れ (DefiLlama): チェーンの TVL・ステーブルコインの増減・先物 DEX・エアドロップ候補 */
function pmFlowSection_() {
  const d = llamaData_(false);
  if (!d || !d.chains || !d.chains.length) return null;
  const chg = function (r) { return [r.c1 != null ? '1日 ' + pmSigned_(r.c1) : '', r.c7 != null ? '7日 ' + pmSigned_(r.c7) : '', r.c30 != null ? '30日 ' + pmSigned_(r.c30) : ''].filter(Boolean).join('・'); };
  const top = d.chains.slice(0, 10);
  const tvlAll = d.chains.reduce(function (n, c) { return n + (c.tvl || 0); }, 0), stAll = d.chains.reduce(function (n, c) { return n + (c.st || 0); }, 0);
  // 30日で TVL が伸びているチェーン (1億ドル以上)
  const grow = d.chains.filter(function (c) { return c.c30 != null && c.tvl >= 1e8 && c.c30 > 0; }).sort(function (a, b) { return b.c30 - a.c30; }).slice(0, 5);
  // ステーブルコインの30日の増減 (ドル)
  const withSt = d.chains.filter(function (c) { return c.s30d != null; });
  const stIn = withSt.filter(function (c) { return c.s30d > 0; }).sort(function (a, b) { return b.s30d - a.s30d; }).slice(0, 5);
  const stOut = withSt.filter(function (c) { return c.s30d < 0; }).sort(function (a, b) { return a.s30d - b.s30d; }).slice(0, 3);
  const perps = (d.perps || []).slice(0, 10);
  const cand = (d.perps || []).filter(llamaIsCand_).slice(0, 6);
  const stLine = function (c) { return c.n + ' ' + (c.s30d >= 0 ? '+' : '−') + pmMoneyJa_(Math.abs(c.s30d)) + (c.s30 != null ? ' (' + pmSigned_(c.s30) + ')' : ''); };
  const perpSub = function (p) {
    return [chg(p), p.f24 != null ? '手数料 24時間 ' + pmMoneyJa_(p.f24) : '', p.token === true ? 'トークン ' + p.sym : p.token === false ? 'トークン未発行' : '', p.isNew ? 'NEW' : '', (p.ch || []).join('・')].filter(Boolean).join(' ／ ');
  };
  let text = '■■ お金の流れ (DefiLlama)\n・全体: 預かり資産 (TVL) ' + pmMoneyJa_(tvlAll) + ' ／ ステーブルコイン ' + pmMoneyJa_(stAll) + ' (上位30チェーンの合計)\n'
    + '\n■ チェーンごとの預かり資産 (上位10)\n' + top.map(function (c) { return '・' + c.n + ': ' + pmMoneyJa_(c.tvl) + (chg(c) ? ' (' + chg(c) + ')' : '') + (c.st ? ' ／ ステーブルコイン ' + pmMoneyJa_(c.st) : ''); }).join('\n') + '\n'
    + (grow.length ? '\n■ 30日で預かり資産が伸びているチェーン\n' + grow.map(function (c) { return '・' + c.n + ' ' + pmSigned_(c.c30) + ' (' + pmMoneyJa_(c.tvl) + ')'; }).join('\n') + '\n' : '')
    + (stIn.length || stOut.length ? '\n■ ステーブルコインの30日の増減\n' + (stIn.length ? '・増えた: ' + stIn.map(stLine).join('、') + '\n' : '') + (stOut.length ? '・減った: ' + stOut.map(stLine).join('、') + '\n' : '') : '');
  let html = pmMailHead_('💧 お金の流れ')
    + pmMailRow_('全体: 預かり資産 <b>' + pmMoneyJa_(tvlAll) + '</b> ／ ステーブルコイン <b>' + pmMoneyJa_(stAll) + '</b>', '上位30チェーンの合計')
    + pmMailSub_('チェーンごとの預かり資産 (上位10)')
    + top.map(function (c) { return pmMailRow_(esc(c.n) + ' <b>' + pmMoneyJa_(c.tvl) + '</b>', [chg(c), c.st ? 'ステーブルコイン ' + pmMoneyJa_(c.st) : ''].filter(Boolean).join(' ／ ')); }).join('')
    + (grow.length ? pmMailSub_('30日で預かり資産が伸びているチェーン') + pmMailRow_(esc(grow.map(function (c) { return c.n + ' ' + pmSigned_(c.c30); }).join('、'))) : '')
    + (stIn.length || stOut.length ? pmMailSub_('ステーブルコインの30日の増減')
      + (stIn.length ? pmMailRow_('<span style="color:#15803d">増えた</span>: ' + esc(stIn.map(stLine).join('、'))) : '')
      + (stOut.length ? pmMailRow_('<span style="color:#b91c1c">減った</span>: ' + esc(stOut.map(stLine).join('、'))) : '') : '');
  if (perps.length) {
    text += '\n■ 先物 DEX の建玉 (上位10)\n・全体: ' + pmMoneyJa_(d.oiTotal) + ([d.oiC1 != null ? '1日 ' + pmSigned_(d.oiC1) : '', d.oiC7 != null ? '7日 ' + pmSigned_(d.oiC7) : ''].filter(Boolean).length ? ' (' + [d.oiC1 != null ? '1日 ' + pmSigned_(d.oiC1) : '', d.oiC7 != null ? '7日 ' + pmSigned_(d.oiC7) : ''].filter(Boolean).join('・') + ')' : '') + '\n'
      + perps.map(function (p) { return '・' + p.n + ': ' + pmMoneyJa_(p.oi) + (perpSub(p) ? ' (' + perpSub(p) + ')' : ''); }).join('\n') + '\n'
      + (cand.length ? '\n■ トークン未発行の先物 DEX (エアドロップの候補)\n' + cand.map(function (p) { return '・' + p.n + ': 建玉 ' + pmMoneyJa_(p.oi) + (p.c30 != null ? ' (30日 ' + pmSigned_(p.c30) + ')' : '') + (p.f30 != null ? ' ／ 手数料 30日 ' + pmMoneyJa_(p.f30) : '') + (p.isNew ? ' ／ NEW' : ''); }).join('\n') + '\n' : '');
    html += pmMailSub_('先物 DEX の建玉 (上位10) — 全体 ' + pmMoneyJa_(d.oiTotal) + (d.oiC7 != null ? ' ・7日 ' + pmSigned_(d.oiC7) : ''))
      + perps.map(function (p) { return pmMailRow_(esc(p.n) + ' <b>' + pmMoneyJa_(p.oi) + '</b>', perpSub(p)); }).join('')
      + (cand.length ? pmMailSub_('トークン未発行の先物 DEX (エアドロップの候補)')
        + cand.map(function (p) { return pmMailRow_(esc(p.n) + ' 建玉 <b>' + pmMoneyJa_(p.oi) + '</b>', [p.c30 != null ? '30日 ' + pmSigned_(p.c30) : '', p.f30 != null ? '手数料 30日 ' + pmMoneyJa_(p.f30) : '', p.isNew ? 'NEW' : ''].filter(Boolean).join(' ／ ')); }).join('') : '');
  }
  const day = Utilities.formatDate(new Date(d.at), 'Asia/Tokyo', 'M/d HH:mm');
  text += '・(' + day + ' 時点。候補は目安で、配布を約束するものではありません)\n';
  return { text: text, html: html };
}

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
    let ml = null, flow = null;
    if (ntf_().dMacro) { try { ml = mac ? pmMacroList_(mac.res) : null; } catch (e) { Logger.log('マクロ指標の一覧をまとめに入れられません: ' + e); } }
    if (ntf_().dFlow) { try { flow = pmFlowSection_(); } catch (e) { Logger.log('お金の流れをまとめに入れられません: ' + e); } }
    const text = day + ' のまとめ\n\n' + (mac ? mac.text + '\n' : '')
      + '■■ ポリマーケット (あなた向け・ウォッチ中の市場)\n\n'
      + sec('24時間で大きく動いた市場', movers, '大きな動きはありませんでした') + '\n'
      + sec('ウォッチ中の市場', watch, 'ウォッチ中の市場はありません (アプリで ☆ を押すと入ります)') + '\n'
      + sec('新しく出てきた市場', fresh, 'ありませんでした') + '\n'
      + (ml ? ml.text + '\n' : '') + (flow ? flow.text + '\n' : '')
      + '■ 記録の状況\n・台帳 ' + st.markets + '件 ／ 決着済み ' + st.resolved + '件' + (st.since ? ' ／ ' + st.since + ' から記録中' : '') + (st.error ? '\n・⚠ ' + st.error : '') + pmHealthLine_() + '\n\n'
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
        + h('⭐ ウォッチ中の市場', watch, 'ウォッチ中の市場はありません') + h('🆕 新しく出てきた市場', fresh, 'ありませんでした')
        + (ml ? ml.html : '') + (flow ? flow.html : '')),
    });
    props.setProperty('PM_DIGEST_LAST', new Date().toISOString());
    hbOk_('digest');
  } catch (e) {
    props.setProperty('PM_LAST_ERROR', new Date().toISOString() + ' 毎朝のまとめ: ' + String(e));
    hbErr_('digest', e);
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
  { id:"oi", th:"crypto", n:"建玉 (BTC 先物)", t:"oi", f:D=>{ const s = D.hl && D.hl.BTC; if(!s || s.length < 2) return null;
      const l = s[s.length-1], a = s.length >= 25 ? s[s.length-25] : null;
      const ch = a && a[1] > 0 ? (l[1]/a[1]-1)*100 : null, pc = a && a[3] > 0 ? (l[3]/a[3]-1)*100 : null;
      const others = ["ETH","SOL","HYPE"].map(c=>{ const x = D.hl[c]; if(!x || x.length < 25) return ""; const y = x[x.length-1], z = x[x.length-25]; return z[1] > 0 ? `${c} ${mcPct((y[1]/z[1]-1)*100, 0)}` : ""; }).filter(Boolean);
      return { v: mcMoney(l[1]/1e9), sub: (ch != null ? `24時間 ${mcPct(ch)} ／ 価格 ${mcPct(pc)}` : "記録が24時間分たまると変化を出します") + (others.length ? ` ／ ${others.join("・")}` : ""), s: s.map(r=>[r[0], r[1]]), d: "",
        sig: ch == null ? null : ch >= 15 ? "r" : ch <= -15 ? "y" : "g", why: ch == null ? "" : ch >= 15 ? "建玉が急増: レバレッジが積み上がり、急な値動きの燃料になりやすい" : ch <= -15 ? "建玉が急減: 手じまい・清算が進んだ" : "建玉は落ち着いている" }; } },
  { id:"funding", th:"crypto", n:"ファンディングレート (BTC)", t:"funding", f:D=>{ const n = ((D.crypto||{}).now||{}).BTC; if(!n || n.funding == null) return null;
      const r8 = n.funding*8*100, yr = n.funding*24*365*100, h = ((D.crypto||{}).now||{}).HYPE, e = ((D.crypto||{}).now||{}).ETH;
      return { v: (r8 >= 0 ? "+" : "") + r8.toFixed(4) + "%", sub: `8時間あたり ／ 年率 ${mcPct(yr)}` + (e ? ` ／ ETH ${(e.funding*800).toFixed(4)}%` : "") + (h ? ` ／ HYPE ${(h.funding*800).toFixed(4)}%` : ""), d: "",
        sig: r8 > 0.03 ? "r" : r8 < 0 ? "y" : "g", why: r8 > 0.03 ? "買いが過熱気味" : r8 < 0 ? "売りが優勢" : "落ち着いた水準" }; } },
];
const MC_SIG = { g:"🟢", y:"🟡", r:"🔴" };
function mcEval(def, D){ try{ return def.f(D) || null; }catch(e){ return null; } }
/* ---- 相場の天気図: 信号を重み付きで足して、追い風 (リスクオン) か向かい風 (リスクオフ) かを出す ----
   🟢 = +1 / 🟡 = 0 / 🔴 = −1 に重みを掛けて平均 (−1〜+1)。重みは影響の大きさの目安 (お金の量・不安の度合いを重く) */
const MC_WEIGHT = { netliq:2, vix:2, hy:2, sp500:1.5, unrate:1.5, curve:1, sofr:1, dgs10:1, dxy:1, cpi:1, nasdaq:1, btc:1, stable:1, tga:1, jpy:1, eth:0.5, fng:0.5, funding:0.5, oi:0.5 };
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
  try { D.hl = hlSeries_(48); } catch (e) {}
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
  return { text: text, html: html, sky: sky, res: res };
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
  hbRun_('daily', function () {
    const today = pmJstDay_(Date.now());
    let day = props.getProperty('PM_DAILY_DONE');
    day = day ? pmDayAdd_(day, 1) : (props.getProperty('PM_FIRST_DAY') || today);
    let n = 0;
    while (day < today && n < 7) {   // 1回に7日分まで (止まっていた分も追いつく)
      pmSummarizeDay_(day);
      props.setProperty('PM_DAILY_DONE', day);
      day = pmDayAdd_(day, 1); n++;
    }
  });
  hbRun_('macrolog', pmMacroLog_);
  hbRun_('llama', llamaLog_);
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
  try { D.hl = hlSeries_(48); } catch (e) {}
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
  const parts = Array.isArray(opt.parts) && opt.parts.length ? opt.parts : ['macro', 'watch', 'alerts', 'resolve', 'kalshi', 'hl', 'llama'];
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
  lines.push('・Polymarket と Kalshi で確率がずれた場面と、その後どちらに寄ったか');
  lines.push('・暗号資産の先物の建玉・ファンディングの変化と、価格や予測市場の動きの関係');
  lines.push('・どのチェーンにお金 (TVL・ステーブルコイン) が集まっているか、エアドロップや TGE を狙う材料になりそうか');
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
  if (parts.indexOf('kalshi') >= 0) {
    const log = pmRead_('fed-compare.json') ? JSON.parse(pmRead_('fed-compare.json')) : { rows: [] };
    // 日ごとの最後の記録
    const last = {};
    log.rows.forEach(function (r) { const d = pmJstDay_(Date.parse(r.t)); if (d >= from && d <= to) last[d + '|' + r.d] = r; });
    const rows = [];
    Object.keys(last).sort().forEach(function (k) { const r = last[k], d = k.split('|')[0];
      FED_BOXES.forEach(function (b) { const x = r.b[b]; if (x && (x[0] != null || x[1] != null)) rows.push([d, r.d, FED_BOX_JA[b], pmP_(x[0]), pmP_(x[1]), x[0] != null && x[1] != null ? Math.round((x[0] - x[1]) * 100) + 'pt' : '-']); }); });
    lines.push('## 5. Polymarket と Kalshi の FOMC 予想のずれ (日ごとの最後の値)');
    lines.push('同じ会合・同じ結果についての、2つの予測市場の確率。差 = Polymarket − Kalshi。');
    lines.push(pmMdTable_(['日付', 'FOMC の日', '結果', 'Polymarket', 'Kalshi', '差'], rows));
    lines.push('');
  }
  if (parts.indexOf('hl') >= 0) {
    const all = hlLoad_(hlMonths_(Date.now(), Math.ceil(days / 28) + 1));
    lines.push('## 6. 暗号資産の先物 (Hyperliquid の建玉・ファンディング、日ごと)');
    lines.push('建玉 = 未決済の先物の総額 (ドル)。ファンディング = その日の平均 (8時間あたり)。プラスで大きいほど買いが過熱。');
    HL_COINS.concat(hlWatch_().filter(function (c) { return HL_COINS.indexOf(c) < 0; })).forEach(function (c) {
      const byDay = {};
      Object.keys(all).sort().forEach(function (k) { const d = k.slice(0, 10); const x = all[k][c]; if (!x || d < from) return; const b = byDay[d] || (byDay[d] = { oi: 0, px: 0, f: [], bin: [] }); b.oi = x[0]; b.px = x[2]; b.f.push(x[1]); if (x[5] != null) b.bin.push(x[5]); });
      const ds = Object.keys(byDay).sort();
      lines.push('### ' + c);
      lines.push(pmMdTable_(['日付', '価格', '建玉', '建玉の前日比', 'ファンディング (8時間)', 'Binance (8時間)', '差 (HL−Binance)'], ds.map(function (d, i) {
        const b = byDay[d], p = i ? byDay[ds[i - 1]] : null, fa = b.f.reduce(function (a, x) { return a + x; }, 0) / b.f.length;
        const ba = b.bin.length ? b.bin.reduce(function (a, x) { return a + x; }, 0) / b.bin.length : null;
        return [d, '$' + Number(b.px).toLocaleString(), pmMoneyJa_(b.oi), p && p.oi ? ((b.oi / p.oi - 1) * 100).toFixed(1) + '%' : '-', (fa * 800).toFixed(4) + '%',
          ba != null ? (ba * 100).toFixed(4) + '%' : '-', ba != null ? ((fa * 8 - ba) * 100).toFixed(4) + '%' : '-'];
      })));
    });
    lines.push('');
  }
  if (parts.indexOf('llama') >= 0) {
    const all = {};
    hlMonths_(Date.now(), Math.ceil(days / 28) + 1).forEach(function (m) { const f = pmLoadJson_('llama-' + m + '.json'); Object.keys(f).forEach(function (k) { if (k >= from && k <= to) all[k] = f[k]; }); });
    const ds = Object.keys(all).sort();
    const latest = llamaData_(false);
    lines.push('## 7. チェーンごとのお金の流れと先物 DEX (DefiLlama)');
    lines.push('TVL = チェーン上の DeFi に預けられた資産。ステーブルコイン = そのチェーン上のドル建てステーブルコインの量。先物 DEX の建玉 = 未決済の先物の総額。');
    if (latest && latest.chains) {
      lines.push('### いまの状態 (TVL の上位)');
      lines.push(pmMdTable_(['チェーン', 'TVL', '1日', '7日', '30日', 'ステーブルコイン', 'ステーブル30日'], latest.chains.slice(0, 15).map(function (c) {
        const p = function (x) { return x == null ? '-' : (x >= 0 ? '+' : '') + x.toFixed(1) + '%'; };
        return [c.n, pmMoneyJa_(c.tvl), p(c.c1), p(c.c7), p(c.c30), c.st ? pmMoneyJa_(c.st) : '-', p(c.s30)];
      })));
      lines.push('### 先物 DEX の建玉 (上位)');
      lines.push(pmMdTable_(['名前', '分類', 'チェーン', '建玉', '1日', '7日', '30日', '手数料24時間', '手数料30日', 'TVL', 'トークン'], (latest.perps || []).slice(0, 20).map(function (x) {
        const p = function (v) { return v == null ? '-' : (v >= 0 ? '+' : '') + Number(v).toFixed(1) + '%'; };
        return [x.n + (x.isNew ? ' (NEW)' : ''), x.cat, x.ch.join('・'), pmMoneyJa_(x.oi), p(x.c1), p(x.c7), p(x.c30), x.f24 != null ? pmMoneyJa_(x.f24) : '-', x.f30 != null ? pmMoneyJa_(x.f30) : '-', x.tvl != null ? pmMoneyJa_(x.tvl) : '-', x.token == null ? '不明' : x.token ? x.sym : '未発行'];
      })));
      const cand = (latest.perps || []).filter(llamaIsCand_);
      if (cand.length) {
        lines.push('### トークン未発行の先物 DEX (エアドロップ候補)');
        lines.push(pmMdTable_(['名前', 'チェーン', '建玉', '30日', '手数料30日'], cand.map(function (x) { return [x.n, x.ch.join('・'), pmMoneyJa_(x.oi), x.c30 == null ? '-' : (x.c30 >= 0 ? '+' : '') + Number(x.c30).toFixed(1) + '%', x.f30 != null ? pmMoneyJa_(x.f30) : '-']; })));
      }
    }
    if (ds.length) {
      const key = ['Ethereum', 'Base', 'Solana', 'Hyperliquid L1', 'Arbitrum', 'BSC'];
      lines.push('### 記録 (日ごとの TVL)');
      lines.push(pmMdTable_(['日付'].concat(key), ds.map(function (d) { return [d].concat(key.map(function (k) { return all[d].tvl[k] ? pmMoneyJa_(all[d].tvl[k]) : '-'; })); })));
    }
    lines.push('');
  }
  const text = lines.join('\n');
  return { ok: true, text: text, chars: text.length, from: from, to: to };
}

// =====================================================================
//  Kalshi と Polymarket の比較 (FOMC の決定)
//    Kalshi の公開データ (登録なし) と Polymarket の同じ会合の市場を、選択肢を4つの箱にそろえて比べる
//      hold: 据え置き / cut25: 0.25%利下げ / cut50: 0.5%以上の利下げ / hike: 利上げ (幅は問わない)
//    fed-compare.json … 1時間ごとの記録 { rows: [{ t, d: 会合日, b: { 箱: [Polymarket, Kalshi] } }] } (180日分)
// =====================================================================

const KALSHI_URL = 'https://api.elections.kalshi.com/trade-api/v2';
const FED_BOXES = ['hold', 'cut25', 'cut50', 'hike'];
const FED_BOX_JA = { hold: '据え置き', cut25: '0.25%利下げ', cut50: '0.5%以上の利下げ', hike: '利上げ' };
const FED_GAP_ALERT = 0.05;        // 買値・売値を考えても5pt以上ずれていたら通知
const FED_GAP_COOLDOWN = 12 * 3600000;

function kalshiFetch_(path) { return JSON.parse(macroFetchText_(KALSHI_URL + path)); }
/** 値段: 買値と売値の真ん中 (片方しか無ければ最後の取引値) */
function fedMid_(bid, ask, last) {
  if (bid > 0 && ask > 0 && ask >= bid) return (bid + ask) / 2;
  return last != null && !isNaN(last) ? last : (ask > 0 ? ask : bid);
}
/** Kalshi の選択肢 (custom_strike) → 箱 */
function fedBoxKalshi_(cs) {
  cs = cs || {};
  if (cs.Hike != null) return String(cs.Hike) === '0' ? 'hold' : 'hike';
  if (cs.Cut != null) return String(cs.Cut) === '25' ? 'cut25' : 'cut50';
  return null;
}
/** Polymarket の選択肢名 → 箱 ("No change" "25 bps decrease" "50+ bps decrease" "25+ bps increase") */
function fedBoxPm_(label) {
  const s = String(label || '').toLowerCase();
  if (/no change|maintain|hold|unchanged/.test(s)) return 'hold';
  const n = Number((s.match(/(\d+)/) || [])[1]);
  if (/decrease|cut|lower/.test(s)) return n >= 50 ? 'cut50' : 'cut25';
  if (/increase|hike|raise/.test(s)) return 'hike';
  return null;
}
function fedAdd_(boxes, k, x) {
  if (!k) return;
  const b = boxes[k] || (boxes[k] = { p: 0, bid: 0, ask: 0, v: 0, n: 0 });
  b.p += x.p; b.bid += x.bid || 0; b.ask += x.ask || 0; b.v += x.v || 0; b.n++;
}
const fedR_ = function (x) { return Math.round(x * 1000) / 1000; };
/** Kalshi: 開いている FOMC の会合 → [{ d: 'YYYY-MM-DD', t: 題名, ticker, boxes }] */
function kalshiFedMeetings_() {
  const d = kalshiFetch_('/events?status=open&series_ticker=KXFEDDECISION&with_nested_markets=true&limit=10');
  return (d.events || []).map(function (ev) {
    const boxes = {};
    (ev.markets || []).forEach(function (m) {
      const bid = Number(m.yes_bid_dollars), ask = Number(m.yes_ask_dollars), last = Number(m.last_price_dollars);
      fedAdd_(boxes, fedBoxKalshi_(m.custom_strike), { p: fedMid_(bid, ask, last), bid: bid, ask: ask, v: Number(m.volume_24h_fp) || 0 });
    });
    return { d: String(ev.strike_date || '').slice(0, 10), t: ev.title, ticker: ev.event_ticker, boxes: boxes };
  }).filter(function (x) { return x.d; }).sort(function (a, b) { return a.d < b.d ? -1 : 1; });
}
/** Polymarket: 同じ会合の「Fed decision in ○月」市場 */
function pmFedMeeting_(date) {
  const mon = MC_MON_EN[Number(date.slice(5, 7)) - 1];
  const r = pmFetch_('/public-search?q=' + encodeURIComponent('Fed decision in ' + mon) + '&limit_per_type=10&events_status=active');
  const day = Date.parse(date + 'T12:00:00Z');
  const ev = ((r && r.events) || []).filter(function (e) {
    return /fed/i.test(e.title || '') && !e.closed && Math.abs((Date.parse(e.endDate) || 0) - day) <= 4 * 86400000;
  }).sort(function (a, b) { return (Number(b.volume) || 0) - (Number(a.volume) || 0); })[0];
  if (!ev) return null;
  const boxes = {};
  (ev.markets || []).filter(function (m) { return !m.closed; }).forEach(function (m) {
    const p = Number(pmJsonArr_(m.outcomePrices)[0]);
    if (isNaN(p)) return;
    const bid = Number(m.bestBid) || 0, ask = Number(m.bestAsk) || 0;
    fedAdd_(boxes, fedBoxPm_(m.groupItemTitle || m.question), { p: bid > 0 && ask > 0 ? fedMid_(bid, ask, p) : p, bid: bid, ask: ask, v: Number(m.volume24hr) || 0 });
  });
  return { t: ev.title, s: ev.slug, boxes: boxes };
}
/** 比較を作る (次の4回の会合)。失敗したら null */
function fedCompare_() {
  const ks = kalshiFedMeetings_().slice(0, 4);
  return ks.map(function (k) {
    let pm = null;
    try { pm = pmFedMeeting_(k.d); } catch (e) { Logger.log('Polymarket の FOMC 市場を探せません: ' + e); }
    const rows = FED_BOXES.filter(function (b) { return k.boxes[b] || (pm && pm.boxes[b]); }).map(function (b) {
      const kk = k.boxes[b], pp = pm && pm.boxes[b];
      // 買値と売値の幅を考えたずれ: 2つの幅が重ならない分だけ (幅が無い時は値段の差)
      let gap = null;
      if (kk && pp) {
        const hasK = kk.bid > 0 && kk.ask > 0, hasP = pp.bid > 0 && pp.ask > 0;
        gap = hasK && hasP ? Math.max(0, Math.max(kk.bid, pp.bid) - Math.min(kk.ask, pp.ask)) : Math.abs(kk.p - pp.p);
      }
      return { b: b, ja: FED_BOX_JA[b],
        k: kk ? { p: fedR_(kk.p), bid: fedR_(kk.bid), ask: fedR_(kk.ask), v: Math.round(kk.v) } : null,
        pm: pp ? { p: fedR_(pp.p), bid: fedR_(pp.bid), ask: fedR_(pp.ask), v: Math.round(pp.v) } : null,
        diff: kk && pp ? fedR_(pp.p - kk.p) : null, gap: gap != null ? fedR_(gap) : null };
    });
    return { d: k.d, k: { t: k.t, ticker: k.ticker, url: 'https://kalshi.com/markets/kxfeddecision' }, pm: pm ? { t: pm.t, url: 'https://polymarket.com/event/' + pm.s } : null, rows: rows };
  });
}
/** 1時間ごと: 比較を記録し、大きなずれを通知する */
function fedCompareRecord_() {
  const list = fedCompare_();
  const now = Date.now();
  pmWrite_('fed-compare-latest.json', JSON.stringify({ at: now, list: list }));
  const cur = pmRead_('fed-compare.json');
  const log = cur ? JSON.parse(cur) : { rows: [] };
  list.forEach(function (m) {
    const b = {};
    m.rows.forEach(function (r) { b[r.b] = [r.pm ? r.pm.p : null, r.k ? r.k.p : null]; });
    log.rows.push({ t: new Date(now).toISOString(), d: m.d, b: b });
  });
  const since = new Date(now - 180 * 86400000).toISOString();
  log.rows = log.rows.filter(function (r) { return r.t >= since; });
  pmWrite_('fed-compare.json', JSON.stringify(log));
  // 大きなずれの通知
  const props = PropertiesService.getScriptProperties();
  const to = pmMailTo_();
  const NT = ntf_(), gapMin = NT.gap / 100;
  if (!to || !pmMailOn_('PM_ALERT_ON') || !NT.kalshi) return list;
  let sent = {};
  try { sent = JSON.parse(props.getProperty('FED_GAP_SENT') || '{}'); } catch (e) {}
  const hits = [];
  list.forEach(function (m) { m.rows.forEach(function (r) {
    const key = m.d + ':' + r.b;
    if (r.gap != null && r.gap >= gapMin - 1e-9 && !(sent[key] && now - sent[key] < FED_GAP_COOLDOWN)) { hits.push({ m: m, r: r }); sent[key] = now; }
  }); });
  if (!hits.length) return list;
  const pct = function (x) { return Math.round(x * 100) + '%'; };
  const body = 'Polymarket と Kalshi で、FOMC の予想が大きくずれています (買値・売値の幅を考えても ' + NT.gap + 'pt 以上)。\n\n'
    + hits.map(function (h) {
      return '・' + h.m.d + ' の FOMC ― ' + h.r.ja + ': Polymarket ' + pct(h.r.pm.p) + ' (買' + pct(h.r.pm.ask) + '/売' + pct(h.r.pm.bid) + ') ／ Kalshi ' + pct(h.r.k.p) + ' (買' + pct(h.r.k.ask) + '/売' + pct(h.r.k.bid) + ') → ずれ ' + Math.round(h.r.gap * 100) + 'pt';
    }).join('\n')
    + '\n\n' + (hits[0].m.pm ? 'Polymarket: ' + hits[0].m.pm.url + '\n' : '') + 'Kalshi: ' + hits[0].m.k.url
    + '\n\n※ 決着のルールが少し違うことがあります。売買はしていません。';
  MailApp.sendEmail({ to: to, subject: '【ポリマーケット】Kalshi とのずれ ' + hits.length + '件: ' + hits[0].m.d + ' FOMC ' + hits[0].r.ja, body: body });
  Object.keys(sent).forEach(function (k) { if (now - sent[k] > 3 * 86400000) delete sent[k]; });
  props.setProperty('FED_GAP_SENT', JSON.stringify(sent));
  return list;
}
/** アプリから: 最新の比較 (1時間より古ければ取り直す) */
function fedCompareLatest_() {
  let cur = null;
  try { cur = JSON.parse(pmRead_('fed-compare-latest.json') || 'null'); } catch (e) {}
  if (!cur || Date.now() - cur.at > 3600000) {
    try { cur = { at: Date.now(), list: fedCompare_() }; pmWrite_('fed-compare-latest.json', JSON.stringify(cur)); }
    catch (e) { if (!cur) return { ok: false, error: String(e) }; }
  }
  return { ok: true, at: cur.at, list: cur.list, gapAlert: ntf_().gap / 100 };
}

// =====================================================================
//  Hyperliquid の建玉 (OI)・ファンディングの記録 (1時間ごと)
//    hl-YYYY-MM.json … { 'YYYY-MM-DDTHH:00' (日本時間): { 銘柄: [建玉(ドル), ファンディング(1時間), 価格] } }
//    建玉は過去の値を取り出せないので、自分で貯める価値がある
// =====================================================================

const HL_COINS = ['BTC', 'ETH', 'SOL', 'HYPE'];
const HL_TOP_EXTRA = 6;              // それ以外に建玉の大きい銘柄をいくつ記録するか
const HL_OI_ALERT = 20;              // 24時間で建玉が ±20% 以上
const HL_FUND_HI = 0.0005, HL_FUND_LO = -0.0003;   // 8時間あたり +0.05% 以上 / −0.03% 以下
const HL_COOLDOWN = 12 * 3600000;

function hlKey_(t) { return Utilities.formatDate(new Date(t), 'Asia/Tokyo', 'yyyy-MM-dd HH:00').replace(' ', 'T'); }
function hlLoad_(months) {
  const out = {};
  months.forEach(function (m) { const f = pmLoadJson_('hl-' + m + '.json'); Object.keys(f).forEach(function (k) { out[k] = f[k]; }); });
  return out;
}
function hlMonths_(t, n) {
  const res = [];
  for (let i = n - 1; i >= 0; i--) { const d = new Date(t); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - i); res.push(Utilities.formatDate(new Date(d.getTime() + 15 * 86400000), 'Asia/Tokyo', 'yyyy-MM')); }
  return res.filter(function (x, i) { return res.indexOf(x) === i; });
}
/** 今の状態: 先物全部 (他の取引所のファンディングつき) と、現物トークン (出来高の上位) */
function hlSnapshot_() {
  const meta = macroHl_({ type: 'metaAndAssetCtxs' });
  const pmap = {};
  try {
    (macroHl_({ type: 'predictedFundings' }) || []).forEach(function (x) {
      const v = {};
      (x[1] || []).forEach(function (y) { const r = y[1]; if (r && r.fundingRate != null) v[y[0]] = Number(r.fundingRate) * (8 / (Number(r.fundingIntervalHours) || 8)); });
      pmap[x[0]] = v;
    });
  } catch (e) { Logger.log('他の取引所のファンディングを取れません: ' + e); }
  const perps = meta[0].universe.map(function (u, i) {
    const c = meta[1][i] || {}, px = Number(c.markPx), pf = pmap[u.name] || {};
    return { n: u.name, d: !!u.isDelisted, px: px, prev: Number(c.prevDayPx), oi: Number(c.openInterest) * px, f: Number(c.funding),
      prem: Number(c.premium), vol: Number(c.dayNtlVlm), bin: pf.BinPerp != null ? pf.BinPerp : null, byb: pf.BybitPerp != null ? pf.BybitPerp : null, lev: u.maxLeverage };
  }).filter(function (r) { return !r.d && r.oi > 0 && !isNaN(r.px); }).sort(function (a, b) { return b.oi - a.oi; });
  let spot = [];
  try {
    const sp = macroHl_({ type: 'spotMetaAndAssetCtxs' });
    const tokens = sp[0].tokens || [];
    const byCoin = {};
    (sp[1] || []).forEach(function (c) { byCoin[c.coin] = c; });
    spot = (sp[0].universe || []).map(function (u) {
      const c = byCoin[u.name] || {}, base = tokens[(u.tokens || [])[0]] || {}, quote = tokens[(u.tokens || [])[1]] || {};
      const px = Number(c.markPx);
      return { n: String(base.name || u.name), q: String(quote.name || ''), px: px, prev: Number(c.prevDayPx), vol: Number(c.dayNtlVlm), circ: Number(c.circulatingSupply), total: Number(c.totalSupply) };
    }).filter(function (r) { return r.q === 'USDC' && r.px > 0 && r.vol > 0; }).sort(function (a, b) { return b.vol - a.vol; }).slice(0, 60);
  } catch (e) { Logger.log('現物を取れません: ' + e); }
  return { at: Date.now(), perps: perps, spot: spot };
}
function hlWatch_() { try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('HL_WATCH') || '[]').map(String); } catch (e) { return []; } }
function hlRecord_() {
  const snap = hlSnapshot_();
  const rows = snap.perps;
  const watch = hlWatch_();
  const fixed = HL_COINS.concat(watch);
  const pick = rows.filter(function (r) { return fixed.indexOf(r.n) >= 0; })
    .concat(rows.filter(function (r) { return fixed.indexOf(r.n) < 0; }).slice(0, HL_TOP_EXTRA));
  const now = Date.now(), key = hlKey_(now), month = key.slice(0, 7);
  const entry = {};
  // [建玉(ドル), ファンディング(1時間), 価格, 24時間出来高, プレミアム, Binance(8時間), Bybit(8時間)]
  pick.forEach(function (r) { entry[r.n] = [Math.round(r.oi), r.f, r.px, Math.round(r.vol || 0), r.prem, r.bin, r.byb]; });
  const add = {}; add[key] = entry;
  const name = 'hl-' + month + '.json';
  const cur = pmLoadJson_(name); cur[key] = entry; pmWrite_(name, JSON.stringify(cur));
  // 現物 (出来高の上位): その日の最後の値を残す { 日付: { 銘柄: [価格, 流通量, 総発行量, 24時間出来高] } }
  if (snap.spot.length) {
    const sname = 'hl-spot-' + month + '.json', sc = pmLoadJson_(sname), sd = {};
    snap.spot.forEach(function (r) { sd[r.n] = [r.px, Math.round(r.circ || 0), Math.round(r.total || 0), Math.round(r.vol)]; });
    sc[key.slice(0, 10)] = sd; pmWrite_(sname, JSON.stringify(sc));
  }
  // 通知: 24時間前と比べた建玉の急変・ファンディングの極端
  const props = PropertiesService.getScriptProperties();
  const to = pmMailTo_();
  const NT = ntf_();
  if (!to || !pmMailOn_('PM_ALERT_ON') || !NT.hl) return entry;
  const prev = hlLoad_(hlMonths_(now - 86400000, 1))[hlKey_(now - 86400000)] || {};
  let sent = {};
  try { sent = JSON.parse(props.getProperty('HL_ALERT_SENT') || '{}'); } catch (e) {}
  const hits = [];
  Object.keys(entry).forEach(function (c) {
    const x = entry[c], p = prev[c];
    if (p && p[0] > 0) {
      const ch = (x[0] / p[0] - 1) * 100, pxch = p[2] > 0 ? (x[2] / p[2] - 1) * 100 : 0;
      if (Math.abs(ch) >= NT.oi && !(sent[c + ':oi'] && now - sent[c + ':oi'] < HL_COOLDOWN)) {
        hits.push(c + ' の建玉が24時間で ' + (ch > 0 ? '+' : '') + ch.toFixed(0) + '% (' + pmMoneyJa_(p[0]) + ' → ' + pmMoneyJa_(x[0]) + ')、価格 ' + (pxch > 0 ? '+' : '') + pxch.toFixed(1) + '%'
          + (ch > 0 ? ' — レバレッジが急に積み上がっています' : ' — 手じまい・清算が進みました'));
        sent[c + ':oi'] = now;
      }
    }
    const f8 = x[1] * 8;
    if ((f8 >= NT.fhi / 100 || f8 <= NT.flo / 100) && !(sent[c + ':f'] && now - sent[c + ':f'] < HL_COOLDOWN)) {
      hits.push(c + ' のファンディングレート ' + (f8 * 100).toFixed(3) + '% / 8時間 — ' + (f8 > 0 ? '買いが過熱' : '売りが優勢'));
      sent[c + ':f'] = now;
    }
  });
  if (hits.length) {
    MailApp.sendEmail({ to: to, subject: '【ポリマーケット】暗号資産の先物: ' + hits[0].split(' — ')[0].slice(0, 40), body: 'Hyperliquid の先物で大きな変化がありました (' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'M/d HH:mm') + ')\n\n' + hits.map(function (h) { return '・' + h; }).join('\n') + '\n\n※ 1時間ごとの記録から判定しています。売買はしていません。' });
    Object.keys(sent).forEach(function (k) { if (now - sent[k] > 3 * 86400000) delete sent[k]; });
    props.setProperty('HL_ALERT_SENT', JSON.stringify(sent));
  }
  return entry;
}
/** 直近 hours 時間の記録 → { 銘柄: [[時刻, 建玉, ファンディング, 価格], ...] } */
function hlSeries_(hours) {
  const now = Date.now(), all = hlLoad_(hlMonths_(now, 2));
  const since = hlKey_(now - (hours || 192) * 3600000);
  const out = {};
  Object.keys(all).filter(function (k) { return k >= since; }).sort().forEach(function (k) {
    Object.keys(all[k]).forEach(function (c) { const x = all[k][c]; (out[c] = out[c] || []).push([k, x[0], x[1], x[2], x[3] != null ? x[3] : null, x[4] != null ? x[4] : null, x[5] != null ? x[5] : null, x[6] != null ? x[6] : null]); });
  });
  return out;
}

// =====================================================================
//  DefiLlama — チェーンごとのお金の流れ (預かり資産 TVL・ステーブルコイン) と、先物 DEX の建玉
//    llama-latest.json … 最新 (6時間ごとに取り直す) / llama-YYYY-MM.json … 日ごとの記録 { 日付: { tvl, st, oi } }
//    ※ 先物 DEX の「出来高」は DefiLlama では有料なので、無料の「建玉」を使う
// =====================================================================

const LLAMA_TTL = 6 * 3600000;
const LLAMA_ALWAYS = ['Base', 'Solana', 'Hyperliquid L1', 'Ethereum', 'Arbitrum', 'BSC'];   // いつも推移を取るチェーン
const LLAMA_TOP = 12;            // 推移を取るチェーンの数 (TVL の上位 + 上の固定分)
const LLAMA_DAYS = 120;

function llamaJson_(url) { return JSON.parse(macroFetchText_(url)); }
function llamaDay_(sec) { return Utilities.formatDate(new Date(Number(sec) * 1000), 'Asia/Tokyo', 'yyyy-MM-dd'); }
/** 系列の n 日前からの変化率 (%) */
function llamaChg_(s, days) {
  if (!s || s.length < 2) return null;
  const last = s[s.length - 1], t = Date.parse(last[0]) - days * 86400000;
  for (let i = s.length - 1; i >= 0; i--) if (Date.parse(s[i][0]) <= t) return s[i][1] > 0 ? (last[1] / s[i][1] - 1) * 100 : null;
  return null;
}
function llamaFetchAll_() {
  const out = { at: Date.now(), chains: [], perps: [], errors: [] };
  let chains = [];
  try { chains = llamaJson_('https://api.llama.fi/v2/chains').filter(function (c) { return c.tvl > 0; }).sort(function (a, b) { return b.tvl - a.tvl; }); }
  catch (e) { out.errors.push('チェーンの一覧'); }
  let stc = {};
  try { llamaJson_('https://stablecoins.llama.fi/stablecoinchains').forEach(function (c) { stc[c.name] = ((c.totalCirculatingUSD || {}).peggedUSD) || 0; }); }
  catch (e) { out.errors.push('ステーブルコイン'); }
  const pick = chains.slice(0, LLAMA_TOP).map(function (c) { return c.name; });
  LLAMA_ALWAYS.forEach(function (n) { if (pick.indexOf(n) < 0 && chains.some(function (c) { return c.name === n; })) pick.push(n); });
  out.chains = chains.slice(0, 30).map(function (c) {
    const x = { n: c.name, tvl: Math.round(c.tvl), st: Math.round(stc[c.name] || 0), sym: c.tokenSymbol || '' };
    if (pick.indexOf(c.name) >= 0) {
      try {
        x.h = llamaJson_('https://api.llama.fi/v2/historicalChainTvl/' + encodeURIComponent(c.name)).slice(-LLAMA_DAYS)
          .map(function (r) { return [llamaDay_(r.date), Math.round(r.tvl)]; });
      } catch (e) { out.errors.push('TVL の推移 ' + c.name); }
      try {
        x.sh = llamaJson_('https://stablecoins.llama.fi/stablecoincharts/' + encodeURIComponent(c.name)).slice(-LLAMA_DAYS)
          .map(function (r) { return [llamaDay_(r.date), Math.round(((r.totalCirculating || r.totalCirculatingUSD || {}).peggedUSD) || 0)]; })
          .filter(function (r) { return r[1] > 0; });
      } catch (e) { out.errors.push('ステーブルコインの推移 ' + c.name); }
    }
    x.c1 = llamaChg_(x.h, 1); x.c7 = llamaChg_(x.h, 7); x.c30 = llamaChg_(x.h, 30);
    x.s7 = llamaChg_(x.sh, 7); x.s30 = llamaChg_(x.sh, 30);
    if (x.sh && x.sh.length > 30) x.s30d = x.sh[x.sh.length - 1][1] - x.sh[x.sh.length - 31][1];   // 30日でのステーブルコインの増減 (ドル)
    return x;
  });
  try { llamaPerps_(out); } catch (e) { out.errors.push('先物 DEX の建玉'); Logger.log(e); }
  return out;
}
/** 最新 (古ければ取り直す) */
function llamaData_(force) {
  let cur = null;
  try { cur = JSON.parse(pmRead_('llama-latest.json') || 'null'); } catch (e) {}
  if (force || !cur || Date.now() - cur.at > LLAMA_TTL) {
    const fresh = llamaFetchAll_();
    if (fresh.chains.length || !cur) { cur = fresh; try { pmWrite_('llama-latest.json', JSON.stringify(cur)); } catch (e) {} }
  }
  return cur;
}
/** 毎日: その日の値を1行残す */
function llamaLog_() {
  const d = llamaData_(false);
  if (!d || !d.chains.length) return;
  const row = { tvl: {}, st: {}, oi: {} };
  d.chains.forEach(function (c) { row.tvl[c.n] = c.tvl; if (c.st) row.st[c.n] = c.st; });
  d.perps.forEach(function (p) { row.oi[p.n] = p.oi; });
  row.px = {};   // 先物 DEX: [建玉, 手数料24時間, TVL]
  d.perps.forEach(function (p) { row.px[p.n] = [p.oi, p.f24 != null ? p.f24 : null, p.tvl != null ? p.tvl : null]; });
  const day = pmJstDay_(Date.now()), name = 'llama-' + day.slice(0, 7) + '.json';
  const cur = pmLoadJson_(name); cur[day] = row; pmWrite_(name, JSON.stringify(cur));
}


/* ---- 先物 DEX の詳しい情報 (建玉の推移・シェア・手数料・トークンの有無) ---- */
const LLAMA_PERP_N = 40;          // 一覧に入れる数
const LLAMA_HIST_DAYS = 90;       // 推移・シェアの期間
const LLAMA_PROTO_TTL = 24 * 3600000;
/** DefiLlama の先物系プロトコルの一覧 (トークン・TVL)。大きいので1日1回だけ取り、ドライブに保存 */
function llamaProtocols_() {
  let cur = null;
  try { cur = JSON.parse(pmRead_('llama-protocols.json') || 'null'); } catch (e) {}
  if (cur && Date.now() - cur.at < LLAMA_PROTO_TTL) return cur.m;
  const m = {};
  llamaJson_('https://api.llama.fi/protocols').forEach(function (p) {
    if (!/derivatives|options|prediction/i.test(p.category || '')) return;
    const sym = p.symbol && p.symbol !== '-' ? String(p.symbol) : '';
    m[String(p.id)] = { n: p.name, sym: sym, tvl: Math.round(p.tvl || 0), par: p.parentProtocol || '' };
  });
  try { pmWrite_('llama-protocols.json', JSON.stringify({ at: Date.now(), m: m })); } catch (e) {}
  return m;
}
function llamaPerps_(out) {
  const d = llamaJson_('https://api.llama.fi/overview/open-interest?excludeTotalDataChart=false&excludeTotalDataChartBreakdown=false');
  out.oiTotal = Math.round(d.total24h || 0); out.oiC1 = d.change_1d; out.oiC7 = d.change_7d;
  let fees = {};
  try {
    (llamaJson_('https://api.llama.fi/overview/fees?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true').protocols || []).forEach(function (p) {
      fees[p.name] = { f24: p.total24h, f30: p.total30d, fc30: p.change_1m };
    });
  } catch (e) { out.errors.push('先物 DEX の手数料'); }
  let protos = {};
  try { protos = llamaProtocols_(); } catch (e) { out.errors.push('先物 DEX のトークン'); }
  // 建玉の推移 (全体と DEX ごと): 直近90日
  const bd = (d.totalDataChartBreakdown || []).slice(-LLAMA_HIST_DAYS);
  const dates = bd.map(function (r) { return llamaDay_(r[0]); });
  const firstSeen = {};   // 30日以上前から建玉があったか (NEW の判定)
  const all = d.totalDataChartBreakdown || [];
  for (let i = Math.max(0, all.length - 400); i < all.length; i++) {
    Object.keys(all[i][1] || {}).forEach(function (k) { if (all[i][1][k] > 0 && firstSeen[k] == null) firstSeen[k] = all[i][0]; });
  }
  const nowSec = Date.now() / 1000;
  const perps = (d.protocols || []).filter(function (p) { return (p.total24h || 0) > 0; }).sort(function (a, b) { return b.total24h - a.total24h; }).slice(0, LLAMA_PERP_N)
    .map(function (p) {
      const pr = protos[String(p.defillamaId)] || protos[String(p.id)] || null;
      const par = pr && pr.par ? Object.keys(protos).map(function (k) { return protos[k]; }).find(function (x) { return x.par === pr.par && x.sym; }) : null;
      const sym = pr ? (pr.sym || (par && par.sym) || '') : null;   // null = 分からない
      const f = fees[p.name] || {};
      const fs = firstSeen[p.name];
      return { n: p.displayName || p.name, key: p.name, slug: p.slug || '', cat: p.category || '', ch: (p.chains || []).slice(0, 2), oi: Math.round(p.total24h),
        c1: p.change_1d, c7: p.change_7d, c30: p.change_1m,
        f24: f.f24 != null ? Math.round(f.f24) : null, f30: f.f30 != null ? Math.round(f.f30) : null, fc30: f.fc30 != null ? f.fc30 : null,
        tvl: pr ? pr.tvl : null, sym: sym, token: sym == null ? null : !!sym,
        isNew: fs != null && nowSec - fs < 30 * 86400 };
    });
  out.perps = perps;
  // シェアと推移 (上位 + トークン未発行の候補)
  const keys = perps.map(function (p) { return p.key; });
  out.oiHist = { dates: dates, total: bd.map(function (r) { return Math.round(Object.keys(r[1] || {}).reduce(function (n, k) { return n + (r[1][k] || 0); }, 0)); }), s: {} };
  keys.forEach(function (k) { out.oiHist.s[k] = bd.map(function (r) { return Math.round((r[1] || {})[k] || 0); }); });
}
/** アプリから: DEX の手数料の推移 (直近90日) */
function llamaFeesHist_(slug) {
  if (!/^[a-z0-9\-\.]{1,80}$/i.test(String(slug || ''))) return { ok: false, error: '名前が正しくありません' };
  try {
    const d = llamaJson_('https://api.llama.fi/summary/fees/' + encodeURIComponent(slug) + '?dataType=dailyFees&excludeTotalDataChartBreakdown=true');
    return { ok: true, h: (d.totalDataChart || []).slice(-LLAMA_HIST_DAYS).map(function (r) { return [llamaDay_(r[0]), Math.round(r[1] || 0)]; }) };
  } catch (e) { return { ok: false, error: '手数料の推移はありません' }; }
}
/** エアドロップ候補: トークン未発行の先物 DEX (予測市場・取引所の外のものは除く) */
function llamaIsCand_(x) { return x.token === false && !/prediction/i.test(x.cat || '') && (x.ch || []).indexOf('Off Chain') < 0; }

// =====================================================================
//  記録の見張り — それぞれの記録が最後にいつ動いたかを控え、止まっていたら知らせる
//    HB_<名前> = 最後に成功した時刻 / HBE_<名前> = 最後の失敗 (時刻 + 理由)。成功したら失敗は消す
// =====================================================================

const HEALTH_JOBS = [
  { k: 'record',   n: 'Polymarket の確率・出来高',        every: '1時間ごと', max: 3 },
  { k: 'fed',      n: 'Kalshi との比較',                  every: '1時間ごと', max: 3 },
  { k: 'hl',       n: 'Hyperliquid の建玉・ファンディング', every: '1時間ごと', max: 3 },
  { k: 'macro',    n: 'マクロ指標の更新',                  every: '1時間ごと', max: 3 },
  { k: 'resolve',  n: '決着の取り込み',                    every: '毎日5時',   max: 30 },
  { k: 'daily',    n: '日ごとの要約',                      every: '毎日5時',   max: 30 },
  { k: 'macrolog', n: 'マクロの日誌 (天気図)',             every: '毎日5時',   max: 30 },
  { k: 'llama',    n: 'お金の流れ (TVL・先物 DEX)',        every: '毎日5時',   max: 30 },
  { k: 'alert',    n: '急変の確認 (通知)',                 every: '10分おき',  max: 1, mail: 'PM_ALERT_ON' },
  { k: 'digest',   n: '毎朝のまとめメール',                every: '毎日8時',   max: 30, mail: 'PM_DIGEST_ON' },
];
const HEALTH_TRIGGERS = ['pmRecord', 'pmResolve', 'pmAlert', 'pmDigest'];
const HEALTH_MAIL_EVERY = 24 * 3600000;

function hbOk_(k) {
  const p = PropertiesService.getScriptProperties();
  p.setProperty('HB_' + k, new Date().toISOString());
  if (p.getProperty('HBE_' + k)) p.deleteProperty('HBE_' + k);
}
function hbErr_(k, e) { PropertiesService.getScriptProperties().setProperty('HBE_' + k, new Date().toISOString() + ' ' + String(e).slice(0, 200)); }
function hbRun_(k, fn) {
  try { fn(); hbOk_(k); }
  catch (e) { hbErr_(k, e); Logger.log(k + ' に失敗: ' + e); }
}
/** 記録ごとの状態: ok (動いている) / stale (止まっている) / error (直近が失敗) / never (まだ一度も) / off (通知をオフにしている) */
function pmHealth_() {
  const p = PropertiesService.getScriptProperties();
  const now = Date.now();
  let since = Number(p.getProperty('HB_SINCE') || 0);
  if (!since) { since = now; p.setProperty('HB_SINCE', String(now)); }
  const mailTo = pmMailTo_();
  const jobs = HEALTH_JOBS.map(function (j) {
    const t = p.getProperty('HB_' + j.k), err = p.getProperty('HBE_' + j.k);
    let st;
    if (j.mail && (!mailTo || !pmMailOn_(j.mail))) st = 'off';
    else if (err && (!t || err.slice(0, 24) > t)) st = 'error';
    else if (!t) st = now - since > j.max * 3600000 ? 'stale' : 'never';
    else st = now - Date.parse(t) > j.max * 3600000 ? 'stale' : 'ok';
    // late = 決まった間隔を過ぎても成功していない (1回だけの失敗ではメールしないための印)
    const late = (st === 'stale') || (st === 'error' && now - (t ? Date.parse(t) : since) > j.max * 3600000);
    return { k: j.k, n: j.n, every: j.every, t: t || null, st: st, err: st === 'error' ? err.slice(25) : null, late: late };
  });
  let have = [];
  try { have = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); }); } catch (e) {}
  const missing = HEALTH_TRIGGERS.filter(function (f) { return have.indexOf(f) < 0; });
  const bad = jobs.filter(function (j) { return j.st === 'stale' || j.st === 'error'; });
  return { at: now, jobs: jobs, missing: missing, bad: bad.length, ok: !bad.length && !missing.length };
}
function pmHealthText_(h) {
  const lines = h.jobs.filter(function (j) { return j.st === 'stale' || j.st === 'error'; }).map(function (j) {
    return '・' + j.n + ' (' + j.every + '): ' + (j.st === 'error' ? '失敗しています — ' + j.err : '止まっています')
      + (j.t ? ' ／ 最後に動いたのは ' + Utilities.formatDate(new Date(j.t), 'Asia/Tokyo', 'M/d HH:mm') : ' ／ まだ一度も動いていません');
  });
  if (h.missing.length) lines.push('・自動で動かす設定 (トリガー) がありません: ' + h.missing.join(', ') + ' → Apps Script で setup を実行してください');
  return lines;
}
/** 毎朝のまとめに入れる1行 (問題がある時だけ) */
function pmHealthLine_() {
  try { const h = pmHealth_(); return h.ok ? '\n・記録はすべて動いています' : '\n・⚠ 止まっている記録があります:\n' + pmHealthText_(h).join('\n'); }
  catch (e) { return ''; }
}
/** 止まっている記録があればメールで知らせる (24時間に1回まで) */
function pmHealthMail_() {
  const p = PropertiesService.getScriptProperties();
  const to = pmMailTo_();
  if (!to || !ntf_().health) return;
  const h = pmHealth_();
  const late = h.jobs.filter(function (j) { return j.late; }).length;   // トリガーが無い時はそもそもここが動かないので、アプリの画面で知らせる
  if (!late) { if (h.ok && p.getProperty('HEALTH_MAILED')) p.deleteProperty('HEALTH_MAILED'); return; }
  const last = Number(p.getProperty('HEALTH_MAILED') || 0);
  if (Date.now() - last < HEALTH_MAIL_EVERY) return;
  MailApp.sendEmail({ to: to, subject: '【ポリマーケット】⚠ 記録が止まっています (' + (h.bad + (h.missing.length ? 1 : 0)) + '件)',
    body: '自動の記録に問題があります。記録は貯め続けることに価値があるので、早めに確かめてください。\n\n' + pmHealthText_(h).join('\n')
      + '\n\n確かめ方: アプリの「設定」→「状況を確認」で、それぞれの記録の状態が見られます。\n1〜2時間たっても直らない時は、Apps Script の画面で setup を実行してみてください。' });
  p.setProperty('HEALTH_MAILED', String(Date.now()));
}

// =====================================================================
//  通知の条件 (アプリの設定で変えられる)。Script Properties の PM_NOTIFY に、初期値と違うものだけ保存
//    単位は画面と同じ: pt・%・倍・ドル・時間
// =====================================================================

/** [初期値, 最小, 最大] (true/false はオン・オフ) */
const NTF_SPEC = {
  pm: [true], h1: [10, 1, 50], d1: [15, 1, 80], wh1: [5, 1, 50], volx: [3, 1.5, 50], minvol: [10000, 0, 10000000], cool: [6, 1, 72],
  kalshi: [true], gap: [5, 1, 50],
  hl: [true], oi: [20, 5, 200], fhi: [0.05, 0.005, 1], flo: [-0.03, -1, -0.005],
  health: [true],
  dMacro: [true], dFlow: [true],   // 毎朝のまとめに入れる欄 (マクロ指標の一覧 / お金の流れ)
};
function ntfDefaults_() { const o = {}; Object.keys(NTF_SPEC).forEach(function (k) { o[k] = NTF_SPEC[k][0]; }); return o; }
function ntf_() {
  const o = ntfDefaults_();
  let saved = {};
  try { saved = JSON.parse(PropertiesService.getScriptProperties().getProperty('PM_NOTIFY') || '{}') || {}; } catch (e) {}
  Object.keys(NTF_SPEC).forEach(function (k) { if (saved[k] != null && typeof saved[k] === typeof o[k]) o[k] = saved[k]; });
  return o;
}
/** 送られてきた値を範囲に収めて保存する (知らない項目・数でないものは無視) */
function ntfSave_(input) {
  const cur = ntf_(), def = ntfDefaults_(), out = {};
  Object.keys(NTF_SPEC).forEach(function (k) {
    const sp = NTF_SPEC[k];
    let v = input[k] != null ? input[k] : cur[k];
    if (typeof sp[0] === 'boolean') v = !!v;
    else { v = Number(v); if (isNaN(v)) v = cur[k]; v = Math.max(sp[1], Math.min(sp[2], v)); }
    if (v !== def[k]) out[k] = v;
  });
  PropertiesService.getScriptProperties().setProperty('PM_NOTIFY', JSON.stringify(out));
}
