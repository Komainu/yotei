'use strict';
/* Hyperliquid その2 の偽物 (公式の説明 2026-11 の形をまねている)
   ・POST https://api.hyperliquid.xyz/info
     vaultDetails {vaultAddress} … { name, vaultAddress, leader, portfolio: [[期間, { accountValueHistory: [[ms, "値"]], pnlHistory: [[ms, "値"]], vlm }]], apr (数), followers: [...], relationship: { type:'parent', data: { childAddresses } } }
     clearinghouseState {user} … { assetPositions: [{ position: { coin, szi, entryPx, positionValue, unrealizedPnl, leverage: { type, value }, liquidationPx, ... }, type:'oneWay' }], marginSummary: { accountValue }, time }
     spotClearinghouseState {user} … { balances: [{ coin, token, hold, total, entryNtl }] }
     allMids … { 銘柄: "価格" }
     spotDeployState {user} … { states: [], gasAuction: { startTimeSeconds, durationSeconds, startGas, currentGas (null あり), endGas } }
     perpDeployAuctionStatus … { startTimeSeconds, durationSeconds, startGas, currentGas, endGas: null }
     それ以外の type には null を返す (ほかの偽物に任せる)
   ・GET https://stats-data.hyperliquid.xyz/Mainnet/leaderboard … { leaderboardRows: [{ ethAddress, accountValue, windowPerformances: [['day', {pnl, roi, vlm}], ['week', …], ['month', …], ['allTime', …]], prize, displayName }] }
   world: { down: { hlp, lb, whales (口座すべて), af, auction, all }, bad: [落ちる口座], wallets: { アドレス: [[銘柄, 'L'|'S', 金額, レバレッジ]] },
            afHype (支援基金の HYPE), hypePx, auctionOff (今はオークションなし), calls: [type か 'leaderboard'] } */
const DAY = 86400000;
const ok = o => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify(o) });

const HLP = '0xdfc24b077bc1425ad1dea75bcb6f8158e10df303';
const AF = '0xfefefefefefefefefefefefefefefefefefefefe';
const KID = '0x010461c14e146ac35fe42271bdc1134ee31c703a';   // HLP の子金庫
const addr = i => '0x' + (0xa00000 + i).toString(16) + '0'.repeat(30) + (0x1000 + i).toString(16);   // 0xa00001…1001 のような42文字
const EVIL = '<img src=x onerror=alert(1)>';

/** 大口 i (1〜24) のポジション [銘柄, 向き, 金額]。手で足し算できるように決めてある
 *  BTC: 1〜12 が買い (3番だけ 2.5億、ほかは 1000万)、13〜15 が売り 2000万
 *  ETH: 1〜5 が売り 3000万、6〜8 が買い 1000万
 *  HYPE: 1〜4 が買い 500万 (21〜24 も買い 500万。上位20人の外なので数えない)
 *  1番は X1〜X8 を k×100万 ずつ買い (X3〜X8 が「建玉の大きい6銘柄」に入る) */
