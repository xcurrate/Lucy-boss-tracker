const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseAmount, parseTargets } = require('../src/commands/bossRewardNotify');
const { findRewardImage, reached, isRewardSourceChannel, isBossEnded, processMessage } = require('../src/services/bossRewardNotifications');
const { cooldownRemaining, NOTIFICATION_COOLDOWN_MS } = require('../src/utils/bossRewardStorage');

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
    const raidUrl = 'https://cdn.discordapp.com/attachments/123456789012345678/123456789012345679/raid.png';
    const message = { components: [{ type: 17, components: [
      { type: 10, content: '## Guild Boss Telah Muncul!' },
      { type: 12, items: [{ media: { url: raidUrl } }] },
      { type: 14, divider: true },
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

describe('Lucy reward source channel filter', () => {
  it('only accepts Lucy messages from the Boss Tracker notification channel', () => {
    const settings = { channelId: '1552409627826585630' };
    assert.equal(isRewardSourceChannel({ guildId: '1183952709427150859', channelId: '1552409627826585630' }, settings), true);
    assert.equal(isRewardSourceChannel({ guildId: '1183952709427150859', channelId: '1552409627826585631' }, settings), false);
    assert.equal(isRewardSourceChannel({ guildId: '1183952709427150859', channelId: '1552409627826585630' }, { channelId: null }), false);
    assert.equal(isRewardSourceChannel({ channelId: '1552409627826585630' }, settings), false);
  });
});

describe('Lucy boss end-state filter', () => {
  it('skips defeated boss result even when reward image exists', () => {
    const message = { components: [{ type: 17, components: [
      { type: 10, content: '## <:lucy_yay:123> Guild Boss Telah Dikalahkan!' },
      { type: 12, items: [{ media: { url: 'https://cdn.discordapp.com/attachments/123456789012345678/123456789012345678/reward.png' } }] },
      { type: 10, content: '## Hadiah' },
      { type: 12, items: [{ media: { url: 'https://cdn.discordapp.com/attachments/123456789012345678/123456789012345678/reward.png' } }] },
      { type: 10, content: '☠ Dikalahkan 7 menit yang lalu' }
    ] }] };
    assert.equal(isBossEnded(message), true);
  });
  it('skips escaped boss message', () => {
    const message = { components: [{ type: 17, components: [
      { type: 10, content: '## GUILD BOSS KABUR!' },
      { type: 2, disabled: true, custom_id: 'raid:fight' }
    ] }] };
    assert.equal(isBossEnded(message), true);
  });
  it('allows active boss messages', () => {
    const message = { components: [{ type: 17, components: [
      { type: 10, content: '## <:lucy_think:123> Guild Boss Telah Muncul!' },
      { type: 12, items: [{ media: { url: 'https://cdn.discordapp.com/attachments/123456789012345678/123456789012345678/reward.png' } }] },
      { type: 10, content: '⏳ Berakhir dalam 20 menit' }
    ] }] };
    assert.equal(isBossEnded(message), false);
  });
});

describe('reward notification cooldown', () => {
  it('holds notification for 30 minutes after successful send timestamp', () => {
    const sentAt = 1000000;
    assert.equal(cooldownRemaining(sentAt, sentAt), NOTIFICATION_COOLDOWN_MS);
    assert.equal(cooldownRemaining(sentAt, sentAt + 10 * 60 * 1000), 20 * 60 * 1000);
    assert.equal(cooldownRemaining(sentAt, sentAt + 30 * 60 * 1000), 0);
    assert.equal(cooldownRemaining(sentAt, sentAt + 35 * 60 * 1000), 0);
  });
});

describe('reward source channel gating', () => {
  it('stays silent for bot messages outside the configured channel', async () => {
    const logs = [];
    const original = console.info;
    console.info = (...args) => logs.push(args.join(' '));
    try {
      // guildId tanpa channelId terkonfigurasi → pesan bot lain tidak diproses.
      await processMessage({
        guildId: 'guild-without-channel',
        channelId: 'some-channel',
        id: '1',
        author: { id: 'other-bot', bot: true },
        components: [{ type: 17 }]
      });
    } finally {
      console.info = original;
    }
    assert.equal(logs.filter(line => line.includes('skip:not-lucy')).length, 0);
    assert.equal(logs.length, 0);
  });
});
