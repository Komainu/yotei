'use strict';
/* DefiLlama その2: ハッキング被害・ステーブルコインのペッグ・DEX の出来高・ステーブルコインの利回り
   (資金調達 /raises とブリッジ bridges.llama.fi は有料で取れないため入れていない) */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('./helpers/gas');
const { openApp, GAS_URL } = require('./helpers/app');
const { createClock } = require('./helpers/clock');
const { llama2Fetch } = require('./helpers/llama2');

const H = 3600000;
const ok = o => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify(o) });
/** DefiLlama その2 だけ答える世界 (毎朝のまとめ・pmRecord 用に Polymarket などは空で答え、ほかは失敗させる) */
function world(opts) {
  opts = opts || {};
  const clock = createClock(opts.at || '2026-11-14T10:00:00+09:00');
  const l2 = llama2Fetch(clock, opts.world);
  const fetch = url => {
    const r = l2(url); if (r) return r;
    if (/gamma-api\.polymarket\.com\/markets/.test(url)) return ok([]);
    if (/gamma-api/.test(url)) return ok({ events: [] });
    throw new Error('このテストでは使わない: ' + url);
  };
  const gas = loadGas({ clock, fetch, props: opts.props || {} });
  const w = l2.world;
  const take = () => [...new Set(w.calls.splice(0))];   // 失敗した時は macroFetchText_ がもう1回試すので、重なりは1つにする
  return { clock, gas, w, take };
}
const file = (gas, name) => { const f = gas.drive.folderFiles('ポリマーケット記録').find(x => x.name === name); return f ? JSON.parse(f.content) : null; };
const MAIL = { MAIL_TO: 'muse@example.com' };
const plain = o => JSON.parse(JSON.stringify(o));   // vm の中の配列をこちらの配列にする
/** 4つの部分がそろった状態にする (重い部分は1回に1つなので2回) */
const fill = gas => { gas.ctx.llamaMoreRecord_(); gas.ctx.llamaMoreRecord_(); };

