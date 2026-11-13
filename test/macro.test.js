'use strict';
/* マクロ画面 (サーバーでまとめて取得 → テーマ別のカードと信号) と用語解説 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('./helpers/gas');
const { openApp, GAS_URL } = require('./helpers/app');
const { createClock } = require('./helpers/clock');

const DAY = 86400000;
const ymd = t => new Date(t).toISOString().slice(0, 10);
/** FRED の CSV の偽物: 系列ごとに、毎日/毎週/毎月の値を作る */
function fredCsv(id, now) {
  const weekly = ['WALCL', 'WRESBAL', 'WTREGEN'], monthly = ['CPIAUCSL', 'CPILFESL', 'UNRATE'];
  const base = { DFF: 3.88, DFEDTARU: 4.0, SOFR: 3.95, IORB: 3.9, DGS2: 3.5, DGS10: 4.1, T10Y2Y: 0.6, WALCL: 6600000, RRPONTSYD: 20, WRESBAL: 2900, WTREGEN: 850000,
    DTWEXBGS: 120, DEXJPUS: 150, VIXCLS: 28, BAMLH0A0HYM2: 3.0, CPIAUCSL: 300, CPILFESL: 310, UNRATE: 4.0, SP500: 6000, NASDAQCOM: 20000, DCOILWTICO: 70 }[id];
  const rows = [];
  for (let t = now - 500 * DAY; t <= now; t += DAY) {
    const d = new Date(t);
    if (weekly.includes(id) && d.getUTCDay() !== 3) continue;
    if (monthly.includes(id) && d.getUTCDate() !== 1) continue;
    const k = (t - (now - 500 * DAY)) / (500 * DAY);   // 0 → 1
    let v = base;
    if (id === 'SP500') v = base * (0.9 + 0.2 * k);          // 上昇 → 200日平均より上
    if (id === 'CPIAUCSL') v = base * (1 + 0.04 * k);        // 前年比 およそ 3.8%
    if (id === 'UNRATE') v = k > 0.82 ? 4.6 : 4.0;   // 直近3か月が上昇            // 直近で上昇 → サームルール
    if (id === 'WTREGEN' && k > 0.96) v = base + 200000;     // 直近4週で +200B
    rows.push(ymd(t) + ',' + (id === 'SOFR' && k > 0.99 ? '.' : v));
  }
  return 'observation_date,' + id + '\n' + rows.join('\n') + '\n';
}
function macroFetch(now, opts) {
  opts = opts || {};
  const log = [];
  const fetch = (url, params) => {
    log.push(url);
    const ok = obj => ({ getResponseCode: () => 200, getContentText: () => typeof obj === 'string' ? obj : JSON.stringify(obj) });
    if (/fred\.stlouisfed\.org/.test(url)) {
      if (opts.fredDown) return { getResponseCode: () => 503, getContentText: () => '' };
      return ok(fredCsv(new URL(url).searchParams.get('id'), now));
    }
    if (/api\.hyperliquid\.xyz/.test(url)) {
      const b = JSON.parse(params.payload);
      if (b.type === 'metaAndAssetCtxs') return ok([{ universe: ['BTC', 'ETH', 'HYPE', 'PAXG'].map(name => ({ name })) },
        [{ markPx: '74000', prevDayPx: '75000', funding: '0.0000125', openInterest: '40000' }, { markPx: '2100', prevDayPx: '2200', funding: '-0.00003', openInterest: '1' },
         { markPx: '74.6', prevDayPx: '76.9', funding: '-0.00005', openInterest: '1' }, { markPx: '4040', prevDayPx: '4000', funding: '0.0000125', openInterest: '1' }]]);
      if (b.type === 'candleSnapshot') {
        const out = [];
        for (let t = now - 400 * DAY; t <= now; t += DAY) out.push({ t, c: String(b.req.coin === 'BTC' ? 90000 - (t - (now - 400 * DAY)) / DAY * 40 : 100) });
        return ok(out);
      }
    }
    if (/stablecoins\.llama\.fi/.test(url)) {
      const out = [];
      for (let t = now - 500 * DAY; t <= now; t += DAY) out.push({ date: String(Math.floor(t / 1000)), totalCirculating: { peggedUSD: 250e9 + (t - (now - 500 * DAY)) / DAY * 1e8 } });
      return ok(out);
    }
    if (/alternative\.me/.test(url)) return ok({ data: [{ value: '22', timestamp: String(Math.floor(now / 1000)) }, { value: '30', timestamp: String(Math.floor((now - DAY) / 1000)) }] });
    throw new Error('想定外: ' + url);
  };
  return { fetch, log };
}

