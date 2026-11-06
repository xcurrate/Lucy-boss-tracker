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
    if (key.includes('noteStorage.js') || key.includes(path.sep + 'dashboard' + path.sep + 'server.js')) delete require.cache[key];
  }
}

const guilds = new Map([
  ['guildA', { id: 'guildA', name: 'Guild A' }],
  ['guildB', { id: 'guildB', name: 'Guild B' }]
]);

function call(method, pathname, body, token = TOKEN) {
  return fetch(baseUrl + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-tracker-dash-notes-'));
  process.chdir(tempDir);
  process.env.DASHBOARD_TOKEN = TOKEN;
  process.env.DASHBOARD_PORT = '0';
  resetModules();
  const { startDashboard } = require('../src/dashboard/server');
  server = startDashboard({ guilds: { cache: guilds } }, {});
  await new Promise(resolve => (server.listening ? resolve() : server.once('listening', resolve)));
  baseUrl = 'http://127.0.0.1:' + server.address().port;
});

afterEach(async () => {
  await new Promise(resolve => server.close(resolve));
  delete process.env.DASHBOARD_TOKEN;
  delete process.env.DASHBOARD_PORT;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('dashboard notes API', () => {
  it('creates, lists, updates, and deletes notes for a guild', async () => {
    const created = await call('POST', '/api/notes', { guildId: 'guildA', title: 'Jadwal', body: 'Boss jam 8' });
    assert.strictEqual(created.status, 200);
    const { note } = await created.json();
    assert.strictEqual(note.title, 'Jadwal');

    const list = await call('GET', '/api/notes?guildId=guildA');
    assert.strictEqual(list.status, 200);
    assert.strictEqual((await list.json()).notes.length, 1);

    const updated = await call('PUT', '/api/notes', { guildId: 'guildA', id: note.id, title: 'Jadwal baru', body: 'Boss jam 9' });
    assert.strictEqual(updated.status, 200);
    assert.strictEqual((await updated.json()).note.title, 'Jadwal baru');

    const removed = await call('DELETE', '/api/notes', { guildId: 'guildA', id: note.id });
    assert.strictEqual(removed.status, 200);
    const after = await call('GET', '/api/notes?guildId=guildA');
    assert.strictEqual((await after.json()).notes.length, 0);
  });

  it('scopes notes per guild', async () => {
    await call('POST', '/api/notes', { guildId: 'guildA', title: 'A', body: 'milik A' });
    const other = await call('GET', '/api/notes?guildId=guildB');
    assert.deepStrictEqual((await other.json()).notes, []);
  });

  it('requires a valid token and validates input', async () => {
    const unauthorized = await call('GET', '/api/notes?guildId=guildA', undefined, '');
    assert.strictEqual(unauthorized.status, 401);

    const empty = await call('POST', '/api/notes', { guildId: 'guildA', title: '', body: '' });
    assert.strictEqual(empty.status, 400);
    assert.match((await empty.json()).error, /wajib diisi/);

    const missingId = await call('DELETE', '/api/notes', { guildId: 'guildA' });
    assert.strictEqual(missingId.status, 400);

    const unknownGuild = await call('GET', '/api/notes?guildId=tidak-ada');
    assert.strictEqual(unknownGuild.status, 404);
  });
});