test('サーバー: ペッグ (ドル建て・流通量1億ドル以上・価格の無いものは除く)・ハッキング (180日・100万ドル以上)・DEX・利回り (ステーブルだけ・1億ドル以上) を読む', () => {
  const { gas } = world();
  let r = gas.get({ action: 'llama2' });
  assert.equal(r.ok, true);
  assert.equal(r.version, gas.C.GAS_VERSION);
  r = gas.get({ action: 'llama2' });
  const m = r.more;
  assert.deepEqual(m.errors, []);
  // ペッグ: PYUSD (価格 null)・ZUSD (価格 0)・SMOL (1億ドル未満)・EURC (ユーロ建て) は入らない。流通量の多い順
  assert.deepEqual(m.pegs.list.map(x => x.sym), ['USDT', 'USDC', 'USDe', 'DAI', 'FDUSD']);
  assert.deepEqual(m.pegs.list[0], { sym: 'USDT', n: 'Tether', px: 0.9998, circ: 175191970543, dev: -0.02 });
  assert.deepEqual(m.pegs.off, [{ sym: 'FDUSD', n: 'First Digital USD', px: 0.994, circ: 1500000000, dev: -0.6 }], '0.5%以上ずれたもの');
  // ハッキング: 新しい順。200日前・70万ドル・金額 null は入らない。日付は日本時間
  assert.deepEqual(m.hacks.list.map(h => [h.d, h.n]), [['2026-11-12', 'Alpha Lend'], ['2026-11-09', 'Beta Bridge'], ['2026-10-25', 'Gamma Swap'], ['2026-08-06', 'Delta Vault']]);
  assert.deepEqual(m.hacks.list[0], { d: '2026-11-12', n: 'Alpha Lend', amt: 35000000, ch: ['Ethereum'], cls: 'Key Compromise', tech: 'Private Key Compromised', ret: 5000000, br: false });
  assert.equal(m.hacks.list[1].br, true);
  assert.equal(m.hacks.list[1].ret, null);
  // DEX: 7日の変化は「前の7日と比べたもの」(change_7dover7d)。チェーンは各 DEX の内訳 (slug) を足し、名前は allChains の表記
  const x = m.dex;
  assert.deepEqual([x.v24, x.v7, x.c1, x.c7, x.c30, x.n], [9848526236, 53985614394, 21.3, -11.1, 3.2, 5]);
  assert.deepEqual(x.chains.map(c => [c.n, c.v24, c.sh]), [['BSC', 1.5e9, 15.2], ['Ethereum', 1.36e9, 13.8], ['Base', 1.1e9, 11.2], ['Solana', 8e8, 8.1], ['Arbitrum', 3e8, 3], ['Gnosis', 1e7, 0.1]]);
  assert.deepEqual(x.protos.map(p => p.n), ['Uniswap V3', 'PancakeSwap AMM V3', 'Raydium AMM', 'Aerodrome Slipstream', 'Curve DEX'], '出来高 0 は除く');
  assert.deepEqual(x.protos[0], { n: 'Uniswap V3', v24: 2e9, c7: 5.1, ch: ['Ethereum', 'Base', 'Arbitrum'] });
  // 利回り: 5件 (STETH・5,000万ドル・multi・IL あり・apy null は除く)。中央値 = 3.8, 4.1, [5.2154], 5.2347, 6.5 の真ん中
  assert.equal(m.yields.n, 5);
  assert.equal(m.yields.med, 5.22);
  assert.deepEqual(m.yields.top.map(p => p.proj), ['sky-lending', 'maple', 'ethena-usde', 'aave-v3', 'morpho-blue'], '預かりの大きい順');
  assert.deepEqual(m.yields.top[3], { proj: 'aave-v3', sym: 'USDC', ch: 'Base', tvl: 400000000, apy: 4.1, base: 3.9, rew: 0.2 });
  // ドライブに1つのファイル
  assert.deepEqual(Object.keys(file(gas, 'llama2-latest.json')).filter(k => ['pegs', 'hacks', 'dex', 'yields'].includes(k)).sort(), ['dex', 'hacks', 'pegs', 'yields']);
});

test('間隔: ペッグは1時間ごと、ハッキング・DEX は6時間、利回りは24時間。重い部分 (DEX・利回り) は1回に1つまで (古い方から)', () => {
  const { gas, clock, take } = world();
  gas.get({ action: 'llama2' });
  assert.deepEqual(take(), ['pegs', 'hacks', 'dex'], '利回りは次の回');
  assert.deepEqual(gas.get({ action: 'llama2' }).more.skipped, []);
  assert.deepEqual(take(), ['yields']);
  gas.get({ action: 'llama2' });
  assert.deepEqual(take(), [], '新しいうちは取りに行かない');
  clock.tick(50 * 60000); gas.get({ action: 'llama2' });
  assert.deepEqual(take(), [], '50分では取り直さない');
  clock.tick(10 * 60000); gas.get({ action: 'llama2' });
  assert.deepEqual(take(), ['pegs'], '1時間でペッグだけ');
  clock.tick(5 * H); gas.get({ action: 'llama2' });
  assert.deepEqual(take(), ['pegs', 'hacks', 'dex'], '6時間でハッキングと DEX (利回りはまだ)');
  clock.tick(18 * H);
  const m = gas.get({ action: 'llama2' }).more;
  assert.deepEqual(take(), ['pegs', 'hacks', 'yields'], '24時間: 重い部分は古い利回りが先、DEX は次の回');
  assert.deepEqual(m.skipped, ['dex']);
  gas.get({ action: 'llama2' });
  assert.deepEqual(take(), ['dex']);
  // force=1 でも重い部分は1つずつ
  gas.get({ action: 'llama2', force: '1' });
  assert.deepEqual(take(), ['pegs', 'hacks', 'dex']);
});

