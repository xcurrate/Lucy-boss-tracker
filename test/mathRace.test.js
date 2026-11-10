const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

let tempDir;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-tracker-math-'));
  process.chdir(tempDir);
  for (const key of Object.keys(require.cache)) {
    if (key.includes('mathRace') || key.includes('mathEngine') || key.includes('mathStorage') || key.includes('storage.js')) {
      delete require.cache[key];
    }
  }
});

let counter = 0;

function makeMessage(content, { guildId = 'guild1', channelId = 'chan1', userId = 'user1', name = 'Tester', admin = false, dev = false, guildOwner = false } = {}) {
  const sent = [];
  const replies = [];
  const reactions = [];
  const nextId = () => 'm' + (++counter);
  const channel = {
    id: channelId,
    send: async payload => { sent.push(payload); return { id: nextId() }; },
    messages: { fetch: async id => ({ id, delete: async () => {} }) }
  };
  return {
    guildId,
    guild: { id: guildId, ownerId: guildOwner ? userId : 'someone-else' },
    channelId,
    author: { id: userId, bot: false, username: name },
    member: { displayName: name, permissions: { has: () => admin } },
    content,
    client: {
      application: { owner: dev ? { id: userId } : null },
      channels: { fetch: async () => channel }
    },
    react: async emoji => { reactions.push(emoji); },
    reply: async payload => { sent.push(payload); replies.push(payload); return { id: nextId(), delete: async () => {} }; },
    channel,
    sent,
    replies,
    reactions
  };
}

describe('math engine', () => {
  it('generates integer-answer questions for every level', () => {
    const engine = require('../src/services/mathEngine');
    for (let level = 1; level <= engine.MAX_LEVEL; level++) {
      for (let i = 0; i < 50; i++) {
        const q = engine.makeQuestion(level);
        assert.equal(q.level, level);
        assert.ok(q.text.length > 0);
        assert.ok(Number.isInteger(q.answer), `jawaban harus bulat: ${q.text} = ${q.answer}`);
      }
    }
  });

  it('clamps out-of-range levels', () => {
    const engine = require('../src/services/mathEngine');
    assert.equal(engine.makeQuestion(0).level, 1);
    assert.equal(engine.makeQuestion(99).level, engine.MAX_LEVEL);
  });

  it('grades answers exactly, not fuzzily like Family 100', () => {
    const engine = require('../src/services/mathEngine');
    assert.equal(engine.isCorrect('8', 8), true);
    assert.equal(engine.isCorrect(' 8 ', 8), true);
    assert.equal(engine.isCorrect('3', 8), false, '3 tidak boleh dianggap 8');
    assert.equal(engine.isCorrect('18', 8), false);
    assert.equal(engine.isCorrect('8,0', 8), true);
    assert.equal(engine.isCorrect('8.0', 8), true);
    assert.equal(engine.isCorrect('bukan angka', 8), false);
    assert.equal(engine.isCorrect('', 8), false);
  });

  it('accepts fractions and rejects code-like input', () => {
    const engine = require('../src/services/mathEngine');
    assert.equal(engine.isCorrect('1/2', 0.5), true);
    assert.equal(engine.isCorrect('4/2', 2), true);
    assert.equal(engine.isCorrect('1/0', 0), false);
    assert.equal(engine.isCorrect('process.exit(1)', 0), false);
    assert.equal(engine.isCorrect('8; rm -rf /', 8), false);
  });

  it('evaluates expressions without eval()', () => {
    const engine = require('../src/services/mathEngine');
    assert.equal(engine.evaluate('2+3*4'), 14);
    assert.equal(engine.evaluate('(2+3)*4'), 20);
    assert.equal(engine.evaluate('12÷3'), 4);
    assert.equal(engine.evaluate('10−4'), 6);
    assert.equal(engine.evaluate('2+'), null);
    assert.equal(engine.evaluate('2+*3'), null);
    assert.equal(engine.evaluate('globalThis'), null);
    assert.equal(engine.evaluate(''), null);
  });

  it('gives harder questions more base points', () => {
    const engine = require('../src/services/mathEngine');
    assert.ok(engine.basePoints(5) > engine.basePoints(1));
  });
});

