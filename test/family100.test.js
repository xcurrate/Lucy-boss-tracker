const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

let tempDir;

function resetModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('family100')) delete require.cache[key];
  }
}

function makeMessage(content, { guildId = 'guild1', channelId = 'chan1', userId = 'user1', name = 'Tester', admin = false } = {}) {
  const sent = [];
  return {
    guildId,
    channelId,
    author: { id: userId, bot: false, username: name },
    member: { displayName: name, permissions: { has: () => admin } },
    content,
    client: { channels: { fetch: async () => ({ messages: { fetch: async () => ({ edit: async () => {} }) } }) } },
    react: async () => {},
    reply: async payload => { sent.push(payload); return { id: 'msg-reply' }; },
    channel: { send: async payload => { sent.push(payload); return { id: 'msg-send' }; } },
    sent
  };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-tracker-f100-'));
  process.chdir(tempDir);
  resetModules();
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('family 100 point scheme', () => {
  it('splits 100 points across answers, largest first, minimum 1', () => {
    const { pointsFor } = require('../src/services/family100Score');
    for (let n = 1; n <= 30; n++) {
      const points = pointsFor(n);
      assert.equal(points.length, n);
      assert.equal(points.reduce((a, b) => a + b, 0), 100, 'total harus 100 untuk ' + n + ' jawaban');
      assert.ok(points.every(p => p >= 1), 'setiap jawaban minimal 1 poin');
      for (let i = 1; i < points.length; i++) assert.ok(points[i] <= points[i - 1], 'urutan menurun');
    }
    assert.deepEqual(pointsFor(1), [100]);
    assert.deepEqual(pointsFor(2), [67, 33]);
    assert.deepEqual(pointsFor(4), [40, 30, 20, 10]);
  });
});

describe('family 100 answer matching', () => {
  it('normalizes case, punctuation, and leading stopwords', () => {
    const { matchAnswer } = require('../src/services/family100Match');
    const answers = [{ text: 'nasi goreng', key: 'nasi goreng' }, { text: 'sate ayam', key: 'sate ayam' }];
    assert.ok(matchAnswer('NASI GORENG!', answers));
    assert.ok(matchAnswer('yang nasi goreng', answers));
    assert.ok(matchAnswer('nasigoreng', answers));
    assert.ok(matchAnswer('sate ayam', answers));
    assert.equal(matchAnswer('bakso', answers), null);
  });

  it('tolerates a single typo on one-word answers only', () => {
    const { matchAnswer } = require('../src/services/family100Match');
    const answers = [{ text: 'angklung', key: 'angklung' }, { text: 'nasi goreng', key: 'nasi goreng' }];
    assert.ok(matchAnswer('angklug', answers), 'salah ketik 1 huruf harus diterima');
    assert.equal(matchAnswer('goreng', answers), null, 'potongan jawaban panjang tidak boleh cocok');
    assert.equal(matchAnswer('nasi gorengan', answers), null, 'jawaban multi-kata harus persis');
  });

  it('does not let one guess unlock two answers', () => {
    const { matchAnswer } = require('../src/services/family100Match');
    const answers = [{ text: 'merah', key: 'merah' }, { text: 'biru', key: 'biru' }];
    assert.equal(matchAnswer('merah', answers).text, 'merah');
    assert.equal(matchAnswer('biru', answers).text, 'biru');
  });
});

describe('family 100 round engine', () => {
  it('starts a round, awards points, and blocks a second active session', async () => {
    const svc = require('../src/services/family100');
    const scores = require('../src/utils/family100Storage');
    const { updateGuildSettings } = require('../src/utils/storage');
    updateGuildSettings('guild1', s => ({ ...s, prefix: '!' }));

    const start = makeMessage('!f100');
    assert.equal(await svc.handleMessage(start), true);
    const session = svc.sessions.get('guild1');
    assert.ok(session, 'sesi harus dibuat');
    assert.equal(session.channelId, 'chan1');
    assert.equal(session.ended, undefined);

    // Perintah kedua di guild yang sama harus ditolak dengan pesan jelas.
    const again = makeMessage('!f100', { channelId: 'chan2' });
    assert.equal(await svc.handleMessage(again), true);
    assert.match(again.sent[0], /Masih ada sesi Family 100 aktif di <#chan1>/);

    // Jawaban benar dari daftar tersembunyi harus dapat poin.
    const answer = session.question.answers[0].text;
    const guess = makeMessage(answer, { name: 'Budi' });
    assert.equal(await svc.handleMessage(guess), true);
    assert.ok(session.revealed.has(0), 'jawaban pertama harus terbuka');
    const day = svc.dayKey();
    const rows = scores.topByDay('guild1', day);
    assert.equal(rows[0].name, 'Budi');
    assert.equal(rows[0].points, session.points[0]);

    // Tebakan yang sama dua kali tidak menambah poin.
    const before = rows[0].points;
    await svc.handleMessage(makeMessage(answer, { name: 'Budi' }));
    assert.equal(scores.topByDay('guild1', day)[0].points, before);
  });

  it('ignores prefix commands and messages from other channels', async () => {
    const svc = require('../src/services/family100');
    const { updateGuildSettings } = require('../src/utils/storage');
    updateGuildSettings('guild1', s => ({ ...s, prefix: '!' }));
    await svc.handleMessage(makeMessage('!f100'));
    const session = svc.sessions.get('guild1');
    const answer = session.question.answers[0].text;

    assert.equal(await svc.handleMessage(makeMessage('!boss status')), false, 'perintah milik handler lain dilepas');
    assert.equal(session.revealed.size, 0, 'perintah tidak boleh membuka jawaban');
    assert.equal(await svc.handleMessage(makeMessage('!f100 status')), true, 'perintah f100 sendiri ditangani');
    assert.equal(session.revealed.size, 0);
    assert.equal(await svc.handleMessage(makeMessage(answer, { channelId: 'chan-lain' })), false, 'channel lain diabaikan');
    assert.equal(session.revealed.size, 0);
  });

  it('ends the round when every answer is revealed', async () => {
    const svc = require('../src/services/family100');
    const { updateGuildSettings } = require('../src/utils/storage');
    updateGuildSettings('guild1', s => ({ ...s, prefix: '!' }));
    await svc.handleMessage(makeMessage('!f100'));
    const session = svc.sessions.get('guild1');
    for (const a of session.question.answers) await svc.handleMessage(makeMessage(a.text));
    assert.equal(session.ended, true);
    assert.equal(session.endReason, 'semua jawaban terbuka');
    assert.equal(session.revealed.size, session.question.answers.length);
  });

  it('lets an admin stop the round and refuses non-admins', async () => {
    const svc = require('../src/services/family100');
    const { updateGuildSettings } = require('../src/utils/storage');
    updateGuildSettings('guild1', s => ({ ...s, prefix: '!' }));
    await svc.handleMessage(makeMessage('!f100'));

    const denied = makeMessage('!f100 stop', { admin: false, userId: 'user2', name: 'Lain' });
    assert.equal(await svc.handleMessage(denied), true);
    assert.match(denied.sent[0], /Hanya moderator\/admin/);
    assert.equal(svc.sessions.get('guild1').ended, undefined, 'ronde harus tetap berjalan');

    const ok = makeMessage('!f100 stop', { admin: true });
    assert.equal(await svc.handleMessage(ok), true);
    assert.equal(svc.sessions.has('guild1'), false, 'sesi dihapus setelah dihentikan');
  });

  it('builds weekly and all-time leaderboards', async () => {
    const svc = require('../src/services/family100');
    const scores = require('../src/utils/family100Storage');
    const day = svc.dayKey();
    scores.addPoints({ guildId: 'guild1', userId: 'a', name: 'Alice', points: 40, day });
    scores.addPoints({ guildId: 'guild1', userId: 'b', name: 'Bob', points: 25, day });
    const weekly = svc.leaderboardView('guild1', 'weekly', 1);
    assert.match(weekly.embed.data.description, /🥇 \*\*40\*\* poin — Alice/);
    assert.match(weekly.embed.data.footer.text, /Mingguan|/);
    const allTime = svc.leaderboardView('guild1', 'alltime', 1);
    assert.equal(allTime.embed.data.title, '🏆 Family 100 — All-Time');
  });

  it('computes a Monday-to-Sunday week range in WIB', () => {
    const svc = require('../src/services/family100');
    const range = svc.weekRange(new Date('2026-11-05T06:00:00Z'));
    assert.equal(range.from, '2026-11-02');
    assert.equal(range.to, '2026-11-08');
  });
});

describe('family 100 question bank', () => {
  it('loads a deduplicated bank with usable answers', () => {
    const bank = require('../src/data/family100Bank');
    assert.ok(bank.count() > 1000, 'bank harus berisi ribuan soal');
    const questions = bank.all();
    const keys = new Set();
    for (const q of questions) {
      assert.ok(q.soal.length > 0);
      assert.ok(q.answers.length > 0);
      const dedupKey = q.soal.toLowerCase().replace(/\s+/g, ' ').trim();
      assert.ok(!keys.has(dedupKey), 'soal tidak boleh duplikat: ' + q.soal);
      keys.add(dedupKey);
    }
  });
});