test('失敗: 1つが落ちても他は新しくなり、落ちたものは前回の値のまま errors に名前。全部落ちて前回も無ければ ok:false と見張りのエラー', () => {
  const { gas, clock, w, take } = world();
  fill(gas); take();
  clock.tick(6 * H);
  w.down.hacks = true; w.px = { USDT: 0.99 };
  let m = gas.get({ action: 'llama2' }).more;
  assert.deepEqual(take(), ['pegs', 'hacks', 'dex']);
  assert.deepEqual(m.errors, ['ハッキング被害']);
  assert.equal(m.hacks.list.length, 4, '前回の値のまま');
  assert.equal(m.pegs.list[0].px, 0.99, 'ペッグは新しい');
  // 落ちたものは次の回にもう一度取りに行き、直れば errors から消える
  w.down.hacks = false; clock.tick(H);
  m = gas.get({ action: 'llama2' }).more;
  assert.deepEqual(take(), ['pegs', 'hacks']);
  assert.deepEqual(m.errors, []);
  // 全部落ちて、前回も無い
  const z = world({ world: { down: { all: true } } });
  const r = z.gas.get({ action: 'llama2' });
  assert.equal(r.ok, false);
  assert.match(r.error, /DefiLlama から取得できませんでした \(ステーブルコインの価格・ハッキング被害・DEX の出来高\)/);
  for (let i = 0; i < 5; i++) z.gas.ctx.pmAlert();   // 定期の取得は pmAlert (10分おき) の後に1回1つずつ
  const h = z.gas.get({ action: 'health' }).health.jobs.find(j => j.k === 'llama2');
  assert.equal(h.n, 'ハッキング・ペッグ・DEX (DefiLlama)');
  assert.equal(h.st, 'error');
  assert.match(h.err, /DefiLlama \(ハッキング・ペッグ・DEX・利回り\) を取得できません/);
  // 直れば ok
  z.w.down.all = false; z.clock.tick(H);
  for (let i = 0; i < 5; i++) z.gas.ctx.pmAlert();   // 定期の取得は pmAlert (10分おき) の後に1回1つずつ
  assert.equal(z.gas.get({ action: 'health' }).health.jobs.find(j => j.k === 'llama2').st, 'ok');
  // 前回の値があれば、全部落ちても投げない (前回のまま)
  z.w.down.all = true; z.clock.tick(24 * H);
  for (let i = 0; i < 5; i++) z.gas.ctx.pmAlert();   // 定期の取得は pmAlert (10分おき) の後に1回1つずつ
  assert.equal(z.gas.get({ action: 'health' }).health.jobs.find(j => j.k === 'llama2').st, 'ok');
});

test('時間の見張り: 定期の取得の回 (pmAlert) の始まりから3.5分を超えていたら重い部分 (DEX・利回り) は次の回へ。終わると目安を戻す', () => {
  const { gas, clock, take } = world();
  gas.ctx.PM_RUN_T0 = clock.now - 4 * 60000;
  let m = plain(gas.ctx.llamaMoreRecord_());
  assert.deepEqual(take(), ['pegs', 'hacks']);
  assert.deepEqual(m.skipped, ['dex', 'yields']);
  assert.deepEqual(m.errors, [], '飛ばしたものはエラーではない');
  gas.ctx.PM_RUN_T0 = clock.now - 3 * 60000;
  m = plain(gas.ctx.llamaMoreRecord_());
  assert.deepEqual(take(), ['dex'], '3分なら重い部分を1つ');
  assert.deepEqual(m.skipped, ['yields']);
  gas.ctx.PM_RUN_T0 = 0;
  gas.ctx.llamaMoreRecord_();
  assert.deepEqual(take(), ['yields']);
  // pmAlert: 始まりに目安をセットし、終わったら 0 に戻す
  clock.tick(25 * H);
  for (let i = 0; i < 4; i++) gas.ctx.pmAlert();   // 定期の取得は pmAlert (10分おき) の後に1回1つずつ
  assert.deepEqual(take(), ['pegs', 'hacks', 'dex'], 'pmAlert の中では経過時間が小さいので重い部分を1つ');
  assert.equal(gas.ctx.PM_RUN_T0, 0);
});

