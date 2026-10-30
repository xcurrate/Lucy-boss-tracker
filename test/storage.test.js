const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

let tempDir;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-tracker-test-'));
  process.chdir(tempDir);
  for (const key of Object.keys(require.cache)) {
    if (key.includes('utils' + path.sep + 'storage.js')) delete require.cache[key];
  }
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('storage', () => {
  it('returns defaults for a fresh guild', () => {
    const { getGuildSettings } = require('../src/utils/storage');
    const s = getGuildSettings('guild1');
    assert.strictEqual(s.enabled, false);
    assert.strictEqual(s.prefix, '!');
    assert.deepStrictEqual(s.dmUsers, []);
    assert.deepStrictEqual(s.userModes, {});
    assert.deepStrictEqual(s.userWarnSeconds, {});
  });

  it('persists user mode and warn seconds', () => {
    const { getGuildSettings, setUserMode, setUserWarnSeconds } = require('../src/utils/storage');
    setUserMode('guild1', 'user1', 'both');
    setUserWarnSeconds('guild1', 'user1', 60);
    const s = getGuildSettings('guild1');
    assert.strictEqual(s.userModes.user1, 'both');
    assert.ok(s.dmUsers.includes('user1'));
    assert.strictEqual(s.userWarnSeconds.user1, 60);
  });

  it('removes user from dmUsers when switching to channel', () => {
    const { getGuildSettings, setUserMode } = require('../src/utils/storage');
    setUserMode('guild1', 'user1', 'both');
    setUserMode('guild1', 'user1', 'channel');
    const s = getGuildSettings('guild1');
    assert.strictEqual(s.userModes.user1, 'channel');
    assert.ok(!s.dmUsers.includes('user1'));
  });

  it('exposes getUserSettings helper', () => {
    const { setUserMode, setUserWarnSeconds, getUserSettings } = require('../src/utils/storage');
    setUserMode('guild1', 'user1', 'both');
    setUserWarnSeconds('guild1', 'user1', 120);
    const u = getUserSettings('guild1', 'user1');
    assert.strictEqual(u.mode, 'both');
    assert.strictEqual(u.dmEnabled, true);
    assert.strictEqual(u.warnSeconds, 120);
  });
});