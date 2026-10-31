'use strict';
/* テスト用の時計。GAS側(vm)とアプリ側(jsdom)で同じ「いま」を共有する。
   時刻はすべて日本時間で考える (process.env.TZ も Asia/Tokyo に固定する) */
process.env.TZ = 'Asia/Tokyo';

const RealDate = Date;

function createClock(start) {
  const clock = {
    now: RealDate.parse(start || '2026-11-02T10:00:00+09:00'),
    /** 日本時間の日時文字列 ("2026-11-02T20:00") に合わせる */
    set(jst) { clock.now = RealDate.parse(/[zZ]|[+-]\d\d:\d\d$/.test(jst) ? jst : jst + '+09:00'); },
    /** ミリ秒単位で進める */
    tick(ms) { clock.now += (ms == null ? 1000 : ms); },
    addDays(n) { clock.now += n * 86400000; },
    iso() { return new RealDate(clock.now).toISOString(); },
  };
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(clock.now); else super(...a); }
    static now() { return clock.now; }
  }
  clock.Date = FakeDate;
  return clock;
}

/** 日本時間の "YYYY-MM-DDTHH:MM" を、clock.now から n 日後で作る (案件の deadline 用) */
function jstLocal(clock, days, hhmm) {
  const d = new RealDate(clock.now + (days || 0) * 86400000 + 9 * 3600000);
  return d.toISOString().slice(0, 10) + 'T' + (hhmm || '23:59');
}

module.exports = { createClock, jstLocal, RealDate };
