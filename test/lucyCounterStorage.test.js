const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

let tempDir;

function resetModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('lucyCounterStorage.js') || key.includes('lucyCounter.js')) delete require.cache[key];
  }
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-tracker-lucystore-'));
  process.chdir(tempDir);
  resetModules();
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('lucy counter SQLite storage', () => {
  it('migrates existing lucy-counter.json data into SQLite on first open', () => {
    fs.mkdirSync(path.join(tempDir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'data', 'lucy-counter.json'), JSON.stringify({
      guild1: {
        users: {
          user1: { name: 'Alice', days: { '2026-11-04': 3, '2026-11-05': 2 }, challengeDayKey: '2026-11-05', challengeCount: 2, challengeNotified: false, lastLucyAcceptedAt: 1000 },
          user2: { name: 'Bob', days: { '2026-11-04': 5 }, challengeDayKey: '2026-11-04', challengeCount: 5, challengeNotified: true }
        }
      }
    }));

    const store = require('../src/utils/lucyCounterStorage');
    const guild = store.getGuildData('guild1');
    assert.strictEqual(Object.keys(guild.users).length, 2);
    assert.deepStrictEqual(guild.users.user1.days, { '2026-11-04': 3, '2026-11-05': 2 });
    assert.strictEqual(guild.users.user1.challengeCount, 2);
    assert.strictEqual(guild.users.user1.challengeDayKey, '2026-11-05');
    assert.strictEqual(guild.users.user1.lastLucyAcceptedAt, 1000);
    assert.strictEqual(guild.users.user2.challengeNotified, true);

    const all = store.getAllData();
    assert.strictEqual(all.guild1.users.user1.name, 'Alice');
  });

  it('does not re-import legacy JSON over newer SQLite data', () => {
    fs.mkdirSync(path.join(tempDir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'data', 'lucy-counter.json'), JSON.stringify({
      guild1: { users: { user1: { name: 'Old', days: { '2026-11-04': 1 } } } }
    }));

    let store = require('../src/utils/lucyCounterStorage');
    store.recordLucy({ guildId: 'guild1', userId: 'user1', name: 'New', day: '2026-11-04', cycleKey: '2026-11-04', targetActive: false, goal: 0 });

    // Simulate restart: drop cached handle, keep the same DB file.
    resetModules();
    store = require('../src/utils/lucyCounterStorage');
    assert.strictEqual(store.getGuildData('guild1').users.user1.days['2026-11-04'], 2);
  });

  it('records accepted Lucy messages and tracks target progress atomically', () => {
    const store = require('../src/utils/lucyCounterStorage');
    store.markAccepted('g1', 'u1', 'Alice', 5000);
    assert.strictEqual(store.getLastAcceptedAt('g1', 'u1'), 5000);

    const first = store.recordLucy({ guildId: 'g1', userId: 'u1', name: 'Alice', day: '2026-11-05', cycleKey: '2026-11-05', targetActive: true, goal: 2 });
    assert.deepStrictEqual(first, { challengeCount: 1, notifiedNow: false });
    const second = store.recordLucy({ guildId: 'g1', userId: 'u1', name: 'Alice', day: '2026-11-05', cycleKey: '2026-11-05', targetActive: true, goal: 2 });
    assert.deepStrictEqual(second, { challengeCount: 2, notifiedNow: true });
    // Notification fires only once per cycle.
    const third = store.recordLucy({ guildId: 'g1', userId: 'u1', name: 'Alice', day: '2026-11-05', cycleKey: '2026-11-05', targetActive: true, goal: 2 });
    assert.deepStrictEqual(third, { challengeCount: 3, notifiedNow: false });

    assert.strictEqual(store.getGuildData('g1').users.u1.days['2026-11-05'], 3);
  });

  it('resets target progress when the cycle changes', () => {
    const store = require('../src/utils/lucyCounterStorage');
    store.recordLucy({ guildId: 'g1', userId: 'u1', name: 'Alice', day: '2026-11-05', cycleKey: '2026-11-05', targetActive: true, goal: 5 });
    const next = store.recordLucy({ guildId: 'g1', userId: 'u1', name: 'Alice', day: '2026-11-06', cycleKey: '2026-11-06', targetActive: true, goal: 5 });
    assert.strictEqual(next.challengeCount, 1);
    assert.strictEqual(next.notifiedNow, false);
  });
});
