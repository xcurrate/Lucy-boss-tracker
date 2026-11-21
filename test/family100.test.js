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

// Soal dengan jawaban panjang (>= 6 huruf) supaya clue tidak kehabisan kandidat
// hanya karena jawabannya pendek. Dipakai test kuota & keacakan.
function fixLongQuestion(svc, guildId, minAnswers = 5, minLetters = 6) {
  const bank = require('../src/data/family100Bank');
  const question = bank.all().find(q => q.answers.length >= minAnswers
    && q.answers.every(a => a.text.replace(/[^a-z]/gi, '').length >= minLetters));
  if (!question) throw new Error('bank tidak punya soal dengan jawaban panjang');
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

  it('gives every player their own quota of 3 clues', async () => {
    const svc = require('../src/services/family100');
    const { updateGuildSettings } = require('../src/utils/storage');
    updateGuildSettings('guild1', s => ({ ...s, prefix: '!' }));
    await svc.handleMessage(makeMessage('!f100'));
    const session = fixLongQuestion(svc, 'guild1');
    // Pesan teks ada di antara payload embed, jadi kumpulkan semua teksnya.
    const texts = m => m.sent.map(x => (typeof x === 'string' ? x : x.content || '')).join('\n');

    // Pemain A memakai seluruh jatahnya (3×).
    const a1 = makeMessage('!f100 clue', { userId: 'userA', name: 'Ani', admin: false });
    assert.equal(await svc.handleMessage(a1), true);
    assert.equal(session.clueByUser.get('userA'), 1);
    assert.equal(session.revealed.size, 0, 'clue tidak membuka jawaban');
    assert.match(texts(a1), /Sisa jatah kamu: \*\*2\/3\*\*/);

    for (let i = 2; i <= 3; i++) {
      await svc.handleMessage(makeMessage('!f100 clue', { userId: 'userA', name: 'Ani' }));
      assert.equal(session.clueByUser.get('userA'), i);
    }

    // Jatah A habis, B tetap punya jatah penuh sendiri.
    const a4 = makeMessage('!f100 clue', { userId: 'userA', name: 'Ani' });
    await svc.handleMessage(a4);
    assert.match(texts(a4), /Jatah clue kamu sudah habis \(3\/3\)/);
    assert.equal(session.clueByUser.get('userA'), 3, 'jatah A tidak bertambah');

    const b1 = makeMessage('!f100 clue', { userId: 'userB', name: 'Budi' });
    assert.equal(await svc.handleMessage(b1), true, 'B tidak ikut kehabisan');
    assert.equal(session.clueByUser.get('userB'), 1, 'B punya jatah terpisah');
    assert.equal(session.clueByUser.get('userA'), 3, 'jatah A tidak berubah oleh B');
  });

  it('reveals one letter on every answer per clue, never leaving fewer than 2 hidden', async () => {
    const svc = require('../src/services/family100');
    const { updateGuildSettings } = require('../src/utils/storage');
    updateGuildSettings('guild1', s => ({ ...s, prefix: '!' }));
    await svc.handleMessage(makeMessage('!f100'));
    const session = fixLongQuestion(svc, 'guild1');
    const hiddenOf = i => svc.letterIndices(session.question.answers[i].text).length - (session.hints.get(i)?.size || 0);
    const totalLetters = () => [...session.hints.values()].reduce((n, set) => n + set.size, 0);

    assert.equal(session.hints.size, 0, 'belum ada huruf terbuka');
    for (let round = 1; round <= 3; round++) {
      const before = session.question.answers.map((_, i) => hiddenOf(i));
      const msg = makeMessage('!f100 clue', { userId: 'userA', name: 'Ani' });
      await svc.handleMessage(msg);
      let expected = 0;
      session.question.answers.forEach((a, i) => {
        const now = hiddenOf(i);
        if (before[i] > 2) {
          assert.equal(now, before[i] - 1, 'jawaban ke-' + i + ' berkurang 1 huruf');
          expected++;
        } else {
          assert.equal(now, before[i], 'jawaban ke-' + i + ' tetap terkunci di 2 huruf');
        }
        assert.ok(now >= 2, 'minimal 2 huruf tetap tersembunyi (jawaban ' + i + ')');
      });
      assert.ok(expected > 0, 'ada jawaban yang mendapat huruf');
      assert.equal(totalLetters(), round * expected, 'total huruf terbuka sesuai jumlah clue');
      assert.match(msg.boards.at(-1).embeds[0].data.footer.text, /Clue \d+ huruf/);
    }
  });

  it('locks an answer at 2 hidden letters while the others keep getting clues', () => {
    const svc = require('../src/services/family100');
    const session = {
      question: { answers: [{ text: 'abc' }, { text: 'abcdefgh' }] },
      revealed: new Set(),
      hints: new Map()
    };
    const hiddenOf = i => svc.letterIndices(session.question.answers[i].text).length - (session.hints.get(i)?.size || 0);

    assert.equal(svc.addHint(session), true);
    assert.equal(hiddenOf(0), 2, 'jawaban 3 huruf langsung terkunci di 2 tersembunyi');
    assert.equal(hiddenOf(1), 7, 'jawaban panjang baru kehilangan 1 huruf');
    assert.equal(svc.addHint(session), true);
    assert.equal(hiddenOf(0), 2, 'jawaban terkunci tidak menerima clue lagi');
    assert.equal(hiddenOf(1), 6, 'jawaban panjang lanjut terbuka');
  });

  it('never clues an answer that already has only 2 letters hidden', () => {
    const svc = require('../src/services/family100');
    const session = {
      question: { answers: [{ text: 'ab' }, { text: 'wxyz' }] },
      revealed: new Set(),
      hints: new Map()
    };
    assert.equal(svc.addHint(session), true);
    assert.equal(session.hints.has(0), false, 'jawaban 2 huruf dilewati');
    assert.equal(svc.letterIndices('wxyz').length - session.hints.get(1).size, 3, 'jawaban 4 huruf berhenti di 2');
  });

  it('reveals a random letter per answer, not always from the front', async () => {
    const svc = require('../src/services/family100');
    const { updateGuildSettings } = require('../src/utils/storage');
    updateGuildSettings('guild1', s => ({ ...s, prefix: '!' }));

    let frontHidden = false;
    for (let round = 0; round < 15; round++) {
      // Sesi lama dibuang supaya `!f100` benar-benar memulai soal baru; kalau tidak,
      // kuota pemain dari soal sebelumnya masih terpakai dan clue ditolak.
      svc.sessions.delete('guild1');
      await svc.handleMessage(makeMessage('!f100'));
      const session = fixLongQuestion(svc, 'guild1');
      await svc.handleMessage(makeMessage('!f100 clue', { userId: 'userA', name: 'Ani' }));
      for (const [index, hint] of session.hints.entries()) {
        assert.equal(hint.size, 1, 'satu clue membuka tepat 1 huruf per jawaban (jawaban ' + index + ')');
        if (!hint.has(0)) frontHidden = true;
      }
    }
    assert.ok(frontHidden, 'huruf depan pernah disembunyikan, jadi clue tidak berurutan dari depan');
  });

  it('does not spend quota when no answer can be clued anymore', async () => {
    const svc = require('../src/services/family100');
    const { updateGuildSettings } = require('../src/utils/storage');
    updateGuildSettings('guild1', s => ({ ...s, prefix: '!' }));
    await svc.handleMessage(makeMessage('!f100'));
    const session = fixQuestion(svc, 'guild1');
    // Paksa semua jawaban sudah tersisa 2 huruf.
    for (let i = 0; i < session.question.answers.length; i++) {
      const letters = svc.letterIndices(session.question.answers[i].text);
      if (letters.length <= svc.CLUE_HIDDEN) continue;
      session.hints.set(i, new Set(letters.slice(0, letters.length - svc.CLUE_HIDDEN)));
    }
    const msg = makeMessage('!f100 clue', { userId: 'userA', name: 'Ani' });
    await svc.handleMessage(msg);
    assert.match(msg.sent.at(-1), /Tidak ada jawaban yang bisa dibuka clue lagi/);
    assert.equal(session.clueByUser.get('userA'), undefined, 'jatah tidak terpotong');
  });

  it('resets the per-player clue quota on a new question', async () => {
    const svc = require('../src/services/family100');
    const { updateGuildSettings } = require('../src/utils/storage');
    updateGuildSettings('guild1', s => ({ ...s, prefix: '!' }));
    await svc.handleMessage(makeMessage('!f100'));
    fixLongQuestion(svc, 'guild1');
    for (let i = 0; i < 3; i++) {
      await svc.handleMessage(makeMessage('!f100 clue', { userId: 'warga', name: 'Warga' }));
    }
    assert.equal(svc.sessions.get('guild1').clueByUser.get('warga'), 3);

    await svc.handleMessage(makeMessage('!f100 skip', { userId: 'warga', name: 'Warga' }));
    const next = svc.sessions.get('guild1');
    assert.equal(next.hints.size, 0, 'hint direset untuk soal baru');
    assert.equal(next.clueByUser.size, 0, 'jatah per pemain direset');
    const again = makeMessage('!f100 clue', { userId: 'warga', name: 'Warga' });
    assert.equal(await svc.handleMessage(again), true);
    assert.equal(next.clueByUser.get('warga'), 1, 'jatah terisi lagi di soal baru');
  });

  it('clueMask follows the given letter positions and keeps the rest hidden', () => {
    const { clueMask } = require('../src/services/family100');
    assert.equal(clueMask('gula'), '\u2593\u2593\u2593\u2593', 'tanpa hint semua huruf tersembunyi');
    assert.equal(clueMask('gula', [1]), '\u2593u\u2593\u2593', 'hanya posisi yang diberikan yang terbuka');
    assert.equal(clueMask('nasi goreng', [0, 1, 4]), 'na\u2593\u2593 g\u2593\u2593\u2593\u2593\u2593', 'spasi tetap, posisi dihitung per huruf');
    assert.equal(clueMask('sate padang', [0, 3, 4, 6, 7, 8, 9]), 's\u2593\u2593e p\u2593dang', 'sisakan 2 huruf');
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
