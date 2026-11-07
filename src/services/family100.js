// Game Family 100.
//
// Satu soal aktif per server, terikat pada channel tempat `!f100` dijalankan.
// Bot mendengarkan semua pesan di channel itu dan mencocokkannya dengan daftar
// jawaban tersembunyi (lihat family100Match). Poin memakai skema total 100 per
// soal (family100Score), tanpa bonus penutup ronde.
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const { getGuildSettings, updateGuildSettings } = require('../utils/storage');
const bank = require('../data/family100Bank');
const scores = require('../utils/family100Storage');
const { matchAnswer } = require('./family100Match');
const { pointsFor } = require('./family100Score');

const WIB = 'Asia/Jakarta';
const F100_NAV = 'f100nav';
const PAGE_SIZE = 10;
const MEDALS = ['🥇', '🥈', '🥉'];

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

function guildConfig(guildId) {
  return getGuildSettings(guildId).family100 || {};
}

function formatIndonesianDate(key) {
  const months = ['jan', 'feb', 'mar', 'apr', 'mei', 'jun', 'jul', 'agu', 'sep', 'okt', 'nov', 'des'];
  const [y, m, d] = String(key).split('-');
  return `${Number(d)} ${months[Number(m) - 1]} ${y}`;
}

function buildBoard(question, points, revealed, players) {
  return question.answers.map((a, i) => {
    const slot = String(i + 1).padStart(2, '0');
    if (!revealed.has(i)) return `⬜ ${slot}. ▓▓▓▓▓▓▓▓`;
    const finder = players.get(i);
    return `✅ ${slot}. **${a.text}** — ${points[i]} poin${finder ? ' (' + finder.name + ')' : ''}`;
  }).join('\n');
}

function roundEmbed(session, { finished = false } = {}) {
  const { question, points, revealed, players } = session;
  const found = revealed.size;
  const embed = new EmbedBuilder()
    .setColor(finished ? 0x57F287 : 0xFEE75C)
    .setTitle(`📺 FAMILY 100 — Soal #${question.id + 1}`)
    .setDescription(`**${question.soal}**\n\n${buildBoard(question, points, revealed, players)}`)
    .setFooter({ text: `${found}/${question.answers.length} jawaban terbuka` + (finished ? ' • Ronde selesai' : ' • Ketik jawabanmu di channel ini') });
  const leaderboard = [...players.entries()]
    .map(([index, p]) => ({ name: p.name, points: p.points, index }))
    .sort((a, b) => b.points - a.points);
  if (leaderboard.length) {
    embed.addFields({
      name: 'Papan skor ronde',
      value: leaderboard.map(p => `${MEDALS[0]} ${p.name} — ${p.points} poin (jawaban #${p.index + 1})`).join('\n').slice(0, 1024)
    });
  }
  return embed;
}

function startRound(guildId, channelId) {
  const question = bank.all()[Math.floor(Math.random() * bank.count())];
  const points = pointsFor(question.answers.length);
  const session = { guildId, channelId, question, points, revealed: new Set(), players: new Map(), messageId: null, timer: null, startedAt: Date.now() };
  sessions.set(guildId, session);
  return session;
}

function endRound(session, { reason = null } = {}) {
  if (session.timer) { clearTimeout(session.timer); session.timer = null; }
  session.ended = true;
  session.endReason = reason;
  return session;
}

function scheduleTimeout(client, session) {
  const { durationSeconds } = guildConfig(session.guildId);
  const seconds = Number(durationSeconds) || 0;
  if (seconds <= 0) return;
  session.timer = setTimeout(async () => {
    if (sessions.get(session.guildId) !== session || session.ended) return;
    endRound(session, { reason: 'waktu habis' });
    await refreshMessage(client, session);
  }, seconds * 1000);
  session.timer.unref?.();
}

async function refreshMessage(client, session) {
  if (!session.messageId) return;
  try {
    const channel = await client.channels.fetch(session.channelId);
    const message = await channel.messages.fetch(session.messageId);
    await message.edit({ embeds: [roundEmbed(session, { finished: session.ended })] });
  } catch (e) {
    console.error('[Family100] gagal memperbarui pesan:', e.message);
  }
}

// Titik masuk untuk setiap pesan: perintah prefix dulu, baru tebakan jawaban.
async function handleMessage(message) {
  if (!message.guildId || message.author?.bot || !message.content) return false;
  if (await handleCommand(message)) return true;
  return handleGuess(message);
}

