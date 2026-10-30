const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

let tempDir;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-tracker-prefix-'));
  process.chdir(tempDir);
  for (const key of Object.keys(require.cache)) {
    if (key.includes('utils' + path.sep + 'storage.js')) delete require.cache[key];
    if (key.includes('commands' + path.sep + 'prefix.js')) delete require.cache[key];
  }
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('prefix command handler', () => {
  function makeMessage(content, guildId = 'guild1', userId = 'user1', admin = false) {
    return {
      guildId,
      author: { id: userId, bot: false },
      content,
      member: {
        permissions: { has: flag => admin }
      },
      guild: { channels: { fetch: async () => ({ send: async () => {} }) }, roles: { fetch: async () => ({}) } },
      reply: async () => {}
    };
  }

  function makeDeps() {
    const calls = [];
    return {
      calls,
      send: async (m, payload) => { calls.push({ kind: 'send', content: payload.content, embeds: payload.embeds, components: payload.components }); },
      isAdmin: m => Boolean(m.member?.permissions?.has('x'))
    };
  }

  it('handles notify alias', async () => {
    const { handlePrefixCommand } = require('../src/commands/prefix');
    const { getGuildSettings } = require('../src/utils/storage');
    const deps = makeDeps();
    await handlePrefixCommand(makeMessage('!boss notif dm'), null, deps);
    assert.strictEqual(getGuildSettings('guild1').userModes.user1, 'dm');
    assert.match(deps.calls[0].content, /DM pribadi/);
  });

  it('handles warn alias with seconds', async () => {
    const { handlePrefixCommand } = require('../src/commands/prefix');
    const { getGuildSettings } = require('../src/utils/storage');
    const deps = makeDeps();
    await handlePrefixCommand(makeMessage('!boss peringatan 300'), null, deps);
    assert.strictEqual(getGuildSettings('guild1').userWarnSeconds.user1, 300);
    assert.match(deps.calls[0].content, /5 menit/);
  });

  it('handles status alias and returns embed', async () => {
    const { handlePrefixCommand } = require('../src/commands/prefix');
    const deps = makeDeps();
    await handlePrefixCommand(makeMessage('!boss cek'), null, deps);
    assert.ok(deps.calls[0].embeds.length > 0);
  });

  it('handles menu alias with v2 components', async () => {
    const { handlePrefixCommand } = require('../src/commands/prefix');
    const deps = makeDeps();
    await handlePrefixCommand(makeMessage('!boss menu'), null, deps);
    const payload = deps.calls[0];
    assert.ok(payload.components.length > 0, 'should include component rows');
    const ids = payload.components.flatMap(r => r.components.map(c => c.data.custom_id));
    assert.ok(ids.includes('boss_notify_mode'));
    assert.ok(ids.includes('boss_warn_select'));
  });

  it('rejects non-admin for setup alias', async () => {
    const { handlePrefixCommand } = require('../src/commands/prefix');
    const deps = makeDeps();
    await handlePrefixCommand(makeMessage('!boss set #general @boss'), null, deps);
    assert.match(deps.calls[0].content, /moderator\/admin/);
  });

  it('rejects non-admin for server-on alias', async () => {
    const { handlePrefixCommand } = require('../src/commands/prefix');
    const deps = makeDeps();
    await handlePrefixCommand(makeMessage('!boss aktif'), null, deps);
    assert.match(deps.calls[0].content, /moderator\/admin/);
  });

  it('handles dm on alias', async () => {
    const { handlePrefixCommand } = require('../src/commands/prefix');
    const { getGuildSettings } = require('../src/utils/storage');
    const deps = makeDeps();
    await handlePrefixCommand(makeMessage('!boss nyalakan'), null, deps);
    assert.strictEqual(getGuildSettings('guild1').userModes.user1, 'both');
  });

  it('ignores non-boss messages', async () => {
    const { handlePrefixCommand } = require('../src/commands/prefix');
    const deps = makeDeps();
    await handlePrefixCommand(makeMessage('!hello world'), null, deps);
    assert.strictEqual(deps.calls.length, 0);
  });
});