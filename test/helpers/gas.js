'use strict';
/* gas/Code.gs を Node の vm で読み込み、Google Apps Script の簡単な偽物を差し込む */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createClock } = require('./clock');

const CODE_PATH = path.join(__dirname, '..', '..', 'gas', 'Code.gs');
/* const で宣言された値は vm の global に出てこないので、読み込み後に取り出す */
const EXPORT_CONSTS = ['GAS_VERSION', 'STORY', 'XP_ON_TIME', 'XP_DONE', 'XP_DROP', 'XP_CHECK', 'XP_BONUS',
  'ALERT_HOUR', 'NUDGE_HOUR', 'SEND_HOUR', 'URGENT_DAYS', 'LEVEL_TITLES'];

const pad = (n, w) => String(n).padStart(w || 2, '0');
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Utilities.formatDate の偽物 (Asia/Tokyo 固定。JSTに夏時間は無いので +9時間で十分) */
function formatDate(date, tz, fmt) {
  if (tz !== 'Asia/Tokyo') throw new Error('テスト用の formatDate は Asia/Tokyo のみ対応: ' + tz);
  const t = new Date(date.getTime() + 9 * 3600000);
  if (isNaN(t)) throw new Error('Invalid Date');
  const map = {
    yyyy: () => String(t.getUTCFullYear()), MM: () => pad(t.getUTCMonth() + 1), dd: () => pad(t.getUTCDate()),
    HH: () => pad(t.getUTCHours()), mm: () => pad(t.getUTCMinutes()), ss: () => pad(t.getUTCSeconds()),
    H: () => String(t.getUTCHours()), M: () => String(t.getUTCMonth() + 1), d: () => String(t.getUTCDate()),
    E: () => WD[t.getUTCDay()],
  };
  return fmt.replace(/yyyy|MM|dd|HH|mm|ss|H|M|d|E/g, k => map[k]());
}

function createProps(initial) {
  const store = new Map(Object.entries(initial || {}));
  return {
    store,
    getProperty: k => (store.has(k) ? store.get(k) : null),
    setProperty: (k, v) => { store.set(k, String(v)); },
    deleteProperty: k => { store.delete(k); },
    getKeys: () => [...store.keys()],
    getProperties: () => Object.fromEntries(store),
  };
}

/**
 * GAS 環境を作る。
 * 戻り値: { ctx (Code.gs の関数), C (定数), clock, props, tg (Telegramの送受信記録), mails, post(), get() ... }
 */
