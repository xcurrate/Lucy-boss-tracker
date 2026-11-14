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

let messageCounter = 0;

// Soal acak membuat test rapuh (jumlah jawaban bervariasi). Pakai soal tetap.
function fixQuestion(svc, guildId, minAnswers = 5) {
  const bank = require('../src/data/family100Bank');
  const question = bank.all().find(q => q.answers.length >= minAnswers);
  const session = svc.sessions.get(guildId);
  session.question = question;
  session.points = svc.pointsFor(question.answers.length);
  return session;
}

function makeMessage(content, { guildId = 'guild1', channelId = 'chan1', userId = 'user1', name = 'Tester', admin = false, dev = false, guildOwner = false } = {}) {
  const sent = [];
  const boards = [];
  const deleted = [];
  const replied = [];
  const nextId = () => 'm' + (++messageCounter);
  return {
    guildId,
    guild: { id: guildId, ownerId: guildOwner ? userId : 'someone-else' },
    channelId,
    author: { id: userId, bot: false, username: name },
    member: { displayName: name, permissions: { has: () => admin } },
    content,
    client: {
      application: { owner: dev ? { id: userId } : null },
      channels: {
        fetch: async () => ({
          messages: { fetch: async id => ({ id, delete: async () => deleted.push(id) }) },
          send: async payload => { sent.push(payload); boards.push(payload); return { id: nextId() }; }
        })
      }
    },
    react: async () => {},
    reply: async payload => {
      sent.push(payload);
      boards.push(payload);
      const obj = { id: nextId(), deleted: false, delete: async () => { obj.deleted = true; } };
      replied.push(obj);
      return obj;
    },
    channel: { send: async payload => { sent.push(payload); boards.push(payload); return { id: nextId() }; } },
    sent,
    boards,
    deleted,
    replied
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

  it('still counts answers that begin with the prefix letter as guesses', async () => {
    const svc = require('../src/services/family100');
    const { updateGuildSettings } = require('../src/utils/storage');
    updateGuildSettings('guild1', s => ({ ...s, prefix: 'd' }));
    await svc.handleMessage(makeMessage('d f100'));
    const session = svc.sessions.get('guild1');
    session.question = { text: 'Hewan', answers: [{ text: 'domba', key: 'domba' }, { text: 'sapi', key: 'sapi' }] };
    session.points = svc.pointsFor(2);

    // "domba" berawalan prefix "d" tetapi bukan perintah — harus tetap dihitung.
    assert.equal(await svc.handleMessage(makeMessage('domba')), true, 'jawaban berawalan prefix tetap tebakan');
    assert.equal(session.revealed.size, 1);
  });

  it('accepts uppercase family 100 commands and prefix', async () => {
    const svc = require('../src/services/family100');
    const { updateGuildSettings } = require('../src/utils/storage');
    updateGuildSettings('guild1', s => ({ ...s, prefix: 'd' }));
    assert.equal(await svc.handleMessage(makeMessage('D F100')), true, 'perintah f100 huruf besar diterima');
    assert.ok(svc.sessions.get('guild1'), 'ronde dimulai');
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

  it('reposts the board on a correct answer and removes the old one', async () => {
    const svc = require('../src/services/family100');
    const { updateGuildSettings } = require('../src/utils/storage');
    updateGuildSettings('guild1', s => ({ ...s, prefix: '!' }));
    await svc.handleMessage(makeMessage('!f100'));
    const session = svc.sessions.get('guild1');
    const firstBoardId = session.messageId;
    assert.ok(firstBoardId, 'papan awal harus terkirim');

    const guess = makeMessage(session.question.answers[0].text, { name: 'Budi' });
    assert.equal(await svc.handleMessage(guess), true);

    assert.notEqual(session.messageId, firstBoardId, 'papan harus dikirim sebagai pesan baru');
    assert.ok(guess.deleted.includes(firstBoardId), 'papan lama harus dihapus');
    const embed = guess.boards.at(-1).embeds[0].data;
    assert.match(embed.description, /✅ 01\. \*\*.+?\*\* — \d+ poin \(Budi\)/, 'papan baru memuat jawaban benar');
    assert.equal(embed.footer.text.split(' ')[0], '1/' + session.question.answers.length);
  });

  it('keeps exactly one board when two correct answers arrive at once', async () => {
    const svc = require('../src/services/family100');
    const { updateGuildSettings } = require('../src/utils/storage');
    updateGuildSettings('guild1', s => ({ ...s, prefix: '!' }));
    await svc.handleMessage(makeMessage('!f100'));
    const session = fixQuestion(svc, 'guild1', 3);
    const firstBoardId = session.messageId;

    const [a, b] = [session.question.answers[0].text, session.question.answers[1].text];
    const m1 = makeMessage(a, { userId: 'u1', name: 'Budi' });
    const m2 = makeMessage(b, { userId: 'u2', name: 'Sari' });
    await Promise.all([svc.handleMessage(m1), svc.handleMessage(m2)]);

    const deleted = [...m1.deleted, ...m2.deleted];
    assert.equal(session.revealed.size, 2, 'kedua jawaban terbuka');
    assert.ok(deleted.includes(firstBoardId), 'papan awal dihapus');
    assert.equal(deleted.length, 2, 'hanya papan sebelumnya yang dihapus');
    assert.ok(!deleted.includes(session.messageId), 'papan terbaru tidak boleh ikut terhapus');
  });

  it('lets anyone skip, and reposts the current question on a repeat !f100', async () => {
    const svc = require('../src/services/family100');
    const { updateGuildSettings } = require('../src/utils/storage');
    updateGuildSettings('guild1', s => ({ ...s, prefix: '!' }));
    await svc.handleMessage(makeMessage('!f100'));
    const session = svc.sessions.get('guild1');
    const firstQuestion = session.question.id;
    const firstBoardId = session.messageId;

    // `!f100` di channel yang sama = tampilkan ulang soal, bukan ronde baru.
    const repeat = makeMessage('!f100', { userId: 'user9', name: 'Warga' });
    assert.equal(await svc.handleMessage(repeat), true);
    assert.equal(svc.sessions.get('guild1').question.id, firstQuestion, 'soal tidak boleh berganti');
    assert.ok(repeat.deleted.includes(firstBoardId), 'papan lama dihapus saat tampilkan ulang');
    assert.match(repeat.boards.at(-1).embeds[0].data.title, /FAMILY 100/, 'papan soal dikirim ulang');

    // Skip oleh pengguna biasa (bukan admin) harus jalan.
    const skip = makeMessage('!f100 skip', { userId: 'user9', name: 'Warga', admin: false });
    assert.equal(await svc.handleMessage(skip), true);
    const next = svc.sessions.get('guild1');
    assert.ok(next, 'ronde berikutnya tetap jalan');
    assert.notEqual(next.question.id, firstQuestion, 'soal berganti setelah skip');
  });

  it('lets a developer stop the round without server admin permission', async () => {
    const svc = require('../src/services/family100');
    const { updateGuildSettings } = require('../src/utils/storage');
    updateGuildSettings('guild1', s => ({ ...s, prefix: '!' }));
    await svc.handleMessage(makeMessage('!f100'));

    const dev = makeMessage('!f100 stop', { userId: 'dev1', admin: false, dev: true });
    assert.equal(await svc.handleMessage(dev), true);
    assert.equal(svc.sessions.has('guild1'), false, 'developer boleh menghentikan ronde');

    await svc.handleMessage(makeMessage('!f100'));
    const owner = makeMessage('!f100 stop', { userId: 'owner1', admin: false, guildOwner: true });
    assert.equal(await svc.handleMessage(owner), true);
    assert.equal(svc.sessions.has('guild1'), false, 'pemilik server boleh menghentikan ronde');
  });

  it('reveals every answer to a developer, then deletes the message after 2 seconds', async () => {
    const svc = require('../src/services/family100');
    const { updateGuildSettings } = require('../src/utils/storage');
    updateGuildSettings('guild1', s => ({ ...s, prefix: '!' }));
    await svc.handleMessage(makeMessage('!f100'));
    const session = svc.sessions.get('guild1');
    const boardId = session.messageId;

    const dev = makeMessage('!f100 reveal', { userId: 'dev1', admin: false, dev: true });
    assert.equal(await svc.handleMessage(dev), true, 'developer boleh memakai skill reveal');
    const embed = dev.boards.at(-1).embeds[0].data;
    assert.match(embed.title, /Developer/, 'judul menandai ini alat developer');
    for (const answer of session.question.answers) {
      assert.ok(embed.description.includes(answer.text), 'jawaban "' + answer.text + '" harus terlihat');
    }

    // Skill ini tidak boleh mengubah state ronde maupun papan.
    assert.equal(session.revealed.size, 0, 'reveal tidak membuka jawaban secara permanen');
    assert.equal(session.messageId, boardId, 'papan ronde tidak disentuh');
    assert.equal(dev.deleted.length, 0, 'papan lama tidak dihapus');

    const revealed = dev.replied.at(-1);
    assert.equal(revealed.deleted, false, 'pesan masih ada sebelum 2 detik');
    await new Promise(resolve => setTimeout(resolve, svc.REVEAL_MS + 200));
    assert.equal(revealed.deleted, true, 'pesan jawaban dihapus otomatis setelah 2 detik');
  });

  it('refuses the reveal skill for non-developers without leaking answers', async () => {
    const svc = require('../src/services/family100');
    const { updateGuildSettings } = require('../src/utils/storage');
    updateGuildSettings('guild1', s => ({ ...s, prefix: '!' }));
    await svc.handleMessage(makeMessage('!f100'));
    const session = svc.sessions.get('guild1');

    const warga = makeMessage('!f100 reveal', { userId: 'user9', name: 'Warga', admin: false });
    assert.equal(await svc.handleMessage(warga), true, 'pesan tetap ditangani');
    assert.equal(warga.boards.filter(p => p.embeds).length, 0, 'tidak ada embed jawaban yang dikirim');
    assert.match(warga.sent.at(-1), /khusus developer bot/);
    assert.equal(session.revealed.size, 0);
  });

  it('reports when the reveal skill has no active round', async () => {
    const svc = require('../src/services/family100');
    const dev = makeMessage('!f100 reveal', { userId: 'dev1', dev: true });
    assert.equal(await svc.handleMessage(dev), true);
    assert.match(dev.sent.at(-1), /Tidak ada ronde Family 100 yang aktif/);
  });

  it('auto-bumps the board after enough idle chatter so the question stays visible', async () => {
    const svc = require('../src/services/family100');
    const { updateGuildSettings } = require('../src/utils/storage');
    updateGuildSettings('guild1', s => ({ ...s, prefix: '!' }));
    await svc.handleMessage(makeMessage('!f100'));
    const session = svc.sessions.get('guild1');
    const startBoardId = session.messageId;

    const noise = makeMessage('ngobrol aja', { userId: 'user9', name: 'Warga' });
    for (let i = 0; i < svc.AUTO_BUMP_AFTER; i++) await svc.handleMessage(noise);
    await session.boardQueue;

    assert.notEqual(session.messageId, startBoardId, 'papan harus dikirim ulang setelah channel ramai');
    assert.ok(noise.deleted.includes(startBoardId), 'papan lama dihapus saat bump');
    assert.equal(session.revealed.size, 0, 'bump tidak membuka jawaban');
  });

  it('reveals one extra leading letter per clue, capped, without unlocking answers', async () => {
    const svc = require('../src/services/family100');
    const { updateGuildSettings } = require('../src/utils/storage');
    updateGuildSettings('guild1', s => ({ ...s, prefix: '!' }));
    await svc.handleMessage(makeMessage('!f100'));
    const session = fixQuestion(svc, 'guild1');

    const first = makeMessage('!f100 clue', { userId: 'user9', name: 'Warga', admin: false });
    assert.equal(await svc.handleMessage(first), true);
    assert.equal(session.clueLevel, 1);
    assert.equal(session.clueByUser.get('user9'), 1);
    assert.equal(session.revealed.size, 0, 'clue tidak membuka jawaban');
    const rows1 = first.boards.at(-1).embeds[0].data.description.split('\n');
    const hidden1 = rows1.find(r => r.startsWith('⬜'));
    assert.match(hidden1, /^\u2b1c \d\d\. [a-z]▓/, 'huruf depan pertama terbuka');
    assert.match(first.boards.at(-1).embeds[0].data.footer.text, /Clue 1\/3/);

    const second = makeMessage('!f100 clue', { userId: 'user9', name: 'Warga' });
    await svc.handleMessage(second);
    assert.equal(session.clueLevel, 2);
    const rows2 = second.boards.at(-1).embeds[0].data.description.split('\n');
    assert.match(rows2.find(r => r.startsWith('⬜')), /^\u2b1c \d\d\. [a-z]{2}▓/, 'clue kedua membuka 2 huruf');

    const third = makeMessage('!f100 clue', { userId: 'user9', name: 'Warga' });
    await svc.handleMessage(third);
    assert.equal(session.clueLevel, 3, 'clue ketiga diterima');

    const capped = makeMessage('!f100 clue', { userId: 'user9', name: 'Warga' });
    assert.equal(await svc.handleMessage(capped), true);
    assert.equal(session.clueLevel, 3, 'clue tidak melebihi batas');
    assert.match(capped.sent.at(-1), /Jatah clue kamu sudah habis \(3\/3\)/);
  });

  it('gives each player their own clue quota while the board keeps the highest level', async () => {
    const svc = require('../src/services/family100');
    const { updateGuildSettings } = require('../src/utils/storage');
    updateGuildSettings('guild1', s => ({ ...s, prefix: '!' }));
    await svc.handleMessage(makeMessage('!f100'));
    const session = svc.sessions.get('guild1');

    // Warga memakai jatahnya habis (3×).
    let lastClue;
    for (let i = 0; i < 3; i++) {
      lastClue = makeMessage('!f100 clue', { userId: 'warga', name: 'Warga', admin: false });
      await svc.handleMessage(lastClue);
    }
    assert.equal(session.clueLevel, 3);
    const blocked = makeMessage('!f100 clue', { userId: 'warga', name: 'Warga' });
    await svc.handleMessage(blocked);
    assert.match(blocked.sent.at(-1), /Jatah clue kamu sudah habis/);

    // Pemain lain tetap punya jatah sendiri.
    const other = makeMessage('!f100 clue', { userId: 'andi', name: 'Andi' });
    assert.equal(await svc.handleMessage(other), true);
    assert.equal(session.clueByUser.get('andi'), 1, 'Andi punya jatah terpisah');
    assert.equal(session.clueLevel, 3, 'level papan tetap yang tertinggi, tidak turun');
    // Papan tidak boleh "mundur": baris tersembunyi tetap sama seperti saat level 3.
    const hiddenRows = m => m.boards.at(-1).embeds[0].data.description.split('\n').filter(r => r.startsWith('⬜'));
    assert.deepEqual(hiddenRows(other), hiddenRows(lastClue), 'papan tetap di level tertinggi yang pernah dicapai');
    assert.match(other.boards.at(-1).embeds[0].data.footer.text, /Clue 3\/3/, 'footer tetap level 3');
    assert.ok(hiddenRows(other)[0].includes('▓'), 'masih ada huruf tersembunyi');
  });

  it('resets the per-player clue quota on a new question', async () => {
    const svc = require('../src/services/family100');
    const { updateGuildSettings } = require('../src/utils/storage');
    updateGuildSettings('guild1', s => ({ ...s, prefix: '!' }));
    await svc.handleMessage(makeMessage('!f100'));
    for (let i = 0; i < 3; i++) {
      await svc.handleMessage(makeMessage('!f100 clue', { userId: 'warga', name: 'Warga' }));
    }
    assert.equal(svc.sessions.get('guild1').clueByUser.get('warga'), 3);

    await svc.handleMessage(makeMessage('!f100 skip', { userId: 'warga', name: 'Warga' }));
    const next = svc.sessions.get('guild1');
    assert.equal(next.clueLevel, 0, 'level clue direset untuk soal baru');
    assert.equal(next.clueByUser.size, 0, 'jatah per pemain direset');
    const again = makeMessage('!f100 clue', { userId: 'warga', name: 'Warga' });
    assert.equal(await svc.handleMessage(again), true);
    assert.equal(next.clueByUser.get('warga'), 1, 'jatah terisi lagi di soal baru');
  });

  it('keeps a short one-word answer unreadable after a clue', () => {
    const { clueMask } = require('../src/services/family100');
    assert.equal(clueMask('gula', 0), '▓▓▓▓', 'tanpa clue semua huruf tersembunyi');
    assert.equal(clueMask('gula', 1), 'g▓▓▓');
    assert.equal(clueMask('gula', 3), 'gul▓');
    assert.equal(clueMask('nasi goreng', 2), 'na▓▓ ▓▓▓▓▓▓');
    assert.equal(clueMask('abc', 3), 'ab▓', 'selalu sisakan minimal satu huruf tersembunyi');
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

  it('has no answer set shared by two different questions', () => {
    const bank = require('../src/data/family100Bank');
    const norm = s => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const byAnswers = new Map();
    for (const q of bank.all()) {
      const key = q.answers.map(a => norm(a.text)).sort().join('|');
      if (!byAnswers.has(key)) byAnswers.set(key, []);
      byAnswers.get(key).push(q.soal);
    }
    const dupes = [...byAnswers.values()].filter(v => v.length > 1);
    assert.deepEqual(dupes, [], 'soal kembar harus dibuang, bukan disimpan dua kali');
  });

  it('keeps every answer relevant: no joke/gibberish slots left behind', () => {
    const bank = require('../src/data/family100Bank');
    // Penanda jawaban sampah: kata ganti/slang era IRC dan emotikon.
    const junk = /(^|[^a-z])(wakz|wekz|ngumpat|patkai|ngaca|bokkk|euy|ahk|wkwk|haha)([^a-z]|$)|-\\.-|\\.\\.\\./i;
    const offenders = [];
    for (const q of bank.all()) {
      for (const a of q.answers) {
        if (junk.test(a.text)) offenders.push(q.soal + ' => ' + a.text);
      }
    }
    assert.deepEqual(offenders, [], 'jawaban sampah harus sudah dikurasi');
  });

  it('drops joke questions that only had nonsense answers', () => {
    const bank = require('../src/data/family100Bank');
    const gone = ['Intip Soal Dan Jawaban', 'Cowo Brengsek Neh…', 'Orang Jelek', 'Nregira', 'Hacker', 'Dunia Dalam Berita'];
    const soal = new Set(bank.all().map(q => q.soal));
    for (const g of gone) assert.ok(!soal.has(g), 'soal lelucon harus dibuang: ' + g);
  });
});
