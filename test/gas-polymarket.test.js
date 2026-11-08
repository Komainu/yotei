'use strict';
/* Polymarket の記録 (1時間ごとの記録・決着の取り込み・状況) */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('./helpers/gas');
const { createClock } = require('./helpers/clock');

/** Gamma API の偽物。markets: id → 市場 (closed などを後から書き換えられる) */
function fakeGamma(n) {
  const markets = new Map();
  for (let i = 1; i <= n; i++) {
    markets.set(String(i), {
      id: String(i), question: 'Will thing ' + i + ' happen?', slug: 'thing-' + i,
      outcomes: '["Yes", "No"]', outcomePrices: JSON.stringify([String(i / (n + 1)), String(1 - i / (n + 1))]),
      volume24hr: 1000 * (n + 1 - i), liquidityNum: 500 * i, closed: false, active: true,
      endDate: '2026-12-31T00:00:00Z', events: [{ slug: 'ev-' + i, title: 'Event ' + i }], groupItemTitle: '',
    });
  }
  const calls = [];
  const fetch = (url) => {
    calls.push(url);
    const u = new URL(url);
    if (u.origin !== 'https://gamma-api.polymarket.com' || u.pathname !== '/markets') throw new Error('想定外のURL: ' + url);
    const ids = u.searchParams.getAll('id');
    let list;
    if (ids.length) list = ids.map(id => markets.get(id)).filter(Boolean);
    else {
      list = [...markets.values()].filter(m => !m.closed).sort((a, b) => b.volume24hr - a.volume24hr);
      const off = Number(u.searchParams.get('offset') || 0), lim = Number(u.searchParams.get('limit') || 100);
      list = list.slice(off, off + lim);
    }
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify(list) };
  };
  return { markets, calls, fetch };
}

function server(n, opts) {
  const clock = createClock('2026-11-08T10:00:00+09:00');
  const g = fakeGamma(n);
  const gas = loadGas(Object.assign({ clock, fetch: g.fetch }, opts || {}));
  const file = name => {
    const f = gas.drive.folderFiles('ポリマーケット記録').find(x => x.name === name);
    return f ? JSON.parse(f.content) : null;
  };
  return { clock, g, gas, file };
}

test('記録: 出来高の多い順に上位400件を1時間ごとにその日のファイルへ足し、台帳を作る', () => {
  const { clock, g, gas, file } = server(450);
  gas.ctx.pmRecord();
  let snap = file('snap-2026-11-08.json');
  assert.equal(snap.rows.length, 1);
  assert.equal(snap.rows[0].m.length, 400, '上位400件');
  assert.deepEqual(snap.cols, ['id', 'p', 'v24', 'liq']);
  assert.deepEqual(snap.rows[0].m[0], ['1', 0.0022, 450000, 500], '出来高が一番多い市場が先頭');
  const cat = file('catalog.json');
  assert.equal(Object.keys(cat.m).length, 400);
  assert.deepEqual({ q: cat.m['1'].q, s: cat.m['1'].s, e: cat.m['1'].e, o: cat.m['1'].o }, { q: 'Will thing 1 happen?', s: 'thing-1', e: 'ev-1', o: ['Yes', 'No'] });
  assert.equal(g.calls.length, 4, '100件ずつ4回');

  // 1時間後: 同じファイルに1行増える。確率の変化も残る
  clock.tick(3600000);
  g.markets.get('1').outcomePrices = '["0.5", "0.5"]';
  gas.ctx.pmRecord();
  snap = file('snap-2026-11-08.json');
  assert.equal(snap.rows.length, 2);
  assert.equal(snap.rows[1].m[0][1], 0.5);
  const st = gas.get({}).pm;
  assert.equal(st.lastCount, 400);
  assert.equal(st.markets, 400);
  assert.equal(st.since, '2026-11-08');
  assert.equal(st.error, null);

  // 日付が変わると (日本時間) 新しいファイル
  clock.addDays(1);
  gas.ctx.pmRecord();
  assert.equal(file('snap-2026-11-09.json').rows.length, 1);
  assert.equal(file('snap-2026-11-08.json').rows.length, 2, '前日のファイルはそのまま');
});

