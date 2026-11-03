const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseAmount, parseTargets } = require('../src/commands/bossRewardNotify');
const { findRewardImage, reached } = require('../src/services/bossRewardNotifications');

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

describe('Lucy reward image component detection', () => {
  const url = 'https://cdn.discordapp.com/attachments/123456789012345678/123456789012345678/reward.png';
  it('finds image nested in Components V2 Hadiah container', () => {
    const message = { components: [{ type: 17, components: [
      { type: 10, content: '## Hadiah' },
      { type: 12, items: [{ media: { url } }] }
    ] }] };
    assert.equal(findRewardImage(message), url);
  });
  it('rejects image when Hadiah heading is absent', () => {
    const message = { components: [{ type: 17, components: [
      { type: 10, content: '## Informasi' },
      { type: 12, items: [{ media: { url } }] }
    ] }] };
    assert.equal(findRewardImage(message), null);
  });
  it('rejects non-HTTPS image URLs', () => {
    const message = { components: [{ type: 17, components: [
      { type: 10, content: '## Hadiah' },
      { type: 12, items: [{ media: { url: 'http://example.com/reward.png' } }] }
    ] }] };
    assert.equal(findRewardImage(message), null);
  });
});

describe('reward threshold evaluation', () => {
  it('uses >= by default and > for ++ targets', () => {
    assert.equal(reached(100, { target: 100, operator: '>=' }), true);
    assert.equal(reached(100, { target: 100, operator: '>' }), false);
    assert.equal(reached(101, { target: 100, operator: '>' }), true);
    assert.equal(reached(null, { target: 100, operator: '>=' }), false);
  });
});
