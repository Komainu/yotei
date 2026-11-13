'use strict';
/* お金の流れ (DefiLlama): チェーンごとの TVL・ステーブルコインと、先物 DEX の建玉 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('./helpers/gas');
const { openApp, GAS_URL } = require('./helpers/app');
const { createClock } = require('./helpers/clock');

const DAY = 86400000;
function world() {
  const clock = createClock('2026-11-09T10:00:00+09:00');
  const calls = [];
  const ok = o => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify(o) });
  const chains = [['Ethereum', 42e9, 'ETH'], ['Base', 5.7e9, ''], ['Solana', 5.1e9, 'SOL'], ['Hyperliquid L1', 2.3e9, 'HYPE'], ['Monad', 9e8, 'MON'], ['Tiny', 5e7, '']];
  // 30日前からの伸び: Base +20%、Monad +80% (小さい Tiny は +200% だが TVL 1億ドル未満)
  const growth = { Ethereum: 0.0, Base: 0.2, Solana: -0.1, 'Hyperliquid L1': 0.05, Monad: 0.8, Tiny: 2 };
  const stNow = { Ethereum: 134e9, Base: 5.1e9, Solana: 14.7e9, 'Hyperliquid L1': 6.6e9 };
  const stGrow = { Ethereum: 1e9, Base: 0.5e9, Solana: -0.3e9, 'Hyperliquid L1': 1.2e9 };
  const hist = (now, g) => { const out = []; for (let i = 120; i >= 0; i--) out.push({ date: String(Math.floor((now - i * DAY) / 1000)), v: 1 + g * (1 - Math.min(i, 30) / 30) }); return out; };
  const fetch = url => {
    calls.push(url);
    const u = new URL(url), now = clock.now;
    if (u.host === 'api.llama.fi' && u.pathname === '/v2/chains') return ok(chains.map(([name, tvl, tokenSymbol]) => ({ name, tvl, tokenSymbol })));
    if (u.host === 'api.llama.fi' && u.pathname.startsWith('/v2/historicalChainTvl/')) {
      const n = decodeURIComponent(u.pathname.split('/').pop()), c = chains.find(x => x[0] === n);
      return ok(hist(now, growth[n]).map(r => ({ date: Number(r.date), tvl: c[1] * r.v / (1 + growth[n]) })));
    }
    if (u.host === 'stablecoins.llama.fi' && u.pathname === '/stablecoinchains') return ok(Object.keys(stNow).map(name => ({ name, totalCirculatingUSD: { peggedUSD: stNow[name] } })));
    if (u.host === 'stablecoins.llama.fi' && u.pathname.startsWith('/stablecoincharts/')) {
      const n = decodeURIComponent(u.pathname.split('/').pop());
      if (!stNow[n]) return ok([]);
      return ok(hist(now, 0).map((r, i, a) => ({ date: r.date, totalCirculating: { peggedUSD: stNow[n] - stGrow[n] * Math.min(1, (a.length - 1 - i) / 30) } })));
    }
    if (u.host === 'api.llama.fi' && u.pathname === '/overview/fees') return ok({ protocols: [
      { name: 'Hyperliquid Perps', total24h: 2.2e6, total30d: 66e6, change_1m: 5 }, { name: 'Aster Perps', total24h: 2e5, total30d: 6e6, change_1m: 40 }, { name: 'Lighter Perps', total24h: 1.5e5, total30d: 4.5e6, change_1m: 90 }] });
    if (u.host === 'api.llama.fi' && u.pathname === '/protocols') return ok([
      { id: '101', name: 'Hyperliquid Perps', category: 'Derivatives', symbol: 'HYPE', tvl: 1.5e8 },
      { id: '102', name: 'Aster Perps', category: 'Derivatives', symbol: 'ASTER', tvl: 3e8 },
      { id: '103', name: 'Lighter Perps', category: 'Derivatives', symbol: '-', tvl: 1e8 },
      { id: '104', name: 'Kalshi', category: 'Prediction Market', symbol: '-', tvl: 0 },
      { id: '999', name: 'Some Lending', category: 'Lending', symbol: '-', tvl: 5e9 }]);
    if (u.host === 'api.llama.fi' && u.pathname.startsWith('/summary/fees/')) return ok({ totalDataChart: [[Math.floor((now - DAY) / 1000), 1e5], [Math.floor(now / 1000), 1.5e5]] });
    if (u.host === 'api.llama.fi' && u.pathname === '/overview/open-interest') return ok({ total24h: 17.3e9, change_1d: -2, change_7d: 3,
      totalDataChartBreakdown: Array.from({ length: 100 }, (_, i) => [Math.floor((now - (99 - i) * DAY) / 1000), Object.assign(
        { 'Hyperliquid Perps': 7e9 - i * 1e6, 'Aster Perps': 1.36e9, 'Kalshi': 2e9 }, i >= 80 ? { 'Lighter Perps': 5e8 } : {})]),
      protocols: [
      { name: 'Hyperliquid Perps', category: 'Derivatives', chains: ['Hyperliquid L1'], total24h: 7.0e9, change_1d: -5.1, change_7d: -5.5, change_1m: -8.2, defillamaId: '101', slug: 'hyperliquid-perps' },
      { name: 'Kalshi', category: 'Prediction Market', chains: ['Off Chain'], total24h: 2.0e9, change_1d: -4.8, change_7d: -7.2, change_1m: 34, defillamaId: '104', slug: 'kalshi' },
      { name: 'Aster Perps', category: 'Derivatives', chains: ['BSC'], total24h: 1.36e9, change_1d: 1, change_7d: 2, change_1m: 3, defillamaId: '102', slug: 'aster-perps' },
      { name: 'Lighter Perps', category: 'Derivatives', chains: ['zkLighter'], total24h: 5e8, change_1d: 3, change_7d: 20, change_1m: 150, defillamaId: '103', slug: 'lighter-perps' }] });
    if (/gamma-api\.polymarket\.com\/markets/.test(url)) return ok([]);
    if (/gamma-api|kalshi|hyperliquid|fred|alternative/.test(url)) throw new Error('このテストでは使わない');
    throw new Error('想定外: ' + url);
  };
  const gas = loadGas({ clock, fetch });
  return { clock, gas, calls };
}

test('サーバー: チェーンの TVL・ステーブルコイン・変化率と、先物 DEX の建玉をまとめ、6時間は使い回す', () => {
  const { gas, clock, calls } = world();
  const d = gas.get({ action: 'llama' }).llama;
  const base = d.chains.find(c => c.n === 'Base');
  assert.equal(base.tvl, 5.7e9);
  assert.equal(base.st, 5.1e9);
  assert.equal(Math.round(base.c30), 20, 'TVL 30日 +20%');
  assert.equal(Math.round(base.s30d / 1e6), 500, 'ステーブルコイン 30日 +5億ドル');
  assert.ok(base.h.length >= 100, '推移');
  assert.equal(d.perps[0].n, 'Hyperliquid Perps');
  assert.equal(d.oiTotal, 17.3e9);
  assert.deepEqual(d.errors, []);
  const n = calls.length;
  clock.tick(3600000); gas.get({ action: 'llama' });
  assert.equal(calls.length, n, '6時間以内は取り直さない');
  clock.tick(6 * 3600000); gas.get({ action: 'llama' });
  assert.ok(calls.length > n);
});

test('記録: 毎日 TVL・ステーブルコイン・建玉を1行残し、AI に渡すレポートの表になる', () => {
  const { gas, clock } = world();
  gas.ctx.pmResolve();
  clock.addDays(1); gas.ctx.pmResolve();
  const f = JSON.parse(gas.drive.folderFiles('ポリマーケット記録').find(x => x.name === 'llama-2026-11.json').content);
  assert.deepEqual(Object.keys(f).sort(), ['2026-11-09', '2026-11-10']);
  assert.equal(f['2026-11-09'].tvl.Base, 5.7e9);
  assert.equal(f['2026-11-09'].st['Hyperliquid L1'], 6.6e9);
  assert.equal(f['2026-11-09'].oi['Aster Perps'], 1.36e9);
  const t = gas.get({ action: 'report', days: '7', parts: 'llama' }).text;
  assert.match(t, /## 7\. チェーンごとのお金の流れと先物 DEX/);
  assert.match(t, /\| Base \| 57億ドル \| [^|]+ \| [^|]+ \| \+20\.0% \| 51億ドル \|/);
  assert.match(t, /\| Kalshi \| Prediction Market \| Off Chain \| 20億ドル \|/);
  assert.match(t, /\| 2026-11-10 \| 420億ドル \| 57億ドル \| 51億ドル \| 23億ドル \|/);
});

test('アプリ: 「💧 お金の流れ」タブに合計・お金が集まっているチェーン・一覧・先物 DEX を出す', async () => {
  const { gas, clock } = world();
  const app = await openApp({ clock, gas, fetch: async () => { throw new TypeError('offline'); }, state: { projects: [], settings: { gasUrl: GAS_URL, gasAuto: false }, deleted: {} } });
  try {
    app.doc.querySelector('nav button[data-tab="flow"]').click();
    for (let i = 0; i < 6; i++) await app.settle();
    assert.match(app.text('#flSum').replace(/\s+/g, ''), /先物DEXの建玉の合計\?173億ドル1日-2\.0%／7日\+3\.0%/);
    const hot = app.text('#flHot').replace(/\s+/g, '');
    assert.match(hot, /TVLの増加率.*Monad\+80\.0%.*Base\+20\.0%/, 'TVL 1億ドル以上で増加率の高い順');
    assert.doesNotMatch(hot.split('ステーブルコインの増加額')[0], /Tiny/);
    assert.match(hot.split('ステーブルコインの増加額')[1], /HyperliquidL1\+12\.0億ドル.*Ethereum\+10\.0億ドル/);
    let rows = [...app.doc.querySelectorAll('#flChains tbody tr')].map(r => r.querySelector('b').textContent);
    assert.equal(rows[0], 'Ethereum');
    const sel = app.doc.querySelector('#flSort'); sel.value = 'c30'; sel.dispatchEvent(new app.win.Event('change'));
    rows = [...app.doc.querySelectorAll('#flChains tbody tr')].map(r => r.querySelector('b').textContent);
    assert.equal(rows[0], 'Tiny');
    assert.ok(app.doc.querySelector('#flChains svg.fl-spark'));
    assert.match(app.text('#flPerps'), /Kalshi予測市場Off Chain/);
    app.doc.querySelector('#tab-flow .term[data-term="tvl"]').click();
    assert.match(app.text('#termBody'), /TVL \(預かり資産\)/);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('先物 DEX: 手数料・TVL・トークンの有無・NEW・建玉の推移 (シェア用) をまとめ、手数料の推移も取れる', () => {
  const { gas } = world();
  const d = gas.get({ action: 'llama' }).llama;
  const by = Object.fromEntries(d.perps.map(p => [p.n, p]));
  assert.deepEqual([by['Hyperliquid Perps'].f24, by['Hyperliquid Perps'].tvl, by['Hyperliquid Perps'].sym, by['Hyperliquid Perps'].token], [2.2e6, 1.5e8, 'HYPE', true]);
  assert.equal(by['Lighter Perps'].token, false, 'トークン未発行');
  assert.equal(by['Lighter Perps'].isNew, true, '20日前に登場 → NEW');
  assert.equal(by['Aster Perps'].isNew, false);
  assert.equal(d.oiHist.dates.length, 90);
  assert.equal(d.oiHist.s['Lighter Perps'][89], 5e8);
  assert.equal(d.oiHist.s['Lighter Perps'][0], 0);
  assert.equal(d.oiHist.total[89], 7e9 - 99e6 + 1.36e9 + 2e9 + 5e8);
  const f = gas.get({ action: 'llamaFees', slug: 'lighter-perps' });
  assert.equal(f.ok, true);
  assert.equal(f.h[1][1], 1.5e5);
  assert.equal(gas.get({ action: 'llamaFees', slug: '../bad' }).ok, false);
  // レポートにエアドロップ候補
  const t = gas.get({ action: 'report', days: '7', parts: 'llama' }).text;
  assert.match(t, /### トークン未発行の先物 DEX \(エアドロップ候補\)\n[\s\S]*\| Lighter Perps \| zkLighter \| 5億ドル \| \+150\.0% \| 450万ドル \|/);
  assert.match(t, /\| Lighter Perps \(NEW\) \|/);
});

test('アプリ: 先物 DEX の欄 (エアドロップ候補・シェアの推移・手数料つきの一覧・詳細の推移)', async () => {
  const { gas, clock } = world();
  const app = await openApp({ clock, gas, fetch: async () => { throw new TypeError('offline'); }, state: { projects: [], settings: { gasUrl: GAS_URL, gasAuto: false }, deleted: {} } });
  try {
    app.doc.querySelector('nav button[data-tab="flow"]').click();
    for (let i = 0; i < 6; i++) await app.settle();
    const cand = [...app.doc.querySelectorAll('#flCand .fl-cand')].map(x => x.dataset.perp);
    assert.deepEqual(cand, ['Lighter Perps'], 'トークン未発行の先物 DEX だけ (予測市場の Kalshi は除く)');
    assert.match(app.text('#flCand').replace(/\s+/g, ''), /LighterPerpsNEWzkLighter建玉5\.0億ドル30日\+150\.0%手数料30日450万ドル/);
    // シェア
    assert.ok(app.doc.querySelector('#flShare svg.fl-share path'));
    assert.match(app.text('#flShare').replace(/\s+/g, ''), /HyperliquidPerps6\d%\(6\d%から\)/);
    assert.match(app.text('#flShare').replace(/\s+/g, ''), /LighterPerps5%\(0%から\)/);
    // 一覧: 手数料で並べ替え・トークン表示
    const sel = app.doc.querySelector('#flPSort'); sel.value = 'f30'; sel.dispatchEvent(new app.win.Event('change'));
    const rows = [...app.doc.querySelectorAll('#flPerps tbody tr')];
    assert.equal(rows[0].dataset.perp, 'Hyperliquid Perps');
    assert.match(rows[0].textContent.replace(/\s+/g, ''), /220万ドル6,600万ドル1\.5億ドルHYPE/);
    assert.match(app.text('#flPerps'), /未発行/);
    // 詳細
    app.doc.querySelector('#flPerps tr[data-perp="Lighter Perps"]').click();
    for (let i = 0; i < 4; i++) await app.settle();
    assert.match(app.text('#flPDetail'), /Lighter Perps/);
    assert.equal(app.doc.querySelectorAll('#flPDetail .hl-chart svg').length, 2, '建玉と手数料のグラフ');
    app.doc.querySelector('#flPDetail [data-perpclose]').click();
    assert.equal(app.text('#flPDetail'), '');
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('毎朝のまとめ: お金の流れ (チェーン・ステーブルコインの増減・先物 DEX・エアドロップ候補) を入れる。設定で外せる', () => {
  const { gas } = world();
  gas.props.setProperty('MAIL_TO', 'muse@example.com');
  const f = gas.ctx.pmFlowSection_();
  assert.match(f.text, /^■■ お金の流れ \(DefiLlama\)\n・全体: 預かり資産 \(TVL\) [\d.]+億ドル ／ ステーブルコイン [\d.]+億ドル/);
  assert.match(f.text, /■ チェーンごとの預かり資産 \(上位10\)\n・Ethereum: 420億ドル \(1日 [+−][\d.]+%・7日 [+−][\d.]+%・30日 [+−][\d.]+%\) ／ ステーブルコイン 1340億ドル/);
  assert.match(f.text, /■ 30日で預かり資産が伸びているチェーン\n・Monad \+80%/);
  assert.match(f.text, /・増えた: Hyperliquid L1 \+12億ドル[^\n]*、Ethereum \+10億ドル/);
  assert.match(f.text, /・減った: Solana −3億ドル/);
  assert.match(f.text, /■ 先物 DEX の建玉 \(上位10\)\n・全体: 173億ドル \(1日 −2%・7日 \+3%\)\n・Hyperliquid Perps: 70億ドル \([^\n]*手数料 24時間 220万ドル ／ トークン HYPE/);
  assert.match(f.text, /■ トークン未発行の先物 DEX \(エアドロップの候補\)\n・Lighter Perps: 建玉 5億ドル \(30日 \+150%\)[^\n]*NEW/);
  assert.ok(!/エアドロップの候補\)\n[^■]*Kalshi/.test(f.text), '予測市場は候補に入れない');
  assert.ok(f.html.includes('💧 お金の流れ') && f.html.includes('Lighter Perps'));

  // まとめメールに入る (マクロが取れなくても、この欄は出る)
  gas.ctx.pmDigest();
  assert.equal(gas.mails.length, 1);
  assert.match(gas.mails[0].body, /■■ お金の流れ \(DefiLlama\)/);
  assert.ok(gas.mails[0].htmlBody.includes('💧 お金の流れ'));
  // 設定で外す
  assert.equal(gas.post({ action: 'pmConfig', notify: { dFlow: false } }).ok, true);
  gas.ctx.pmDigest();
  assert.equal(gas.mails.length, 2);
  assert.doesNotMatch(gas.mails[1].body, /お金の流れ/);
});