test('読み取り: ハッキング・ペッグ・DEX・利回りをやさしい文にする。すべて1ドル付近の時は落ち着いた文', () => {
  const { gas, w, clock } = world();
  fill(gas);
  let read = gas.get({ action: 'llama2' }).more.read;
  assert.deepEqual(read, [
    '直近の大きなハッキング被害は Alpha Lend (11/12・Ethereum) で 3,500万ドル (うち 500万ドル は戻りました)。この30日では 3件・合計 4,950万ドル です',
    '1ドルからずれているステーブルコインがあります: FDUSD 0.9940ドル (−0.6%)。1ドルとの連動 (ペッグ) が揺らぐと、そのコインを使うサービスにも影響が出ることがあります',
    'DEX の出来高は24時間で 98.5億ドル。直近7日 (539.9億ドル) は前の7日より −11.1%: 大きな変化はありません',
    'ステーブルコインを預けた時の利回り (預かり1億ドル以上の 5件) の中央値は 年5.22%: ふつうの水準です',
  ]);
  w.px = { FDUSD: 0.9991 };
  clock.tick(H);
  read = gas.get({ action: 'llama2' }).more.read;
  assert.equal(read[1], '主なステーブルコインはすべて1ドル付近です (流通量1億ドル以上の 5種類)');
});

test('記録: 1時間ごとに llama2-YYYY-MM.json へ その日の行 (利回りの中央値・DEX の出来高・ペッグ外れの数)。doGet の hist に出る', () => {
  const { gas, clock } = world();
  gas.ctx.llamaMoreRecord_();
  assert.deepEqual(file(gas, 'llama2-2026-11.json'), { '2026-11-14': { ymed: null, dexv24: 9848526236, pegOff: 1 } }, '利回りはまだ');
  gas.ctx.llamaMoreRecord_();
  clock.tick(24 * H); gas.ctx.llamaMoreRecord_();
  assert.deepEqual(file(gas, 'llama2-2026-11.json'), { '2026-11-14': { ymed: 5.22, dexv24: 9848526236, pegOff: 1 }, '2026-11-15': { ymed: 5.22, dexv24: 9848526236, pegOff: 1 } });
  assert.deepEqual(Object.keys(gas.get({ action: 'llama2' }).hist), ['2026-11-14', '2026-11-15']);
});