function positionsOf(i) {
  const p = [];
  if (i <= 12) p.push(['BTC', 'L', i === 3 ? 2.5e8 : 1e7]);
  else if (i <= 15) p.push(['BTC', 'S', 2e7]);
  if (i <= 5) p.push(['ETH', 'S', 3e7]);
  else if (i <= 8) p.push(['ETH', 'L', 1e7]);
  if (i <= 4 || i >= 21) p.push(['HYPE', 'L', 5e6]);
  if (i === 1) for (let k = 1; k <= 8; k++) p.push(['X' + k, 'L', k * 1e6]);
  return p.map(x => x.concat([5]));
}
function pos(c, side, v, lev) {
  const px = c === 'BTC' ? 100000 : c === 'ETH' ? 4000 : c === 'HYPE' ? 40 : 1;
  const sz = v / px;
  return { position: { coin: c, szi: String(side === 'L' ? sz : -sz), entryPx: String(px * 0.98), positionValue: String(v), unrealizedPnl: String(side === 'L' ? v * 0.02 : -v * 0.02),
    leverage: { type: 'cross', value: lev, rawUsd: '0' }, liquidationPx: side === 'L' ? String(px * 0.8) : String(px * 1.2), marginUsed: String(v / lev), maxLeverage: 40, returnOnEquity: '0.1',
    cumFunding: { allTime: '0', sinceChange: '0', sinceOpen: '0' } }, type: 'oneWay' };
}
function leaderboard() {
  const row = (a, av, mvlm, name, pnlD, pnlM) => ({ ethAddress: a, accountValue: String(av), displayName: name || null, prize: 0,
    windowPerformances: [['day', { pnl: String(pnlD || 0), roi: '0.01', vlm: '1000' }], ['week', { pnl: '0', roi: '0', vlm: '1000' }], ['month', { pnl: String(pnlM || 0), roi: '0.1', vlm: String(mvlm) }], ['allTime', { pnl: '0', roi: '0', vlm: '1' }]] });
  const rows = [
    row(HLP, 4e8, 1e9, 'HLP'),                            // 金庫そのもの → 除く
    row(AF, 3e9, 1e6),                                     // 支援基金 → 除く
    row(KID, 9e8, 1e8, 'HLP Strategy A'),                  // HLP の子金庫 → 除く
    row('0x0000000000000000000000000000000000000000', 5e9, 1),   // 仕組みのアドレス → 除く
    row('0x9999999999999999999999999999999999999999', 2e9, 0, 'Sleepy'),   // 今月の出来高 0 → 除く
    row('0xbad', 1e10, 5),                                 // 形が違う → 除く
  ];
  for (let i = 1; i <= 24; i++) rows.push(row(addr(i), (25 - i) * 1e7, 1e6 * i, i === 2 ? EVIL : i === 1 ? 'Whale One' : null, i * 1000, i * 10000));
  return { leaderboardRows: rows.reverse() };   // 並びは口座の大きさの順ではない
}
function vault(now) {
  const hist = (n, stepMs, v0, dv, p0, dp) => {
    const av = [], pnl = [];
    for (let k = 0; k < n; k++) { const t = now - (n - 1 - k) * stepMs; av.push([t, String(v0 + dv * k)]); pnl.push([t, String(p0 + dp * k)]); }
    return { accountValueHistory: av, pnlHistory: pnl, vlm: '1000000' };
  };
  return { name: 'Hyperliquidity Provider (HLP)', vaultAddress: HLP, leader: '0x677d831aef5328190852e24f13c46cac05f984e7', description: '...',
    portfolio: [
      ['day', hist(25, 3600000, 3.9e8, 0, 0, 50000)],           // 1日の損益 +120万ドル (24 × 5万)
      ['week', hist(8, DAY, 3.9e8, 0, 0, -100000)],             // 7日 −70万ドル
      ['month', hist(100, 30 * DAY / 99, 3.6e8, 3e5, 0, 40000)],  // 30日 +396万ドル (99 × 4万)・預かりは 3.6億 → 3.897億
      ['allTime', hist(3, 300 * DAY, 1e8, 1e8, 0, 3e7)],          // 全期間 +6000万ドル
      ['perpDay', hist(2, 3600000, 3.9e8, 0, 0, 1)],
    ],
    apr: 0.1234, followerState: null, leaderFraction: 0.0007, leaderCommission: 0,
    followers: [{ user: '0x005844b2ffb2e122cf4244be7dbcb4f84924907c', vaultEquity: '714491.7', pnl: '3203.4', allTimePnl: '79843.7', daysFollowing: 388, vaultEntryTime: 1700926145201, lockupUntil: 1734824439201 },
      { user: '0x005844b2ffb2e122cf4244be7dbcb4f84924907d', vaultEquity: '1', pnl: '0', allTimePnl: '0', daysFollowing: 1, vaultEntryTime: 1, lockupUntil: 1 }],
    maxDistributable: 1, maxWithdrawable: 1, isClosed: false,
    relationship: { type: 'parent', data: { childAddresses: [KID, '0x2e3d94f0562703b25c83308a05046ddaf9a8dd14'] } },
    allowDeposits: true, alwaysCloseOnWithdraw: false };
}