describe('math race game', () => {
  it('starts a round, accepts the right answer, and advances', async () => {
    const svc = require('../src/services/mathRace');
    svc.setNextDelay(0);
    const start = makeMessage('d math 3');
    assert.equal(await svc.handleMessage(start), true);
    const session = svc.sessions.get('guild1');
    assert.ok(session, 'sesi dibuat');
    assert.equal(session.round, 1);
    assert.equal(session.totalRounds, 3);
    assert.ok(start.sent.at(-1).embeds[0].data.description.includes(session.question.text));

    const answer = makeMessage(String(session.question.answer), { userId: 'user2', name: 'Budi' });
    assert.equal(await svc.handleMessage(answer), true);
    assert.ok(answer.reactions.includes('✅'));
    assert.equal(svc.sessions.get('guild1').round, 2, 'lanjut ke soal berikutnya');
    const scored = svc.sessions.get('guild1').players.get('user2');
    assert.equal(scored.correct, 1);
    assert.ok(scored.points > 0);
  });

  it('rejects a wrong answer without ending the question', async () => {
    const svc = require('../src/services/mathRace');
    svc.setNextDelay(0);
    await svc.handleMessage(makeMessage('d math 3'));
    const session = svc.sessions.get('guild1');
    const wrong = makeMessage(String(session.question.answer + 1), { userId: 'user2', name: 'Budi' });
    assert.equal(await svc.handleMessage(wrong), true);
    assert.ok(wrong.reactions.includes('❌'));
    assert.equal(svc.sessions.get('guild1').round, 1, 'soal tidak berganti');
    assert.equal(svc.sessions.get('guild1').players.size, 0, 'tidak ada poin untuk jawaban salah');
  });

  it('records points in the leaderboard', async () => {
    const svc = require('../src/services/mathRace');
    svc.setNextDelay(0);
    const scores = require('../src/utils/mathStorage');
    await svc.handleMessage(makeMessage('d math 1'));
    const session = svc.sessions.get('guild1');
    await svc.handleMessage(makeMessage(String(session.question.answer), { userId: 'user2', name: 'Budi' }));
    const day = svc.dayKey();
    const rows = scores.topByDay('guild1', day);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].userId, 'user2');
    assert.ok(rows[0].points > 0);
  });

  it('ignores chat that is not a number', async () => {
    const svc = require('../src/services/mathRace');
    svc.setNextDelay(0);
    await svc.handleMessage(makeMessage('d math 3'));
    const chat = makeMessage('halo semua', { userId: 'user2' });
    assert.equal(await svc.handleMessage(chat), false);
    assert.equal(svc.sessions.get('guild1').round, 1);
  });

  it('refuses to start a second round in the same guild', async () => {
    const svc = require('../src/services/mathRace');
    svc.setNextDelay(0);
    await svc.handleMessage(makeMessage('d math 3'));
    const again = makeMessage('d math 3');
    assert.equal(await svc.handleMessage(again), true);
    assert.match(again.sent.at(-1), /Masih ada ronde/);
  });

  it('lets a moderator stop the round', async () => {
    const svc = require('../src/services/mathRace');
    svc.setNextDelay(0);
    await svc.handleMessage(makeMessage('d math 3'));
    const denied = makeMessage('d math stop', { admin: false, userId: 'user9' });
    assert.equal(await svc.handleMessage(denied), true);
    assert.match(denied.sent.at(-1), /Hanya moderator/);
    assert.ok(svc.sessions.has('guild1'));
    const ok = makeMessage('d math stop', { admin: true });
    assert.equal(await svc.handleMessage(ok), true);
    assert.equal(svc.sessions.has('guild1'), false);
  });

  it('scales points down as the answer takes longer', async () => {
    const svc = require('../src/services/mathRace');
    const session = {
      askedAt: 0,
      deadline: 30000,
      question: { level: 3, answer: 10 }
    };
    const instant = svc.pointsForAnswer(session, 0);
    const slow = svc.pointsForAnswer(session, 29000);
    assert.ok(instant > slow, 'jawaban cepat harus lebih besar');
    assert.ok(slow >= require('../src/services/mathEngine').basePoints(3), 'poin dasar tetap diberikan');
  });

  it('builds a paged leaderboard embed', async () => {
    const svc = require('../src/services/mathRace');
    const scores = require('../src/utils/mathStorage');
    const day = svc.dayKey();
    scores.addPoints({ guildId: 'guild1', userId: 'a', name: 'Alice', points: 60, ms: 1200, day });
    scores.addPoints({ guildId: 'guild1', userId: 'b', name: 'Bob', points: 30, ms: 4000, day });
    const view = svc.leaderboardView('guild1', 'weekly', 1);
    assert.match(view.embed.data.description, /🥇 \*\*60\*\* poin — Alice \(tercepat 1\.2s\)/);
    assert.match(view.embed.data.footer.text, /Mingguan|/);
    const allTime = svc.leaderboardView('guild1', 'alltime', 1);
    assert.equal(allTime.embed.data.title, '🏆 Cepat Tepat — All-Time');
  });

  it('is case-insensitive on the command prefix like the rest of the bot', async () => {
    const svc = require('../src/services/mathRace');
    svc.setNextDelay(0);
    assert.equal(await svc.handleMessage(makeMessage('D MATH 2')), true);
    assert.ok(svc.sessions.has('guild1'));
  });
});
