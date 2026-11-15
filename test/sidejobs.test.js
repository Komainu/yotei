'use strict';
/* 定期の取得の順番待ち: オプション・ニュース・米国のお金の流れ・DefiLlama その2・Hyperliquid その2 は pmRecord (1時間ごと) ではなく、
   pmAlert (10分おき) の最後に1回1つずつ動かす (pmRecord が6分の制限に近づかないように) */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('./helpers/gas');
const { createClock } = require('./helpers/clock');
const { deribitFetch } = require('./helpers/deribit');
const { newsFetch, NEWS_URLS } = require('./helpers/news');
const { usFetch } = require('./helpers/usflow');
const { llama2Fetch } = require('./helpers/llama2');
const { hl2Fetch } = require('./helpers/hl2');

const M = 60000, H = 60 * M;
const NEWS = Object.values(NEWS_URLS);
const LLAMA2 = /^https:\/\/(api\.llama\.fi\/hacks|stablecoins\.llama\.fi\/stablecoins\?|api\.llama\.fi\/overview\/dexs|yields\.llama\.fi\/pools)/;
/** 通信の行き先を定期の取得の名前に分ける (それ以外は null) */
const HL2_TYPES = ['vaultDetails', 'clearinghouseState', 'spotClearinghouseState', 'allMids', 'spotDeployState', 'perpDeployAuctionStatus'];
const isHl2 = (url, params) => /^https:\/\/stats-data\.hyperliquid\.xyz\//.test(url)
  || (/^https:\/\/api\.hyperliquid\.xyz\/info/.test(url) && !!params && HL2_TYPES.includes(JSON.parse(params.payload).type));
const kindOf = (url, params) => isHl2(url, params) ? 'hl2' : /^https:\/\/www\.deribit\.com\//.test(url) ? 'opt'
  : NEWS.some(u => url.startsWith(u)) ? 'news'
  : /^https:\/\/(api\.fiscaldata\.treasury\.gov|markets\.newyorkfed\.org)\//.test(url) ? 'us'
  : LLAMA2.test(url) ? 'llama2' : null;

