const { describe, it } = require('node:test');
const assert = require('node:assert');
const { extractNextBossTimestamp } = require('../src/services/bossTracker');

const TS = 1750000000;

describe('extractNextBossTimestamp', () => {
  it('extracts timestamp from plain message content', () => {
    const m = {
      content: 'Guild Boss Telah Dikalahkan!\nBoss baru: <t:' + TS + ':F>',
      embeds: [],
      components: []
    };
    assert.strictEqual(extractNextBossTimestamp(m), TS);
  });

  it('ignores messages without boss title', () => {
    const m = {
      content: 'Boss baru <t:' + TS + ':F>',
      embeds: [],
      components: []
    };
    assert.strictEqual(extractNextBossTimestamp(m), null);
  });

  it('extracts timestamp from v2 components', () => {
    const m = {
      content: 'Guild Boss Telah Dikalahkan!',
      embeds: [{ description: 'Boss baru: <t:' + TS + ':F>' }],
      components: [{ components: [{ components: [{ value: '<t:' + TS + ':R>' }] }] }]
    };
    assert.strictEqual(extractNextBossTimestamp(m), TS);
  });

  it('extracts timestamp from embeds of a real Message object', () => {
    const m = {
      toJSON: () => ({
        content: 'Guild Boss Telah Dikalahkan!',
        embeds: [{ description: '**Boss baru** <t:' + TS + ':F>' }],
        components: []
      })
    };
    assert.strictEqual(extractNextBossTimestamp(m), TS);
  });

  it('returns null when no timestamp is present', () => {
    const m = {
      content: 'Guild Boss Telah Dikalahkan!\nBoss baru muncul!',
      embeds: [],
      components: []
    };
    assert.strictEqual(extractNextBossTimestamp(m), null);
  });
});