/** 偽の UrlFetchApp: (url, params) → 応答 (Hyperliquid その2 の分でなければ null) */
function hl2Fetch(clock, world) {
  world = world || {};
  world.down = world.down || {};
  world.bad = world.bad || [];
  world.wallets = world.wallets || {};
  world.calls = world.calls || [];
  if (world.afHype == null) world.afHype = 32100000;
  if (world.hypePx == null) world.hypePx = 40;
  const isDown = k => world.down.all || world.down[k];
  const fetch = (url, params) => {
    if (/^https:\/\/stats-data\.hyperliquid\.xyz\/Mainnet\/leaderboard/.test(url)) {
      world.calls.push('leaderboard');
      if (isDown('lb')) throw new Error('leaderboard 503');
      return ok(leaderboard());
    }
    if (!/^https:\/\/api\.hyperliquid\.xyz\/info/.test(url) || !params || !params.payload) return null;
    const b = JSON.parse(params.payload);
    const now = clock.now;
    if (b.type === 'vaultDetails') {
      world.calls.push(b.type);
      if (isDown('hlp')) throw new Error('vaultDetails 503');
      return ok(vault(now));
    }
    if (b.type === 'clearinghouseState') {
      world.calls.push(b.type);
      const u = String(b.user).toLowerCase();
      if (isDown('whales') || world.bad.includes(u)) throw new Error('clearinghouseState 500 ' + u);
      let list = [];
      if (world.wallets[u]) list = world.wallets[u];
      else { const i = [...Array(24).keys()].map(k => k + 1).find(k => addr(k) === u); if (i) list = positionsOf(i); }
      const ntl = list.reduce((s, x) => s + x[2], 0);
      return ok({ assetPositions: list.map(x => pos(x[0], x[1], x[2], x[3])), crossMaintenanceMarginUsed: '0',
        crossMarginSummary: { accountValue: '1', totalMarginUsed: '0', totalNtlPos: '0', totalRawUsd: '0' },
        marginSummary: { accountValue: String(world.wallets[u] ? 5e6 : (() => { const i = [...Array(24).keys()].map(k => k + 1).find(k => addr(k) === u); return i ? (25 - i) * 1e7 + 1e6 : 0; })()), totalMarginUsed: '0', totalNtlPos: String(ntl), totalRawUsd: '0' },
        time: now, withdrawable: '0' });
    }
    if (b.type === 'spotClearinghouseState') {
      world.calls.push(b.type);
      if (isDown('af')) throw new Error('spotClearinghouseState 503');
      return ok({ balances: [{ coin: 'USDC', token: 0, hold: '0.0', total: '1234.5', entryNtl: '0.0' }, { coin: 'HYPE', token: 150, hold: '0.0', total: String(world.afHype), entryNtl: '0.0' }] });
    }
    if (b.type === 'allMids') {
      world.calls.push(b.type);
      if (isDown('af')) throw new Error('allMids 503');
      return ok({ BTC: '100000.5', ETH: '4000.1', HYPE: String(world.hypePx), '@107': String(world.hypePx) });
    }
    if (b.type === 'spotDeployState') {
      world.calls.push(b.type);
      if (isDown('auction')) throw new Error('spotDeployState 503');
      const st = Math.floor((now - 10 * 3600000) / 1000);
      return ok({ states: [], gasAuction: { startTimeSeconds: st, durationSeconds: 111600, startGas: '2000.0', currentGas: world.auctionOff ? null : '1516.13', endGas: '500.0' } });
    }
    if (b.type === 'perpDeployAuctionStatus') {
      world.calls.push(b.type);
      if (isDown('auction')) throw new Error('perpDeployAuctionStatus 503');
      return ok({ startTimeSeconds: Math.floor((now - 3600000) / 1000), durationSeconds: 111600, startGas: '500.0', currentGas: '500.0', endGas: null });
    }
    return null;
  };
  fetch.world = world;
  return fetch;
}

module.exports = { hl2Fetch, HLP, AF, KID, addr, positionsOf, EVIL };