function world(opts) {
  opts = opts || {};
  const clock = createClock('2026-11-14T10:00:00+09:00');
  const st = { optDown: false, gammaDown: false };
  const ok = o => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify(o) });
  const deribit = deribitFetch(clock), news = newsFetch(clock), us = usFetch(clock, { auctions: [] }), l2 = llama2Fetch(clock), h2 = hl2Fetch(clock);
  const fetch = (url, params) => {
    if (/deribit/.test(url) && st.optDown) throw new Error('Deribit 503');
    const dr = deribit(url) || news(url, params) || us(url) || l2(url) || h2(url, params); if (dr) return dr;
    if (/gamma-api\.polymarket\.com\/markets/.test(url)) {
      if (st.gammaDown) throw new Error('Gamma 503');
      return ok(Number(new URL(url).searchParams.get('offset')) === 0 ? [{ id: '1', question: 'Q', outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]', volume24hr: 1, closed: false, events: [{ id: 'e', title: 'E', slug: 'e' }] }] : []);
    }
    if (/gamma-api/.test(url)) return ok({ events: [] });
    if (/kalshi/.test(url)) return ok({ events: [] });
    if (/hyperliquid/.test(url)) { const b = JSON.parse(params.payload); return ok(b.type === 'metaAndAssetCtxs' ? [{ universe: [{ name: 'BTC' }] }, [{ markPx: '1', prevDayPx: '1', openInterest: '1', funding: '0', dayNtlVlm: '1', premium: '0' }]] : []); }
    throw new Error('取得できません: ' + url);   // FRED など
  };
  const gas = loadGas({ clock, fetch, props: opts.props || { MAIL_TO: 'muse@example.com' } });
  if (opts.setup !== false) gas.ctx.setup();
  /** fn を動かし、その間に通信した定期の取得の名前 (重なりなし) を返す */
  const kinds = fn => {
    const from = gas.fetchLog.length;
    fn();
    return [...new Set(gas.fetchLog.slice(from).map(x => kindOf(x.url, x.params)).filter(Boolean))];
  };
  /** pmAlert を1回動かし、その回に動いた定期の取得の名前 (SIDE_LAST の控えが新しくなったもの) を返す。
      (米国のお金の流れは3時間は取り直さないので、通信の有無では分からない) */
  const alert = () => {
    const before = sideLast(gas);
    gas.ctx.pmAlert();
    const after = sideLast(gas);
    return Object.keys(after).filter(k => after[k] !== before[k]);
  };
  return { clock, gas, st, kinds, alert };
}
const health = gas => Object.fromEntries(gas.get({ action: 'health' }).health.jobs.map(j => [j.k, j]));
const sideLast = gas => JSON.parse(gas.props.getProperty('SIDE_LAST') || '{}');

test('pmRecord: Polymarket・マクロ・Kalshi・Hyperliquid だけ。Deribit・RSS・財務省/NY連銀・DefiLlama その2・Hyperliquid その2 には取りに行かない', () => {
  const { gas, clock, kinds } = world({ setup: false });
  const from = gas.fetchLog.length;
  assert.deepEqual(kinds(() => gas.ctx.pmRecord()), []);
  const urls = gas.fetchLog.slice(from).map(x => x.url);
  assert.ok(urls.some(u => /gamma-api\.polymarket\.com\/markets/.test(u)), 'Polymarket');
  assert.ok(urls.some(u => /fred\.stlouisfed\.org/.test(u)), 'マクロ (FRED)');
  assert.ok(urls.some(u => /kalshi/.test(u)), 'Kalshi');
  assert.ok(urls.some(u => /hyperliquid/.test(u)), 'Hyperliquid');
  const h = health(gas);
  assert.deepEqual([h.record.st, h.fed.st, h.hl.st], ['ok', 'ok', 'ok']);
  assert.ok(gas.props.getProperty('HB_macro') || gas.props.getProperty('HBE_macro'), 'マクロも動いた');
  assert.deepEqual([h.opt.st, h.news.st, h.us.st, h.llama2.st, h.hl2.st], ['never', 'never', 'never', 'never', 'never']);
  assert.equal(gas.props.getProperty('SIDE_LAST'), null);
  // 1時間後の pmRecord でも同じ
  clock.tick(H);
  assert.deepEqual(kinds(() => gas.ctx.pmRecord()), []);
  assert.equal(gas.ctx.PM_RUN_T0, 0);
});

test('順番: pmAlert のたびに1つずつ opt → news → us → llama2 → hl2。1時間たつまでは何もしない。60分 (1分早くても) で次の回', () => {
  const { gas, clock, alert } = world();
  const runs = [];
  for (let i = 0; i < 6; i++) { runs.push(alert()); clock.tick(10 * M); }
  assert.deepEqual(runs, [['opt'], ['news'], ['us'], ['llama2'], ['hl2'], []]);
  const last = sideLast(gas);
  assert.deepEqual(Object.keys(last), ['opt', 'news', 'us', 'llama2', 'hl2']);
  assert.equal(last.news - last.opt, 10 * M);
  // ここで opt から 60分。次は opt から
  assert.deepEqual(alert(), ['opt']);
  clock.tick(9 * M);
  assert.deepEqual(alert(), ['news'], '59分でも動かす (トリガーのずれ)');
  clock.tick(M);
  assert.deepEqual(alert(), [], 'us はまだ 50分');
  clock.tick(10 * M);
  assert.deepEqual(alert(), ['us']);
  assert.equal(gas.ctx.PM_RUN_T0, 0, '終わったら目安を 0 に戻す');
});

test('順番: 一番長く待っているものから。1回に1つだけ。時間になったものが無ければ null', () => {
  const { gas, clock } = world({ setup: false });
  const now = clock.now;
  gas.props.setProperty('SIDE_LAST', JSON.stringify({ opt: now - 2 * H, news: now - 3 * H, us: now - 90 * M, llama2: now - 30 * M, hl2: now - 20 * M, old: 1 }));
  const got = [];
  for (let i = 0; i < 4; i++) got.push(gas.ctx.pmSideJobs_());
  assert.deepEqual(got, ['news', 'opt', 'us', null]);
  const last = sideLast(gas);
  assert.equal(last.old, undefined, 'SIDE_JOBS に無い名前は消す');
  assert.equal(last.llama2, now - 30 * M);
  assert.equal(last.hl2, now - 20 * M);
  clock.tick(30 * M);
  assert.equal(gas.ctx.pmSideJobs_(), 'llama2');
  // 壊れた控えでも動く (まだ一度も動いていない扱い)
  gas.props.setProperty('SIDE_LAST', '{壊れた');
  assert.equal(gas.ctx.pmSideJobs_(), 'opt');
});

test('失敗: 落ちた取得も始める前に時刻を控えるので、次の回に取り直さない。ほかは後の回に動く。見張りは error', () => {
  const { gas, clock, st, alert } = world();
  st.optDown = true;
  assert.deepEqual(alert(), ['opt']);
  assert.ok(sideLast(gas).opt, '落ちても控える');
  let h = health(gas);
  assert.equal(h.opt.st, 'error');
  assert.match(h.opt.err, /Deribit/);
  clock.tick(10 * M);
  assert.deepEqual(alert(), ['news'], 'opt を10分後に取り直さない');
  clock.tick(10 * M); assert.deepEqual(alert(), ['us']);
  clock.tick(10 * M); assert.deepEqual(alert(), ['llama2']);
  clock.tick(10 * M); assert.deepEqual(alert(), ['hl2']);
  h = health(gas);
  assert.deepEqual([h.news.st, h.us.st, h.llama2.st, h.hl2.st, h.opt.st], ['ok', 'ok', 'ok', 'ok', 'error']);
  assert.equal(h.alert.st, 'ok', '急変の確認の見張りは変わらない');
  assert.equal(gas.props.getProperty('HBE_alert'), null);
  // 1時間後に取り直し、直っていれば ok
  st.optDown = false; clock.tick(20 * M);
  assert.deepEqual(alert(), ['opt']);
  assert.equal(health(gas).opt.st, 'ok');
});

test('急変の確認が先に終わっても動く: 送り先が無い・通知オフ・Polymarket が落ちた・途中で投げた', () => {
  // 送り先が無い
  let z = world({ props: {} });
  assert.deepEqual(z.alert(), ['opt']);
  assert.equal(health(z.gas).alert.st, 'off');
  assert.equal(z.gas.props.getProperty('HB_alert'), null);
  // 急変の通知をオフ
  z = world({ props: { MAIL_TO: 'muse@example.com', PM_ALERT_ON: '0' } });
  assert.deepEqual(z.alert(), ['opt']);
  z.clock.tick(10 * M);
  assert.deepEqual(z.alert(), ['news']);
  assert.equal(z.gas.props.getProperty('HB_alert'), null, '急変の確認はしていない');
  // Polymarket が落ちた → 急変の確認は error、取得は動く
  z = world();
  z.st.gammaDown = true;
  assert.deepEqual(z.alert(), ['opt']);
  let h = health(z.gas);
  assert.equal(h.alert.st, 'error');
  assert.match(h.alert.err, /Gamma 503/);
  assert.equal(h.opt.st, 'ok');
  // 急変の確認の中で思わぬ例外 → pmAlert は今まで通り投げるが、取得は先に済ませる
  z = world();
  z.gas.ctx.pmMailTo_ = () => { throw new Error('思わぬ失敗'); };
  let kinds;
  assert.throws(() => { kinds = null; const from = z.gas.fetchLog.length; try { z.gas.ctx.pmAlert(); } finally { kinds = z.gas.fetchLog.slice(from).some(x => kindOf(x.url) === 'opt'); } }, /思わぬ失敗/);
  assert.equal(kinds, true);
  assert.ok(sideLast(z.gas).opt);
  assert.equal(z.gas.ctx.PM_RUN_T0, 0);
});

test('取得の失敗は急変の確認の見張りを変えない', () => {
  const { gas, st, alert } = world();
  st.optDown = true;
  alert();
  const h = health(gas);
  assert.equal(h.opt.st, 'error');
  assert.equal(h.alert.st, 'ok');
  assert.equal(gas.props.getProperty('HBE_alert'), null);
  assert.equal(gas.mails.filter(m => /急変/.test(m.subject)).length, 0);
});

test('見張り: setup のあと pmAlert を5回で、5つとも ok', () => {
  const { gas, clock } = world();
  let h = health(gas);
  assert.deepEqual([h.opt.st, h.news.st, h.us.st, h.llama2.st, h.hl2.st], ['never', 'never', 'never', 'never', 'never']);
  for (let i = 0; i < 5; i++) { gas.ctx.pmAlert(); clock.tick(10 * M); }
  h = health(gas);
  assert.deepEqual([h.opt.st, h.news.st, h.us.st, h.llama2.st, h.hl2.st, h.alert.st], ['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
  assert.deepEqual([h.opt.every, h.news.every, h.us.every, h.llama2.every, h.hl2.every], ['1時間ごと', '1時間ごと', '1時間ごと', '1時間ごと', '1時間ごと']);
});
