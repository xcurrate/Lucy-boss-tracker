const { describe, it } = require('node:test');
const assert = require('node:assert');
const { extractNextBossTimestamp, parseBossMessage } = require('../src/services/bossTracker');

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
describe('parseBossMessage', () => {
  // Struktur pesan mengikuti boss.json di branch main.
  function componentsMessage(lines) {
    return { content: '', components: [{ type: 17, components: lines.map(content => ({ type: 10, content })) }] };
  }

  it('classifies a spawn message and uses the message time', () => {
    const m = componentsMessage([
      '## <:lucy_think:1> Guild Boss Telah Muncul!',
      '⏳ Berakhir <t:1793615870:R>'
    ]);
    m.createdTimestamp = TS * 1000;
    assert.deepStrictEqual(parseBossMessage(m), { kind: 'spawn', appearAt: TS });
  });

  it('classifies a global raid spawn message', () => {
    const m = componentsMessage([
      '## <:lucy_think:1> Global Raid Boss Telah Muncul!',
      '⏳ Berakhir <t:1793719068:R>'
    ]);
    m.createdTimestamp = TS * 1000;
    assert.deepStrictEqual(parseBossMessage(m), { kind: 'spawn', appearAt: TS });
  });

  it('reads the next spawn time from a defeat message', () => {
    const m = componentsMessage([
      '## <:lucy_yay:1> Guild Boss Telah Dikalahkan!',
      '☠ Dikalahkan 7 menit yang lalu\n⌛ Boss baru <t:1792162619:R>\n-# Limit fight reset <t:1792170000:R>'
    ]);
    assert.deepStrictEqual(parseBossMessage(m), { kind: 'defeat', nextAt: 1792162619 });
  });

  it('classifies an escaped boss message', () => {
    const m = { content: 'GUILD BOSS KABUR!', components: [{ type: 2, custom_id: 'raid:fight', disabled: true }] };
    assert.deepStrictEqual(parseBossMessage(m), { kind: 'escape' });
  });

  it('derives spawn time from the snowflake when createdTimestamp is absent', () => {
    // 2026-11-02T09:37:50.877Z, id dari boss.json BOSS MUNCUL.
    const m = componentsMessage(['## Guild Boss Telah Muncul!']);
    m.id = '1566748163186892976';
    const event = parseBossMessage(m);
    assert.strictEqual(event.kind, 'spawn');
    assert.strictEqual(event.appearAt, 1793612270);
  });

  it('does not treat the defeat line as a spawn message', () => {
    const m = componentsMessage(['## Guild Boss Telah Dikalahkan!', '⌛ Boss baru <t:1792162619:R>']);
    assert.strictEqual(parseBossMessage(m).kind, 'defeat');
  });

  it('returns null for unrelated messages', () => {
    assert.strictEqual(parseBossMessage({ content: 'halo dunia' }), null);
  });
});

