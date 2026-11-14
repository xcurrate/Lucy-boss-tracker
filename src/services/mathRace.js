// Matematika Cepat Tepat.
//
// Mode: satu soal aritmetika aktif per server, terikat channel tempat `d math`
// dijalankan. Siapa pun yang menjawab BENAR paling dulu mendapat poin; soal
// ditutup lalu soal berikutnya dikirim. Berbeda dari Family 100 yang memakai
// pencocokan mirip, di sini jawaban dinilai eksak (mathEngine.isCorrect) supaya
// "3" tidak lolos saat jawabannya "8".
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const { getGuildSettings, DEFAULT_PREFIX, matchPrefix } = require('../utils/storage');
const engine = require('./mathEngine');
const scores = require('../utils/mathStorage');

const WIB = 'Asia/Jakarta';
const MATH_NAV = 'mathnav';
const PAGE_SIZE = 10;
const MEDALS = ['🥇', '🥈', '🥉'];
// Batas waktu menjawab satu soal. Bisa diubah per server lewat dashboard/settings.
const DEFAULT_SECONDS = 30;
// Jeda sebelum soal berikutnya dikirim, supaya jawaban terakhir sempat terbaca.
const NEXT_DELAY_MS = 2500;
// Bisa diubah (mis. test memakai 0 agar tidak menunggu).
let nextDelayMs = NEXT_DELAY_MS;
function setNextDelay(ms) { nextDelayMs = Math.max(0, Number(ms) || 0); }
function delay(ms) { return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve(); }
// Bonus maksimum karena menjawab cepat (diberikan penuh bila dijawab seketika).
const SPEED_BONUS = 50;
// Jumlah soal bawaan bila pemain tidak menyebut angka.
const DEFAULT_ROUNDS = 5;
const MAX_ROUNDS = 30;
// guildId -> sesi berjalan
const sessions = new Map();

function dayKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: WIB, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

