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
    await handlePrefixCommand(makeMessage('dboss notif dm'), null, deps);
    assert.strictEqual(getGuildSettings('guild1').userModes.user1, 'dm');
    assert.match(deps.calls[0].content, /DM pribadi/);
  });

  it('handles warn alias with seconds', async () => {
    const { handlePrefixCommand } = require('../src/commands/prefix');
    const { getGuildSettings } = require('../src/utils/storage');
    const deps = makeDeps();
    await handlePrefixCommand(makeMessage('dboss peringatan 300'), null, deps);
    assert.strictEqual(getGuildSettings('guild1').userWarnSeconds.user1, 300);
    assert.match(deps.calls[0].content, /5 menit/);
  });

  it('handles status alias and returns status text', async () => {
    const { handlePrefixCommand } = require('../src/commands/prefix');
    const deps = makeDeps();
    await handlePrefixCommand(makeMessage('dboss cek'), null, deps);
    assert.match(deps.calls[0].content, /Boss Tracker|Lucy|notifikasi/i);
  });

  it('handles menu alias with v2 components', async () => {
    const { handlePrefixCommand } = require('../src/commands/prefix');
    const deps = makeDeps();
    await handlePrefixCommand(makeMessage('dboss menu'), null, deps);
    const payload = deps.calls[0];
    assert.ok(payload.components.length > 0, 'should include component rows');
    const ids = payload.components.flatMap(r => r.components.map(c => c.data.custom_id));
    assert.ok(ids.some(id => id.startsWith('boss_notify_mode:')));
    assert.ok(ids.some(id => id.startsWith('boss_warn_select:')));
  });

  it('rejects non-admin for setup alias', async () => {
    const { handlePrefixCommand } = require('../src/commands/prefix');
    const deps = makeDeps();
    await handlePrefixCommand(makeMessage('dboss set #general @boss'), null, deps);
    assert.match(deps.calls[0].content, /moderator\/admin/);
  });

  it('rejects non-admin for server-on alias', async () => {
    const { handlePrefixCommand } = require('../src/commands/prefix');
    const deps = makeDeps();
    await handlePrefixCommand(makeMessage('dboss aktif'), null, deps);
    assert.match(deps.calls[0].content, /moderator\/admin/);
  });

  it('handles dm on alias', async () => {
    const { handlePrefixCommand } = require('../src/commands/prefix');
    const { getGuildSettings } = require('../src/utils/storage');
    const deps = makeDeps();
    await handlePrefixCommand(makeMessage('dboss nyalakan'), null, deps);
    assert.strictEqual(getGuildSettings('guild1').userModes.user1, 'both');
  });

  it('ignores non-boss messages', async () => {
    const { handlePrefixCommand } = require('../src/commands/prefix');
    const deps = makeDeps();
    await handlePrefixCommand(makeMessage('hello world'), null, deps);
    assert.strictEqual(deps.calls.length, 0);
  });

  it('responds to ping with latency info', async () => {
    const { handlePrefixCommand } = require('../src/commands/prefix');
    const deps = makeDeps();
    await handlePrefixCommand(makeMessage('dping'), null, deps);
    assert.strictEqual(deps.calls.length, 1);
    assert.match(deps.calls[0].content, /Pong/);
    assert.match(deps.calls[0].content, /Roundtrip/);
  });

  it('responds to the ping short alias', async () => {
    const { handlePrefixCommand } = require('../src/commands/prefix');
    const deps = makeDeps();
    await handlePrefixCommand(makeMessage('dp'), null, deps);
    assert.match(deps.calls[0].content, /Pong/);
  });

  it('shows the admin section (including prefix command) to admins', async () => {
    const { handlePrefixCommand } = require('../src/commands/prefix');
    const deps = makeDeps();
    await handlePrefixCommand(makeMessage('dboss help', 'guild1', 'user1', true), null, deps);
    const names = deps.calls[0].embeds[0].data.fields.map(f => f.name);
    assert.ok(names.some(n => n.startsWith('⚙️')), 'bagian admin harus tampil untuk moderator');
    const text = deps.calls[0].embeds[0].data.fields.map(f => f.value).join('\n');
    assert.match(text, /boss prefix/);
  });

  it('hides the admin section from regular members', async () => {
    const { handlePrefixCommand } = require('../src/commands/prefix');
    const deps = makeDeps();
    await handlePrefixCommand(makeMessage('dboss help', 'guild1', 'user1', false), null, deps);
    const names = deps.calls[0].embeds[0].data.fields.map(f => f.name);
    assert.ok(!names.some(n => n.startsWith('⚙️')), 'bagian admin tidak boleh tampil untuk anggota biasa');
  });

  it('uses the new default prefix "d" out of the box', async () => {
    const { handlePrefixCommand } = require('../src/commands/prefix');
    const { getGuildSettings } = require('../src/utils/storage');
    assert.strictEqual(getGuildSettings('guild1').prefix, 'd');
    const deps = makeDeps();
    await handlePrefixCommand(makeMessage('dboss status'), null, deps);
    assert.strictEqual(deps.calls.length, 1, 'prefix bawaan d harus dikenali');
  });

  it('lets a guild override the default prefix, and the old one stops working', async () => {
    const { handlePrefixCommand } = require('../src/commands/prefix');
    const { getGuildSettings } = require('../src/utils/storage');
    const deps = makeDeps();
    await handlePrefixCommand(makeMessage('dboss prefix dragneel', 'guild1', 'user1', true), null, deps);
    assert.strictEqual(getGuildSettings('guild1').prefix, 'dragneel');

    const after = makeDeps();
    await handlePrefixCommand(makeMessage('dragneelboss status', 'guild1', 'user1'), null, after);
    assert.strictEqual(after.calls.length, 1, 'prefix baru harus dikenali');

    const old = makeDeps();
    await handlePrefixCommand(makeMessage('dboss status', 'guild1', 'user1'), null, old);
    assert.strictEqual(old.calls.length, 0, 'prefix lama tidak boleh lagi memicu perintah');
  });
});