test('通知: 初めての回は今あるハッキングを覚えるだけ。新しい被害 (2,000万ドル以上) は1回だけ。ペッグ外れ (1%以上) は同じコインで12時間に1回', () => {
  const { gas, clock, w } = world({ props: MAIL });
  fill(gas);
  assert.equal(gas.mails.length, 0, '前からある被害はまとめて送らない (FDUSD の −0.6% は基準の1%より小さい)');
  assert.equal(JSON.parse(gas.props.getProperty('LLAMA2_SENT')).h.length, 4);
  // 新しい被害: 4,500万ドル (送る) と 500万ドル (基準より小さい)
  w.extraHacks.push({ date: Math.floor((clock.now - 3 * H) / 1000), name: 'New Exploit', amount: 45000000, chain: ['Base'], classification: 'Protocol Logic', technique: 'Reentrancy', returnedFunds: null });
  w.extraHacks.push({ date: Math.floor((clock.now - 3 * H) / 1000), name: 'Small One', amount: 5000000 });
  clock.tick(6 * H); gas.ctx.llamaMoreRecord_();
  assert.equal(gas.mails.length, 1);
  let m = gas.mails[0];
  assert.match(m.subject, /【ポリマーケット】DefiLlama: New Exploit でハッキング被害 \(11\/14・Base\): 4,500万ドル/);
  assert.match(m.body, /・New Exploit でハッキング被害 \(11\/14・Base\): 4,500万ドル — 分類: Protocol Logic ／ 手口: Reentrancy \(基準 2,000万ドル 以上\)/);
  assert.doesNotMatch(m.body, /Small One/);
  assert.match(m.body, /■ いまの読み取り\n・直近の大きなハッキング被害は New Exploit/);
  clock.tick(6 * H); gas.ctx.llamaMoreRecord_();
  assert.equal(gas.mails.length, 1, '同じ被害は1回だけ');
  // ペッグ外れ: USDe が 0.97 (−3%)
  w.px = { USDe: 0.97 };
  clock.tick(H); gas.ctx.llamaMoreRecord_();
  assert.equal(gas.mails.length, 2);
  assert.match(gas.mails[1].body, /・USDe \(Ethena USDe\) が 0\.9700ドル — 1ドルから −3% ずれています \(流通量 60億ドル、基準 ±1%\)。売られて1ドルを下回っています/);
  clock.tick(H); gas.ctx.llamaMoreRecord_();
  assert.equal(gas.mails.length, 2, '12時間以内は送らない');
  clock.tick(11 * H); gas.ctx.llamaMoreRecord_();
  assert.equal(gas.mails.length, 3, '12時間たてばもう一度');
  // 基準を変える: 被害 5,000万ドル以上・ずれ 5%以上 → どちらも送らない
  gas.post({ action: 'pmConfig', notify: { hackMin: 50, pegPct: 5 } });
  w.extraHacks.push({ date: Math.floor((clock.now - H) / 1000), name: 'Mid Exploit', amount: 45000000 });
  clock.tick(13 * H); gas.ctx.llamaMoreRecord_();
  assert.equal(gas.mails.length, 3);
  // 範囲の外は丸める (被害 1〜1000、ずれ 0.3〜10)
  gas.post({ action: 'pmConfig', notify: { hackMin: 0.5, pegPct: 20 } });
  assert.deepEqual([gas.ctx.ntf_().hackMin, gas.ctx.ntf_().pegPct], [1, 10]);
  // オフにすると送らない (被害は覚えておく)
  gas.post({ action: 'pmConfig', notify: { hack: false, peg: false, hackMin: 1, pegPct: 0.3 } });
  w.extraHacks.push({ date: Math.floor((clock.now - H) / 1000), name: 'Off Exploit', amount: 90000000 });
  clock.tick(13 * H); gas.ctx.llamaMoreRecord_();
  assert.equal(gas.mails.length, 3);
  assert.ok(JSON.parse(gas.props.getProperty('LLAMA2_SENT')).h.includes('2026-11-15|Off Exploit'));
  gas.post({ action: 'pmConfig', notify: { hack: true } });
  clock.tick(6 * H); gas.ctx.llamaMoreRecord_();
  assert.equal(gas.mails.length, 3, 'オフの間に覚えた被害はあとで送らない');
});

