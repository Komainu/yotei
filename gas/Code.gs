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

/** 期限が何日以内なら「緊急」として強調するか */
const URGENT_DAYS = 7;

/** Telegramを何分おきに確認するか (1, 5, 10, 15, 30 のいずれか) */
const POLL_MINUTES = 1;   // ボタンの反応を早くするため1分おき

/** このスクリプトの版数 (アプリ側で古いかどうか判定するのに使う) */
const GAS_VERSION = '2026.10.27';

// =====================================================================
//  受信箱 — Telegramで行った変更を記録し、Web版AIへの引き継ぎに使う
//  (Web版AIが台帳の本体なので、Telegram側の変更をそちらへ戻す必要がある)
// =====================================================================

function getInbox_() {
  try { return JSON.parse(loadBlob_('INBOX') || '[]'); } catch (e) { return []; }
}

function logInbox_(entry) {
  const list = getInbox_();
  entry.at = new Date().toISOString();
  list.push(entry);
  saveBlob_('INBOX', JSON.stringify(list.slice(-100)));
}

// =====================================================================
//  データの保存 / 読み出し
//  (1件あたり9KB制限を回避するため分割して保存します)
// =====================================================================

function saveBlob_(key, str) {
  const props = PropertiesService.getScriptProperties();
  const CHUNK = 8000;
  const n = Math.ceil(str.length / CHUNK) || 1;
  const old = Number(props.getProperty(key + '_N') || 0);
  for (let i = 0; i < n; i++) props.setProperty(key + '_' + i, str.substr(i * CHUNK, CHUNK));
  for (let j = n; j < old; j++) props.deleteProperty(key + '_' + j);
  props.setProperty(key + '_N', String(n));
}

function loadBlob_(key) {
  const props = PropertiesService.getScriptProperties();
  const n = Number(props.getProperty(key + '_N') || 0);
  let out = '';
  for (let i = 0; i < n; i++) out += (props.getProperty(key + '_' + i) || '');
  return out;
}

function getProjects_() {
  const raw = loadBlob_('ALL');
  if (raw) { try { return JSON.parse(raw); } catch (e) {} }
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('PROJECTS') || '[]'); }
  catch (e) { return []; }
}

/** 削除した案件の記録 (id → 削除時刻)。複数端末の合体で「消したのに復活」を防ぐ */
function getTombs_() {
  try { return JSON.parse(loadBlob_('DELETED') || '{}') || {}; } catch (e) { return {}; }
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

// =====================================================================
//  アプリとの通信
// =====================================================================

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    const raw = (e && e.parameter && e.parameter.payload)
      ? e.parameter.payload
      : (e && e.postData ? e.postData.contents : '{}');
    const data = JSON.parse(raw);
    const props = PropertiesService.getScriptProperties();

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
  base.tgChats = tgChats_().length;
  base.alertLastOk = props.getProperty('ALERT_LAST_OK') || null;
  try { base.tgLastSend = JSON.parse(props.getProperty('TG_LAST_SEND') || 'null'); } catch (e) { base.tgLastSend = null; }
  base.inbox = getInbox_();
  try { base.game = gameSummary_(); } catch (e) { base.game = null; }
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
  const keep = ['sendDailyMail', 'pollTelegram', 'checkDeadlines'];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (keep.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendDailyMail')
    .timeBased().atHour(SEND_HOUR).everyDays(1).inTimezone('Asia/Tokyo').create();
  // 朝のTelegramダイジェストは pollTelegram の中から1日1回送る (専用トリガーは不要。
  // 以前の checkDeadlines トリガーが残っていると通知が二重になるため、上で削除している)
  ScriptApp.newTrigger('pollTelegram')
    .timeBased().everyMinutes(POLL_MINUTES).create();
  Logger.log('メール通知 ' + SEND_HOUR + ':00 / Telegramダイジェスト ' + ALERT_HOUR + ':00 / '
    + POLL_MINUTES + '分おきのTelegram確認 を登録しました');
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
  if (!props.getProperty('TG_TOKEN')) return;

  // 1日1回のダイジェスト。新着が無い時も確実に動くよう、受信処理より前で呼ぶ
  try { maybeRunDailyAlert_(); } catch (e) { Logger.log('ダイジェスト失敗: ' + e); }
  try { maybeNudge_(); } catch (e) { Logger.log('夜のお知らせ失敗: ' + e); }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
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
      const g = getGame_();
      const doneBefore = g.doneTotal || 0;
      const a = awardDone_(g, p);
      touchStreak_(g);
      const q = ensureQuest_(g, list);
      if (q.ids.indexOf(p.id) >= 0) q.res[p.id] = 'done';
      putGame_(g);
      tgSend_('✅ 完了にしました: <b>' + esc(p.name) + '</b>  +' + a.xp + 'XP 🔥' + g.streak + '日連続', from);
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
  try { g = JSON.parse(loadBlob_('GAME') || '{}') || {}; } catch (e) { g = {}; }
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
  return near.concat(pins).slice(0, 3).map(function (p) { return p.id; });
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
      const a = awardDone_(g, p);
      up = a.up || up;
      touchStreak_(g);
      q.res[id] = parts[1] === 'x' ? 'drop' : 'done';
      changed = true;
      logInbox_({ type: 'done', id: p.id, name: p.name, dropped: parts[1] === 'x' || undefined });
      try { logHist_([histEntry_(parts[1] === 'x' ? 'drop' : 'done', p, 'tg')]); } catch (e) {}
      toast = (parts[1] === 'x' ? '🙅 見送りました' : '✅ 完了！') + ' +' + a.xp + 'XP';
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
  try { return JSON.parse(loadBlob_('HIST') || '[]') || []; } catch (e) { return []; }
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
