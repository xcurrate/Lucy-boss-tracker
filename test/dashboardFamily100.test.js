const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

let tempDir;
let server;
let baseUrl;
const TOKEN = 't'.repeat(32);

function resetModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('family100Storage.js') || key.includes(path.sep + 'dashboard' + path.sep + 'server.js')) delete require.cache[key];
  }
}

const guilds = new Map([
  ['guildA', { id: 'guildA', name: 'Guild A', channels: { cache: new Map() }, roles: { cache: new Map() } }],
  ['guildB', { id: 'guildB', name: 'Guild B', channels: { cache: new Map() }, roles: { cache: new Map() } }]
]);

function call(method, pathname, body, token = TOKEN) {
  return fetch(baseUrl + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

const baseSettings = () => ({
  enabled: false,
  channelId: '',
  roleId: '',
  prefix: '!',
  family100: { enabled: true, channelId: '', durationSeconds: 0 },
  lucyCounter: { enabled: false, targetEnabled: false, targetGoal: 0, targetMessage: '', targetChannelId: '', targetStartTime: '12:00', targetStopTime: '10:00', blacklistedChannelIds: [], whitelistedChannelIds: [] },
  autoThreadRep: { enabled: false, channelId: '', targetUserId: '1515658233174294569', amount: '50k', threadNamePrefix: 'Rep', autoArchiveDuration: 1440 }
});

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-tracker-dash-f100-'));
  process.chdir(tempDir);
  process.env.DASHBOARD_TOKEN = TOKEN;
  process.env.DASHBOARD_PORT = '0';
  resetModules();
  const { startDashboard } = require('../src/dashboard/server');
  server = startDashboard({ guilds: { cache: guilds } }, { stopGuild() {}, scheduleGuild() {} });
  await new Promise(resolve => (server.listening ? resolve() : server.once('listening', resolve)));
  baseUrl = 'http://127.0.0.1:' + server.address().port;
});

afterEach(async () => {
  await new Promise(resolve => server.close(resolve));
  delete process.env.DASHBOARD_TOKEN;
  delete process.env.DASHBOARD_PORT;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('dashboard family 100 settings', () => {
  it('exposes family100 defaults in public settings', async () => {
    const res = await call('GET', '/api/settings?guildId=guildA');
    assert.strictEqual(res.status, 200);
    const { settings } = await res.json();
    assert.strictEqual(settings.family100.enabled, true);
    assert.strictEqual(settings.family100.channelId, '');
    assert.strictEqual(settings.family100.durationSeconds, 0);
  });

  it('saves enabled, channel, and duration', async () => {
    const settings = baseSettings();
    settings.family100 = { enabled: false, channelId: '', durationSeconds: 300 };
    const saved = await call('PUT', '/api/settings', { guildId: 'guildA', settings });
    assert.strictEqual(saved.status, 200);

    const res = await call('GET', '/api/settings?guildId=guildA');
    const { settings: loaded } = await res.json();
    assert.strictEqual(loaded.family100.enabled, false);
    assert.strictEqual(loaded.family100.durationSeconds, 300);
  });

  it('rejects an out-of-range duration', async () => {
    const settings = baseSettings();
    settings.family100 = { enabled: true, channelId: '', durationSeconds: 999999 };
    const res = await call('PUT', '/api/settings', { guildId: 'guildA', settings });
    assert.strictEqual(res.status, 400);
    assert.match((await res.json()).error, /Durasi Family 100/);
  });

  it('rejects a malformed channel id', async () => {
    const settings = baseSettings();
    settings.family100 = { enabled: true, channelId: 'bukan-id', durationSeconds: 0 };
    const res = await call('PUT', '/api/settings', { guildId: 'guildA', settings });
    assert.strictEqual(res.status, 400);
    assert.match((await res.json()).error, /channel Family 100/);
  });
});

describe('dashboard family 100 leaderboard', () => {
  it('returns weekly and all-time rankings for the guild', async () => {
    const { dayKey, weekRange } = require('../src/services/family100');
    const scores = require('../src/utils/family100Storage');
    const { from } = weekRange();
    scores.addPoints({ guildId: 'guildA', userId: 'u1', name: 'Alice', points: 40, day: dayKey() });
    scores.addPoints({ guildId: 'guildA', userId: 'u2', name: 'Bob', points: 25, day: dayKey() });
    scores.addPoints({ guildId: 'guildA', userId: 'u3', name: 'Lama', points: 90, day: '2020-01-01' });
    scores.addPoints({ guildId: 'guildB', userId: 'u4', name: 'GuildB', points: 99, day: dayKey() });

    const weekly = await call('GET', '/api/family100/leaderboard?guildId=guildA&scope=weekly');
    assert.strictEqual(weekly.status, 200);
    const weeklyRows = (await weekly.json()).rows;
    assert.deepStrictEqual(weeklyRows.map(r => r.name), ['Alice', 'Bob']);
    assert.ok(weeklyRows.every(r => r.points > 0));

    const allTime = await call('GET', '/api/family100/leaderboard?guildId=guildA&scope=alltime');
    const allRows = (await allTime.json()).rows;
    assert.deepStrictEqual(allRows.map(r => r.name), ['Lama', 'Alice', 'Bob']);
    assert.ok(!allRows.some(r => r.name === 'GuildB'), 'guild lain tidak boleh ikut');
    assert.ok(from <= dayKey(), 'rentang minggu memuat hari ini');
  });

  it('requires the dashboard token', async () => {
    const res = await call('GET', '/api/family100/leaderboard?guildId=guildA', undefined, '');
    assert.strictEqual(res.status, 401);
  });
});
