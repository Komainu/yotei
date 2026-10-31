'use strict';
/* 部屋の背景 drawRoom() — 全イベント・昼夜・狭い/広い画面でエラーなく描けるか */
const test = require('node:test');
const assert = require('node:assert/strict');
const { openApp } = require('./helpers/app');
const { project } = require('./helpers/gas');
const { createClock, jstLocal } = require('./helpers/clock');

const WIDTHS = [360, 619, 620, 1000, 1400];   // 620 以上が「広い画面」

function checkSvg(app, r, label) {
  assert.equal(typeof r.svg, 'string', label);
  assert.ok(r.svg.length > 1000, label + ': 中身がある');
  assert.equal(r.h, 640, label);
  for (const bad of ['NaN', 'undefined', 'Infinity', '[object']) assert.ok(!r.svg.includes(bad), `${label}: "${bad}" が含まれない`);
  const doc = new app.win.DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${r.svg}</svg>`, 'image/svg+xml');
  assert.equal(doc.getElementsByTagName('parsererror').length, 0, label + ': SVGとして正しい');
}

async function setup(clock) {
  const overdue = [1, 2, 3, 5, 8, 13, 21, 40].map((d, i) => project(clock, { id: 'o' + i, name: '期限切れ<' + i + '>&"', deadline: jstLocal(clock, -d) }));
  return openApp({ clock, state: { projects: overdue, settings: {}, deleted: {} } });
}

test('drawRoom: 全イベント × 昼夜 × 狭い/広い画面で描ける', async () => {
  const clock = createClock('2026-11-02T10:00:00+09:00');
  const app = await setup(clock);
  try {
    const events = app.run(`[...ROOM_EVENTS, ...ROOM_SPECIAL].map(e=>({ id:e.id, months:e.months||null, from:e.from||null }))`);
    const ids = [...events.map(e => e.id), 'clover', ''];
    assert.ok(ids.length >= 30, 'イベントの一覧が取れている');
    const clutter = app.run('state.projects');
    let n = 0;
    for (const id of ids) {
      const ev = events.find(e => e.id === id);
      const month = ev && ev.months ? ev.months[0] : ev && ev.from ? ev.from[0] : 1;
      for (const night of [false, true]) {
        for (const W of WIDTHS) {
          const label = `event=${id || '(なし)'} night=${night} W=${W}`;
          const r = app.win.drawRoom({ night, points: 99999, streak: 30, clutter, W, event: id, month, story: 21 });
          checkSvg(app, r, label);
          assert.equal(r.w, W, label);
          n++;
        }
      }
    }
    assert.ok(n > 300);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('drawRoom: 家具が0個〜全部、散らかり0〜多数、全ての月で描ける。期限切れの段ボールは押せる', async () => {
  const clock = createClock('2026-11-02T10:00:00+09:00');
  const app = await setup(clock);
  try {
    const steps = [0, ...app.run('ROOM_ITEMS.map(i=>i.at)')];
    const all = app.run('state.projects');
    for (const points of steps) {
      for (const clutter of [[], all.slice(0, 1), all]) {
        for (const night of [false, true]) {
          for (const W of [360, 1400]) {
            const r = app.win.drawRoom({ night, points, streak: points ? 5 : 0, clutter, W, event: '', month: 1 + (points % 12), story: 0 });
            checkSvg(app, r, `points=${points} clutter=${clutter.length} night=${night} W=${W}`);
          }
        }
      }
    }
    for (let month = 1; month <= 12; month++) {
      for (const night of [false, true]) checkSvg(app, app.win.drawRoom({ night, points: 500, streak: 3, clutter: all, W: 800, event: 'rain', month }), 'month=' + month);
    }
    // 家具が増えるほど絵も増える
    const size = p => app.win.drawRoom({ night: false, points: p, streak: 0, clutter: [], W: 800, month: 1 }).svg.length;
    assert.ok(size(99999) > size(0));
    // 段ボールには案件IDが付き、名前はエスケープされる
    const r = app.win.drawRoom({ night: false, points: 0, streak: 0, clutter: all.slice(0, 2), W: 360, month: 1 });
    assert.match(r.svg, /class="rbox" data-pid="o0"/);
    assert.ok(r.svg.includes('期限切れ&lt;0&gt;&amp;&quot;'));
    // 同じ条件なら毎回同じ絵 (乱数の種が固定)
    const o = { night: true, points: 300, streak: 2, clutter: all, W: 700, event: 'moon', month: 11 };
    assert.equal(app.win.drawRoom(o).svg, app.win.drawRoom(o).svg);
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});

test('renderRoom: 画面の大きさ・配色・日付が変わっても描ける (60日 × 昼夜)', async () => {
  const clock = createClock('2026-01-01T07:00:00+09:00');
  const app = await setup(clock);
  try {
    const sizes = [[375, 812], [1920, 1080], [768, 1024], [3000, 400]];
    const seen = new Set();
    for (let day = 0; day < 60; day++) {
      for (const hr of [8, 21]) {
        clock.set(new Date(Date.parse('2026-01-01T00:00:00+09:00') + day * 86400000 + hr * 3600000).toISOString());
        const [w, h] = sizes[(day + hr) % sizes.length];
        Object.defineProperty(app.win, 'innerWidth', { value: w, configurable: true });
        Object.defineProperty(app.win, 'innerHeight', { value: h, configurable: true });
        app.doc.documentElement.dataset.theme = hr > 18 ? 'dark' : 'light';
        app.run('renderRoom()');
        const svg = app.doc.querySelector('#roomBg svg');
        assert.ok(svg, `day=${day} hr=${hr}`);
        const vb = svg.getAttribute('viewBox').split(' ').map(Number);
        assert.equal(vb[3], 640);
        assert.ok(vb[2] >= 360 && vb[2] <= 1400, '幅は360〜1400');
        seen.add(app.run('todayEvent().id'));
      }
    }
    assert.ok(seen.size >= 10, '日によっていろいろなイベントが出る (' + seen.size + '種類)');
    // 背景をオフにすると消える
    app.run('state.settings.roomBg = false; renderRoom()');
    assert.equal(app.doc.querySelector('#roomBg').innerHTML, '');
    assert.deepEqual(app.errors, []);
  } finally { app.close(); }
});
