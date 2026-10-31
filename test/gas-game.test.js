'use strict';
/* Telegramのクエスト・XP・連続記録・夜のお知らせ・ものがたり (gas/Code.gs) */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas, project } = require('./helpers/gas');
const { createClock, jstLocal } = require('./helpers/clock');

const CHAT = '111';
const clone = x => JSON.parse(JSON.stringify(x));

function setupQuest() {
  const clock = createClock('2026-11-02T09:05:00+09:00');
  const gas = loadGas({ clock });
  gas.enableTelegram([CHAT]);
  gas.setProjects([
    project(clock, { id: 'q1', name: '明日まで', deadline: jstLocal(clock, 1) }),
    project(clock, { id: 'q2', name: '明後日まで', deadline: jstLocal(clock, 2) }),
    project(clock, { id: 'q3', name: 'ピン留め', pinned: true }),
    project(clock, { id: 'q4', name: 'まだ先', deadline: jstLocal(clock, 30) }),
  ]);
  return { clock, gas };
}
const press = (gas, data) => { gas.tg.pushButton(CHAT, data); gas.ctx.pollTelegram(); };
const lastToast = gas => clone(gas.tg.calls.filter(c => c.method === 'answerCallbackQuery').pop().body.text);

test('クエスト: 朝9時にボタン付きで届き、ボタンで完了するとXPが入る (二重加算なし・全部片付けでボーナス)', () => {
  const { gas } = setupQuest();
  const { XP_ON_TIME, XP_DROP, XP_DONE, XP_BONUS } = gas.C;

  gas.ctx.pollTelegram();
  const msg = gas.tg.sent.find(s => /今日のクエスト/.test(s.text));
  assert.ok(msg, '今日のクエストが届く');
  assert.equal(String(msg.chat_id), CHAT);
  const buttons = msg.reply_markup.inline_keyboard.flat().map(b => b.callback_data);
  assert.deepEqual(clone(gas.game().quest.ids), ['q1', 'q2', 'q3'], '期限が近い順 → ピン留め、最大3件');
  for (const id of ['q1', 'q2', 'q3']) for (const k of ['d', 's', 'x']) assert.ok(buttons.includes(`q:${k}:${id}`));
  assert.ok(buttons.includes('q:c'), '「確認した」ボタンもある');

  // ✅ 期限内に完了 → 20XP
  press(gas, 'q:d:q1');
  let g = gas.game();
  assert.equal(g.xp, XP_ON_TIME);
  assert.equal(g.streak, 1);
  assert.equal(gas.projects().find(p => p.id === 'q1').status, 'done');
  assert.match(lastToast(gas), new RegExp('\\+' + XP_ON_TIME + 'XP'));
  assert.ok(gas.tg.calls.some(c => c.method === 'editMessageText' && /<s>明日まで<\/s>/.test(c.body.text)), 'メッセージが更新される');

  // 同じボタンをもう一度 → 増えない
  press(gas, 'q:d:q1');
  assert.equal(gas.game().xp, XP_ON_TIME, '二重加算しない');
  assert.match(lastToast(gas), /すでに完了/);

  // 🙅 見送り → 2XP
  press(gas, 'q:x:q2');
  g = gas.game();
  assert.equal(g.xp, XP_ON_TIME + XP_DROP);
  const q2 = gas.projects().find(p => p.id === 'q2');
  assert.equal(q2.status, 'done');
  assert.equal(q2.dropped, true);
  assert.equal(g.quest.bonus, false, 'まだ全部は片付いていない');

  // 最後の1件 (期限なし) → 10XP + 全クリアのボーナス30XP
  gas.tg.clear();
  press(gas, 'q:d:q3');
  g = gas.game();
  const total = XP_ON_TIME + XP_DROP + XP_DONE + XP_BONUS;
  assert.equal(g.xp, total);
  assert.equal(g.quest.bonus, true);
  assert.match(lastToast(gas), /クエスト達成/);
  assert.ok(gas.tg.texts(CHAT).some(t => /レベルアップ/.test(t) && /Lv\.2/.test(t)), '50XPを超えたのでレベルアップの通知');
  assert.ok(gas.tg.calls.some(c => c.method === 'editMessageText' && /クエスト達成/.test(c.body.text)));

  // もう一度押してもボーナスは1回だけ
  press(gas, 'q:d:q3');
  press(gas, 'q:x:q2');
  assert.equal(gas.game().xp, total);

  // アプリから同期で同じ案件が届いても、XPは二重に付かない
  gas.post({ all: gas.projects(), deleted: {}, syncedAt: new Date(gas.clock.now).toISOString() });
  assert.equal(gas.game().xp, total);

  // HOME用のまとめ
  const sum = gas.ctx.gameSummary_();
  assert.equal(sum.xp, total);
  assert.equal(sum.lv, 2);
  assert.deepEqual(clone(sum.quest), { total: 3, cleared: 3, bonus: true });
  assert.equal(sum.week[6], total, '今日のXP');
});