test('サーバー: FRED・Hyperliquid・DefiLlama・恐怖と強欲指数をまとめて取り、保存して使い回す', () => {
  const clock = createClock('2026-11-09T10:00:00+09:00');
  const net = macroFetch(clock.now);
  const gas = loadGas({ clock, fetch: net.fetch });
  let r = gas.get({ action: 'macro' });
  assert.equal(r.ok, true);
  const m = r.macro;
  assert.equal(Object.keys(m.fred).length, 21);
  assert.deepEqual(m.fred.DGS10[0].length, 2);
  assert.ok(!m.fred.SOFR.some(x => isNaN(x[1])), '空の値 (.) は飛ばす');
  assert.equal(m.crypto.now.BTC.px, 74000);
  assert.ok(m.crypto.series.BTC.length > 300);
  assert.ok(m.stable.length <= 500);
  assert.equal(m.fng[m.fng.length - 1][1], 22, '古い順に並べ直す');
  assert.equal(m.errors, undefined);
  // 10分後: 保存分を使う (通信しない)
  const n = net.log.length;
  clock.tick(10 * 60000);
  gas.get({ action: 'macro' });
  assert.equal(net.log.length, n);
  // 31分後: 価格だけ取り直す (FRED は6時間)
  clock.tick(21 * 60000);
  gas.get({ action: 'macro' });
  assert.ok(net.log.slice(n).every(u => !/fred/.test(u)) && net.log.length > n);
  // 合言葉
  gas.props.setProperty('API_SECRET', 'secret-macro-1234');
  assert.equal(gas.get({ action: 'macro' }).needKey, true);
});

test('サーバー: FRED が取れない時は前回の値を使い、取れなかったものを知らせる', () => {
  const clock = createClock('2026-11-09T10:00:00+09:00');
  const gas = loadGas({ clock, fetch: macroFetch(clock.now).fetch });
  gas.get({ action: 'macro' });
  const gas2 = loadGas({ clock, fetch: macroFetch(clock.now, { fredDown: true }).fetch });
  gas2.drive.items.clear();
  for (const [k, v] of gas.drive.items) gas2.drive.items.set(k, v);
  for (const k of ['PM_FOLDER_ID']) gas2.props.setProperty(k, gas.props.getProperty(k));
  const r = gas2.get({ action: 'macro', force: '1' });
  assert.equal(Object.keys(r.macro.fred).length, 21, '前回の値が残る');
  assert.ok(r.macro.errors.some(e => /FRED DGS10/.test(e)));
});

async function macroApp() {
  const clock = createClock('2026-11-09T10:00:00+09:00');
  const gas = loadGas({ clock, fetch: macroFetch(clock.now).fetch });
  const app = await openApp({ clock, gas, fetch: async () => { throw new TypeError('offline'); }, state: { projects: [], settings: { gasUrl: GAS_URL, gasAuto: false }, deleted: {} } });
  app.run('switchTab("btc")');
  for (let i = 0; i < 5; i++) await app.settle();
  return { app, gas };
}
const card = (app, id) => app.doc.querySelector(`.mc-card[data-mc="${id}"]`);