test('記録: ウォッチ中の市場は上位に入っていなくても記録する', () => {
  const { gas, file } = server(450, { props: { PM_WATCH: JSON.stringify(['430', '445']) } });
  gas.ctx.pmRecord();
  const ids = file('snap-2026-11-08.json').rows[0].m.map(r => r[0]);
  assert.equal(ids.length, 402);
  assert.ok(ids.includes('430') && ids.includes('445'));
  assert.equal(gas.get({}).pm.watch, 2);
});

test('記録: 取得に失敗した時はエラーを控え、台帳や記録を壊さない', () => {
  const { clock, g, gas, file } = server(50);
  gas.ctx.pmRecord();
  const before = JSON.stringify(file('catalog.json'));
  clock.tick(3600000);
  const ok = g.fetch;
  gas.ctx.UrlFetchApp.fetch = () => ({ getResponseCode: () => 503, getContentText: () => '' });
  gas.ctx.pmRecord();
  assert.match(gas.get({}).pm.error, /Gamma API 503/);
  assert.equal(JSON.stringify(file('catalog.json')), before);
  assert.equal(file('snap-2026-11-08.json').rows.length, 1);
  // 直れば、エラーは消える
  gas.ctx.UrlFetchApp.fetch = ok;
  gas.ctx.pmRecord();
  assert.equal(gas.get({}).pm.error, null);
  assert.equal(file('snap-2026-11-08.json').rows.length, 2);
});

test('決着: 締切を過ぎた・上位から外れた市場の結果を台帳に記録する。まだ決まっていないものは次回に', () => {
  const { clock, g, gas, file } = server(30);
  gas.ctx.pmRecord();
  // 1: Yes で決着 / 2: No で決着 / 3: 終わったが結果待ち / 4: 引き分け / 5: 締切前で上位にいる (確認しない)
  const close = (id, prices) => Object.assign(g.markets.get(id), { closed: true, outcomePrices: JSON.stringify(prices), closedTime: '2026-11-09 01:00:00+00' });
  close('1', ['1', '0']); close('2', ['0', '1']); close('3', ['0.7', '0.3']); close('4', ['0.5', '0.5']);
  ['1', '2', '3', '4'].forEach(id => { g.markets.get(id).endDate = '2026-11-08T12:00:00Z'; });
  clock.tick(7 * 3600000);
  gas.ctx.pmRecord();   // 1〜4 は終わったので上位から外れる
  gas.ctx.pmResolve();
  const cat = file('catalog.json');
  assert.equal(cat.m['1'].r, 'Yes');
  assert.equal(cat.m['2'].r, 'No');
  assert.equal(cat.m['3'].r, undefined, '結果待ちは記録しない');
  assert.equal(cat.m['4'].r, '50-50');
  assert.equal(cat.m['5'].r, undefined);
  assert.equal(cat.m['1'].ra, '2026-11-09 01:00:00+00');
  assert.equal(gas.get({}).pm.resolved, 3);
  // 次の日、3 が決まれば記録される。決まったものは問い合わせない
  close('3', ['0', '1']);
  clock.addDays(1);
  gas.ctx.pmRecord();   // 本番では1時間ごとに記録が動いている
  g.calls.length = 0;
  gas.ctx.pmResolve();
  assert.equal(file('catalog.json').m['3'].r, 'No');
  const asked = g.calls.flatMap(u => new URL(u).searchParams.getAll('id'));
  assert.deepEqual(asked, ['3']);
});

test('setup: 予定管理の通知を止め、記録のトリガーを登録して1回目を記録する', () => {
  const { gas, file } = server(20);
  gas.ctx.ScriptApp.newTrigger('pollTelegram').timeBased().everyMinutes(1).create();
  gas.ctx.ScriptApp.newTrigger('sendDailyMail').timeBased().atHour(8).everyDays(1).create();
  gas.ctx.setup();
  assert.deepEqual(gas.ctx.ScriptApp.triggers.map(t => t.fn).sort(), ['pmRecord', 'pmResolve']);
  assert.equal(file('snap-2026-11-08.json').rows[0].m.length, 20);
  assert.ok(gas.logs.some(l => /1回目の記録: 20件/.test(l)));
  // 2回目の setup でもトリガーは増えない
  gas.ctx.setup();
  assert.equal(gas.ctx.ScriptApp.triggers.length, 2);
});