// Menangani pesan biasa sebagai tebakan. Dipanggil untuk setiap pesan di guild
// yang punya sesi aktif.
async function handleGuess(message) {
  const session = sessions.get(message.guildId);
  if (!session || session.ended) return false;
  if (message.channelId !== session.channelId) return false;

  const prefix = getGuildSettings(message.guildId).prefix || '!';
  // Pesan perintah (mis. "!boss status") bukan tebakan.
  if (message.content.trim().startsWith(prefix)) return false;

  const match = matchAnswer(message.content, session.question.answers);
  if (!match) return false;
  const index = session.question.answers.findIndex(a => a.text === match.text);
  if (index === -1 || session.revealed.has(index)) return false;

  session.revealed.add(index);
  const awarded = session.points[index];
  const name = message.member?.displayName || message.author?.username || 'Pemain';
  session.players.set(index, { userId: message.author.id, name, points: awarded });

  scores.addPoints({ guildId: message.guildId, userId: message.author.id, name, points: awarded, day: dayKey() });

  await message.react('✅').catch(() => {});
  if (session.revealed.size === session.question.answers.length) endRound(session, { reason: 'semua jawaban terbuka' });
  await refreshMessage(message.client, session);
  return true;
}

function isF100Nav(customId) {
  return typeof customId === 'string' && customId.startsWith(F100_NAV + ':');
}

function navRow(type) {
  const buttons = [
    { action: 'first', label: '⏮️', style: ButtonStyle.Secondary },
    { action: 'prev', label: '◀️', style: ButtonStyle.Primary },
    { action: 'next', label: '▶️', style: ButtonStyle.Primary },
    { action: 'last', label: '⏭️', style: ButtonStyle.Secondary }
  ].map(b => new ButtonBuilder().setCustomId(`${F100_NAV}:${type}:${b.action}`).setLabel(b.label).setStyle(b.style));
  return new ActionRowBuilder().addComponents(...buttons);
}

function leaderboardView(guildId, type, page = 1) {
  const rows = type === 'alltime'
    ? scores.topAllTime(guildId)
    : scores.topByRange(guildId, ...Object.values(weekRange()));
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const slice = rows.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const offset = (current - 1) * PAGE_SIZE;
  const desc = slice.length
    ? slice.map((r, i) => `${MEDALS[offset + i] || (offset + i + 1) + '.'} **${r.points.toLocaleString('id-ID')}** poin — ${r.name || 'Pemain'}`).join('\n')
    : 'Belum ada poin tercatat.';
  const range = weekRange();
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(type === 'alltime' ? '🏆 Family 100 — All-Time' : '🏆 Family 100 — Mingguan')
    .setDescription(desc)
    .setFooter({ text: `Halaman ${current}/${totalPages} • ${rows.length} pemain • ${type === 'alltime' ? 'semua waktu' : formatIndonesianDate(range.from) + ' – ' + formatIndonesianDate(range.to)}` });
  return { embed, page: current, totalPages };
}

