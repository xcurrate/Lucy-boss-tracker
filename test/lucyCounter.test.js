const test = require('node:test');
const assert = require('node:assert/strict');
const { countLucy, dayKey } = require('../src/services/lucyCounter');

test('counts Lucy as a whole word, case-insensitively', () => {
  assert.equal(countLucy('Lucy lucy LUCY'), 3);
  assert.equal(countLucy('lucyland lucky'), 0);
  assert.equal(countLucy('one Lucy, two lucy!'), 2);
});

test('daily key uses YYYY-MM-DD in WIB', () => {
  assert.match(dayKey(new Date('2026-11-01T17:30:00.000Z')), /^2026-11-02$/);
});
