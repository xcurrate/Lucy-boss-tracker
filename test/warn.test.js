const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { warnLabel } = require('../src/ui/panel');

function switchToTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-tracker-warn-'));
  process.chdir(dir);
  for (const key of Object.keys(require.cache)) {
    if (key.includes('utils' + path.sep + 'storage.js')) delete require.cache[key];
  }
  return dir;
}

describe('warnLabel', () => {
  it('formats labels', () => {
    assert.strictEqual(warnLabel(0), 'Tidak ada peringatan');
    assert.strictEqual(warnLabel(10), '10 detik sebelum boss');
    assert.strictEqual(warnLabel(60), '1 menit sebelum boss');
    assert.strictEqual(warnLabel(300), '5 menit sebelum boss');
  });
});

describe('warn scheduling', () => {
  it('schedules a warn DM before the boss spawn', () => {
    const tempDir = switchToTempDir();
    try {
      const { updateGuildSettings, setUserWarnSeconds } = require('../src/utils/storage');
      const { BossTracker } = require('../src/services/bossTracker');

      const guildId = 'warn-guild';
      const userId = 'warn-user';
      const bossTs = Math.floor(Date.now() / 1000) + 600;
      const client = {
        users: { fetch: async id => ({ send: async () => {} }) }
      };

      setUserWarnSeconds(guildId, userId, 60);
      updateGuildSettings(guildId, s => ({
        ...s,
        enabled: true,
        channelId: 'ch',
        roleId: 'role',
        lastBossTimestamp: bossTs,
        userModes: { ...s.userModes, [userId]: 'both' }
      }));

      const tracker = new BossTracker(client);
      try {
        tracker.scheduleGuild(guildId, bossTs);

        // A warn timer must be scheduled for (bossTs - 60s), ~540s from now.
        const key = guildId + ':' + userId + ':' + bossTs;
        assert.ok(tracker.warnTimers.has(key), 'warn timer should be scheduled');
        const timer = tracker.warnTimers.get(key);
        assert.ok(
          timer._idleTimeout >= 539000 && timer._idleTimeout <= 540500,
          'warn delay should be ~540s, got ' + timer._idleTimeout
        );
      } finally {
        tracker.stopGuild(guildId);
        for (const t of [...tracker.timers.values(), ...tracker.warnTimers.values()]) clearTimeout(t);
      }
      assert.strictEqual(tracker.warnTimers.size, 0, 'warn timers cleaned up on stop');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not schedule warn when user mode is channel', () => {
    const tempDir = switchToTempDir();
    try {
      const { updateGuildSettings, setUserWarnSeconds } = require('../src/utils/storage');
      const { BossTracker } = require('../src/services/bossTracker');

      const guildId = 'g2';
      const userId = 'u2';
      const bossTs = Math.floor(Date.now() / 1000) + 600;
      const client = { users: { fetch: async () => ({ send: async () => {} }) } };

      setUserWarnSeconds(guildId, userId, 60);
      updateGuildSettings(guildId, s => ({
        ...s, enabled: true, lastBossTimestamp: bossTs, userModes: { ...s.userModes, [userId]: 'channel' }
      }));

      const tracker = new BossTracker(client);
      try {
        tracker.scheduleGuild(guildId, bossTs);
        assert.strictEqual(tracker.warnTimers.size, 0);
      } finally {
        tracker.stopGuild(guildId);
        for (const t of [...tracker.timers.values(), ...tracker.warnTimers.values()]) clearTimeout(t);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});