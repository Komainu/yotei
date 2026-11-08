'use strict';
/* Polymarket の画面 (一覧・急変の帯・詳細シート・和訳・あなた向け・ウォッチ) */
const test = require('node:test');
const assert = require('node:assert/strict');
const { openApp, GAS_URL } = require('./helpers/app');
const { loadGas } = require('./helpers/gas');
const { createClock } = require('./helpers/clock');

const reply = obj => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(obj)) });
const mk = (id, f) => Object.assign({
  id: String(id), question: 'Q' + id, groupItemTitle: '', outcomes: '["Yes","No"]', outcomePrices: '["0.4","0.6"]',
  oneHourPriceChange: 0, oneDayPriceChange: 0, oneWeekPriceChange: 0, volume24hr: 50000, liquidityNum: 1000,
  endDate: '2026-11-20T00:00:00Z', clobTokenIds: `["tok${id}","tokn${id}"]`, slug: 's' + id, closed: false, negRisk: false,
  events: [{ id: 'e' + id, title: 'Event ' + id, slug: 'ev' + id }],
}, f);
const ev = (id, title, extra) => [{ id, title, slug: 'slug-' + id }].map(e => Object.assign(e, extra || {}));

/** 本物に近い市場の一覧 */
function markets() {
  return [
    mk(1, { question: 'Will the Fed cut rates in December?', outcomePrices: '["0.63","0.37"]', oneHourPriceChange: 0.08, oneDayPriceChange: 0.12, volume24hr: 2500000, events: ev('fed', 'Fed decision in December?') }),
    // 段階の形 (価格のしきい値) — 本来の並び (しきい値の順) で出す
    mk(2, { question: 'Will Bitcoin reach $150k?', groupItemTitle: '↑ 150,000', groupItemThreshold: '2', outcomePrices: '["0.10","0.90"]', volume24hr: 300000, events: ev('btc', 'What price will Bitcoin hit in 2026?') }),
    mk(3, { question: 'Will Bitcoin dip to $70k?', groupItemTitle: '↓ 70,000', groupItemThreshold: '0', outcomePrices: '["0.55","0.45"]', volume24hr: 200000, events: ev('btc', 'What price will Bitcoin hit in 2026?') }),
    mk(4, { question: 'Will Bitcoin reach $130k?', groupItemTitle: '↑ 130,000', groupItemThreshold: '1', outcomePrices: '["0.30","0.70"]', volume24hr: 100000, events: ev('btc', 'What price will Bitcoin hit in 2026?') }),
    // 「どれか1つが勝つ」形 — 確率の高い順
    mk(5, { question: 'Will Alice win?', groupItemTitle: 'Alice', negRisk: true, outcomePrices: '["0.2","0.8"]', volume24hr: 90000, events: ev('el', 'Mayor election winner') }),
    mk(6, { question: 'Will Bob win?', groupItemTitle: 'Bob', negRisk: true, outcomePrices: '["0.7","0.3"]', volume24hr: 80000, events: ev('el', 'Mayor election winner') }),
    // 試合中のスポーツ (帯には出さない)
    mk(7, { question: 'Lakers vs. Celtics', outcomes: '["Lakers","Celtics"]', outcomePrices: '["0.5","0.5"]', oneHourPriceChange: 0.40, volume24hr: 9000000, events: ev('nba', 'Lakers vs. Celtics') }),
    // ほぼ決着済み・終了済みは並べない
    mk(8, { outcomePrices: '["0.999","0.001"]' }),
    mk(9, { closed: true }),
    mk(10, { question: 'Will Solana flip Ethereum?', oneHourPriceChange: -0.05, volume24hr: 40000, events: ev('sol', 'Solana flips Ethereum?') }),
  ];
}
const HIST = { history: [{ t: 1793500000, p: 0.5 }, { t: 1793503600, p: 0.55 }, { t: 1793507200, p: 0.63 }] };
function fakeNet(list) {
  const calls = [];
  const fetch = async url => {
    calls.push(url);
    const u = new URL(url);
    if (u.host === 'gamma-api.polymarket.com' && u.pathname === '/markets') {
      const id = u.searchParams.get('id');
      if (id) return reply([Object.assign({}, list.find(m => m.id === id), { description: 'This market resolves Yes if the Fed cuts rates at the December meeting.' })]);
      return reply(Number(u.searchParams.get('offset')) === 0 ? list : []);
    }
    if (u.host === 'clob.polymarket.com') return reply(HIST);
    throw new TypeError('想定外の通信: ' + url);
  };
  return { fetch, calls };
}
async function open(opts) {
  const net = fakeNet(markets());
  const app = await openApp(Object.assign({ fetch: net.fetch }, opts || {}));
  for (let i = 0; i < 5; i++) await app.settle();
  return { app, net };
}
const cards = app => [...app.doc.querySelectorAll('#pmList .pm-card')];
const titles = app => cards(app).map(c => c.querySelector('.pm-title').firstChild.textContent.trim());