test('マクロ画面: テーマごとにカードを並べ、値・変化・信号・理由を出す', async () => {
  const { app } = await macroApp();
  try {
    const themes = [...app.doc.querySelectorAll('.mc-theme h3')].map(h => h.textContent);
    assert.deepEqual(themes, ['🏦 金利', '💧 お金の量', '💱 ドルと円', '😨 不安の度合い', '📊 物価と景気', '📈 株と商品', '🪙 暗号資産']);
    assert.match(card(app, 'ff').textContent, /3\.88%/);
    assert.match(card(app, 'vix').textContent, /🔴 強い不安/);
    assert.match(card(app, 'hy').textContent, /🟢/);
    assert.match(card(app, 'cpi').textContent, /🔴|🟡/);
    assert.match(card(app, 'unrate').textContent, /🔴 サームルールに達した/);
    assert.match(card(app, 'sp500').textContent, /🟢 200日平均より上/);
    assert.match(card(app, 'btc').textContent, /\$74,000/);
    assert.match(card(app, 'btc').textContent, /🔴 200日平均/, 'BTC は下落の流れ');
    assert.match(card(app, 'netliq').textContent, /兆ドル/);
    assert.match(card(app, 'tga').textContent, /🔴/, 'TGA が4週で +2,000億ドル');
    assert.match(card(app, 'fng').textContent, /22 極端な恐怖/);
    assert.match(card(app, 'funding').textContent, /\+0\.0100%/);
    assert.ok(card(app, 'vix').querySelector('svg.mc-spark path'));
    assert.match(app.text('#mcInfo'), /時点/);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('用語解説: ? を押すと解説、関連する用語へたどれる。理由の文の言葉も押せる。用語集で検索できる', async () => {
  const { app } = await macroApp();
  try {
    card(app, 'curve').querySelector('.gq').click();
    assert.equal(app.doc.querySelector('#termSheet').hidden, false);
    assert.match(app.text('#termBody'), /長短金利差・逆イールド/);
    assert.match(app.text('#termBody'), /ひとことで/);
    assert.match(app.text('#termBody'), /景気後退の前触れ/);
    // 関連する用語へ
    app.doc.querySelector('#termBody .chip[data-term="recession"]').click();
    assert.match(app.text('#termBody'), /景気後退 \(リセッション\)/);
    // 解説の中の言葉もリンク
    assert.ok(app.doc.querySelector('#termBody .term[data-term]'));
    app.doc.querySelector('#termSheet .pm-x').click();
    assert.equal(app.doc.querySelector('#termSheet').hidden, true);
    // カードの理由の文の言葉
    const t = card(app, 'unrate').querySelector('.mc-sig .term');
    assert.equal(t.dataset.term, 'sahm');
    // 用語集
    app.run('switchTab("gloss")');
    assert.ok(app.doc.querySelectorAll('#glossList .gloss-item').length >= 40);
    const q = app.doc.querySelector('#glossQ');
    q.value = 'FDV'; q.dispatchEvent(new app.win.Event('input'));
    assert.deepEqual([...app.doc.querySelectorAll('#glossList .gloss-item b')].map(b => b.textContent).slice(0, 1), ['FDV (完全希薄化時価総額)']);
    app.doc.querySelector('#glossList .gloss-item').click();
    assert.match(app.text('#termBody'), /トークンの値段 × 最終的に発行される全部の枚数/);
    // 自動リンク: 英字の途中では付けない
    assert.equal(app.run('linkTerms("BTCとBITCOIN")').includes('data-term'), true);
    assert.equal(app.run('linkTerms("SPTFX")').includes('data-term'), false);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('すべての用語: 関連する用語の先があり、別名が他の用語とかぶらない', async () => {
  const { app } = await macroApp();
  try {
    const bad = app.run(`(()=>{ const out = []; const seen = {};
      for(const [k,g] of Object.entries(GLOSS)){ if(!g.n || !g.s) out.push(k + ': 名前か説明がない');
        for(const r of g.r||[]) if(!GLOSS[r]) out.push(k + ' → ' + r + ' が無い');
        for(const a of g.a||[]){ if(seen[a]) out.push(a + ' が ' + seen[a] + ' と ' + k + ' で重複'); seen[a] = k; } }
      for(const d of MC_DEFS) if(!GLOSS[d.t]) out.push('指標 ' + d.id + ' の用語 ' + d.t + ' が無い');
      return JSON.stringify(out); })()`);
    assert.equal(bad, '[]');
  } finally { app.close(); }
});

test('天気図: 信号を重み付きでまとめて空模様を出し、追い風・向かい風・テーマごとの空・変わった信号を示す', async () => {
  const clock = createClock('2026-11-09T10:00:00+09:00');
  const gas = loadGas({ clock, fetch: macroFetch(clock.now).fetch });
  const before = { t: clock.now - 3 * 3600000, sig: { vix: 'y', sp500: 'g' }, score: 0 };
  let app = await openApp({ clock, gas, fetch: async () => { throw new TypeError('offline'); }, storage: { mc_sig_v1: before }, state: { projects: [], settings: { gasUrl: GAS_URL, gasAuto: false }, deleted: {} } });
  try {
    app.run('switchTab("btc")');
    for (let i = 0; i < 5; i++) await app.settle();
    const w = app.text('#mcWeather');
    assert.match(w, /今日の相場は「(晴れ|晴れ時々くもり|くもり|雨|嵐)」/);
    const score = app.run('mcScore(Object.keys(MC_WEIGHT), Object.fromEntries(MC_DEFS.map(d=>[d.id, mcEval(d, MC.data)]))).s');
    assert.ok(score > -1 && score < 1);
    assert.match(w, /🔴 向かい風/);
    assert.match(w, /VIX \(恐怖指数\)強い不安/, '重みの大きい向かい風から');
    assert.match(w, /🟢 追い風/);
    assert.match(w, /S&P500/);
    assert.match(w, /前回から変わった信号: VIX \(恐怖指数\) 🟡→🔴/);
    assert.equal(app.doc.querySelectorAll('#mcWeather .mc-tile').length, 7);
    // 理由を押すとそのカードへ
    app.doc.querySelector('#mcWeather .mc-reason[data-goto="vix"]').click();
    assert.ok(app.doc.querySelector('.mc-card[data-mc="vix"]').classList.contains('mc-flash'));
    // 「リスクオン」の解説
    app.doc.querySelector('#mcWeather .gq[data-term="riskon"]').click();
    assert.match(app.text('#termBody'), /リスクオン・リスクオフ/);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
  // 空模様の決まり
  app = await openApp({ fetch: async () => { throw new TypeError('x'); } });
  try {
    assert.equal(app.run('mcSky(0.5)[2]'), '晴れ');
    assert.equal(app.run('mcSky(0)[2]'), 'くもり');
    assert.equal(app.run('mcSky(-0.6)[2]'), '嵐');
    assert.equal(app.run('mcScore(["vix","hy"], { vix:{sig:"r"}, hy:{sig:"g"} }).s'), 0);
    assert.equal(app.run('mcScore(["netliq","fng"], { netliq:{sig:"g"}, fng:{sig:"r"} }).s').toFixed(2), '0.60');
  } finally { app.close(); }
});

test('経済カレンダー: 次の発表を日本時間で並べ、関連する Polymarket の予想を出す', async () => {
  const clock = createClock('2026-11-09T10:00:00+09:00');
  const gas = loadGas({ clock, fetch: macroFetch(clock.now).fetch });
  const searches = [];
  const fedEv = { id: 'fed12', title: 'Fed decision in December?', slug: 'fed-decision-in-december', endDate: '2026-12-09T00:00:00Z', volume: '5000000', markets: [
    { id: 'a', groupItemTitle: 'No change', outcomePrices: '["0.62","0.38"]' }, { id: 'b', groupItemTitle: '25 bps decrease', outcomePrices: '["0.36","0.64"]' },
    { id: 'c', groupItemTitle: '50+ bps decrease', outcomePrices: '["0.02","0.98"]' }] };
  const fetch = async url => {
    const u = new URL(url);
    if (u.pathname === '/public-search') {
      searches.push(u.searchParams.get('q'));
      const q = u.searchParams.get('q');
      const cpi = [{ id: 'uk', title: 'October Inflation UK - Annual', endDate: '2026-11-11T00:00:00Z', volume: '900000', markets: [{ id: 'u', groupItemTitle: '3.1%', outcomePrices: '["0.9","0.1"]' }] },
        { id: 'm', title: 'October Inflation US - Monthly', endDate: '2026-11-11T00:00:00Z', volume: '46336', markets: [{ id: 'm1', groupItemTitle: '0.2%', outcomePrices: '["0.5","0.5"]' }] },
        { id: 'y', title: 'October Inflation US - Annual', endDate: '2026-11-11T00:00:00Z', volume: '84716', markets: [{ id: 'y1', groupItemTitle: '2.9%', outcomePrices: '["0.4","0.6"]' }, { id: 'y2', groupItemTitle: '3.0%', outcomePrices: '["0.35","0.65"]' }] }];
      return { ok: true, status: 200, json: async () => ({ events: /Fed decision in December/.test(q) ? [fedEv, { id: 'x', title: 'Fed decision in January?', endDate: '2027-01-27T00:00:00Z', markets: [] }] : /October Inflation US/.test(q) ? cpi : [] }) };
    }
    throw new TypeError('offline');
  };
  const app = await openApp({ clock, gas, fetch, state: { projects: [], settings: { gasUrl: GAS_URL, gasAuto: false }, deleted: {} } });
  try {
    app.run('switchTab("btc")');
    for (let i = 0; i < 8; i++) await app.settle();
    const rows = [...app.doc.querySelectorAll('#mcCal .mc-cal-row')].map(r => r.textContent.replace(/\s+/g, ' ').trim());
    assert.equal(rows.length, 6);
    assert.match(rows[0], /^あと1日 ?11\/10\(火\) 22:30 🛒 CPI \(物価\) 10月分/, '11/10 8:30 ET (冬時間) = 日本時間 22:30');
    assert.match(rows[0], /📊 2\.9% 40% ／ 3\.0% 35%/, 'CPI は米国の前年比 (Annual) を選び、英国などは除く');
    const fomc = rows.find(r => /FOMC/.test(r));
    assert.match(fomc, /12\/10\(木\) 04:00/, '12/9 14:00 ET = 日本時間 12/10 4:00');
    assert.match(fomc, /📊 No change 62% ／ 25 bps decrease 36% ／ 50\+ bps decrease 2%/);
    assert.ok(searches.includes('Fed decision in December'));
    assert.match(rows.find(r => /雇用統計/.test(r)).replace(/\s+/g, ''), /12\/4\(金\)22:30.*雇用統計11月分.*関連する予想市場は見つかりませんでした/);
    // 夏時間: 2027-06-09 14:00 ET = 6/10 3:00 JST
    assert.equal(app.run('mcEtTime("2027-06-09", 14, 0).toISOString()'), '2027-06-09T18:00:00.000Z');
    assert.equal(app.run('mcEtTime("2026-12-09", 14, 0).toISOString()'), '2026-12-09T19:00:00.000Z');
    // 解説
    app.doc.querySelector('#mcCal .gq[data-term="fomc"]').click();
    assert.match(app.text('#termBody'), /FOMC/);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('マクロの計算は、アプリ (index.html) とサーバー (gas/Code.gs) でまったく同じ', () => {
  const fs = require('node:fs'), path = require('node:path');
  const B = '/* ===== マクロの計算 (この囲みの中は', E = '/* ===== マクロの計算 ここまで ===== */';
  const block = f => { const s = fs.readFileSync(path.join(__dirname, '..', f), 'utf8'); const i = s.indexOf(B), j = s.indexOf(E); assert.ok(i >= 0 && j > i, f); return s.slice(i, j); };
  assert.equal(block('index.html'), block('gas/Code.gs'));
});

test('毎朝のまとめ: 先頭に相場の天気図・昨日から変わった信号・これから7日の予定 (Polymarket の予想つき) を入れる', () => {
  const clock = createClock('2026-11-09T08:00:00+09:00');
  const net = macroFetch(clock.now);
  const fetch = (url, params) => {
    if (/gamma-api\.polymarket\.com\/public-search/.test(url)) {
      const q = new URL(url).searchParams.get('q');
      const ev = { id: 'y', title: 'October Inflation US - Annual', endDate: '2026-11-11T00:00:00Z', volume: '84716', markets: [{ id: 'y1', groupItemTitle: '2.9%', outcomePrices: '["0.4","0.6"]' }, { id: 'y2', groupItemTitle: '3.0%', outcomePrices: '["0.35","0.65"]' }] };
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ events: /October Inflation US/.test(q) ? [ev] : [] }) };
    }
    if (/gamma-api\.polymarket\.com\/markets/.test(url)) return { getResponseCode: () => 200, getContentText: () => '[]' };
    return net.fetch(url, params);
  };
  const gas = loadGas({ clock, fetch, props: { MAIL_TO: 'muse@example.com', PM_MC_SIG: JSON.stringify({ t: clock.now - 86400000, sig: { vix: 'y' } }) } });
  gas.ctx.pmDigest();
  assert.equal(gas.mails.length, 1);
  const m = gas.mails[0];
  assert.match(m.subject, /11月9日のまとめ (☀️|🌤|⛅|🌧|⛈)/);
  assert.match(m.body, /^11月9日 のまとめ\n\n■ 相場の天気図: \S+ \S+ — /);
  assert.match(m.body, /・向かい風: [^\n]*VIX \(恐怖指数\) \(強い不安 \(リスクオフ\)\)/);
  assert.match(m.body, /・昨日から変わった信号: VIX \(恐怖指数\) 🟡→🔴/);
  assert.match(m.body, /■ これから7日の予定 \(日本時間\)\n・11\/10\(火\) 22:30 CPI \(物価\) 10月分 — Polymarket: 2\.9% 40% ／ 3\.0% 35%/);
  assert.match(m.body, /■■ ポリマーケット/);
  assert.ok(m.htmlBody.includes('相場の天気図'));
  // 次の日は、今日の信号と比べる
  assert.match(gas.props.getProperty('PM_MC_SIG'), /"vix":"r"/);
  // マクロ指標の一覧: テーマごとに、信号・名前・値・補足を全部
  assert.match(m.body, /■■ マクロ指標の一覧[^\n]*\n\n■ 🏦 金利\n・政策金利 \(FF金利\): \d\.\d\d% \(/);
  for (const th of ['💧 お金の量', '💱 ドルと円', '😨 不安の度合い', '📊 物価と景気', '📈 株と商品', '🪙 暗号資産']) assert.ok(m.body.includes('\n■ ' + th + '\n'), th);
  assert.match(m.body, /\n🔴 VIX \(恐怖指数\): [\d.]+ \([^\n]*強い不安/);
  const listed = m.body.slice(m.body.indexOf('■■ マクロ指標の一覧')).split('\n').filter(l => /^(🟢 |🟡 |🔴 |・)\S/.test(l) && /: /.test(l)).length;
  assert.ok(listed >= 15, '指標が15個以上並ぶ: ' + listed);
  assert.ok(m.htmlBody.includes('📋 マクロ指標の一覧'));
  assert.ok(m.body.indexOf('■■ ポリマーケット') < m.body.indexOf('■■ マクロ指標の一覧'), '一覧は Polymarket の後ろ');
  // 設定で外せる
  assert.equal(gas.post({ action: 'pmConfig', notify: { dMacro: false } }).ok, true);
  gas.ctx.pmDigest();
  assert.doesNotMatch(gas.mails[1].body, /マクロ指標の一覧/);
  assert.match(gas.mails[1].body, /■ 相場の天気図/);
});

test('マクロの日誌: 毎日1行 (空・点数・信号・主な値) を残し、AI に渡すレポートの表になる', () => {
  const clock = createClock('2026-11-09T05:00:00+09:00');
  const net = macroFetch(clock.now);
  const fetch = (url, params) => /gamma-api/.test(url) ? { getResponseCode: () => 200, getContentText: () => '[]' } : net.fetch(url, params);
  const gas = loadGas({ clock, fetch });
  gas.ctx.pmResolve();
  const log = JSON.parse(gas.drive.folderFiles('ポリマーケット記録').find(f => f.name === 'macro-log.json').content);
  const x = log['2026-11-09'];
  assert.ok(x && typeof x.s === 'number' && x.sky);
  assert.equal(x.sig.vix, 'r');
  assert.match(x.v.vix, /^28/);
  const r = gas.get({ action: 'report', days: '7', parts: 'macro' });
  assert.match(r.text, /## 1\. マクロ環境と天気図の推移/);
  assert.match(r.text, /\| 2026-11-09 \| \S+ \| -?\d/);
  assert.match(r.text, /VIX \(恐怖指数\)/);
});
