'use strict';
/* 操作の記録 HIST (振り返り分析用) — gas/Code.gs */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas, project } = require('./helpers/gas');
const { createClock, jstLocal } = require('./helpers/clock');

const CHAT = '111';
const kinds = gas => gas.hist().map(e => e.k + ':' + (e.id || '') + ':' + e.s);

test('操作の記録: アプリからの同期で 追加/完了/期限変更/未完了に戻す/削除 が残る', () => {
  const clock = createClock('2026-11-02T10:00:00+09:00');
  const gas = loadGas({ clock });
  const sync = (all, deleted) => { clock.tick(60000); const r = gas.post({ all, deleted: deleted || {}, syncedAt: clock.iso() }); assert.equal(r.ok, true); return r.projects; };
  const touch = p => { p.updatedAt = new Date(clock.now + 60000).toISOString(); return p; };

  let list = sync([project(clock, { id: 'h1', name: '記録1', chain: 'ETH', deadline: jstLocal(clock, 3) }), project(clock, { id: 'h2', name: '記録2' })]);
  assert.deepEqual(kinds(gas), ['add:h1:app', 'add:h2:app']);
  assert.ok(gas.props.getProperty('HIST_SINCE'), '記録の開始時刻');

  // 期限変更 (前の期限 od も残る)
  const oldDl = list[0].deadline;
  list[0].deadline = jstLocal(clock, 10); touch(list[0]);
  list = sync(list);
  const due = gas.hist().find(e => e.k === 'due');
  assert.equal(due.id, 'h1');
  assert.equal(due.od, oldDl);
  assert.equal(due.d, list[0].deadline);
  assert.equal(due.n, '記録1');
  assert.equal(due.c, 'ETH');

  // 完了 → 未完了に戻す → 見送り
  list[1].status = 'done'; touch(list[1]); list = sync(list);
  list[1].status = 'open'; touch(list[1]); list = sync(list);
  list[1].status = 'done'; list[1].dropped = true; touch(list[1]); list = sync(list);

  // 削除
  const delAt = new Date(clock.now + 60000).toISOString();
  list = sync(list.filter(p => p.id !== 'h1'), { h1: delAt });

  // 何も変わらない同期では記録は増えない
  const n = gas.hist().length;
  sync(list);
  assert.equal(gas.hist().length, n);

  assert.deepEqual(kinds(gas), ['add:h1:app', 'add:h2:app', 'due:h1:app', 'done:h2:app', 'reopen:h2:app', 'drop:h2:app', 'del:h1:app']);
  for (const e of gas.hist()) assert.ok(!isNaN(Date.parse(e.t)), '時刻が入っている');

  // ?action=history で取り出せる
  const h = gas.get({ action: 'history' });
  assert.equal(h.hist.length, 7);
  assert.ok(Array.isArray(h.qhist));
  assert.equal(h.histSince, gas.props.getProperty('HIST_SINCE'));
});

test('操作の記録: Telegramでの 追加/完了/ピン/明日へ/見送り/確認 も残る (s=tg)', () => {
  const clock = createClock('2026-11-02T10:00:00+09:00');
  const gas = loadGas({ clock });
  gas.enableTelegram([CHAT]);
  gas.setProjects([project(clock, { id: 't1', name: '近い', deadline: jstLocal(clock, 1) }), project(clock, { id: 't2', name: '近い2', deadline: jstLocal(clock, 2) })]);

  gas.tg.pushMessage(CHAT, '新しいエアドロップ\nhttps://x.com/someone/status/1');
  gas.ctx.pollTelegram();
  const added = gas.projects().find(p => p.src === 'telegram');
  assert.equal(added.name, '新しいエアドロップ');
  assert.equal(added.sources[0].url, 'https://x.com/someone/status/1');
  assert.ok(gas.tg.texts(CHAT).some(t => /1件を登録しました/.test(t)));

  gas.tg.pushMessage(CHAT, '/list');
  gas.tg.pushMessage(CHAT, '/pin 3');
  gas.tg.pushMessage(CHAT, '/done 1');
  gas.tg.pushMessage(CHAT, '/alert');
  gas.ctx.pollTelegram();
  gas.tg.pushButton(CHAT, 'q:s:t2');
  gas.tg.pushButton(CHAT, 'q:x:t2');
  gas.ctx.pollTelegram();
  clock.addDays(1);
  gas.tg.pushButton(CHAT, 'q:c');
  gas.ctx.pollTelegram();

  assert.deepEqual(kinds(gas), [
    `add:${added.id}:tg`, `pin:${added.id}:tg`, 'done:t1:tg', 'skip:t2:tg', 'drop:t2:tg', 'check::tg',
  ]);
  // Web版AIへの引き継ぎ用の受信箱にも残る
  assert.deepEqual(gas.get().inbox.map(x => x.type), ['add', 'pin', 'done', 'done']);
});

test('操作の記録: 180日より古いものと1500件を超えた分は捨てる', () => {
  const clock = createClock();
  const gas = loadGas({ clock });
  const old = { t: new Date(clock.now - 181 * 86400000).toISOString(), k: 'add', id: 'old', s: 'app' };
  gas.ctx.saveBlob_('HIST', JSON.stringify([old]));
  const many = Array.from({ length: 1600 }, (_, i) => ({ t: new Date(clock.now + i).toISOString(), k: 'add', id: 'n' + i, s: 'app' }));
  gas.ctx.logHist_(many);
  const h = gas.hist();
  assert.equal(h.length, 1500);
  assert.ok(!h.some(e => e.id === 'old'));
  assert.equal(h[h.length - 1].id, 'n1599', '新しい方を残す');
});