test('一覧: イベントごとにまとめ、出来高の順。決着済みは出さない。金額・締切は日本語', async () => {
  const { app } = await open({ start: '2026-11-08T10:00:00+09:00' });
  try {
    assert.deepEqual(titles(app), ['Lakers vs. Celtics', 'Will the Fed cut rates in December?', 'What price will Bitcoin hit in 2026?', 'Mayor election winner', 'Will Solana flip Ethereum?']);
    const fed = cards(app)[1];
    assert.match(fed.querySelector('.pm-big').textContent, /63%\s*はい/);
    assert.match(fed.textContent, /▲8\.0pt 1時間/);
    assert.match(fed.textContent, /▲12pt 24時間/);
    assert.match(fed.textContent, /出来高 250万ドル/);
    assert.match(fed.textContent, /あと12日/);
    assert.equal(app.run('pmMoney(345000000)'), '3.5億ドル');
    assert.equal(app.run('pmMoney(1234)'), '1,234ドル');
    assert.equal(app.run('pmPct(0.004)'), '1%未満');
    // 段階の形は、しきい値の順に並べ、50%に近い3つを出す
    const btc = cards(app)[2];
    assert.deepEqual([...btc.querySelectorAll('.pm-opt .l')].map(x => x.textContent), ['↓ 70,000', '↑ 130,000', '↑ 150,000']);
    // どれか1つが勝つ形は、確率の高い順
    assert.deepEqual([...cards(app)[3].querySelectorAll('.pm-opt .l')].map(x => x.textContent), ['Bob', 'Alice']);
    // 推移グラフ (CLOB) が描かれる
    await app.settle();
    assert.ok(app.doc.querySelector('#pmList svg[data-spark="tok1"] path'), '推移グラフ');
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('急変の帯: 1時間で大きく動いた市場を出し、試合中のスポーツは除く', async () => {
  const { app } = await open();
  try {
    const mv = [...app.doc.querySelectorAll('#pmMovers .pm-mv')].map(b => b.dataset.m);
    assert.deepEqual(mv, ['1', '10'], 'Fed (▲8pt) → Solana (▼5pt)。Lakers は除く');
    assert.match(app.text('#pmMovers'), /▲8\.0pt 1時間/);
    assert.match(app.text('#pmMvHead'), /スポーツを除く/);
    // 帯を押すと詳細が開く
    app.doc.querySelector('#pmMovers .pm-mv').click();
    assert.equal(app.doc.querySelector('#pmSheet').hidden, false);
    assert.match(app.text('#pmSTitle'), /Fed cut rates/);
  } finally { app.close(); }
});

test('検索と分野: 文字を打つとすぐ絞り込む。分野のボタンで絞る', async () => {
  const { app } = await open();
  try {
    const q = app.doc.querySelector('#pmQ');
    q.value = 'bitcoin'; q.dispatchEvent(new app.win.Event('input'));
    await new Promise(r => setTimeout(r, 100));
    assert.deepEqual(titles(app), ['What price will Bitcoin hit in 2026?']);
    q.value = ''; q.dispatchEvent(new app.win.Event('input'));
    await new Promise(r => setTimeout(r, 100));
    app.doc.querySelector('#pmCats [data-cat="暗号資産"]').click();
    assert.deepEqual(titles(app), ['What price will Bitcoin hit in 2026?', 'Will Solana flip Ethereum?']);
    app.doc.querySelector('#pmCats [data-cat="スポーツ"]').click();
    assert.deepEqual(titles(app), ['Lakers vs. Celtics']);
  } finally { app.close(); }
});

test('詳細シート: 確率・チャート・選択肢の切り替え。ルールは原文を出す (サーバー無し)', async () => {
  const { app, net } = await open();
  try {
    cards(app)[2].click();   // ビットコイン (段階の形)
    await app.settle(); await app.settle();
    assert.equal(app.doc.querySelector('#pmSheet').hidden, false);
    assert.equal(app.doc.querySelectorAll('#pmSOutcomes .pm-opt').length, 3);
    assert.match(app.text('#pmSChartLabel'), /↓ 70,000 の確率/, '代表は50%に近い市場');
    assert.ok(app.doc.querySelector('#pmSChart svg'), 'チャート');
    assert.match(app.text('#pmSChart'), /この期間: 50% → 63%/);
    // 選択肢を押すとグラフが切り替わる
    app.doc.querySelector('#pmSOutcomes .pm-opt[data-m="2"]').click();
    await app.settle();
    assert.match(app.text('#pmSChartLabel'), /↑ 150,000/);
    // 期間の切り替え
    app.doc.querySelector('#pmSRange [data-r="1m"]').click();
    await app.settle();
    assert.ok(net.calls.some(u => /interval=1m/.test(u)));
    assert.match(app.text('#pmSRule'), /resolves Yes/);
    assert.match(app.text('#pmSRule'), /サーバーを登録すると、日本語の要約/);
    // 閉じる
    app.doc.querySelector('#pmSheet .pm-x').click();
    assert.equal(app.doc.querySelector('#pmSheet').hidden, true);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

/* ---------- サーバー (和訳・あなた向け・ウォッチ) ---------- */

/** Gemini の偽物: 訳は「訳:原文」、点数はイベント名に Bitcoin/Fed があれば3 */
function fakeGemini(log) {
  return (url, params) => {
    if (!/generativelanguage\.googleapis\.com/.test(url)) throw new Error('想定外: ' + url);
    const body = JSON.parse(params.payload);
    const sys = body.system_instruction.parts[0].text, input = body.contents[0].parts[0].text;
    log.push(sys.slice(0, 20));
    let out;
    if (/翻訳者/.test(sys)) out = JSON.parse(input).map(x => ({ i: x.i, ja: '訳:' + x.t }));
    else if (/興味に合う/.test(sys)) out = JSON.parse(input).map(x => ({ i: x.i, s: /Bitcoin|Fed/.test(x.t) ? 3 : 0, c: /Bitcoin|Solana/.test(x.t) ? '暗号資産' : /Fed/.test(x.t) ? '経済・金融' : 'スポーツ' }));
    else out = { ja: '・FRBが12月に利下げしたら「はい」' };
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] }) };
  };
}

test('和訳とあなた向け: サーバーで訳して保存し、2回目からは Gemini を呼ばない', async () => {
  const clock = createClock('2026-11-08T10:00:00+09:00');
  const glog = [];
  const gas = loadGas({ clock, fetch: fakeGemini(glog), props: { GEMINI_KEY: 'test-gemini' } });
  const net = fakeNet(markets());
  const app = await openApp({ clock, gas, fetch: net.fetch, state: { projects: [], settings: { gasUrl: GAS_URL, gasAuto: false }, deleted: {} } });
  try {
    for (let i = 0; i < 10; i++) await app.settle();
    assert.ok(titles(app).includes('訳:Fed decision in December?') || titles(app).includes('訳:Will the Fed cut rates in December?'));
    assert.match(cards(app)[1].querySelector('.pm-title .en').textContent, /Fed/, '原文も小さく出す');
    // あなた向け
    const you = app.doc.querySelector('#pmCats [data-cat="you"]');
    assert.match(you.textContent, /あなた向け 2/);
    you.click();
    assert.deepEqual(cards(app).map(c => c.dataset.ev), ['fed', 'btc']);
    assert.ok(cards(app)[0].classList.contains('you3'));
    // 分野は Gemini の判定を使う
    assert.equal(app.run('pmCatOf(pm.events.find(e=>e.id==="sol"))'), '暗号資産');
    // サーバーのドライブに保存された
    const tr = JSON.parse(gas.drive.folderFiles('ポリマーケット記録').find(f => f.name === 'tr.json').content);
    assert.equal(tr['Will Solana flip Ethereum?'], '訳:Will Solana flip Ethereum?');
    assert.equal(tr['Yes'], undefined, 'はい/いいえは訳さない');
    // 日本語で検索できる
    app.doc.querySelector('#pmCats [data-cat="all"]').click();
    const q = app.doc.querySelector('#pmQ');
    q.value = '訳:will solana'; q.dispatchEvent(new app.win.Event('input'));
    await new Promise(r => setTimeout(r, 100));
    assert.deepEqual(cards(app).map(c => c.dataset.ev), ['sol']);
    const n = glog.length;
    assert.ok(n >= 2);
    // 別の端末 (端末の保存なし) でも、サーバーの保存分を使うので Gemini は呼ばれない
    const app2 = await openApp({ clock, gas, fetch: fakeNet(markets()).fetch, state: { projects: [], settings: { gasUrl: GAS_URL, gasAuto: false }, deleted: {} } });
    try {
      for (let i = 0; i < 10; i++) await app2.settle();
      assert.equal(glog.length, n, 'Gemini を呼ばない');
      assert.ok(titles(app2).some(t => /^訳:/.test(t)));
    } finally { app2.close(); }
    // ルールの要約
    cards(app)[0].click();
    for (let i = 0; i < 5; i++) await app.settle();
    assert.match(app.text('#pmSRule'), /FRBが12月に利下げしたら/);
    assert.match(app.text('#pmSRule'), /原文 \(英語\) を見る/);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('ウォッチと興味なし: ウォッチはサーバーの記録対象になり、興味なしは一覧から消える', async () => {
  const clock = createClock('2026-11-08T10:00:00+09:00');
  const gas = loadGas({ clock });
  const net = fakeNet(markets());
  const app = await openApp({ clock, gas, fetch: net.fetch, state: { projects: [], settings: { gasUrl: GAS_URL, gasAuto: false }, deleted: {} } });
  try {
    for (let i = 0; i < 5; i++) await app.settle();
    // Gemini のキーが無い時は英語のまま、案内を出す
    assert.match(app.text('#pmInfo'), /Gemini のキーを登録すると日本語/);
    cards(app).find(c => c.dataset.ev === 'btc').click();
    app.doc.querySelector('#pmSWatch').click();
    await app.settle();
    assert.deepEqual(JSON.parse(gas.props.getProperty('PM_WATCH')).sort(), ['2', '3', '4']);
    assert.match(app.text('#pmCats [data-cat="watch"]'), /ウォッチ 1/);
    app.doc.querySelector('#pmCats [data-cat="watch"]').click();
    assert.deepEqual(cards(app).map(c => c.dataset.ev), ['btc']);
    app.doc.querySelector('#pmCats [data-cat="all"]').click();
    cards(app).find(c => c.dataset.ev === 'nba').click();
    app.doc.querySelector('#pmSHide').click();
    assert.ok(!cards(app).some(c => c.dataset.ev === 'nba'), '興味なしは出ない');
    assert.equal(app.doc.querySelector('#pmSheet').hidden, true);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('設定: Gemini のキーと興味を保存すると、サーバーに入り、キーは端末に残らない', async () => {
  const clock = createClock('2026-11-08T10:00:00+09:00');
  const gas = loadGas({ clock });
  const app = await openApp({ clock, gas, fetch: fakeNet(markets()).fetch, state: { projects: [], settings: { gasUrl: GAS_URL, gasAuto: false }, deleted: {} } });
  try {
    app.run('switchTab("settings")');
    for (let i = 0; i < 3; i++) await app.settle();
    assert.match(app.text('#pmAiState'), /未登録/);
    assert.match(app.doc.querySelector('#pmProfile').value, /ビットコイン/);
    app.doc.querySelector('#pmGemKey').value = 'AIza-test-key';
    app.doc.querySelector('#pmProfile').value = 'FRBと日本の金利';
    app.doc.querySelector('#pmAiSave').click();
    for (let i = 0; i < 5; i++) await app.settle();
    assert.equal(gas.props.getProperty('GEMINI_KEY'), 'AIza-test-key');
    assert.equal(gas.props.getProperty('PM_PROFILE'), 'FRBと日本の金利');
    assert.equal(app.doc.querySelector('#pmGemKey').value, '');
    assert.doesNotMatch(app.win.localStorage.getItem('sakiyomi_v1') || '', /AIza-test-key/);
    assert.match(app.text('#pmAiState'), /登録済み/);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});
