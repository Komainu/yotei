'use strict';
/* DefiLlama その2 の偽物 (2026-11 に確かめた本物の形をまねている)
   ・https://api.llama.fi/hacks … 配列 [{ date (unix 秒), name, classification, technique, amount (ドル・null あり), chain:[…], bridgeHack, targetType, source, returnedFunds (ドル or null), defillamaId, language, description }]。並びは日付順ではない
   ・https://stablecoins.llama.fi/stablecoins?includePrices=true … { peggedAssets: [{ id, name, symbol, gecko_id, pegType ('peggedUSD' など), priceSource, pegMechanism, circulating:{peggedUSD}, circulatingPrevDay, circulatingPrevWeek, circulatingPrevMonth, chainCirculating, chains, price }] }
   ・https://api.llama.fi/overview/dexs?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true … { total24h, total48hto24h, total7d, total30d, change_1d, change_7d (24時間を7日前の24時間と比べる), change_1m, change_7dover7d (7日を前の7日と比べる), change_30dover30d, allChains, breakdown24h:null, chain:null, protocols:[{ name, displayName, chains, total24h, total7d, change_7d, change_7dover7d, breakdown24h:{ チェーンの slug: { 名前: 値 } } }] }
   ・https://yields.llama.fi/pools … { status:'success', data: [{ chain, project, symbol, tvlUsd, apyBase, apyReward, apy, rewardTokens, pool, apyPct1D, stablecoin, ilRisk ('no'/'yes'), exposure ('single'/'multi'), ... }] }
   ・/raises と bridges.llama.fi は取れない (有料) ので使わない
   world: { down: { pegs, hacks, dex, yields }, px: { 記号: 価格 }, hacks: [...] (追加), calls: [取った部分] } */
const DAY = 86400000;
const ok = o => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify(o) });