// Rentang minggu (Senin–Minggu) yang memuat `date`, dalam format dayKey WIB.
function weekRange(date = new Date()) {
  const key = dayKey(date);
  const d = new Date(key + 'T12:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7; // Senin = 0
  d.setUTCDate(d.getUTCDate() - dow);
  const from = d.toISOString().slice(0, 10);
  d.setUTCDate(d.getUTCDate() + 6);
  return { from, to: d.toISOString().slice(0, 10) };
}

function formatIndonesianDate(key) {
  const months = ['jan', 'feb', 'mar', 'apr', 'mei', 'jun', 'jul', 'agu', 'sep', 'okt', 'nov', 'des'];
  const [y, m, d] = String(key).split('-');
  return `${Number(d)} ${months[Number(m) - 1]} ${y}`;
}

function guildConfig(guildId) {
  return getGuildSettings(guildId).mathRace || {};
}

function parsePage(value) {
  const n = Number(String(value || '').trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

// Tingkat kesulitan naik seiring nomor soal, dan menyesuaikan level rata-rata
// pemain di server (kalau banyak yang cepat, soal lebih sulit).
function levelForRound(round) {
  if (round <= 2) return 1;
  if (round <= 4) return 2;
  if (round <= 7) return 3;
  if (round <= 10) return 4;
  return 5;
}

function roundEmbed(session, { revealAnswer = false } = {}) {
  const { question, round, totalRounds, players } = session;
  const elapsed = session.answeredAt ? session.answeredAt - session.askedAt : null;
  const lines = [`# ${question.text}`];
  if (revealAnswer) {
    const who = session.winnerName ? ` — ${session.winnerName}` : '';
    lines.push('', `**Jawaban: ${question.answer}**${who}`);
  }
  const embed = new EmbedBuilder()
    .setColor(revealAnswer ? 0x57F287 : 0x5865F2)
    .setTitle(`🧮 Cepat Tepat — Soal ${round}/${totalRounds}`)
    .setDescription(lines.join('\n'))
    .setFooter({
      text: `Level ${question.level} • jawab di channel ini` +
        (elapsed !== null ? ` • ${(elapsed / 1000).toFixed(1)} detik` : '')
    });
  if (revealAnswer) {
    const scored = [...players.entries()]
      .map(([userId, p]) => ({ userId, ...p }))
      .sort((a, b) => b.points - a.points)
      .slice(0, 10);
    if (scored.length) {
      embed.addFields({
        name: 'Skor sementara',
        value: scored.map((p, i) => `${MEDALS[i] || (i + 1) + '.'} ${p.name} — ${p.points} poin`).join('\n').slice(0, 1024)
      });
    }
  } else {
    embed.addFields({ name: 'Poin dasar', value: `${engine.basePoints(question.level)} + bonus kecepatan s/d ${SPEED_BONUS}`, inline: true });
    embed.addFields({ name: 'Waktu', value: `${Math.round((session.deadline - Date.now()) / 1000)} detik`, inline: true });
  }
  return embed;
}

function isMathNav(customId) {
  return typeof customId === 'string' && customId.startsWith(MATH_NAV + ':');
}

function navRow(type) {
  const buttons = [
    { action: 'first', label: '⏮️', style: ButtonStyle.Secondary },
    { action: 'prev', label: '◀️', style: ButtonStyle.Primary },
    { action: 'next', label: '▶️', style: ButtonStyle.Primary },
    { action: 'last', label: '⏭️', style: ButtonStyle.Secondary }
  ].map(b => new ButtonBuilder().setCustomId(`${MATH_NAV}:${type}:${b.action}`).setLabel(b.label).setStyle(b.style));
  return new ActionRowBuilder().addComponents(...buttons);
}

function leaderboardView(guildId, type, page = 1) {
  const rows = type === 'alltime'
    ? scores.topAllTime(guildId)
    : scores.topByRange(guildId, ...Object.values(weekRange()));
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const offset = (current - 1) * PAGE_SIZE;
  const slice = rows.slice(offset, offset + PAGE_SIZE);
  const desc = slice.length
    ? slice.map((r, i) => `${MEDALS[offset + i] || (offset + i + 1) + '.'} **${r.points.toLocaleString('id-ID')}** poin — ${r.name || 'Pemain'}` +
        (r.bestMs !== null ? ` (tercepat ${(r.bestMs / 1000).toFixed(1)}s)` : '')).join('\n')
    : 'Belum ada poin tercatat.';
  const range = weekRange();
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(type === 'alltime' ? '🏆 Cepat Tepat — All-Time' : '🏆 Cepat Tepat — Mingguan')
    .setDescription(desc)
    .setFooter({ text: `Halaman ${current}/${totalPages} • ${rows.length} pemain • ${type === 'alltime' ? 'semua waktu' : formatIndonesianDate(range.from) + ' – ' + formatIndonesianDate(range.to)}` });
  return { embed, page: current, totalPages };
}

function isModerator(message) {
  return Boolean(message.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild));
}

function isDeveloper(message) {
  const ids = new Set(String(process.env.DEVELOPER_IDS || '').split(',').map(s => s.trim()).filter(Boolean));
  const owner = message.client?.application?.owner;
  if (owner?.id) ids.add(owner.id);
  else if (owner?.members) for (const id of owner.members.keys()) ids.add(id);
  if (ids.has(message.author?.id)) return true;
  return Boolean(message.guild?.ownerId && message.guild.ownerId === message.author.id);
}

function isAdmin(message) {
  return isModerator(message) || isDeveloper(message);
}

function startSession(guildId, channelId, totalRounds = DEFAULT_ROUNDS) {
  const session = {
    guildId,
    channelId,
    round: 0,
    totalRounds,
    players: new Map(),
    question: null,
    questionId: 0,
    // Dikunci begitu sebuah soal selesai (dijawab benar ATAU waktu habis).
    // Diset sinkron sebelum await apa pun supaya dua jawaban benar yang datang
    // hampir bersamaan tidak sama-sama dihitung dan tidak memajukan dua soal.
    locked: false,
    messageId: null,
    askedAt: 0,
    answeredAt: null,
    deadline: 0,
    winnerName: null,
    timer: null,
    ended: false
  };
  sessions.set(guildId, session);
  return session;
}

// Soal berikutnya: level naik, timer dijalankan. Kalau jumlah soal habis,
// ronde ditutup dan skor akhir diposting.
async function nextQuestion(client, session, { replyTo = null } = {}) {
  if (session.ended) return;
  if (session.round >= session.totalRounds) return endSession(client, session, { replyTo });
  // Cegah dua pemanggilan nextQuestion berjalan bersamaan: keduanya akan
  // menaikkan `round` dan mengirim papan masing-masing, sehingga soal melompat.
  if (session.advancing) return;
  session.advancing = true;
  try {
    // Buang timer soal sebelumnya: kalau tidak, timer lama bisa menyala di tengah
    // soal baru dan memajukan ronde lagi (soal terlihat "ganti terlalu cepat").
    clearTimer(session);
    session.round += 1;
    session.questionId += 1;
    session.locked = false;
    session.question = engine.makeQuestion(levelForRound(session.round));
    session.askedAt = Date.now();
    session.answeredAt = null;
    session.winnerName = null;
    const seconds = Number(guildConfig(session.guildId).durationSeconds) || DEFAULT_SECONDS;
    session.deadline = session.askedAt + seconds * 1000;

    const payload = { embeds: [roundEmbed(session)] };
    let sent = null;
    try {
      sent = replyTo
        ? await replyTo.reply({ ...payload, allowedMentions: { parse: [] } })
        : await (await client.channels.fetch(session.channelId)).send(payload);
    } catch (e) {
      console.error('[MathRace] gagal mengirim soal:', e.message);
      return;
    }
    const previous = session.messageId;
    if (sent?.id) session.messageId = sent.id;
    if (previous && previous !== session.messageId) deleteBoard(client, session.channelId, previous);

    const questionId = session.questionId;
    session.timer = setTimeout(() => timeoutQuestion(client, session, questionId), seconds * 1000);
    session.timer.unref?.();
  } finally {
    session.advancing = false;
  }
}

function clearTimer(session) {
  if (session.timer) { clearTimeout(session.timer); session.timer = null; }
}

function deleteBoard(client, channelId, messageId) {
  if (!messageId) return;
  Promise.resolve()
    .then(async () => {
      const channel = await client.channels.fetch(channelId);
      const message = await channel.messages.fetch(messageId);
      await message.delete();
    })
    .catch(e => console.error('[MathRace] gagal menghapus soal lama:', e.message));
}

async function timeoutQuestion(client, session, questionId) {
  if (sessions.get(session.guildId) !== session || session.ended) return;
  // Timer dari soal yang sudah tidak berlaku (mis. soal sudah dijawab) harus
  // diabaikan, supaya tidak memajukan ronde dua kali.
  if (questionId !== session.questionId || session.locked) return;
  session.locked = true;
  session.answeredAt = Date.now();
  session.timedOut = true;
  try {
    const channel = await client.channels.fetch(session.channelId);
    await channel.send({ embeds: [roundEmbed(session, { revealAnswer: true })] });
  } catch (e) {
    console.error('[MathRace] gagal mengirim jawaban timeout:', e.message);
  }
  await delay(nextDelayMs);
  session.timedOut = false;
  await nextQuestion(client, session);
}

// Poin: dasar menurut level + bonus kecepatan yang menurun linier. Batas waktu
// diambil dari sesi supaya bonus konsisten dengan durasi yang berlaku saat soal
// dikirim (bukan dari settings yang bisa berubah di tengah ronde).
function pointsForAnswer(session, elapsedMs) {
  const limit = Math.max(1, (session.deadline - session.askedAt) / 1000);
  const base = engine.basePoints(session.question.level);
  const fraction = Math.max(0, Math.min(1, 1 - elapsedMs / (limit * 1000)));
  return base + Math.round(SPEED_BONUS * fraction);
}

async function endSession(client, session, { replyTo = null } = {}) {
  clearTimer(session);
  session.ended = true;
  sessions.delete(session.guildId);
  const scored = [...session.players.entries()]
    .map(([userId, p]) => ({ userId, ...p }))
    .sort((a, b) => b.points - a.points);
  const lines = scored.length
    ? scored.map((p, i) => `${MEDALS[i] || (i + 1) + '.'} **${p.points}** poin — ${p.name} (${p.correct} benar)`).join('\n')
    : 'Tidak ada yang menjawab benar.';
  const embed = new EmbedBuilder()
    .setColor(0xFEE75C)
    .setTitle('🏁 Cepat Tepat selesai')
    .setDescription(lines)
    .setFooter({ text: `${session.totalRounds} soal • ${scored.length} pemain` });
  const payload = { embeds: [embed], allowedMentions: { parse: [] } };
  try {
    if (replyTo) await replyTo.reply(payload);
    else await (await client.channels.fetch(session.channelId)).send(payload);
  } catch (e) {
    console.error('[MathRace] gagal mengirim hasil akhir:', e.message);
  }
}

// Menangani jawaban pemain. Hanya pesan yang seluruhnya berupa angka/pecahan
// yang dianggap tebakan, supaya chat biasa tidak dinilai.
async function handleGuess(message) {
  const session = sessions.get(message.guildId);
  if (!session || session.ended) return false;
  if (message.channelId !== session.channelId) return false;
  if (!session.question) return false;
  // Soal sudah selesai (dijawab benar atau waktu habis): jangan dinilai lagi.
  if (session.locked || session.timedOut) return false;

  const value = engine.parseAnswer(message.content);
  if (value === null) return false;
  if (!engine.isCorrect(message.content, session.question.answer)) {
    await message.react('❌').catch(() => {});
    return true;
  }

  // Kunci soal SEKARANG, sinkron sebelum await apa pun. Kalau tidak, dua pemain
  // yang menjawab benar hampir bersamaan sama-sama lolos dan memajukan dua soal.
  session.locked = true;
  clearTimer(session);
  session.answeredAt = Date.now();
  const elapsed = session.answeredAt - session.askedAt;
  const name = message.member?.displayName || message.author?.username || 'Pemain';
  session.winnerName = name;
  const awarded = pointsForAnswer(session, elapsed);
  const current = session.players.get(message.author.id) || { name, points: 0, correct: 0 };
  session.players.set(message.author.id, { name, points: current.points + awarded, correct: current.correct + 1 });

  scores.addPoints({ guildId: message.guildId, userId: message.author.id, name, points: awarded, ms: elapsed, day: dayKey() });

  await message.react('✅').catch(() => {});
  try {
    await message.channel.send({ embeds: [roundEmbed(session, { revealAnswer: true })], allowedMentions: { parse: [] } });
  } catch (e) {
    console.error('[MathRace] gagal mengirim hasil soal:', e.message);
  }
  await delay(nextDelayMs);
  await nextQuestion(message.client, session);
  return true;
}

async function handleMessage(message) {
  if (!message.guildId || message.author?.bot || !message.content) return false;
  if (await handleCommand(message)) return true;
  return handleGuess(message);
}

function helpText(prefix) {
  return [
    '**Cepat Tepat (Matematika)** — jawab benar paling dulu untuk dapat poin.',
    `\`${prefix}math\` — mulai ronde (${DEFAULT_ROUNDS} soal)`,
    `\`${prefix}math <jumlah>\` — mulai ronde dengan jumlah soal (maks ${MAX_ROUNDS})`,
    `\`${prefix}math lb [all]\` — leaderboard mingguan/all-time`,
    `\`${prefix}math stop\` — hentikan ronde (moderator/admin/developer)`
  ].join('\n');
}

async function handleCommand(message) {
  if (!message.guildId || !message.content) return false;
  const prefix = getGuildSettings(message.guildId).prefix || DEFAULT_PREFIX;
  const rest = matchPrefix(message.content.trim(), prefix);
  if (rest === null) return false;
  const parts = rest.trim().split(/\s+/);
  const command = (parts[0] || '').toLowerCase();
  if (!['math', 'mtk', 'hitung', 'hitungcepat'].includes(command)) return false;
  const sub = (parts[1] || '').toLowerCase();

  if (sub === 'lb' || sub === 'leaderboard' || sub === 'peringkat') {
    const type = ['all', 'alltime', 'semua'].includes((parts[2] || '').toLowerCase()) ? 'alltime' : 'weekly';
    const view = leaderboardView(message.guildId, type, parsePage(parts[3] || parts[2]));
    await message.reply({ embeds: [view.embed], components: [navRow(type)], allowedMentions: { parse: [] } });
    return true;
  }

  if (sub === 'stop' || sub === 'selesai') {
    const session = sessions.get(message.guildId);
    if (!session || session.ended) { await message.reply('Tidak ada ronde Cepat Tepat yang aktif.'); return true; }
    if (!isAdmin(message)) { await message.reply('Hanya moderator/admin atau developer yang bisa menghentikan ronde.'); return true; }
    clearTimer(session);
    session.ended = true;
    sessions.delete(message.guildId);
    await message.reply('Ronde Cepat Tepat dihentikan.');
    return true;
  }

  if (sub === 'help' || sub === 'bantuan') { await message.reply(helpText(prefix)); return true; }

  const active = sessions.get(message.guildId);
  if (active && !active.ended) {
    await message.reply(`Masih ada ronde Cepat Tepat di <#${active.channelId}>. Hentikan dulu dengan \`${prefix}math stop\`.`);
    return true;
  }

  const cfg = guildConfig(message.guildId);
  if (cfg.enabled === false) {
    await message.reply(`Cepat Tepat sedang dimatikan.`);
    return true;
  }
  if (cfg.channelId && cfg.channelId !== message.channelId) {
    await message.reply(`Cepat Tepat hanya boleh dijalankan di <#${cfg.channelId}>.`);
    return true;
  }

  const requested = Number(parts[1]);
  const rounds = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), MAX_ROUNDS) : DEFAULT_ROUNDS;
  const session = startSession(message.guildId, message.channelId, rounds);
  session.startedBy = message.author.id;
  await nextQuestion(message.client, session, { replyTo: message });
  return true;
}

async function handleNavigation(interaction) {
  const [, type, action] = String(interaction.customId).split(':');
  const kind = type === 'alltime' ? 'alltime' : 'weekly';
  const current = interaction.message?.embeds?.[0]?.footer?.text?.match(/Halaman (\d+)\//);
  const page = current ? Number(current[1]) : 1;
  const rows = kind === 'alltime'
    ? scores.topAllTime(interaction.guildId)
    : scores.topByRange(interaction.guildId, ...Object.values(weekRange()));
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const target = { first: 1, prev: page - 1, next: page + 1, last: totalPages }[action] || page;
  const view = leaderboardView(interaction.guildId, kind, target);
  await interaction.update({ embeds: [view.embed], components: [navRow(kind)] });
}

module.exports = {
  handleMessage, handleCommand, handleNavigation, isMathNav, navRow, helpText,
  leaderboardView, roundEmbed, weekRange, dayKey, isAdmin,
  DEFAULT_SECONDS, DEFAULT_ROUNDS, MAX_ROUNDS, NEXT_DELAY_MS, SPEED_BONUS, setNextDelay,
  sessions, startSession, endSession, pointsForAnswer, timeoutQuestion, nextQuestion
};
