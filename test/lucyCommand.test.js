const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

let tempDir;

function resetModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes(path.sep + 'storage.js') || key.includes('lucyCounter.js')) delete require.cache[key];
  }
}

function makeMessage(content, { guildId = 'guild1', userId = 'user1', admin = false } = {}) {
  const replies = [];
  const payloads = [];
  return {
    guildId,
    channelId: 'chan1',
    author: { id: userId, bot: false, username: 'tester' },
    content,
    member: { displayName: 'tester', permissions: { has: () => admin } },
    createdTimestamp: Date.now(),
    client: {},
    reply: async payload => {
      payloads.push(payload);
      replies.push(typeof payload === 'string' ? payload : payload.content);
      return { id: 'msg' };
    },
    react: async () => {},
    replies,
    payloads
  };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-tracker-lucycmd-'));
  process.chdir(tempDir);
  resetModules();
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('lucy counter command routing', () => {
  it('releases messages that are not Lucy commands so other handlers can reply', async () => {
    const { updateGuildSettings } = require('../src/utils/storage');
    const lucyCounter = require('../src/services/lucyCounter');
    updateGuildSettings('guild1', s => ({ ...s, prefix: 'h' }));

    for (const content of ['hboss status', 'hboss setup #c @r', 'hboss help']) {
      const message = makeMessage(content);
      const handled = await lucyCounter.handleCommand(message);
      assert.strictEqual(handled, false, content + ' harus dilepas ke handler prefix boss');
      assert.strictEqual(message.replies.length, 0, content + ' tidak boleh dibalas Lucy Counter');
    }
  });

  it('does not emit the moderator warning for non-Lucy commands', async () => {
    const { updateGuildSettings } = require('../src/utils/storage');
    const lucyCounter = require('../src/services/lucyCounter');
    updateGuildSettings('guild1', s => ({ ...s, prefix: '!' }));

    const message = makeMessage('!boss setup #general @role', { admin: false });
    const handled = await lucyCounter.handleCommand(message);
    assert.strictEqual(handled, false);
    assert.strictEqual(message.replies.length, 0);
  });

  it('counts an accepted Lucy message into SQLite and shows it on the leaderboard', async () => {
    const { updateGuildSettings } = require('../src/utils/storage');
    const lucyCounter = require('../src/services/lucyCounter');
    const store = require('../src/utils/lucyCounterStorage');
    updateGuildSettings('guild1', s => ({ ...s, prefix: '!', lucyCounter: { ...s.lucyCounter, enabled: true } }));

    await lucyCounter.handleMessage(makeMessage('halo lucy!', { userId: 'user1' }));
    const guild = store.getGuildData('guild1');
    const day = lucyCounter.dayKey(new Date());
    assert.strictEqual(guild.users.user1.days[day], 1);

    // Cooldown: a second message within 10 seconds is ignored.
    await lucyCounter.handleMessage(makeMessage('lucy lagi', { userId: 'user1' }));
    assert.strictEqual(store.getGuildData('guild1').users.user1.days[day], 1);
  });

  it('filters each leaderboard by the date typed as "5 nov"', async () => {
    const { updateGuildSettings } = require('../src/utils/storage');
    const lucyCounter = require('../src/services/lucyCounter');
    const store = require('../src/utils/lucyCounterStorage');
    updateGuildSettings('guild1', s => ({ ...s, prefix: '!', lucyCounter: { ...s.lucyCounter, enabled: true, targetEnabled: true, targetGoal: 5 } }));

    // Data dua tanggal berbeda: 5 nov (3 Lucy) dan 6 nov (1 Lucy).
    store.recordLucy({ guildId: 'guild1', userId: 'user1', name: 'tester', day: '2026-11-05', cycleKey: '2026-11-05', targetActive: false, goal: 0 });
    store.recordLucy({ guildId: 'guild1', userId: 'user1', name: 'tester', day: '2026-11-05', cycleKey: '2026-11-05', targetActive: false, goal: 0 });
    store.recordLucy({ guildId: 'guild1', userId: 'user1', name: 'tester', day: '2026-11-06', cycleKey: '2026-11-06', targetActive: false, goal: 0 });
    store.recordLucy({ guildId: 'guild1', userId: 'user1', name: 'tester', day: '2026-11-05', cycleKey: '2026-11-05', targetActive: true, goal: 5 });

    const daily = makeMessage('!lcount 5 nov');
    assert.ok(await lucyCounter.handleCommand(daily));
    assert.match(daily.payloads[0].embeds[0].data.description, /\*\*3\*\* — tester/);
    assert.ok(daily.payloads[0].embeds[0].data.footer.text.includes('5 nov 2026'));
    // Tombol navigasi membawa tanggal yang sama.
    assert.match(daily.payloads[0].components[0].components[0].data.custom_id, /lcnav:daily:2026-11-05:/);

    const target = makeMessage('!ltarget 5 nov');
    assert.ok(await lucyCounter.handleCommand(target));
    assert.match(target.payloads[0].embeds[0].data.description, /\*\*1\*\* — tester/);
    assert.match(target.payloads[0].components[0].components[0].data.custom_id, /lcnav:target:2026-11-05:/);

    const servers = makeMessage('!lservers 5 nov');
    assert.ok(await lucyCounter.handleCommand(servers));
    assert.ok(servers.payloads[0].embeds[0].data.footer.text.includes('5 nov 2026'));
  });

  it('rejects an impossible date instead of silently ignoring it', async () => {
    const { updateGuildSettings } = require('../src/utils/storage');
    const lucyCounter = require('../src/services/lucyCounter');
    updateGuildSettings('guild1', s => ({ ...s, prefix: '!' }));

    const message = makeMessage('!lcount 32 nov');
    assert.ok(await lucyCounter.handleCommand(message));
    assert.match(message.replies[0], /Tanggal tidak dikenali/);
  });

  it('still handles lucytarget status and admin settings', async () => {
    const { updateGuildSettings } = require('../src/utils/storage');
    const lucyCounter = require('../src/services/lucyCounter');
    updateGuildSettings('guild1', s => ({ ...s, prefix: 'h' }));

    const status = makeMessage('hlucytarget status');
    assert.ok(await lucyCounter.handleCommand(status));
    assert.match(status.replies[0], /Target Lucy/);

    const enabled = makeMessage('hlucytarget on', { admin: true });
    assert.ok(await lucyCounter.handleCommand(enabled));
    assert.match(enabled.replies[0], /diaktifkan/);

    const denied = makeMessage('hlucytarget on', { admin: false });
    assert.ok(await lucyCounter.handleCommand(denied));
    assert.match(denied.replies[0], /moderator\/admin/);
  });
});
