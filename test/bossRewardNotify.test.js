const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseAmount, parseTargets } = require('../src/commands/bossRewardNotify');

describe('boss reward target parser', () => {
  it('normalizes plain, comma, and k amounts', () => {
    assert.deepEqual(parseAmount('100'), { target: 100, operator: '>=' });
    assert.deepEqual(parseAmount('10,000++'), { target: 10000, operator: '>' });
    assert.deepEqual(parseAmount('1.5k'), { target: 1500, operator: '>=' });
    assert.deepEqual(parseAmount('10k++'), { target: 10000, operator: '>' });
  });
  it('parses multiple category/value pairs without separators', () => {
    assert.deepEqual(parseTargets(['ws', '100', 'xp', '10k++', 'flb', '5']), {
      weapon_shards: { target: 100, operator: '>=' },
      experience: { target: 10000, operator: '>' },
      fabled_lootbox: { target: 5, operator: '>=' }
    });
  });
  it('rejects incomplete or malformed pairs', () => {
    assert.throws(() => parseTargets(['ws']), /Format/);
    assert.throws(() => parseTargets(['unknown', '100']), /tidak valid/);
    assert.throws(() => parseTargets(['ws', '10++x']), /tidak valid/);
  });
});
