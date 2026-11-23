'use strict';
/* ホームの「⭐ 今日の注目」: 各タブが読み込んだデータから、大きな変化を点数の高い順に5つまで (サーバーへの通信は増やさない) */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('./helpers/gas');
const { openApp, GAS_URL } = require('./helpers/app');
const { createClock } = require('./helpers/clock');

const H = 3600000, D = 24 * H;
async function open() {
  const clock = createClock('2026-11-14T10:00:00+09:00');
  const gas = loadGas({ clock, fetch: url => { throw new Error('使わない: ' + url); } });
  const app = await openApp({ clock, gas, fetch: async () => { throw new TypeError('offline'); }, state: { settings: { gasUrl: GAS_URL, gasAuto: false } } });
  for (let i = 0; i < 8; i++) await app.settle();
  /* 読み込みが終わった状態から、各タブのデータを直接入れる */
  app.run(`(() => {
    pm.events = []; pm.watch = {}; pm.sc = {}; pm.hide = {};
    CMP.data = null; MC.res = null; MC.changed = []; OP.data = null; HL.data = null; OK.data = null; H2.data = null; H2.hist = {};
    US.data = null; FM.data = null; FD.data = null; CG.data = null; CG.hist = {}; NW.data = null;
    [pm, MC, CMP, HL, H2, OK, OP, NW, US, FL, FM, FD, CG].forEach(o => { o.loading = false; });
  })()`);
  return { app, clock };
}
const rows = app => [...app.doc.querySelectorAll('#hmHi .hm-row')].map(r => ({ title: r.querySelector('b').textContent, sub: r.querySelector('small').textContent, score: Number(r.querySelector('.hm-badge').textContent), jump: r.dataset.jump, kind: r.dataset.hi }));
const draw = app => { app.run('renderTop()'); return rows(app); };
const ev = (id, q, d1, p) => ({ id, t: q, multi: false, markets: [{ q, p: [p, 1 - p], d1 }] });

