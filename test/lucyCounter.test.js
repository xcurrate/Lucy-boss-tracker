const test = require('node:test');
const assert = require('node:assert/strict');
const { countLucy, dayKey, isTargetWindow, challengeCycleKey } = require('../src/services/lucyCounter');

test('counts at most one Lucy per message, case-insensitively', () => {
  assert.equal(countLucy('Lucy lucy LUCY'), 1);
  assert.equal(countLucy('lucyland lucky'), 0);
  assert.equal(countLucy('one Lucy, two lucy!'), 1);
  assert.equal(countLucy('hello there'), 0);
});

test('daily key uses YYYY-MM-DD in WIB', () => {
  assert.match(dayKey(new Date('2026-11-01T17:30:00.000Z')), /^2026-11-02$/);
});

test('target schedule spans from noon to 10:00 WIB the next day', () => {
  const config = { targetStartTime: '12:00', targetStopTime: '10:00' };
  assert.equal(isTargetWindow(new Date('2026-11-02T05:00:00.000Z'), config), true); // 12:00 WIB
  assert.equal(isTargetWindow(new Date('2026-11-03T02:59:00.000Z'), config), true); // 09:59 WIB
  assert.equal(isTargetWindow(new Date('2026-11-03T03:00:00.000Z'), config), false); // 10:00 WIB
  assert.equal(isTargetWindow(new Date('2026-11-03T04:59:00.000Z'), config), false); // 11:59 WIB
  assert.equal(challengeCycleKey(new Date('2026-11-02T04:59:00.000Z'), config), '2026-11-01');
  assert.equal(challengeCycleKey(new Date('2026-11-02T05:00:00.000Z'), config), '2026-11-02');
});
