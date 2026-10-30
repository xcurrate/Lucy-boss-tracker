const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

let tempDir;

function resetModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes(path.sep + 'storage.js') || key.includes(path.sep + 'panel.js') || key.includes('boss.js') || key.includes('prefix.js')) {
      delete require.cache[key];
    }
  }
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-tracker-access-'));
  process.chdir(tempDir);
  fs.mkdirSync(path.join(tempDir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'data', 'guild-settings.json'), JSON.stringify({ guild1: {} }));
  resetModules();
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('panel ownership guard', () => {
  const { getGuildSettings } = require('../src/utils/storage');
  const panel = require('../src/ui/panel');
  const { handleComponent } = require('../src/commands/boss');

  function makeInteraction(customId, userId) {
    const replies = [];
    const followUps = [];
    const updates = [];
    return {
      guildId: 'guild1',
      user: { id: userId },
      customId,
      isButton: () => customId.startsWith('boss_'),
      isStringSelectMenu: () => customId.startsWith('boss_') && customId.includes('_mode') || customId.includes('_select'),
      values: ['dm'],
      reply: async p => { replies.push(p); },
      followUp: async p => { followUps.push(p); },
      update: async p => { updates.push(p); },
      replies, followUps, updates
    };
  }

  it('mengabaikan interaksi milik user lain', async () => {
    const owner = 'userA';
    const roles = ['boss_dm_on', 'boss_dm_off', 'boss_warn_select', 'boss_notify_mode', 'boss_panel_status', 'boss_panel_help', 'boss_panel_admin_help', 'boss_panel_refresh'];
    for (const base of roles) {
      const i = makeInteraction(base + ':' + owner, 'userB');
      await handleComponent(i, null);
      assert.strictEqual(i.replies.length, 1, 'harus ditolak untuk ' + base);
      assert.match(i.replies[0].content, /hanya bisa digunakan oleh pemiliknya/);
      assert.strictEqual(i.updates.length, 0, 'tidak boleh mengupdate panel ' + base);
      assert.strictEqual(getGuildSettings('guild1').userModes?.userB, undefined, 'mode user lain tidak berubah');
      assert.strictEqual(getGuildSettings('guild1').userWarnSeconds?.userB, undefined, 'warn user lain tidak berubah');
    }
  });

  it('mengizinkan interaksi milik panel owner', async () => {
    const owner = 'userA';
    const i = makeInteraction('boss_dm_on:' + owner, owner);
    await handleComponent(i, null);
    assert.strictEqual(i.updates.length, 1);
    assert.strictEqual(getGuildSettings('guild1').userModes[owner], 'both');
  });

  it('menolak customId tak dikenal / tidak ter-scope', async () => {
    for (const customId of ['random', 'boss_dm_on', 'boss_dm_on:', ':userA', '']) {
      const i = makeInteraction(customId, 'userA');
      await handleComponent(i, null);
      assert.strictEqual(i.replies.length, 1, 'tidak dikenal: ' + JSON.stringify(customId));
      assert.match(i.replies[0].content, /kedaluwarsa|hanya bisa digunakan oleh pemiliknya/);
    }
  });

  it('komponen panel memakai customId ter-scope userId', async () => {
    const payload = panel.personalPanel(getGuildSettings('guild1'), 'userA', { includeFooter: true });
    const ids = payload.components.flatMap(r => r.components.map(c => c.data.custom_id));
    assert.ok(ids.length > 0);
    for (const id of ids) {
      const parsed = panel.parseCustomId(id);
      assert.strictEqual(parsed.ok, true, id);
      assert.strictEqual(parsed.userId, 'userA', id);
    }
  });
});