test('毎朝のまとめ: 「■■ ハッキング・ステーブルコイン・DEX」をお金の流れの後に。dDeals をオフにすると載せない。データが無ければ出さない', () => {
  const { gas } = world({ props: MAIL });
  fill(gas);
  gas.ctx.pmDigest();
  const m = gas.mails[gas.mails.length - 1], body = m.body;
  const i = body.indexOf('■■ ハッキング・ステーブルコイン・DEX');
  assert.ok(i > 0 && i < body.indexOf('■ 記録の状況'));
  const sec = body.slice(i, body.indexOf('■ 記録の状況'));
  assert.equal(sec, '■■ ハッキング・ステーブルコイン・DEX (DefiLlama)\n'
    + '・直近の大きなハッキング被害は Alpha Lend (11/12・Ethereum) で 3,500万ドル (うち 500万ドル は戻りました)。この30日では 3件・合計 4,950万ドル です\n'
    + '・1ドルからずれているステーブルコインがあります: FDUSD 0.9940ドル (−0.6%)。1ドルとの連動 (ペッグ) が揺らぐと、そのコインを使うサービスにも影響が出ることがあります\n'
    + '・DEX の出来高は24時間で 98.5億ドル。直近7日 (539.9億ドル) は前の7日より −11.1%: 大きな変化はありません\n'
    + '・ステーブルコインを預けた時の利回り (預かり1億ドル以上の 5件) の中央値は 年5.22%: ふつうの水準です\n'
    + '\n■ この7日のハッキング被害 (100万ドル以上)\n'
    + '・11/12 Alpha Lend: 3,500万ドル (Ethereum) ／ 手口: Private Key Compromised ／ 戻った額 500万ドル\n'
    + '・11/9 Beta Bridge: 1,200万ドル (Arbitrum・Base) ／ 手口: Forged Proof\n'
    + '\n■ ステーブルコインのペッグ (1ドルから0.5%以上ずれているもの)\n'
    + '・FDUSD (First Digital USD): 0.9940ドル (−0.6%) ／ 流通量 15億ドル\n'
    + '\n■ DEX の出来高\n'
    + '・24時間 98.5億ドル ／ 7日 539.9億ドル (前の7日比 −11.1%) ／ 上位: Uniswap V3 20億ドル、PancakeSwap AMM V3 15億ドル、Raydium AMM 8億ドル\n'
    + '\n■ ステーブルコインの利回り (預かり1億ドル以上)\n'
    + '・中央値 年5.22% (5件) ／ 預かりが大きいところ: sky-lending SUSDS 3.8%、maple USDC 5.22%、ethena-usde SUSDE 5.23%\n\n');
  assert.match(m.htmlBody, /🚨 ハッキング・ステーブルコイン・DEX \(DefiLlama\)/);
  gas.post({ action: 'pmConfig', notify: { dDeals: false } });
  gas.ctx.pmDigest();
  assert.doesNotMatch(gas.mails[gas.mails.length - 1].body, /ハッキング・ステーブルコイン・DEX/);
  const z = world({ props: MAIL, world: { down: { all: true } } });
  z.gas.ctx.pmDigest();
  assert.doesNotMatch(z.gas.mails[z.gas.mails.length - 1].body, /ハッキング・ステーブルコイン・DEX/);
});

