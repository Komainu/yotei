'use strict';
/* gas/Code.gs を Node の vm で読み込み、Google Apps Script の簡単な偽物を差し込む */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createClock } = require('./clock');

const CODE_PATH = path.join(__dirname, '..', '..', 'gas', 'Code.gs');
/* const で宣言された値は vm の global に出てこないので、読み込み後に取り出す */
const EXPORT_CONSTS = ['GAS_VERSION'];

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

/**
 * DriveApp の偽物。drive.files に中身を持つ。
 * drive.fail = { write: n } で n 回目以降の書き込みを失敗させる / { read: true } で読み出しを失敗させる
 */
function createDrive(clock) {
  const items = new Map();   // id → {kind, name, content, parent, trashed, created}
  let seq = 0;
  const drive = { items, fail: {}, writes: 0, calls: 0 };
  const iter = list => { let i = 0; return { hasNext: () => i < list.length, next: () => list[i++] }; };
  const checkWrite = () => {
    drive.writes++;
    if (drive.fail.write && drive.writes >= drive.fail.write) throw new Error('テスト用のドライブ書き込み失敗');
  };
  function wrapFile(it) {
    return {
      getId: () => it.id, getName: () => it.name, isTrashed: () => it.trashed,
      setTrashed: v => { it.trashed = !!v; },
      setContent: c => { checkWrite(); it.content = String(c); return wrapFile(it); },
      getBlob: () => ({ getDataAsString: () => { if (drive.fail.read) throw new Error('テスト用のドライブ読み出し失敗'); return it.content; } }),
      getDateCreated: () => new Date(it.created),
    };
  }
  function wrapFolder(it) {
    return {
      getId: () => it.id, getName: () => it.name, isTrashed: () => it.trashed,
      setTrashed: v => { it.trashed = !!v; },
      createFile(name, content, mime) {
        checkWrite();
        const f = { id: 'file' + (++seq), kind: 'file', name, content: String(content), mime, parent: it.id, trashed: false, created: clock.now };
        items.set(f.id, f);
        return wrapFile(f);
      },
      getFiles: () => iter([...items.values()].filter(f => f.kind === 'file' && f.parent === it.id).map(wrapFile)),
      getFilesByName: n => iter([...items.values()].filter(f => f.kind === 'file' && f.parent === it.id && f.name === n && !f.trashed).map(wrapFile)),
    };
  }
  const get = (id, kind) => { drive.calls++; const it = items.get(id); if (!it || it.kind !== kind) throw new Error('見つかりません: ' + id); return it; };
  drive.api = {
    getFileById: id => wrapFile(get(id, 'file')),
    getFolderById: id => wrapFolder(get(id, 'folder')),
    createFolder(name) {
      const f = { id: 'folder' + (++seq), kind: 'folder', name, parent: 'root', trashed: false, created: clock.now };
      items.set(f.id, f);
      return wrapFolder(f);
    },
  };
  /** 名前でフォルダ内のファイルを探す (テスト用) */
  drive.folderFiles = folderName => [...items.values()].filter(f => f.kind === 'file' && !f.trashed && items.get(f.parent) && items.get(f.parent).name === folderName);
  return drive;
}

function createProps(initial, limit) {
  const store = new Map(Object.entries(initial || {}));
  /** 保存している量 (バイト)。本物は合計500KBまで */
  const bytes = () => [...store].reduce((n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(v), 0);
  return {
    store, bytes,
    getProperty: k => (store.has(k) ? store.get(k) : null),
    setProperty: (k, v) => {
      const old = store.get(k);
      store.set(k, String(v));
      if (limit && bytes() > limit) {
        if (old === undefined) store.delete(k); else store.set(k, old);
        throw new Error('Exceeded maximum stored value size (テスト用の' + limit + 'バイト上限)');
      }
    },
    deleteProperty: k => { store.delete(k); },
    getKeys: () => [...store.keys()],
    getProperties: () => Object.fromEntries(store),
  };
}

/**
 * GAS 環境を作る。
 * 戻り値: { ctx (Code.gs の関数), C (定数), clock, props, mails, drive, post(), get() ... }
 */
function loadGas(opts) {
  opts = opts || {};
  const clock = opts.clock || createClock(opts.start);
  const props = createProps(opts.props, opts.propsLimit);

  const fetchLog = [];
  const response = obj => ({ getContentText: () => JSON.stringify(obj), getResponseCode: () => 200 });

  const UrlFetchApp = {
    fetch(url, params) {
      fetchLog.push({ url, params });
      if (opts.fetch) return opts.fetch(url, params);
      throw new Error('テストでは外部への通信はできません: ' + url);
    },
  };

  const drive = createDrive(clock);
  const mails = [];
  const logs = [];
  const sandbox = {
    Date: clock.Date,
    console,
    PropertiesService: { getScriptProperties: () => props },
    UrlFetchApp,
    Utilities: { formatDate, sleep() {} },
    DriveApp: drive.api,
    MimeType: { PLAIN_TEXT: 'text/plain' },
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
      WeekDay: { SUNDAY: 'SUNDAY', MONDAY: 'MONDAY', SATURDAY: 'SATURDAY' },
      getProjectTriggers() { return sandbox.ScriptApp.triggers; },
      deleteTrigger(t) { sandbox.ScriptApp.triggers = sandbox.ScriptApp.triggers.filter(x => x !== t); },
      newTrigger(fn) {
        const t = { fn, getHandlerFunction: () => fn };
        const b = { timeBased: () => b, atHour: h => { t.hour = h; return b; }, onWeekDay: d => { t.weekDay = d; return b; }, everyDays: () => b, everyMinutes: m => { t.minutes = m; return b; }, everyHours: h => { t.hours = h; return b; }, inTimezone: () => b, create: () => { sandbox.ScriptApp.triggers.push(t); return t; } };
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
    ctx, C, clock, props, mails, logs, fetchLog, drive,
    /** 別の実行 (トリガー・通信) が始まったことにする (今は実行をまたぐキャッシュが無いので何もしない) */
    newRun() {},
    /** doPost に JSON を送る (アプリの fetch と同じ形) */
    post(obj) { return parse(ctx.doPost({ postData: { contents: JSON.stringify(obj) }, parameter: {} })); },
    /** フォーム送信 (payload=) の形で送る */
    postForm(obj) { return parse(ctx.doPost({ parameter: { payload: JSON.stringify(obj) } })); },
    get(params) { return parse(ctx.doGet({ parameter: params || {} })); },
    /** 以前の予定管理のデータがドライブ (「予定管理データ」) に残っている状態にする */
    setLegacy(list, tombs) {
      const folder = drive.api.createFolder('予定管理データ');
      props.setProperty('STORE', 'drive');
      props.setProperty('FILE_ALL', folder.createFile('ALL.json', JSON.stringify(list || [])).getId());
      props.setProperty('FILE_DELETED', folder.createFile('DELETED.json', JSON.stringify(tombs || {})).getId());
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
