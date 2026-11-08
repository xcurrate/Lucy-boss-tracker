const { EmbedBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getGuildSettings, updateGuildSettings, DEFAULT_PREFIX, matchPrefix } = require('../utils/storage');
const store = require('../utils/lucyCounterStorage');

const WIB = 'Asia/Jakarta';
const DEFAULT_TARGET_MESSAGE = '🎉 Target Lucy tercapai!';
const DEFAULT_TARGET_START = '12:00';
const DEFAULT_TARGET_STOP = '10:00';

function dayKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: WIB, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function timeParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: WIB, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return { hour: Number(p.hour), minute: Number(p.minute), minutes: Number(p.hour) * 60 + Number(p.minute) };
}
function previousDayKey(key) {
  const d = new Date(key + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
function targetSchedule(config = {}) {
  const parse = (value, fallback) => {
    const parts = String(value || fallback).split(':').map(Number);
    if (parts.length !== 2 || !Number.isInteger(parts[0]) || !Number.isInteger(parts[1]) || parts[0] < 0 || parts[0] > 23 || parts[1] < 0 || parts[1] > 59) return null;
    return parts[0] * 60 + parts[1];
  };
  return { startMinutes: parse(config.targetStartTime, DEFAULT_TARGET_START), stopMinutes: parse(config.targetStopTime, DEFAULT_TARGET_STOP) };
}
function challengeCycleKey(date = new Date(), config = {}) {
  const today = dayKey(date);
  return timeParts(date).minutes >= targetSchedule(config).startMinutes ? today : previousDayKey(today);
}
function isTargetWindow(date, config = {}) {
  const now = timeParts(date).minutes;
  const { startMinutes, stopMinutes } = targetSchedule(config);
  if (startMinutes === null || stopMinutes === null || startMinutes === stopMinutes) return false;
  return startMinutes > stopMinutes
    ? now >= startMinutes || now < stopMinutes
    : now >= startMinutes && now < stopMinutes;
}
function countLucy(content) { return /\blucy\b/i.test(String(content || '')) ? 1 : 0; }

// Nama bulan Indonesia untuk parsing tanggal gaya `5 nov` / `5 november`.
const MONTHS_ID = {
  jan: '01', januari: '01', feb: '02', februari: '02', mar: '03', maret: '03',
  apr: '04', april: '04', mei: '05', may: '05', jun: '06', juni: '06',
  jul: '07', juli: '07', agu: '08', agustus: '08', aug: '08',
  sep: '09', september: '09', okt: '10', oktober: '10', oct: '10',
  nov: '11', november: '11', des: '12', desember: '12', dec: '12'
};
const MONTHS_ID_LABEL = ['jan', 'feb', 'mar', 'apr', 'mei', 'jun', 'jul', 'agu', 'sep', 'okt', 'nov', 'des'];

// Format tanggal tampilan: `5 nov 2026`.
function formatIndonesianDate(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!m) return String(key || '');
  return Number(m[3]) + ' ' + MONTHS_ID_LABEL[Number(m[2]) - 1] + ' ' + m[1];
}

// Terima `5 nov`, `5 november 2026`, `5/11/2026`, atau `2026-11-05`.
// Tahun opsional: tanpa tahun dipakai tahun dari `today` (acuan WIB).
// Mengembalikan key YYYY-MM-DD, atau null bila tidak valid.
function parseIndonesianDate(input, today = new Date()) {
  const text = String(input || '').trim().toLowerCase();
  if (!text) return null;
  const fallbackYear = dayKey(today).slice(0, 4);
  const build = (day, month, year) => {
    const d = Number(day);
    const mo = Number(month);
    const y = Number(year);
    if (!Number.isInteger(d) || !Number.isInteger(mo) || !Number.isInteger(y)) return null;
    if (d < 1 || d > 31 || mo < 1 || mo > 12 || y < 1970 || y > 9999) return null;
    const key = String(y).padStart(4, '0') + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    const check = new Date(key + 'T00:00:00Z');
    if (Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== key) return null;
    return key;
  };

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (m) return build(m[3], m[2], m[1]);

  m = /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{4}))?$/.exec(text);
  if (m) return build(m[1], m[2], m[3] || fallbackYear);

  m = /^(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?$/.exec(text);
  if (m) {
    const month = MONTHS_ID[m[2]];
    if (!month) return null;
    return build(m[1], month, m[3] || fallbackYear);
  }
  return null;
}