test('レポート: 「## 11.」にハッキングの表・いまのペッグ外れ・日ごとの表・DEX の上位。既定の parts に入っている', () => {
  const { gas } = world();
  fill(gas);
  const t = gas.get({ action: 'report', days: '7', parts: 'deals' }).text;
  assert.match(t, /## 11\. ハッキング被害・ステーブルコインのペッグ・DEX の出来高・利回り \(DefiLlama\)/);
  assert.match(t, /\| 日付 \| 名前 \| 被害額 \| チェーン \| 分類 \| 手口 \| 戻った額 \|/);
  assert.match(t, /\| 2026-11-12 \| Alpha Lend \| 35000000 \| Ethereum \| Key Compromise \| Private Key Compromised \| 5000000 \|/);
  assert.match(t, /\| 2026-11-09 \| Beta Bridge \| 12000000 \| Arbitrum・Base \| Bridge & Cross-Chain \| Forged Proof \| - \|/);
  assert.doesNotMatch(t, /Gamma Swap/, '7日より前は入れない');
  assert.match(t, /\| FDUSD \| First Digital USD \| 0\.994 \| -0\.6 \| 1500000000 \|/);
  assert.match(t, /\| 日付 \| DEX 出来高 \(24時間\) \| ステーブル利回りの中央値 \(%\) \| ペッグ外れの数 \|/);
  assert.match(t, /\| 2026-11-14 \| 9848526236 \| 5\.22 \| 1 \|/);
  assert.match(t, /\| Uniswap V3 \| 2000000000 \| 5\.1 \| Ethereum・Base・Arbitrum \|/);
  assert.match(gas.get({ action: 'report', days: '7' }).text, /## 11\. ハッキング被害/);
});

test('見張り: 定期の取得 (pmAlert の後) で、ハッキング・ペッグ・DEX は ok (1時間ごと・6時間まで)', () => {
  const { gas } = world();
  for (let i = 0; i < 4; i++) gas.ctx.pmAlert();   // 定期の取得は pmAlert (10分おき) の後に1回1つずつ
  const j = gas.get({ action: 'health' }).health.jobs.find(x => x.k === 'llama2');
  assert.deepEqual([j.n, j.every, j.st], ['ハッキング・ペッグ・DEX (DefiLlama)', '1時間ごと', 'ok']);
  const def = plain(gas.ctx.ntfDefaults_());
  assert.deepEqual([def.hack, def.hackMin, def.peg, def.pegPct, def.dDeals], [true, 20, true, 1, true]);
});

const appState = { projects: [], settings: { gasUrl: GAS_URL, gasAuto: false }, deleted: {} };
const offline = async () => { throw new TypeError('offline'); };

test('アプリ: お金の流れのタブに 読み取り・ハッキング (もっと見る)・ペッグ (外れたものを上に)・DEX・利回り。↻ で取り直し、ホームに行', async () => {
  const extra = Array.from({ length: 25 }, (_, i) => ({ date: Math.floor((Date.parse('2026-11-14T00:00:00Z') - (30 + i) * 86400000) / 1000), name: 'Old Exploit ' + i, amount: 3e6 }));
  const { gas, clock, take } = world({ world: { extraHacks: extra } });
  fill(gas); clock.tick(24 * H); fill(gas); take();
  const app = await openApp({ clock, gas, fetch: offline, state: appState });
  try {
    for (let i = 0; i < 8; i++) await app.settle();
    // ホーム: お金の流れのカードに、14日以内の2,000万ドル以上の被害とペッグ外れ
    const home = app.text('#homeBody').replace(/\s+/g, '');
    assert.match(home, /🚨ハッキング被害:AlphaLend11\/13・Ethereum・PrivateKeyCompromised3,500万ドル/);
    assert.match(home, /⚠ペッグ外れ:FDUSD1ドルから0\.5%以上ずれています0\.994ドル/);
    app.doc.querySelector('nav button[data-tab="flow"]').click();
    for (let i = 0; i < 6; i++) await app.settle();
    assert.match(app.text('#fmRead'), /直近の大きなハッキング被害は Alpha Lend/);
    assert.ok(app.doc.querySelector('#fmRead .term[data-term="dex"]'), '用語に下線');
    assert.match(app.text('#fmInfo'), /時点$/);
    // ハッキング: 20件まで → もっと見る
    let rows = [...app.doc.querySelectorAll('#fmHacks tbody tr')];
    assert.equal(rows.length, 20);
    assert.deepEqual([...rows[0].querySelectorAll('td')].map(td => td.textContent), ['11/13', 'Alpha Lend', '3,500万ドル', 'Ethereum', 'Private Key CompromisedKey Compromise', '500万ドル']);
    assert.match(rows[1].textContent, /Beta Bridge ブリッジ/);
    app.doc.querySelector('#fmHacks [data-fmmore]').click();
    rows = [...app.doc.querySelectorAll('#fmHacks tbody tr')];
    assert.equal(rows.length, 29);
    assert.equal(app.doc.querySelector('#fmHacks [data-fmmore]'), null);
    // ペッグ: 外れたものが一番上で目立つ
    assert.match(app.text('#fmPegs'), /⚠ 1ドルから0\.5%以上ずれているステーブルコインがあります \(1種類\)/);
    const p = [...app.doc.querySelectorAll('#fmPegs tbody tr')];
    assert.ok(p[0].classList.contains('fm-off'));
    assert.match(p[0].textContent, /^FDUSD ペッグ外れFirst Digital USD0\.9940ドル−0\.60%15\.0億ドル$/);
    assert.equal(p.length, 5);
    assert.match(p[1].textContent, /^USDTTether0\.9998ドル−0\.02%1,752億ドル$/);
    // DEX
    const dx = app.text('#fmDex').replace(/\s+/g, '');
    assert.match(dx, /24時間98\.5億ドル前の日と比べて\+21\.3%7日540億ドル前の7日と比べて-11\.1%/);
    assert.match(dx, /BSC15\.0億ドル15\.2%Ethereum13\.6億ドル13\.8%/);
    assert.match(dx, /UniswapV320\.0億ドル\+5\.1%Ethereum・Base・Arbitrum/);
    // 利回り: 2日分の記録があるのでグラフ
    assert.match(app.text('#fmYields'), /利回りの中央値 \(年・5件\)5\.22%/);
    assert.ok(app.doc.querySelector('#fmYields svg'));
    assert.match(app.text('#fmYields tbody tr'), /^sky-lendingSUSDSEthereum37\.4億ドル3\.8%基本 3\.8%$/);
    // ? で解説
    app.doc.querySelector('#fmArea .gq[data-term="peg"]').click();
    assert.match(app.text('#termBody'), /ペッグ \(ペッグ外れ\)/);
    // ↻ で取り直す (force=1)
    const before = app.requests.length;
    app.doc.querySelector('#flReload').click();
    for (let i = 0; i < 4; i++) await app.settle();
    assert.ok(app.requests.slice(before).some(r => /action=llama2&force=1/.test(r.url)));
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('アプリ: すべて1ドル付近なら落ち着いた文。一部取得できない時は「一部取得できず」。サーバーを登録していない時は案内', async () => {
  const { gas, clock, w } = world({ world: { px: { FDUSD: 1 } } });
  fill(gas);
  clock.tick(6 * H); w.down.hacks = true; gas.ctx.llamaMoreRecord_();
  let app = await openApp({ clock, gas, fetch: offline, state: appState });
  try {
    app.doc.querySelector('nav button[data-tab="flow"]').click();
    for (let i = 0; i < 8; i++) await app.settle();
    assert.match(app.text('#fmPegs'), /✅ 主なステーブルコインはすべて1ドル付近です/);
    assert.equal(app.doc.querySelector('#fmPegs tr.fm-off'), null);
    assert.match(app.text('#fmInfo'), /一部取得できず \(ハッキング被害\)/);
    assert.match(app.text('#fmHacks'), /Alpha Lend/, '前回の値');
    assert.doesNotMatch(app.text('#homeBody') || '', /ペッグ外れ/);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
  // 全部取れない時 (前回も無い)
  const z = world({ world: { down: { all: true } } });
  app = await openApp({ clock: z.clock, gas: z.gas, fetch: offline, state: appState });
  try {
    app.doc.querySelector('nav button[data-tab="flow"]').click();
    for (let i = 0; i < 8; i++) await app.settle();
    assert.match(app.text('#fmRead'), /取得できませんでした: DefiLlama から取得できませんでした/);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
  // サーバー未登録
  app = await openApp({ clock, fetch: offline, state: { projects: [], settings: {}, deleted: {} } });
  try {
    app.doc.querySelector('nav button[data-tab="flow"]').click();
    for (let i = 0; i < 4; i++) await app.settle();
    assert.match(app.text('#fmRead'), /設定でサーバー \(Apps Script\) の URL を入れると表示されます/);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('アプリ: 設定に通知の欄 (被害は百万ドル・ずれは %) と毎朝のまとめの dDeals、記録をAIに渡すに deals', async () => {
  const { gas, clock } = world();
  const app = await openApp({ clock, gas, fetch: offline, state: appState });
  try {
    for (const k of ['hack', 'hackMin', 'peg', 'pegPct', 'dDeals']) assert.ok(app.doc.querySelector(`#ntfBox [data-ntf="${k}"]`), k);
    assert.match(app.doc.querySelector('#ntfBox [data-ntf="hackMin"]').parentElement.textContent, /百万ドル以上/);
    assert.match(app.doc.querySelector('#ntfBox [data-ntf="pegPct"]').parentElement.textContent, /% 以上 ずれた/);
    assert.ok(app.doc.querySelector('#repSheet .rep-parts input[value="deals"]').checked);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});
