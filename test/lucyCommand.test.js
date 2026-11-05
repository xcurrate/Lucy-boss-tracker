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
  return {
    guildId,
    channelId: 'chan1',
    author: { id: userId, bot: false, username: 'tester' },
    content,
    member: { displayName: 'tester', permissions: { has: () => admin } },
    createdTimestamp: Date.now(),
    client: {},
    reply: async payload => { replies.push(typeof payload === 'string' ? payload : payload.content); return { id: 'msg' }; },
    react: async () => {},
    replies
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
