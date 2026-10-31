'use strict';
/* index.html を jsdom で開く。画面の外 (通信・ダイアログ等) は簡単な偽物にする */
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { createClock } = require('./clock');

const HTML_PATH = path.join(__dirname, '..', '..', 'index.html');
const HTML = fs.readFileSync(HTML_PATH, 'utf8');
const GAS_URL = 'https://script.google.com/macros/s/TEST/exec';

/** fetch の応答の形 */
const reply = obj => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(obj)), text: async () => JSON.stringify(obj) });

/**
 * gas (helpers/gas.js の loadGas の戻り値) を渡すと、アプリの通信がそこへ届く。
 * opts.state を渡すと localStorage(sakiyomi_v1) に入れた状態で起動する。
 */
async function openApp(opts) {
  opts = opts || {};
  const clock = opts.clock || createClock(opts.start);
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push('jsdomError: ' + (e && (e.stack || e.message) || e)));
  vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
  vc.on('warn', () => {});
  const requests = [];

  const fakeFetch = async (url, init) => {
    url = String(url);
    requests.push({ url, init });
    if (opts.gas && url.startsWith(GAS_URL)) {
      opts.gas.clock.now = clock.now;   // 同じ時計を共有
      if (init && String(init.method || 'GET').toUpperCase() === 'POST') {
        return reply(JSON.parse(opts.gas.ctx.doPost({ postData: { contents: init.body }, parameter: {} }).getContent()));
      }
      const params = Object.fromEntries(new URL(url).searchParams);
      return reply(JSON.parse(opts.gas.ctx.doGet({ parameter: params }).getContent()));
    }
    if (opts.fetch) return opts.fetch(url, init);
    throw new TypeError('テストではこの通信はできません: ' + url);
  };

  const dom = new JSDOM(HTML, {
    url: 'https://komainu.github.io/yotei/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(win) {
      win.Date = clock.Date;
      win.fetch = fakeFetch;
      win.confirm = () => (opts.confirm !== undefined ? opts.confirm : true);
      win.alert = () => {};
      win.scrollTo = () => {};
      if (win.HTMLDialogElement) {
        const P = win.HTMLDialogElement.prototype;
        if (typeof P.showModal !== 'function' || opts.stubDialog !== false) {
          P.showModal = function () { this.setAttribute('open', ''); };
          P.show = function () { this.setAttribute('open', ''); };
          P.close = function () { this.removeAttribute('open'); };
        }
      }
      Object.defineProperty(win.navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true });
      win.HTMLCanvasElement.prototype.getContext = () => null;
      win.addEventListener('error', e => errors.push('window error: ' + (e.error && e.error.stack || e.message)));
      win.addEventListener('unhandledrejection', e => errors.push('unhandledrejection: ' + (e.reason && e.reason.stack || e.reason)));
      if (opts.state) win.localStorage.setItem('sakiyomi_v1', JSON.stringify(opts.state));
    },
  });
  const win = dom.window;
  await settle(win);
  return {
    dom, win, doc: win.document, clock, errors, requests, GAS_URL,
    /** アプリのスクリプトの中で式を評価する (const/let の変数も見える) */
    run: code => win.eval(code),
    text: sel => { const el = win.document.querySelector(sel); return el ? el.textContent : null; },
    settle: () => settle(win),
    close: () => win.close(),
  };
}

/** 非同期の処理 (起動時の同期など) が終わるのを少し待つ */
async function settle(win) {
  for (let i = 0; i < 20; i++) await new Promise(r => win.setTimeout(r, 0));
}

module.exports = { openApp, GAS_URL, HTML };