test('並び: Polymarket (ウォッチ +10)・Kalshi のずれ (赤・同じ会合は1つ)・マクロ (変わった信号と赤は高い方だけ)・ニュース。上位5つ・行き先のタブ・題はエスケープ', async () => {
  const { app, clock } = await open();
  try {
    const now = clock.now;
    app.run(`(() => {
      pm.events = [${JSON.stringify(ev('e1', 'Will BTC hit 150k?', 0.15, 0.45))}, ${JSON.stringify(ev('e2', 'Fed cut in December?', -0.30, 0.2))},
        ${JSON.stringify(ev('e3', 'Small move', 0.05, 0.5))}, ${JSON.stringify(ev('e4', 'Not for you', 0.5, 0.9))}, ${JSON.stringify(ev('e5', '<img src=x onerror=alert(1)>Evil', 0.12, 0.3))}];
      pm.watch = { e1: true, e5: true }; pm.sc = { e2: { s: 2 }, e3: { s: 3 }, e4: { s: 0 } };
      CMP.data = { gapAlert: 0.05, list: [{ d: '2026-12-09', rows: [
        { ja: '据え置き', gap: 0.08, diff: 0.08, pm: { p: 0.6 }, k: { p: 0.52 } },
        { ja: '0.25%利下げ', gap: 0.06, diff: -0.06, pm: { p: 0.3 }, k: { p: 0.36 } },
        { ja: '利上げ', gap: 0.01, diff: 0.01, pm: { p: 0.02 }, k: { p: 0.01 } }] }] };
      MC.res = { vix: { sig: 'r', why: '不安が高い' }, netliq: { sig: 'r', why: '市場のお金が減っている' }, fng: { sig: 'r' }, dxy: { sig: 'g' } };
      MC.changed = [{ id: 'vix', from: 'y', to: 'r' }];
      NW.data = { feeds: [{ k: 'frb', n: 'FRB', off: true }, { k: 'coindesk', n: 'CoinDesk', off: false }], news: { items: [
        { id: 'n1', s: 'frb', t: ${now - 2 * H}, sc: 3, ti: 'FOMC statement', ja: 'FOMC の声明' },
        { id: 'n2', s: 'frb', t: ${now - 13 * H}, sc: 3, ti: 'Old' },
        { id: 'n3', s: 'coindesk', t: ${now - H}, sc: 3, ti: 'Not official' },
        { id: 'n4', s: 'frb', t: ${now - H}, sc: 2, ti: 'Minor' }] } };
    })()`);
    const all = app.run('hiSignals()');
    assert.ok(all.length <= 5);
    const r = draw(app);
    assert.equal(r.length, 5, '上位5つまで');
    assert.deepEqual(r.map(x => [x.kind, x.score, x.jump]), [['pm', 100, 'poly'], ['pm', 85, 'poly'], ['kalshi', 80, 'poly'], ['mc', 80, 'btc'], ['pm', 70, 'poly']]);
    assert.equal(r[0].title, 'Fed cut in December?');
    assert.equal(r[0].sub, '24時間で −30pt ・ いま はい 20%');
    assert.equal(r[1].sub, '24時間で +15pt ・ いま はい 45% ・ ウォッチ中', 'ウォッチは 75 + 10');
    assert.match(r[2].title, /Kalshi とのずれ \(据え置き\)/, '同じ会合の赤は高い方だけ');
    assert.equal(r[2].sub, 'Polymarket 60% ／ Kalshi 52% (差 8pt)');
    assert.equal(r[3].title, 'VIX (恐怖指数) の信号が変わりました'.replace('VIX (恐怖指数)', app.run('mcName("vix")')));
    assert.match(r[3].sub, /🟡 → 🔴 ・ 不安が高い/);
    assert.equal(r[4].title, '<img src=x onerror=alert(1)>Evil');
    assert.equal(app.doc.querySelectorAll('#hmHi img').length, 0, '外から来る題はエスケープ');
    // 6番目以降 (netliq の赤 60・FRB の公式発表 60) は出ない。重複は1つ
    const keys = all.map(x => x.kind + ':' + x.subj);
    assert.equal(new Set(keys).size, keys.length);
    assert.equal(all.filter(x => x.kind === 'mc' && x.subj === 'vix').length, 1, 'vix は変わった信号 (80) と赤 (60) の高い方だけ');
    // 上の2つを消すと、ニュースとマクロの赤が入る (12時間より前・公式でない・重要度2は入らない)
    app.run('pm.events = pm.events.filter(e => e.id !== "e1" && e.id !== "e2")');
    const r2 = draw(app);
    assert.deepEqual(r2.map(x => x.kind), ['kalshi', 'mc', 'pm', 'mc', 'news']);
    assert.equal(r2[3].title, app.run('mcName("netliq")') + ' が向かい風');
    assert.equal(r2[4].title, 'FOMC の声明');
    assert.match(r2[4].sub, /^FRB ・ /);
    assert.equal(r2[4].jump, 'news');
    // 押すとそのタブへ
    app.doc.querySelector('#hmHi .hm-row[data-hi="news"]').click();
    assert.ok(app.doc.querySelector('#tab-news').classList.contains('active'));
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('先物・オプション: DVOL (24時間の変化・順位)・スキューの向き・OKX の比率と清算・大口の BTC の向き (前の日が無ければ出さない)・Hyperliquid のファンディング', async () => {
  const { app, clock } = await open();
  try {
    const now = clock.now;
    app.run(`(() => {
      OP.data = { opt: { cur: { BTC: { dvol: { v: 55, d1: 8, rank: 90 }, skew: 4 }, ETH: { dvol: { v: 70, d1: 1, rank: 50 }, skew: -2 } } },
        hist: { '2026-11-13': { BTC: [0, 0, 0, 0, 0, 0, -3], ETH: [0, 0, 0, 0, 0, 0, -1.5] }, '2026-11-14': { BTC: [0, 0, 0, 0, 0, 0, 4] } } };
      OK.data = { coins: { BTC: { ls: 3, liq: { long24: 2e8, short24: 1e7, span: 24 } }, ETH: { ls: 0.5 }, SOL: { ls: 1.2, liq: { long24: 5e7, short24: 1e6, span: 24 } } } };
      H2.data = { whales: { nLb: 20, net: [{ c: 'BTC', net: 5e6, nL: 12, nS: 8 }] } }; H2.hist = { '2026-11-13': { net: { BTC: -3e6 } } };
      HL.data = { snap: { perps: [{ n: 'SOL', f: 0.0001 }, { n: 'BTC', f: 0.00001 }] }, series: { SOL: [], BTC: [] } };
    })()`);
    const all = app.run('hiSignals()');
    const r = draw(app);
    assert.deepEqual(r.map(x => [x.kind, x.score]), [['liq', 100], ['dvol', 80], ['fund', 80], ['ls', 60], ['ls', 60]]);
    assert.equal(r[0].title, 'OKX の BTC: 買いの清算が多い');
    assert.equal(r[0].sub, '24時間 で 2.0億ドル');
    assert.equal(r[1].title, 'BTC の予想変動率 (DVOL) 55');
    assert.equal(r[1].sub, '24時間で +8 ・ 90日の中で 90% の位置', 'max(80, 50 + 5/15×50 = 67)');
    assert.equal(r[2].title, 'SOL のファンディングが高い (買いが過熱)');
    assert.deepEqual(r.map(x => x.jump), ['hl', 'opt', 'hl', 'hl', 'hl']);
    assert.equal(all.length, 5);
    // 上位の外: 大口の向き (60)・スキュー (55)。DVOL を消すと出てくる
    app.run('OK.data = null; HL.data = null');
    const r2 = draw(app);
    assert.deepEqual(r2.map(x => [x.kind, x.score]), [['dvol', 80], ['whale', 60], ['skew', 55]]);
    assert.equal(r2[1].title, '大口の BTC が買い越しに変わりました');
    assert.equal(r2[1].sub, '12人が買い・8人が売り (前の日は売り越し)');
    assert.equal(r2[2].sub, '−3 → +4 (下げへの備えが増えた)');
    // 前の日の値が無ければ大口もスキューも出さない
    app.run('H2.hist = {}; OP.data.hist = {}');
    assert.deepEqual(draw(app).map(x => x.kind), ['dvol']);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('米国のお金・お金の流れ: SRF・TGA・弱い入札・ペッグ外れ (流通5億ドル以上)・ハッキング (3日以内)・資金調達 (2日以内・トークン未発行は +15)・BTC の占める割合の7日の変化', async () => {
  const { app, clock } = await open();
  try {
    const now = clock.now;
    app.run(`(() => {
      US.data = { srf: [['2026-11-13', 0.6]], tga: [['2026-11-12', 800], ['2026-11-13', 870]], auctions: { recent: [{ n: '10年債', d: '2026-11-12', weak: true }, { n: '2年債', d: '2026-11-05', weak: true }] } };
      FM.data = { pegs: { off: [{ sym: 'USDX', n: 'X', px: 0.995, circ: 6e8, dev: -0.5 }, { sym: 'TINY', n: 'T', px: 0.9, circ: 1e8, dev: -10 }] },
        hacks: { list: [{ n: 'BadDEX', d: '2026-11-13', amt: 3e7 }, { n: 'OldHack', d: '2026-11-01', amt: 9e8 }, { n: 'Small', d: '2026-11-13', amt: 1e6 }] } };
      FD.data = { fund: { list: [{ p: 'Acme', t: ${now - D}, amt: 4e7, token: false, r: 'Seed' }, { p: 'Listed', t: ${now - D}, amt: 4e7, token: true }, { p: 'Older', t: ${now - 3 * D}, amt: 9e8 }] } };
      CG.data = { global: { btcDom: 58 } }; CG.hist = { '2026-11-10': { btcDom: 56.5 }, '2026-11-14': { btcDom: 58 } };
    })()`);
    const all = app.run('hiSignals()');
    assert.equal(all.length, 5);
    const r = draw(app);
    assert.deepEqual(r.map(x => [x.kind, x.score]), [['raise', 82], ['hack', 75], ['dom', 75], ['tga', 70], ['raise', 67]]);
    assert.equal(r[0].title, '資金調達: Acme');
    assert.match(r[0].sub, /トークン未発行$/);
    assert.equal(r[1].title, 'ハッキング被害: BadDEX');
    assert.equal(r[2].sub, 'いま 58% ・ 7日で +1.5pt');
    assert.match(r[3].title, /財務省口座 \(TGA\) が1日で増えました/);
    assert.deepEqual(r.map(x => x.jump), ['flow', 'flow', 'flow', 'btc', 'flow']);
    // 上位の外: 弱い入札 55・ペッグ 50・SRF 30 (古い入札・小さいペッグ・古いハッキングは出さない)
    app.run('FD.data = null; CG.data = null; FM.data.hacks.list = []; US.data.tga = []');
    const r2 = draw(app);
    assert.deepEqual(r2.map(x => [x.kind, x.score]), [['auc', 55], ['peg', 50], ['srf', 30]]);
    assert.equal(r2[0].title, '国債の入札が不調: 10年債');
    assert.equal(r2[1].title, 'USDX が1ドルからずれています');
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('空・読み込み中: 何も無ければ「大きな変化は今のところありません」。読み込み中のタブがあれば「読み込み中のデータがあります」。今日の注目は日付の下・天気図の上', async () => {
  const { app } = await open();
  try {
    let r = draw(app);
    assert.equal(r.length, 0);
    assert.match(app.text('#hmHi'), /^⭐ 今日の注目大きな変化は今のところありません$/);
    app.run('NW.loading = true');
    draw(app);
    assert.match(app.text('#hmHi'), /読み込み中のデータがあります/);
    app.run('NW.loading = false');
    draw(app);
    assert.doesNotMatch(app.text('#hmHi'), /読み込み中/);
    const hi = app.doc.querySelector('#hmHi');
    assert.equal(hi.previousElementSibling.id, 'homeDate', '日付のすぐ下');
    assert.ok(hi.compareDocumentPosition(app.doc.querySelector('#homeBody .hm-hero')) & 4, '天気図より上');
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
  // サーバー未登録
  const app2 = await openApp({ fetch: async () => { throw new TypeError('offline'); } });
  try {
    await app2.settle();
    assert.match(app2.text('#hmHi'), /設定でサーバー \(Apps Script\) の URL を入れると/);
    assert.deepEqual(app2.errors, []);
  } finally { app2.close(); }
});