function defaultHacks(now) {
  const at = d => Math.floor((now - d * DAY) / 1000);
  const h = (d, name, amount, chain, cls, tech, ret, br) => ({ date: at(d), name, classification: cls || 'Protocol Logic', technique: tech || 'Logic Flaw', amount, chain, bridgeHack: !!br, targetType: 'DeFi Protocol', source: '', returnedFunds: ret == null ? null : ret, defillamaId: null, language: null, description: '...' });
  return [
    h(20, 'Gamma Swap', 2500000, ['BSC'], 'Oracle Manipulation', 'Price Oracle Manipulation'),
    h(2, 'Alpha Lend', 35000000, ['Ethereum'], 'Key Compromise', 'Private Key Compromised', 5000000),
    h(200, 'Old Hack', 50000000, ['Ethereum']),                  // 180日より前
    h(5, 'Beta Bridge', 12000000, ['Arbitrum', 'Base'], 'Bridge & Cross-Chain', 'Forged Proof', null, true),
    h(3, 'Tiny Pool', 700000, ['Base']),                          // 100万ドル未満
    h(100, 'Delta Vault', 80000000, ['Solana'], 'Access Control', 'Proxy Upgrade Hijack', 0),
    h(1, 'Nulla Fi', null, ['Sui']),                              // 金額が分からない
  ];
}
function asset(id, name, symbol, circ, price, pegType) {
  return { id: String(id), name, symbol, gecko_id: symbol.toLowerCase(), pegType: pegType || 'peggedUSD', priceSource: 'defillama', pegMechanism: 'fiat-backed',
    circulating: { peggedUSD: circ }, circulatingPrevDay: { peggedUSD: circ }, circulatingPrevWeek: { peggedUSD: circ }, circulatingPrevMonth: { peggedUSD: circ },
    chainCirculating: { Ethereum: { current: { peggedUSD: circ } } }, chains: ['Ethereum'], price };
}
const PEGS = [
  [1, 'Tether', 'USDT', 175191970542.9, 0.9998],
  [2, 'USD Coin', 'USDC', 75000000000, 1.0001],
  [146, 'Ethena USDe', 'USDe', 6000000000, 0.9985],
  [5, 'Dai', 'DAI', 4000000000, 1.0],
  [119, 'First Digital USD', 'FDUSD', 1500000000, 0.994],   // −0.6% (ペッグ外れ)
  [120, 'PayPal USD', 'PYUSD', 1000000000, null],            // 価格が無い → 見ない
  [121, 'Zero Price USD', 'ZUSD', 300000000, 0],             // 価格が 0 → 見ない
  [300, 'Small USD', 'SMOL', 50000000, 0.9],                 // 1億ドル未満 → 見ない
];
function pegs(world) {
  const list = PEGS.map(([id, n, s, c, p]) => asset(id, n, s, c, world.px && world.px[s] !== undefined ? world.px[s] : p));
  list.push(asset(50, 'EURC', 'EURC', 300000000, 1.16, 'peggedEUR'));   // ユーロ建ては見ない
  return { peggedAssets: list };
}
function dex() {
  const p = (name, v, c7, chains, bd) => ({ defillamaId: name, name, displayName: name, module: name.toLowerCase(), category: 'Dexs', chains, total24h: v, total48hto24h: v, total7d: v * 7, total30d: v * 30,
    change_1d: 1, change_7d: c7 + 10, change_1m: 2, change_7dover7d: c7, change_30dover30d: 3, breakdown24h: bd, breakdown30d: bd });
  return { totalDataChart: [], totalDataChartBreakdown: [], breakdown24h: null, breakdown30d: null, chain: null,
    allChains: ['Ethereum', 'Base', 'BSC', 'Solana', 'Arbitrum', 'Gnosis', 'OP Mainnet', 'Hyperliquid L1'],
    total24h: 9848526236.18, total48hto24h: 8120700854.59, total7d: 53985614393.67, total30d: 251826206664.86,
    change_1d: 21.28, change_7d: 18.35, change_1m: 7.33, change_7dover7d: -11.13, change_30dover30d: 3.24,
    protocols: [
      p('PancakeSwap AMM V3', 1.5e9, 20.04, ['BSC'], { bsc: { 'PancakeSwap AMM V3': 1.5e9 } }),
      p('Uniswap V3', 2.0e9, 5.06, ['Ethereum', 'Base', 'Arbitrum', 'OP Mainnet'], { ethereum: { 'Uniswap V3': 1.2e9 }, base: { 'Uniswap V3': 5e8 }, arbitrum: { 'Uniswap V3': 3e8 } }),
      p('Raydium AMM', 8e8, -30, ['Solana'], { solana: { 'Raydium AMM': 8e8 } }),
      p('Curve DEX', 1.7e8, -2, ['Ethereum', 'Gnosis'], { ethereum: { 'Curve DEX': 1.6e8 }, xdai: { 'Curve DEX': 1e7 } }),
      p('Aerodrome Slipstream', 6e8, 12, ['Base'], { base: { 'Aerodrome Slipstream': 6e8 } }),
      p('Dead DEX', 0, 0, ['Ethereum'], {}),
    ] };
}
function yields() {
  const y = (chain, project, symbol, tvlUsd, apy, o) => Object.assign({ chain, project, symbol, tvlUsd, apyBase: apy, apyReward: null, apy, rewardTokens: null, pool: project + '-' + symbol + '-' + chain,
    apyPct1D: 0, apyPct7D: 0, apyPct30D: 0, stablecoin: true, ilRisk: 'no', exposure: 'single', predictions: {}, poolMeta: null, mu: apy, sigma: 0.1, count: 100, outlier: false, underlyingTokens: [] }, o || {});
  return { status: 'success', data: [
    y('Ethereum', 'lido', 'STETH', 18432288368, 2.26, { stablecoin: false }),
    y('Ethereum', 'sky-lending', 'SUSDS', 3744520754, 3.8),
    y('Ethereum', 'maple', 'USDC', 2249023482, 5.21542, { apyReward: 0 }),
    y('Ethereum', 'ethena-usde', 'SUSDE', 1199794954, 5.23475),
    y('Base', 'aave-v3', 'USDC', 400000000, 4.1, { apyBase: 3.9, apyReward: 0.2 }),
    y('Ethereum', 'morpho-blue', 'USDT', 150000000, 6.5),
    y('Ethereum', 'small-vault', 'USDC', 50000000, 12),                    // 1億ドル未満
    y('Ethereum', 'curve-dex', 'USDC-USDT', 500000000, 3, { exposure: 'multi' }),
    y('Ethereum', 'risky', 'USDX', 500000000, 20, { ilRisk: 'yes' }),
    y('Ethereum', 'no-apy', 'USDC', 500000000, null),
  ] };
}

/** 偽の UrlFetchApp: url → 応答 (DefiLlama その2 の URL でなければ null) */
function llama2Fetch(clock, world) {
  world = world || {};
  world.down = world.down || {};
  world.calls = world.calls || [];
  world.extraHacks = world.extraHacks || [];
  const isDown = k => world.down.all || world.down[k];
  const fetch = url => {
    const u = new URL(url);
    let k = null;
    if (u.host === 'api.llama.fi' && u.pathname === '/hacks') k = 'hacks';
    else if (u.host === 'stablecoins.llama.fi' && u.pathname === '/stablecoins' && u.searchParams.get('includePrices') === 'true') k = 'pegs';
    else if (u.host === 'api.llama.fi' && u.pathname === '/overview/dexs') k = 'dex';
    else if (u.host === 'yields.llama.fi' && u.pathname === '/pools') k = 'yields';
    if (!k) return null;
    world.calls.push(k);
    if (isDown(k)) throw new Error('DefiLlama 503 ' + k);
    if (k === 'hacks') return ok(defaultHacks(clock.now).concat(world.extraHacks.map(h => Object.assign({ classification: 'Protocol Logic', technique: 'Logic Flaw', bridgeHack: false, targetType: 'DeFi Protocol', source: '', returnedFunds: null, chain: ['Ethereum'] }, h))));
    if (k === 'pegs') return ok(pegs(world));
    if (k === 'dex') return ok(dex());
    return ok(yields());
  };
  fetch.world = world;
  return fetch;
}

module.exports = { llama2Fetch };
