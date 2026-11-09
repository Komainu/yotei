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
    if (u.host === 'api.llama.fi' && u.pathname === '/overview/open-interest') return ok({ total24h: 17.3e9, change_1d: -2, change_7d: 3, protocols: [
      { name: 'Hyperliquid Perps', category: 'Derivatives', chains: ['Hyperliquid L1'], total24h: 7.0e9, change_1d: -5.1, change_7d: -5.5, change_1m: -8.2 },
      { name: 'Kalshi', category: 'Prediction Market', chains: ['Off Chain'], total24h: 2.0e9, change_1d: -4.8, change_7d: -7.2, change_1m: 34 },
      { name: 'Aster Perps', category: 'Derivatives', chains: ['BSC'], total24h: 1.36e9, change_1d: 1, change_7d: 2, change_1m: 3 }] });
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