// Ambil tanggal dari daftar argumen. Mengembalikan { date, rest, invalid }:
// - date    : key YYYY-MM-DD bila ada tanggal valid, selain itu null
// - rest    : argumen tanpa token tanggal (mis. nomor halaman)
// - invalid : teks yang menyerupai tanggal tapi tidak valid (mis. `32 nov`)
function extractDateArg(args) {
  const list = (Array.isArray(args) ? args : [args]).filter(a => a != null && a !== '');
  const rest = [];
  let date = null;
  let invalid = null;
  for (let i = 0; i < list.length; i++) {
    if (!date) {
      const hit = matchDateAt(list, i);
      if (hit) { date = hit.key; i += hit.len - 1; continue; }
      if (!invalid) {
        const shape = dateShapeAt(list, i);
        if (shape) { invalid = shape; i += shape.split(' ').length - 1; continue; }
      }
    }
    rest.push(list[i]);
  }
  return { date, rest, invalid };
}

// Coba cocokkan tanggal pada posisi i, dari bentuk terpanjang (3 token) ke
// terpendek (1 token), mis. `5 nov 2026`, `5 nov`, `5/11/2026`.
function matchDateAt(list, i) {
  const candidates = [];
  if (list[i + 2] != null) candidates.push({ text: list[i] + ' ' + list[i + 1] + ' ' + list[i + 2], len: 3 });
  if (list[i + 1] != null) candidates.push({ text: list[i] + ' ' + list[i + 1], len: 2 });
  candidates.push({ text: list[i], len: 1 });
  for (const c of candidates) {
    const key = parseIndonesianDate(c.text);
    if (key) return { key, len: c.len };
  }
  return null;
}

// Teks yang menyerupai tanggal tetapi tidak bisa diparse — hanya dipakai untuk
// memberi pesan kesalahan, bukan untuk membaca data.
function dateShapeAt(list, i) {
  const candidates = [];
  if (list[i + 2] != null) candidates.push(list[i] + ' ' + list[i + 1] + ' ' + list[i + 2]);
  if (list[i + 1] != null) candidates.push(list[i] + ' ' + list[i + 1]);
  candidates.push(list[i]);
  for (const text of candidates) if (looksLikeDate(text)) return text;
  return null;
}