test('状況は合言葉で守られる', () => {
  const { gas } = server(5, { props: { API_SECRET: 'secret-pm-test-123' } });
  gas.ctx.pmRecord();
  const r = gas.get({});
  assert.equal(r.ok, false);
  assert.equal(r.pm, undefined);
  assert.equal(gas.get({ key: 'secret-pm-test-123' }).pm.lastCount, 5);
});

test('アプリ: 設定の「状況を確認」で記録の状況が分かる', async () => {
  const { openApp, GAS_URL } = require('./helpers/app');
  const { clock, gas } = server(12);
  const app = await openApp({ clock, gas, state: { projects: [], settings: { gasUrl: GAS_URL, gasAuto: false }, deleted: {} } });
  try {
    app.run('switchTab("settings")');
    app.doc.querySelector('#gasCheck').click();
    await app.settle();
    assert.match(app.text('#gasResult'), /まだ始まっていません.*setup/);
    gas.ctx.pmRecord();
    app.doc.querySelector('#gasCheck').click();
    await app.settle();
    assert.match(app.text('#gasResult'), /記録: 最終 .*\(12件\)/);
    assert.match(app.text('#gasResult'), /台帳 12件 ／ 決着済み 0件 ／ 2026-11-08 から記録中/);
    // 3時間以上止まっていたら知らせる
    clock.tick(4 * 3600000);
    app.doc.querySelector('#gasCheck').click();
    await app.settle();
    assert.match(app.text('#gasResult'), /3時間以上止まっています/);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('和訳・判定: キーが無い時は保存分だけ返す。興味を変えると判定し直す。1日の上限で止まる', () => {
  const clock = createClock('2026-11-08T10:00:00+09:00');
  let calls = 0;
  const gem = (url, params) => {
    calls++;
    const body = JSON.parse(params.payload), sys = body.system_instruction.parts[0].text, input = JSON.parse(body.contents[0].parts[0].text);
    const out = /翻訳者/.test(sys) ? input.map(x => ({ i: x.i, ja: 'J' + x.t })) : input.map(x => ({ i: x.i, s: /興味: FRBの金利\n/.test(sys) ? 3 : 1, c: '存在しない分野' }));
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] }) };
  };
  const gas = loadGas({ clock, fetch: gem });
  const ask = () => gas.post({ action: 'pmAi', texts: ['Hello', 'World'], events: [{ id: 'e1', t: 'Fed', m: 'x' }] });
  let r = ask();
  assert.equal(r.noKey, true);
  assert.deepEqual(r.tr, {});
  assert.equal(calls, 0);
  gas.post({ action: 'pmConfig', geminiKey: 'k' });
  r = ask();
  assert.deepEqual(r.tr, { Hello: 'JHello', World: 'JWorld' });
  assert.deepEqual(r.sc, { e1: { s: 1, c: 'その他' } }, '知らない分野は「その他」');
  assert.equal(calls, 2);
  ask();
  assert.equal(calls, 2, '保存分を使う');
  gas.post({ action: 'pmConfig', profile: 'FRBの金利' });
  r = ask();
  assert.equal(r.sc.e1.s, 3, '興味を変えたら判定し直す');
  assert.equal(calls, 3);
  // 1日の上限
  gas.props.setProperty('PM_AI_DAY', JSON.stringify({ d: '2026-11-08', n: 400 }));
  r = gas.post({ action: 'pmAi', texts: ['New text'], events: [] });
  assert.match(r.error, /上限/);
  assert.equal(r.left, 1);
  clock.addDays(1);
  r = gas.post({ action: 'pmAi', texts: ['New text'], events: [] });
  assert.equal(r.tr['New text'], 'JNew text', '日付が変わればまた使える');
  // 合言葉
  gas.props.setProperty('API_SECRET', 'secret-pm-ai-1234');
  assert.equal(gas.post({ action: 'pmAi', texts: ['Hello'] }).needKey, true);
  assert.equal(gas.post({ action: 'pmAi', texts: ['Hello'], key: 'secret-pm-ai-1234' }).tr.Hello, 'JHello');
  // ウォッチ
  assert.equal(gas.post({ action: 'pmWatch', ids: ['1', '2', 'bad', '3'], key: 'secret-pm-ai-1234' }).watch, 3);
  assert.equal(gas.props.getProperty('PM_WATCH'), '["1","2","3"]');
});