test('クエスト: 「明日へ」はXPなし・連続記録は伸びる。翌日はクエストの結果が振り返り用に残る', () => {
  const { clock, gas } = setupQuest();
  gas.ctx.pollTelegram();
  press(gas, 'q:s:q1');
  let g = gas.game();
  assert.equal(g.xp || 0, 0);
  assert.equal(g.streak, 1);
  assert.equal(g.quest.res.q1, 'skip');
  assert.equal(gas.projects().find(p => p.id === 'q1').status, 'open', '明日へは完了にしない');
  press(gas, 'q:d:q2');

  clock.addDays(1);
  gas.ctx.pollTelegram();   // 翌朝9時過ぎ → 新しいクエスト
  g = gas.game();
  assert.equal(g.quest.date, '2026-11-03');
  const h = g.qhist.find(x => x.d === '2026-11-02');
  assert.deepEqual(clone(h), { d: '2026-11-02', n: 3, done: 1, drop: 0, skip: 1, b: false });
  assert.ok(g.quest.ids.includes('q1'), '明日へ回した案件がまた候補に入る');
});

test('クエスト: アプリで完了した案件にも同期でXPが付き、クエストに反映される', () => {
  const { clock, gas } = setupQuest();
  gas.ctx.pollTelegram();
  clock.tick(60000);
  const list = gas.projects();
  for (const p of list) if (['q1', 'q2', 'q3'].includes(p.id)) { p.status = 'done'; p.doneAt = p.updatedAt = clock.iso(); }
  const r = gas.post({ all: list, deleted: {}, syncedAt: clock.iso() });
  const { XP_ON_TIME, XP_DONE, XP_BONUS } = gas.C;
  assert.equal(r.game.xp, XP_ON_TIME * 2 + XP_DONE + XP_BONUS);
  assert.equal(r.game.quest.bonus, true);
  assert.equal(r.game.streak, 1);
});

test('毎朝のクエストは9時より前には送らず、9時を過ぎたら1日1回だけ送る', () => {
  const clock = createClock('2026-11-02T08:58:00+09:00');
  const gas = loadGas({ clock });
  gas.enableTelegram([CHAT, '222']);
  gas.setProjects([project(clock, { id: 'a', name: 'A', pinned: true })]);
  const quests = () => gas.tg.sent.filter(s => /今日のクエスト/.test(s.text)).length;
  gas.ctx.pollTelegram();
  assert.equal(quests(), 0, '8:58 はまだ');
  clock.set('2026-11-02T09:00');
  gas.ctx.pollTelegram();
  assert.equal(quests(), 2, '9:00 に登録済みの2チャットへ');
  for (let i = 0; i < 5; i++) { clock.tick(60000); gas.ctx.pollTelegram(); }
  assert.equal(quests(), 2, '同じ日に二度は送らない');
  clock.set('2026-11-03T09:01');
  gas.ctx.pollTelegram();
  assert.equal(quests(), 4, '翌日はまた届く');
});

test('連続記録: 毎日続けると伸び、1日空くと1からやり直し。最高記録は残る', () => {
  const clock = createClock('2026-11-02T10:00:00+09:00');
  const gas = loadGas({ clock });
  gas.enableTelegram([CHAT]);
  const { XP_CHECK } = gas.C;

  press(gas, 'q:c');
  assert.equal(gas.game().streak, 1);
  assert.equal(gas.game().xp, XP_CHECK);
  press(gas, 'q:c');
  assert.equal(gas.game().xp, XP_CHECK, '同じ日の「確認した」は1回だけ');
  assert.match(lastToast(gas), /記録済み/);

  clock.set('2026-11-03T23:50');
  press(gas, 'q:c');
  clock.set('2026-11-04T00:10');   // 日付が変わった直後 (日本時間)
  press(gas, 'q:c');
  let g = gas.game();
  assert.equal(g.streak, 3);
  assert.equal(g.best, 3);
  assert.equal(gas.ctx.gameSummary_().streak, 3);

  // 11/5 は何もしない → 11/6 のHOMEでは途切れている
  clock.set('2026-11-06T10:00');
  assert.equal(gas.ctx.gameSummary_().streak, 0);
  press(gas, 'q:c');
  g = gas.game();
  assert.equal(g.streak, 1, '1からやり直し');
  assert.equal(g.best, 3, '最高記録は残る');
});