function looksLikeDate(text) {
  const t = String(text || '').trim().toLowerCase();
  const monthForm = /^(\d{1,2})\s+([a-z]{3,9})(?:\s+\d{4})?$/.exec(t);
  if (monthForm) {
    const word = monthForm[2];
    return Object.hasOwn(MONTHS_ID, word) || MONTHS_ID_LABEL.some(x => word.startsWith(x) || x.startsWith(word));
  }
  return /^\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?$/.test(t) || /^\d{4}-\d{1,2}-\d{1,2}$/.test(t);
}
function total(user, day) {
  return Object.entries(user.days || {}).filter(([key]) => !day || key === day).reduce((sum, [, n]) => sum + n, 0);
}
function ranking(guild, day) {
  return Object.entries(guild.users).map(([id, u]) => ({ id, name: u.name || id, count: total(u, day) }))
    .filter(x => x.count > 0).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
const LEADERBOARD_PAGE_SIZE = 10;
function pageRows(rows, page = 1) {
  const totalPages = Math.max(1, Math.ceil(rows.length / LEADERBOARD_PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const start = (currentPage - 1) * LEADERBOARD_PAGE_SIZE;
  return { rows: rows.slice(start, start + LEADERBOARD_PAGE_SIZE), page: currentPage, totalPages, total: rows.length };
}
function formatLeaderboard(rows, page, emptyText, footerLabel) {
  const result = pageRows(rows, page);
  const medals = ['🥇', '🥈', '🥉'];
  const offset = (result.page - 1) * LEADERBOARD_PAGE_SIZE;
  const desc = result.rows.length
    ? result.rows.map((r, i) => (medals[offset + i] || (offset + i + 1) + '.') + ' **' + r.count.toLocaleString('id-ID') + '** — ' + r.name).join('\n')
    : emptyText;
  return {
    description: desc,
    footer: `${footerLabel} • Halaman ${result.page}/${result.totalPages} • ${result.total} peserta`,
    page: result.page,
    totalPages: result.totalPages
  };
}
function dailyLeaderboardView(guild, day, allTime = false, page = 1) {
  const rows = ranking(guild, allTime ? null : day);
  const formatted = formatLeaderboard(rows, page, 'Belum ada data Lucy yang terhitung.', allTime ? 'All-time' : 'Harian');
  const embed = new EmbedBuilder().setColor(0xFEE75C)
    .setTitle(allTime ? 'All-Time Server Lucy Leaderboard' : 'Daily Server Lucy Leaderboard')
    .setDescription(formatted.description)
    .setFooter({ text: formatted.footer + ' • ' + (allTime ? 'semua tanggal' : formatIndonesianDate(day)) });
  return { embed, page: formatted.page, totalPages: formatted.totalPages };
}
function leaderboardEmbed(guild, day, allTime = false, page = 1) {
  return dailyLeaderboardView(guild, day, allTime, page).embed;
}
function targetRanking(guild, cycleKey) {
  return Object.entries(guild.users).map(([id, user]) => ({
    id, name: user.name || id,
    count: user.challengeDayKey === cycleKey ? Number(user.challengeCount || 0) : 0
  })).filter(row => row.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// Pilih sumber data target: siklus yang sedang berjalan dibaca dari state user
// (paling mutakhir), siklus lama dibaca dari riwayat lucy_target_daily.
function targetDataFor(guild, cycle, currentCycle, guildId) {
  if (cycle === currentCycle || !guildId) return guild;
  return store.getTargetCounts(guildId, cycle);
}

function targetLeaderboardView(guild, config, page = 1, date = new Date(), { guildId = null, cycle = null } = {}) {
  const currentCycle = challengeCycleKey(new Date(), config);
  const targetCycle = cycle || challengeCycleKey(date, config);
  const data = targetDataFor(guild, targetCycle, currentCycle, guildId);
  const rows = targetRanking(data, targetCycle);
  const formatted = formatLeaderboard(rows, page, 'Belum ada progres Target Lucy pada siklus ini.', 'Target Lucy');
  const embed = new EmbedBuilder().setColor(0x57F287).setTitle('Lucy Target Leaderboard')
    .setDescription(formatted.description)
    .setFooter({ text: formatted.footer + ' • Siklus ' + formatIndonesianDate(targetCycle) + ' (WIB)' });
  return { embed, page: formatted.page, totalPages: formatted.totalPages, cycle: targetCycle };
}
function targetLeaderboardEmbed(guild, config, page = 1, date = new Date()) {
  return targetLeaderboardView(guild, config, page, date).embed;
}
function serverRanking(all, client, day = null) {
  return Object.entries(all).map(([guildId, data]) => {
    const count = Object.values(data.users || {}).reduce((sum, user) => sum + total(user, day), 0);
    const guild = client?.guilds?.cache?.get(guildId);
    return { id: guildId, name: guild?.name || ('Server ' + guildId), count };
  }).filter(row => row.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
function serverLeaderboardView(all, client, page = 1, day = null) {
  const rows = serverRanking(all, client, day);
  const formatted = formatLeaderboard(rows, page, day
    ? 'Belum ada data Lucy dari server mana pun pada tanggal ini.'
    : 'Belum ada data Lucy dari server mana pun.', day ? 'Per server' : 'All-time per server');
  const embed = new EmbedBuilder().setColor(0x5865F2)
    .setTitle(day ? 'Server Lucy Leaderboard' : 'All-Time Lucy Server Leaderboard')
    .setDescription(formatted.description)
    .setFooter({ text: formatted.footer + ' • ' + (day ? formatIndonesianDate(day) : 'semua tanggal') });
  return { embed, page: formatted.page, totalPages: formatted.totalPages };
}
function serverLeaderboardEmbed(all, client, page = 1, day = null) {
  return serverLeaderboardView(all, client, page, day).embed;
}

// Tombol navigasi halaman leaderboard. customId memuat tipe, tanggal (`-` bila
// tidak difilter), dan halaman tujuan, mis. "lcnav:daily:2026-11-05:3", sehingga
// tiap klik memuat ulang data terbaru dari SQLite dengan tanggal yang sama.
const LUCY_NAV = 'lcnav';
const NAV_BUTTONS = [
  { action: 'first', label: '⏮️', style: ButtonStyle.Secondary },
  { action: 'prev', label: '◀️', style: ButtonStyle.Primary },
  { action: 'next', label: '▶️', style: ButtonStyle.Primary },
  { action: 'last', label: '⏭️', style: ButtonStyle.Secondary }
];
function navRow(type, date = null) {
  const buttons = NAV_BUTTONS.map(b => new ButtonBuilder()
    .setCustomId(`${LUCY_NAV}:${type}:${date || '-'}:${b.action}`)
    .setLabel(b.label)
    .setStyle(b.style));
  return new ActionRowBuilder().addComponents(...buttons);
}
function buildLeaderboard(type, page, client) {
  const guildId = client.guildId;
  const date = client.date || null;
  if (type === 'target') {
    const view = targetLeaderboardView(store.getGuildData(guildId), client.config, page, new Date(), { guildId, cycle: date });
    return { embed: view.embed, totalPages: view.totalPages, page: view.page };
  }
  if (type === 'servers') {
    const view = serverLeaderboardView(store.getAllData(), client, page, date);
    return { embed: view.embed, totalPages: view.totalPages, page: view.page };
  }
  const allTime = type === 'alltime';
  const view = dailyLeaderboardView(store.getGuildData(guildId), date || dayKey(), allTime, page);
  return { embed: view.embed, totalPages: view.totalPages, page: view.page };
}
function isLucyNav(customId) {
  return typeof customId === 'string' && customId.startsWith(LUCY_NAV + ':');
}
// Dipanggil dari handler interaksi. Selalu membaca ulang SQLite agar jumlah Lucy
// yang tampil sinkron dengan data terbaru. Mengembalikan false bila bukan tombolnya.
async function handleNavigation(i, deps = {}) {
  if (!isLucyNav(i.customId)) return false;
  const [, type, dateToken, action] = i.customId.split(':');
  const date = dateToken && dateToken !== '-' ? dateToken : null;
  const getSettings = deps.getSettings || getGuildSettings;
  const config = getSettings(i.guildId).lucyCounter;
  const client = { guildId: i.guildId, guilds: i.client?.guilds, config, date };
  const embed = i.message?.embeds?.[0];
  const footerText = embed?.footer?.text || embed?.data?.footer?.text || '';
  const currentPage = Number(footerText.match(/Halaman (\d+)\//)?.[1] || 1);
  const current = buildLeaderboard(type, currentPage, client);
  const target = action === 'first' ? 1
    : action === 'last' ? current.totalPages
    : action === 'prev' ? Math.max(1, current.page - 1)
    : Math.min(current.totalPages, current.page + 1);
  const view = buildLeaderboard(type, target, client);
  await i.update({ embeds: [view.embed], components: [navRow(type, date)] });
  return true;
}
function parsePage(value) {
  if (value === undefined || value === null || value === '') return 1;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

function admin(message) { return Boolean(message.member?.permissions?.has(PermissionFlagsBits.ManageGuild)); }
async function handleCommand(message) {
  if (!message.guildId || message.author?.bot) return false;
  const settings = getGuildSettings(message.guildId);
  const config = settings.lucyCounter;
  const prefix = settings.prefix || DEFAULT_PREFIX;
  const text = message.content.trim();
  const rest = matchPrefix(text, prefix);
  if (rest === null) return false;
  const commandParts = rest.trim().split(/\s+/);
  const command = (commandParts[0] || '').toLowerCase();
  const subcommand = (commandParts[1] || '').toLowerCase();
  const badDate = value => message.reply(`Tanggal tidak dikenali: **${value}**. Contoh: \`${prefix}lcount 5 nov\`.`);
  if (['lcount', 'lcountd', 'lcountall', 'lucycount'].includes(command) ||
      (command === 'lucy' && subcommand === 'count')) {
    const allTime = command === 'lcountall';
    const type = allTime ? 'alltime' : 'daily';
    const { date, rest, invalid } = extractDateArg(command === 'lucy' ? commandParts.slice(2) : commandParts.slice(1));
    if (invalid) return badDate(invalid);
    // All-time selalu memakai seluruh tanggal, jadi argumen tanggal diabaikan.
    const day = allTime ? dayKey() : (date || dayKey());
    const view = dailyLeaderboardView(store.getGuildData(message.guildId), day, allTime, parsePage(rest[0]));
    await message.reply({ embeds: [view.embed], components: [navRow(type, allTime ? null : day)], allowedMentions: { parse: [] } });
    return true;
  }
  if (['ltarget', 'ltargetlb'].includes(command) ||
      (command === 'lucytarget' && (subcommand === '' || subcommand === 'leaderboard' || /^\d+$/.test(subcommand)))) {
    const raw = commandParts.slice(1).filter(a => a.toLowerCase() !== 'leaderboard');
    const { date, rest, invalid } = extractDateArg(raw);
    if (invalid) return badDate(invalid);
    const cycle = date || challengeCycleKey(new Date(), config);
    const view = targetLeaderboardView(store.getGuildData(message.guildId), config, parsePage(rest[0]), new Date(), { guildId: message.guildId, cycle });
    await message.reply({ embeds: [view.embed], components: [navRow('target', cycle)], allowedMentions: { parse: [] } });
    return true;
  }
  if (['lservers', 'lserver', 'lserverlb'].includes(command)) {
    const { date, rest, invalid } = extractDateArg(commandParts.slice(1));
    if (invalid) return badDate(invalid);
    const view = serverLeaderboardView(store.getAllData(), message.client, parsePage(rest[0]), date);
    await message.reply({ embeds: [view.embed], components: [navRow('servers', date)], allowedMentions: { parse: [] } });
    return true;
  }

  // Sisa subperintah di bawah hanya milik `lucytarget`; perintah lain (mis. `d status`)
  // harus dilepas agar tidak ditangani ganda oleh handler prefix boss.
  if (command !== 'lucytarget') return false;

  const parts = rest.trim().split(/\s+/);
  const sub = (parts[1] || '').toLowerCase();
  const targetSub = (parts[2] || '').toLowerCase();
  if (sub === 'status') {
    const data = store.getGuildData(message.guildId);
    const totalCount = ranking(data, null).reduce((n, r) => n + r.count, 0);
    const today = challengeCycleKey(new Date(), config);
    const memberData = data.users[message.author.id];
    const progress = memberData && memberData.challengeDayKey === today ? Number(memberData.challengeCount) || 0 : 0;
    if (!memberData || memberData.challengeDayKey !== today) {
      store.resetChallenge(message.guildId, message.author.id, message.member?.displayName || message.author.username, today);
    }
    const schedule = targetSchedule(config);
    const fmt = n => String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
    return message.reply({ content: `🎯 Target Lucy: **${config.targetEnabled ? 'ON' : 'OFF'}** • Target per orang: **${config.targetGoal || 0}** • Progres kamu siklus ini: **${progress}/${config.targetGoal || 0}** • Jadwal WIB: **${fmt(schedule.startMinutes)}–${fmt(schedule.stopMinutes)}** • Status jadwal: **${isTargetWindow(new Date(), config) ? 'AKTIF' : 'ISTIRAHAT'}** • Total Lucy server (semua anggota): **${totalCount}**`, allowedMentions: { parse: [] } });
  }
  if (!admin(message)) return message.reply('Pengaturan Lucy hanya untuk moderator/admin dengan izin Manage Server.');

  if (sub === 'on' || sub === 'off') {
    updateGuildSettings(message.guildId, s => ({ ...s, lucyCounter: { ...s.lucyCounter, enabled: sub === 'on' } }));
    return message.reply(`Lucy Counter ${sub === 'on' ? 'diaktifkan' : 'dimatikan'} untuk server ini.`);
  }
  if (sub === 'target' && (targetSub === 'on' || targetSub === 'off')) {
    updateGuildSettings(message.guildId, s => ({ ...s, lucyCounter: { ...s.lucyCounter, targetEnabled: targetSub === 'on' } }));
    return message.reply(`Target Lucy ${targetSub === 'on' ? 'diaktifkan' : 'dimatikan'}.`);
  }
  if (sub === 'set') {
    const goal = Number(parts[2]);
    if (!Number.isSafeInteger(goal) || goal < 1) return message.reply(`Format: ${prefix}lucytarget set <jumlah>`);
    updateGuildSettings(message.guildId, s => ({ ...s, lucyCounter: { ...s.lucyCounter, targetGoal: goal } }));
    return message.reply(`Target Lucy disetel ke ${goal}.`);
  }
  if (sub === 'message') {
    const value = parts.slice(2).join(' ').trim();
    if (!value || value.length > 1500) return message.reply(`Format: ${prefix}lucytarget message <pesan>`);
    updateGuildSettings(message.guildId, s => ({ ...s, lucyCounter: { ...s.lucyCounter, targetMessage: value } }));
    return message.reply('Pesan target tercapai berhasil disimpan.');
  }
  return message.reply('Perintah Target: ' + prefix + ' lucytarget on|off|target on|off|set <jumlah>|message <pesan>|status|leaderboard [tanggal] [halaman]\nLeaderboard: ' + prefix + ' lcount [tanggal] [halaman] (harian), ' + prefix + ' lcountall [halaman] (all-time), ' + prefix + ' ltarget [tanggal] [halaman] (alias: ' + prefix + ' ltargetlb / ' + prefix + ' lucytarget leaderboard), ' + prefix + ' lservers [tanggal] [halaman] (alias: ' + prefix + ' lserver).\nTanggal: `5 nov`, `5 november 2026`, `5/11/2026`, atau `2026-11-05` — contoh: `' + prefix + ' lcount 5 nov`.');
}
async function handleMessage(message) {
  if (!message.guildId || message.author?.bot || !message.content) return;
  if (await handleCommand(message)) return;
  const prefix = getGuildSettings(message.guildId).prefix || DEFAULT_PREFIX;
  const matched = matchPrefix(message.content.trim(), prefix);
  if (matched !== null && /^\s*(?:lcountd|lcountall|lcount|lucycount|lucy\s+count|ltarget|ltargetlb|lservers|lserver|lserverlb|lucytarget)(?:\s|$)/i.test(matched)) return;

  const settings = getGuildSettings(message.guildId);
  const config = settings.lucyCounter;
  const blacklistedChannelIds = config.blacklistedChannelIds || [];
  const whitelistedChannelIds = config.whitelistedChannelIds || [];
  if (!config.enabled || blacklistedChannelIds.includes(message.channelId)) return;
  if (whitelistedChannelIds.length > 0 && !whitelistedChannelIds.includes(message.channelId)) return;
  if (!countLucy(message.content)) return;

  const currentSettings = getGuildSettings(message.guildId);
  const currentConfig = currentSettings.lucyCounter;
  if (!currentConfig.enabled) return;

  // Per-person cooldown in this server: each member has an independent 10-second cooldown.
  const messageTime = message.createdTimestamp || Date.now();
  const displayName = message.member?.displayName || message.author.username;
  const lastLucyAt = store.getLastAcceptedAt(message.guildId, message.author.id);
  if (messageTime - lastLucyAt < 10000) return;

  store.markAccepted(message.guildId, message.author.id, displayName, messageTime);

  try { await message.react('✅'); } catch (error) {
    console.warn('[LucyCounter] Gagal memberi reaksi verifikasi:', error.message);
    return;
  }

  // Target progress is tracked independently for each person and resets at the start of each cycle.
  // It only counts accepted Lucy messages within the configured daily start/stop window.
  const day = dayKey(new Date(messageTime));
  const cycleKey = challengeCycleKey(new Date(messageTime), currentConfig);
  const targetActive = currentConfig.targetEnabled && currentConfig.targetGoal > 0 && isTargetWindow(new Date(messageTime), currentConfig);
  const result = store.recordLucy({
    guildId: message.guildId, userId: message.author.id, name: displayName,
    day, cycleKey, targetActive, goal: currentConfig.targetGoal
  });

  if (result.notifiedNow) {
    const channel = currentConfig.targetChannelId ? await message.guild.channels.fetch(currentConfig.targetChannelId).catch(() => null) : message.channel;
    const targetMessage = currentConfig.targetMessage || DEFAULT_TARGET_MESSAGE;
    const report = `🎯 **${displayName}** mencapai target Lucy pribadi (${result.challengeCount}/${currentConfig.targetGoal})!\n${targetMessage}`;
    if (channel?.isTextBased()) await channel.send({ content: report, allowedMentions: { parse: [] } }).catch(() => {});
  }
}
module.exports = { handleMessage, handleCommand, handleNavigation, isLucyNav, navRow, buildLeaderboard, countLucy, dayKey, parseIndonesianDate, formatIndonesianDate, extractDateArg, leaderboardEmbed, dailyLeaderboardView, targetLeaderboardEmbed, targetLeaderboardView, serverLeaderboardEmbed, serverLeaderboardView, ranking, targetRanking, serverRanking, pageRows, LEADERBOARD_PAGE_SIZE, targetSchedule, challengeCycleKey, isTargetWindow };