function loadGas(opts) {
  opts = opts || {};
  const clock = opts.clock || createClock(opts.start);
  const props = createProps(opts.props);

  /* Telegram の偽物: 送ったものは tg.sent に記録、getUpdates は tg.queue から返す */
  const tg = {
    sent: [], calls: [], queue: [], nextUpdateId: 1, failSend: false,
    /** 届いた文章 (sendMessage の text) だけを取り出す */
    texts(chat) { return tg.sent.filter(s => chat == null || String(s.chat_id) === String(chat)).map(s => s.text); },
    clear() { tg.sent.length = 0; tg.calls.length = 0; },
    pushMessage(chat, text) { tg.queue.push({ update_id: tg.nextUpdateId++, message: { message_id: tg.nextUpdateId, chat: { id: Number(chat) }, text } }); },
    pushButton(chat, data, messageId) {
      tg.queue.push({ update_id: tg.nextUpdateId++, callback_query: { id: 'cb' + tg.nextUpdateId, data, message: { message_id: messageId || 100, chat: { id: Number(chat) } } } });
    },
  };
  const fetchLog = [];
  const response = obj => ({ getContentText: () => JSON.stringify(obj), getResponseCode: () => 200 });

  const UrlFetchApp = {
    fetch(url, params) {
      fetchLog.push({ url, params });
      const m = String(url).match(/^https:\/\/api\.telegram\.org\/bot[^/]+\/(\w+)$/);
      if (m) {
        const method = m[1];
        const body = params && params.payload ? JSON.parse(params.payload) : {};
        tg.calls.push({ method, body });
        if (method === 'getUpdates') {
          const off = Number(body.offset || 0);
          const res = tg.queue.filter(u => u.update_id >= off).slice(0, body.limit || 100);
          tg.queue = tg.queue.filter(u => !res.includes(u));
          return response({ ok: true, result: res });
        }
        if (method === 'sendMessage') {
          if (tg.failSend) return response({ ok: false, description: 'テスト用の送信失敗' });
          tg.sent.push(body);
          return response({ ok: true, result: { message_id: tg.sent.length } });
        }
        return response({ ok: true, result: true });
      }
      if (opts.fetch) return opts.fetch(url, params);
      throw new Error('テストでは外部への通信はできません: ' + url);
    },
  };

  const mails = [];
  const logs = [];
  const sandbox = {
    Date: clock.Date,
    console,
    PropertiesService: { getScriptProperties: () => props },
    UrlFetchApp,
    Utilities: { formatDate },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput(content) {
        const o = { content, mime: null, setMimeType(m) { o.mime = m; return o; }, getContent: () => content };
        return o;
      },
    },
    MailApp: { sendEmail(m) { mails.push(m); } },
    Logger: { log: s => logs.push(String(s)) },
    ScriptApp: {
      triggers: [],
      getProjectTriggers() { return sandbox.ScriptApp.triggers; },
      deleteTrigger(t) { sandbox.ScriptApp.triggers = sandbox.ScriptApp.triggers.filter(x => x !== t); },
      newTrigger(fn) {
        const t = { fn, getHandlerFunction: () => fn };
        const b = { timeBased: () => b, atHour: h => { t.hour = h; return b; }, everyDays: () => b, everyMinutes: m => { t.minutes = m; return b; }, inTimezone: () => b, create: () => { sandbox.ScriptApp.triggers.push(t); return t; } };
        return b;
      },
    },
  };
  const ctx = vm.createContext(sandbox);
  const code = fs.readFileSync(CODE_PATH, 'utf8');
  vm.runInContext(code + '\n;globalThis.__C = {' + EXPORT_CONSTS.join(',') + '};', ctx, { filename: 'Code.gs' });
  const C = ctx.__C;

  const parse = out => JSON.parse(out.getContent());
  const env = {
    ctx, C, clock, props, tg, mails, logs, fetchLog,
    /** doPost に JSON を送る (アプリの fetch と同じ形) */
    post(obj) { return parse(ctx.doPost({ postData: { contents: JSON.stringify(obj) }, parameter: {} })); },
    /** フォーム送信 (payload=) の形で送る */
    postForm(obj) { return parse(ctx.doPost({ parameter: { payload: JSON.stringify(obj) } })); },
    get(params) { return parse(ctx.doGet({ parameter: params || {} })); },
    projects() { return JSON.parse(ctx.loadBlob_('ALL') || '[]'); },
    tombs() { return JSON.parse(ctx.loadBlob_('DELETED') || '{}'); },
    game() { return JSON.parse(ctx.loadBlob_('GAME') || '{}'); },
    hist() { return JSON.parse(ctx.loadBlob_('HIST') || '[]'); },
    setProjects(list) { ctx.saveBlob_('ALL', JSON.stringify(list)); },
    /** Telegram を有効にした状態にする */
    enableTelegram(chats) {
      props.setProperty('TG_TOKEN', 'test-token');
      props.setProperty('TG_CHAT', (chats || ['111']).join(','));
    },
  };
  return env;
}

/** 案件を1件作る (テスト用) */
function project(clock, fields) {
  const now = new Date(clock.now).toISOString();
  return Object.assign({ id: 'p' + Math.random().toString(36).slice(2, 8), name: '案件', chain: '', deadline: '', memo: '', sources: [], pinned: false, status: 'open', createdAt: now, updatedAt: now }, fields || {});
}

module.exports = { loadGas, project, formatDate };