test('夜20時のお知らせ: 連続記録が途切れそうな日だけ、1日1回', () => {
  const clock = createClock('2026-11-02T10:00:00+09:00');
  const gas = loadGas({ clock });
  gas.enableTelegram([CHAT]);
  press(gas, 'q:c');                       // 11/2 に記録 → 1日連続
  const nudges = () => gas.tg.texts(CHAT).filter(t => /途切れそう/.test(t)).length;

  clock.set('2026-11-02T20:30');
  gas.ctx.pollTelegram();
  assert.equal(nudges(), 0, '今日すでに記録した日は送らない');

  clock.set('2026-11-03T19:59');
  gas.ctx.pollTelegram();
  assert.equal(nudges(), 0, '20時より前は送らない');
  clock.set('2026-11-03T20:00');
  gas.ctx.pollTelegram();
  assert.equal(nudges(), 1, '20時に1回');
  const m = gas.tg.sent.find(s => /途切れそう/.test(s.text));
  assert.match(m.text, /1日連続/);
  assert.deepEqual(clone(m.reply_markup.inline_keyboard[0].map(b => b.callback_data)), ['q:c']);
  for (let i = 0; i < 10; i++) { clock.tick(60000); gas.ctx.pollTelegram(); }
  assert.equal(nudges(), 1, '同じ夜に二度は送らない');

  // ボタンで記録を守れる
  press(gas, 'q:c');
  assert.equal(gas.game().streak, 2);

  // 記録が途切れた後 (2日以上空いた) は送らない
  clock.set('2026-11-06T20:05');
  gas.ctx.pollTelegram();
  assert.equal(nudges(), 1);
});

test('ものがたり: 完了数が節目を越えるとお話の通知が届く (見送りは数えない)', () => {
  const clock = createClock('2026-11-02T10:00:00+09:00');
  const gas = loadGas({ clock });
  gas.enableTelegram([CHAT]);
  gas.setProjects(['s1', 's2', 's3', 's4'].map((id, i) => project(clock, { id, name: 'お話' + (i + 1) })));
  const stories = () => gas.tg.texts(CHAT).filter(t => /新しいお話が届きました/.test(t));

  const done = n => { gas.tg.pushMessage(CHAT, '/list'); gas.tg.pushMessage(CHAT, '/done ' + n); gas.ctx.pollTelegram(); };
  done(1);
  assert.equal(gas.game().doneTotal, 1);
  assert.equal(stories().length, 1);
  assert.match(stories()[0], /第1話「はじまりの部屋」/);
  assert.match(stories()[0], /手帳を一冊/);

  done(1);
  assert.equal(gas.game().doneTotal, 2);
  assert.equal(stories().length, 1, '節目でなければ届かない');

  // 見送りは完了数に入らない
  gas.tg.pushMessage(CHAT, '/alert'); gas.ctx.pollTelegram();
  const qid = gas.game().quest.ids[0];
  press(gas, 'q:x:' + qid);
  assert.equal(gas.game().doneTotal, 2);
  assert.equal(stories().length, 1);

  // ボタンでの完了でも届く (3件目 → 第2話)
  const rest = gas.projects().find(p => p.status !== 'done');
  gas.ctx.handleCallback_({ id: 'x', data: 'q:d:' + rest.id, message: { message_id: 1, chat: { id: Number(CHAT) } } });
  assert.equal(gas.game().doneTotal, 3);
  assert.equal(stories().length, 2);
  assert.match(stories()[1], /第2話「窓辺の訪問者」/);
});

test('ものがたり: storyNotice_ は一度に複数の節目を越えたら最新のお話を返す', () => {
  const gas = loadGas();
  assert.equal(gas.ctx.storyNotice_(0, 0), '');
  assert.equal(gas.ctx.storyNotice_(1, 2), '');
  assert.match(gas.ctx.storyNotice_(0, 5), /第3話「ちいさな種」/);
  assert.match(gas.ctx.storyNotice_(139, 200), /第21話「いつもの部屋」/);
  assert.equal(gas.ctx.storyNotice_(140, 500), '', '全21話の後は何も届かない');
  assert.equal(gas.C.STORY.length, 21);
  // 初めてゲームを使う時は、今ある完了済みの数から始める
  const clock = createClock();
  const g2 = loadGas({ clock });
  g2.setProjects([project(clock, { status: 'done' }), project(clock, { status: 'done' }), project(clock, { status: 'done', dropped: true })]);
  assert.equal(g2.ctx.getGame_().doneTotal, 2);
});

test('レベル: Lv.L に必要な累計XP は 25×(L-1)×L', () => {
  const gas = loadGas();
  for (const [xp, lv] of [[0, 1], [49, 1], [50, 2], [149, 2], [150, 3], [300, 4], [500, 5]]) {
    assert.equal(gas.ctx.levelOf_(xp), lv, xp + 'XP');
  }
  const li = gas.ctx.levelInfo_(160);
  assert.deepEqual(clone(li), { lv: 3, title: 'ガス代の守り手', cur: 10, need: 150 });
});
