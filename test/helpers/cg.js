'use strict';
/* CoinGecko の公開 API (キー不要) の偽物。形は docs.coingecko.com の説明 (2026-11) に合わせている
   (api.coingecko.com そのものはこの作業の環境から開けなかった)
   ・/global … { data: { total_market_cap:{usd}, total_volume:{usd}, market_cap_percentage:{btc, eth, usdt, usdc, …}, market_cap_change_percentage_24h_usd, updated_at } }
   ・/search/trending … { coins: [{ item: { id, name, symbol, market_cap_rank, data: { price_change_percentage_24h: { usd } } } }], categories: [...] }
   ・/coins/categories … [{ id, name, market_cap, market_cap_change_24h (%), volume_24h, top_3_coins_id, top_3_coins, updated_at }] (値が null のこともある)
   ・/companies/public_treasury/bitcoin|ethereum … { total_holdings, total_value_usd, market_cap_dominance, companies: [{ name, symbol, country, total_holdings, total_current_value_usd, percentage_of_total_supply }] }
   world = { down: { global, trend, cats, treasBtc, treasEth } (true = 503、数 = その HTTP の番号), all: 番号 (全部), rate429: true (全部 429),
             global: {...} (上書き), trend: [...], cats: [...] }
   fetch.calls = [{ part, url, headers, t }] */
const ok = o => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify(o) });
const fail = code => ({ getResponseCode: () => code, getContentText: () => (code === 429 ? '{"status":{"error_code":429,"error_message":"You\'ve exceeded the Rate Limit."}}' : 'error') });

function defaultGlobal() {
  return { data: { active_cryptocurrencies: 17000, markets: 1400, total_market_cap: { btc: 4e7, usd: 3.2e12 }, total_volume: { btc: 1e6, usd: 1.1e11 },
    market_cap_percentage: { btc: 58.234, eth: 11.5, usdt: 5.6, usdc: 2.1, bnb: 3, xrp: 2.9 }, market_cap_change_percentage_24h_usd: -1.234, volume_change_percentage_24h_usd: 5, updated_at: 1795000000 } };
}
function defaultTrend() {
  const c = (id, name, symbol, rank, chg) => ({ item: { id, coin_id: 1, name, symbol, market_cap_rank: rank, thumb: 'https://x/t.png', data: { price: 1, price_change_percentage_24h: { usd: chg, btc: chg } } } });
  return { coins: [
    c('pepe', 'Pepe', 'PEPE', 30, 12.345), c('sui', 'Sui', 'SUI', 15, -3.21), c('hyperliquid', 'Hyperliquid', 'HYPE', 12, 5.5),
    c('evil', '<img src=x onerror=alert(1)>Evil', 'EVIL', null, null), c('a', 'Alpha', 'alp', 100, 1), c('b', 'Beta', 'BET', 101, 2), c('c', 'Gamma', 'GAM', 102, 3),
    c('d', 'Delta', 'DEL', 103, 4), c('e', 'Epsilon', 'EPS', 104, 5), c('f', 'Zeta', 'ZET', 105, 6), c('g', 'Eta', 'ETA', 106, 7), c('h', 'Theta', 'THE', 107, 8),
  ], nfts: [], categories: [{ id: 1, name: 'Meme' }] };
}
function defaultCats() {
  const k = (id, name, mcap, chg, vol) => ({ id, name, market_cap: mcap, market_cap_change_24h: chg, content: '', top_3_coins_id: [], top_3_coins: [], volume_24h: vol, updated_at: '2026-11-14T00:00:00Z' });
  return [
    k('smart-contract-platform', 'Smart Contract Platform', 2.5e12, -0.5, 9e10),
    k('meme-token', 'Meme', 8e10, 8.14, 1e10),
    k('ai', 'AI', 3e10, -4.26, 5e9),
    k('defi', 'DeFi', 1e11, 2.0, 8e9),
    k('tiny', 'Tiny Cat', 5e8, 50, 1e7),          // 10億ドル未満 (分野の値動きには出さない)
    k('nullcat', 'Null Cat', 2e9, null, null),    // 値動きが null
    k('gaming', 'Gaming', 1.5e9, -1.0, 2e8),
    k('rwa', 'RWA', 2e10, 3.3, 1e9),
    k('bad', null, 1e10, 1, 1),                   // 名前が無い (捨てる)
  ];
}
function defaultTreas(coin) {
  if (coin === 'bitcoin') return { total_holdings: 1272129.03, total_value_usd: 9.72e10, market_cap_dominance: 6.06, companies: [
    { name: 'Strategy', symbol: 'MSTR.US', country: 'US', total_holdings: 843738, total_entry_value_usd: 6.3e10, total_current_value_usd: 6.45e10, percentage_of_total_supply: 4.018 },
    { name: 'XXI', symbol: 'XXI.US', country: 'US', total_holdings: 43514, total_entry_value_usd: 0, total_current_value_usd: 3.3e9, percentage_of_total_supply: 0.207 },
  ] };
  return { total_holdings: 4000000, total_value_usd: 1.2e10, market_cap_dominance: 3.3, companies: [
    { name: 'BitMine', symbol: 'BMNR.US', country: 'US', total_holdings: 3000000, total_entry_value_usd: 9e9, total_current_value_usd: 9e9, percentage_of_total_supply: 2.5 },
  ] };
}
function cgFetch(clock, world) {
  world = world || {};
  world.down = world.down || {};
  const calls = [];
  const fetch = (url, params) => {
    const m = /^https:\/\/api\.coingecko\.com\/api\/v3(\/[^?]*)/.exec(url);
    if (!m) return null;
    const path = m[1];
    const part = path === '/global' ? 'global' : path === '/search/trending' ? 'trend' : path === '/coins/categories' ? 'cats'
      : path === '/companies/public_treasury/bitcoin' ? 'treasBtc' : path === '/companies/public_treasury/ethereum' ? 'treasEth' : null;
    if (!part) throw new Error('想定外の CoinGecko の URL: ' + url);
    calls.push({ part, url, headers: (params && params.headers) || {}, t: clock.now });
    if (world.rate429) return fail(429);
    if (world.all) return fail(world.all);
    const d = world.down[part];
    if (d) return fail(d === true ? 503 : d);
    if (part === 'global') return ok(world.global || defaultGlobal());
    if (part === 'trend') return ok(world.trend || defaultTrend());
    if (part === 'cats') return ok(world.cats || defaultCats());
    return ok(defaultTreas(part === 'treasBtc' ? 'bitcoin' : 'ethereum'));
  };
  fetch.world = world;
  fetch.calls = calls;
  return fetch;
}

module.exports = { cgFetch, defaultGlobal, defaultTrend, defaultCats, defaultTreas };