function parsePage(value) {
  const n = Number(String(value || '').trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

function isAdmin(message) {
  return Boolean(message.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild));
}

async function handleCommand(message) {
  if (!message.guildId || !message.content) return false;
  const prefix = getGuildSettings(message.guildId).prefix || '!';
  const text = message.content.trim();
  if (!text.startsWith(prefix)) return false;
  const parts = text.slice(prefix.length).trim().split(/\s+/);
  const command = (parts[0] || '').toLowerCase();
  if (!['f100', 'family100', 'kuis'].includes(command)) return false;
  const sub = (parts[1] || '').toLowerCase();
  const cfg = guildConfig(message.guildId);

  if (sub === 'lb' || sub === 'leaderboard' || sub === 'peringkat') {
    const type = (parts[2] || '').toLowerCase() === 'all' || (parts[2] || '').toLowerCase() === 'alltime' ? 'alltime' : 'weekly';
    const view = leaderboardView(message.guildId, type, parsePage(parts[3] || parts[2]));
    await message.reply({ embeds: [view.embed], components: [navRow(type)], allowedMentions: { parse: [] } });
    return true;
  }

  if (sub === 'stop' || sub === 'selesai') {
    const session = sessions.get(message.guildId);
    if (!session || session.ended) return message.reply('Tidak ada ronde Family 100 yang aktif.').then(() => true);
    if (!isAdmin(message) && message.author.id !== session.startedBy) {
      await message.reply('Hanya moderator/admin atau pemula ronde yang bisa menghentikan ronde.');
      return true;
    }
    endRound(session, { reason: 'dihentikan' });
    await refreshMessage(message.client, session);
    await message.reply({ embeds: [roundEmbed(session, { finished: true })] });
    sessions.delete(message.guildId);
    return true;
  }
  if (sub === 'skip' || sub === 'lewati') {
    if (!isAdmin(message)) return message.reply('Hanya moderator/admin yang bisa melewati soal.').then(() => true);
    const session = sessions.get(message.guildId);
    if (!session || session.ended) return message.reply('Tidak ada ronde Family 100 yang aktif.').then(() => true);
    endRound(session, { reason: 'dilewati' });
    await refreshMessage(message.client, session);
    sessions.delete(message.guildId);
    const next = startRound(message.guildId, message.channelId);
    next.startedBy = message.author.id;
    const sent = await message.channel.send({ embeds: [roundEmbed(next)] });
    next.messageId = sent.id;
    scheduleTimeout(message.client, next);
    return true;
  }

  if (sub === 'status') {
    const session = sessions.get(message.guildId);
    if (!session || session.ended) {
      await message.reply(`Family 100 tidak ada ronde aktif. Bank soal: **${bank.count()}** soal. Total 100 poin per soal.`);
      return true;
    }
    await message.reply({ embeds: [roundEmbed(session)] });
    return true;
  }

  if (sub === 'on' || sub === 'off') {
    if (!isAdmin(message)) return message.reply('Hanya moderator/admin yang bisa mengubah pengaturan.').then(() => true);
    const enabled = sub === 'on';
    updateGuildSettings(message.guildId, s => ({ ...s, family100: { ...s.family100, enabled } }));
    await message.reply(`Family 100 ${enabled ? 'diaktifkan' : 'dimatikan'}.`);
    return true;
  }

  if (sub && sub !== 'mulai' && sub !== 'start' && sub !== '') {
    await message.reply(helpText(prefix));
    return true;
  }

  // Mulai ronde.
  const active = sessions.get(message.guildId);
  if (active && !active.ended) {
    await message.reply(`Masih ada sesi Family 100 aktif di <#${active.channelId}>. Selesaikan atau hentikan dulu dengan \`${prefix}f100 stop\`.`);
    return true;
  }
  if (cfg.enabled === false) {
    await message.reply(`Family 100 sedang dimatikan. Aktifkan dengan \`${prefix}f100 on\`.`);
    return true;
  }
  if (cfg.channelId && cfg.channelId !== message.channelId) {
    await message.reply(`Family 100 hanya boleh dijalankan di <#${cfg.channelId}>.`);
    return true;
  }

  const session = startRound(message.guildId, message.channelId);
  session.startedBy = message.author.id;
  const sent = await message.reply({ embeds: [roundEmbed(session)] });
  session.messageId = sent?.id || null;
  scheduleTimeout(message.client, session);
  return true;
}

async function handleNavigation(interaction) {
  const [, type, action] = String(interaction.customId).split(':');
  const kind = type === 'alltime' ? 'alltime' : 'weekly';
  const footer = interaction.message?.embeds?.[0]?.data?.footer?.text || '';
  const current = Number((footer.match(/Halaman (\d+)\//) || [])[1]) || 1;
  const total = leaderboardView(interaction.guildId, kind, current).totalPages;
  const target = action === 'first' ? 1 : action === 'last' ? total : action === 'prev' ? current - 1 : current + 1;
  const next = leaderboardView(interaction.guildId, kind, target);
  await interaction.update({ embeds: [next.embed], components: [navRow(kind)] });
}

function helpText(prefix) {
  return [
    `**Family 100** — ${bank.count()} soal, total 100 poin per soal.`,
    `\`${prefix}f100\` — mulai ronde di channel ini`,
    `\`${prefix}f100 stop\` — hentikan ronde`,
    `\`${prefix}f100 skip\` — lewati ke soal berikutnya (admin)`,
    `\`${prefix}f100 status\` — lihat soal & progres ronde`,
    `\`${prefix}f100 lb [all]\` — leaderboard mingguan/all-time`,
    `\`${prefix}f100 on|off\` — aktifkan/matikan (admin)`
  ].join('\n');
}

module.exports = {
  handleCommand, handleMessage, handleNavigation, isF100Nav, navRow, helpText,
  leaderboardView, roundEmbed, pointsFor, weekRange, dayKey,
  sessions, startRound, endRound, matchAnswer
};
