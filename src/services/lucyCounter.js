const { EmbedBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getGuildSettings, updateGuildSettings } = require('../utils/storage');
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
    .setDescription(formatted.description).setFooter({ text: formatted.footer + ' • ' + dayKey() });
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
function targetLeaderboardView(guild, config, page = 1, date = new Date()) {
  const cycle = challengeCycleKey(date, config);
  const rows = targetRanking(guild, cycle);
  const formatted = formatLeaderboard(rows, page, 'Belum ada progres Target Lucy pada siklus ini.', 'Target Lucy');
  const embed = new EmbedBuilder().setColor(0x57F287).setTitle('Lucy Target Leaderboard')
    .setDescription(formatted.description)
    .setFooter({ text: formatted.footer + ' • Siklus mulai ' + cycle + ' (WIB)' });
  return { embed, page: formatted.page, totalPages: formatted.totalPages };
}
function targetLeaderboardEmbed(guild, config, page = 1, date = new Date()) {
  return targetLeaderboardView(guild, config, page, date).embed;
}
function serverRanking(all, client) {
  return Object.entries(all).map(([guildId, data]) => {
    const count = Object.values(data.users || {}).reduce((sum, user) => sum + total(user, null), 0);
    const guild = client?.guilds?.cache?.get(guildId);
    return { id: guildId, name: guild?.name || ('Server ' + guildId), count };
  }).filter(row => row.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
function serverLeaderboardView(all, client, page = 1) {
  const rows = serverRanking(all, client);
  const formatted = formatLeaderboard(rows, page, 'Belum ada data Lucy dari server mana pun.', 'All-time per server');
  const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('All-Time Lucy Server Leaderboard')
    .setDescription(formatted.description).setFooter({ text: formatted.footer });
  return { embed, page: formatted.page, totalPages: formatted.totalPages };
}
function serverLeaderboardEmbed(all, client, page = 1) {
  return serverLeaderboardView(all, client, page).embed;
}

// Tombol navigasi halaman leaderboard. customId memuat tipe & halaman tujuan,
// mis. "lcnav:daily:3", sehingga tiap klik bisa memuat data terbaru dari SQLite.
const LUCY_NAV = 'lcnav';
const NAV_BUTTONS = [
  { action: 'first', label: '⏮️', style: ButtonStyle.Secondary },
  { action: 'prev', label: '◀️', style: ButtonStyle.Primary },
  { action: 'next', label: '▶️', style: ButtonStyle.Primary },
  { action: 'last', label: '⏭️', style: ButtonStyle.Secondary }
];
function navRow(type, page, totalPages) {
  const atFirst = page <= 1;
  const atLast = page >= totalPages;
  const buttons = NAV_BUTTONS.map(b => {
    const disabled = (b.action === 'first' || b.action === 'prev') ? atFirst
      : (b.action === 'next' || b.action === 'last') ? atLast : false;
    return new ButtonBuilder()
      .setCustomId(`${LUCY_NAV}:${type}:${b.action}`)
      .setLabel(b.label)
      .setStyle(b.style)
      .setDisabled(disabled);
  });
  return new ActionRowBuilder().addComponents(...buttons);
}
function buildLeaderboard(type, page, client) {
  if (type === 'target') {
    const view = targetLeaderboardView(store.getGuildData(client.guildId), client.config, page);
    return { embed: view.embed, totalPages: view.totalPages, page: view.page };
  }
  if (type === 'servers') {
    const view = serverLeaderboardView(store.getAllData(), client, page);
    return { embed: view.embed, totalPages: view.totalPages, page: view.page };
  }
  const allTime = type === 'alltime';
  const view = dailyLeaderboardView(store.getGuildData(client.guildId), dayKey(), allTime, page);
  return { embed: view.embed, totalPages: view.totalPages, page: view.page };
}
function isLucyNav(customId) {
  return typeof customId === 'string' && customId.startsWith(LUCY_NAV + ':');
}
// Dipanggil dari handler interaksi. Selalu membaca ulang SQLite agar jumlah Lucy
// yang tampil sinkron dengan data terbaru. Mengembalikan false bila bukan tombolnya.
async function handleNavigation(i, deps = {}) {
  if (!isLucyNav(i.customId)) return false;
  const [, type, action] = i.customId.split(':');
  const getSettings = deps.getSettings || getGuildSettings;
  const config = getSettings(i.guildId).lucyCounter;
  const client = { guildId: i.guildId, guilds: i.client?.guilds, config };
  const embed = i.message?.embeds?.[0];
  const footerText = embed?.footer?.text || embed?.data?.footer?.text || '';
  const currentPage = Number(footerText.match(/Halaman (\d+)\//)?.[1] || 1);
  const current = buildLeaderboard(type, currentPage, client);
  const target = action === 'first' ? 1
    : action === 'last' ? current.totalPages
    : action === 'prev' ? Math.max(1, current.page - 1)
    : Math.min(current.totalPages, current.page + 1);
  const view = buildLeaderboard(type, target, client);
  await i.update({ embeds: [view.embed], components: [navRow(type, view.page, view.totalPages)] });
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
  const prefix = settings.prefix || '!';
  const text = message.content.trim();
  if (!text.startsWith(prefix)) return false;
  const lower = text.toLowerCase();
  const commandParts = text.slice(prefix.length).trim().split(/\s+/);
  const command = (commandParts[0] || '').toLowerCase();
  const subcommand = (commandParts[1] || '').toLowerCase();
  const page = parsePage(commandParts[command === 'lucy' ? 2 : 1]);
  if (['lcount', 'lcountd', 'lcountall', 'lucycount'].includes(command) ||
      (command === 'lucy' && subcommand === 'count')) {
    const allTime = command === 'lcountall';
    const type = allTime ? 'alltime' : 'daily';
    const view = dailyLeaderboardView(store.getGuildData(message.guildId), dayKey(), allTime, page);
    await message.reply({ embeds: [view.embed], components: [navRow(type, view.page, view.totalPages)], allowedMentions: { parse: [] } });
    return true;
  }
  if (['ltarget', 'ltargetlb'].includes(command) ||
      (command === 'lucytarget' && (subcommand === '' || subcommand === 'leaderboard' || /^\d+$/.test(subcommand)))) {
    const targetPage = command === 'lucytarget' && /^\d+$/.test(subcommand) ? parsePage(subcommand) : parsePage(commandParts[command === 'lucytarget' ? 2 : 1]);
    const view = targetLeaderboardView(store.getGuildData(message.guildId), config, targetPage);
    await message.reply({ embeds: [view.embed], components: [navRow('target', view.page, view.totalPages)], allowedMentions: { parse: [] } });
    return true;
  }
  if (['lservers', 'lserver', 'lserverlb'].includes(command)) {
    const view = serverLeaderboardView(store.getAllData(), message.client, page);
    await message.reply({ embeds: [view.embed], components: [navRow('servers', view.page, view.totalPages)], allowedMentions: { parse: [] } });
    return true;
  }

  // Sisa subperintah di bawah hanya milik `lucytarget`; perintah lain (mis. `boss status`)
  // harus dilepas agar tidak ditangani ganda oleh handler prefix boss.
  if (command !== 'lucytarget') return false;

  const parts = text.slice(prefix.length).trim().split(/\s+/);
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
  return message.reply('Perintah Target: ' + prefix + 'lucytarget on|off|target on|off|set <jumlah>|message <pesan>|status|leaderboard [halaman]\nLeaderboard: ' + prefix + 'lcount [halaman] (harian), ' + prefix + 'lcountall [halaman] (all-time), ' + prefix + 'ltarget [halaman] (alias: ' + prefix + 'ltargetlb / ' + prefix + 'lucytarget leaderboard), ' + prefix + 'lservers [halaman] (alias: ' + prefix + 'lserver).');
}
async function handleMessage(message) {
  if (!message.guildId || message.author?.bot || !message.content) return;
  if (await handleCommand(message)) return;
  const prefix = getGuildSettings(message.guildId).prefix || '!';
  if (message.content.startsWith(prefix) && /^\s*(?:lcountd|lcountall|lcount|lucycount|lucy\s+count|ltarget|ltargetlb|lservers|lserver|lserverlb|lucytarget)(?:\s|$)/i.test(message.content.slice(prefix.length))) return;

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
module.exports = { handleMessage, handleCommand, handleNavigation, isLucyNav, navRow, buildLeaderboard, countLucy, dayKey, leaderboardEmbed, dailyLeaderboardView, targetLeaderboardEmbed, targetLeaderboardView, serverLeaderboardEmbed, serverLeaderboardView, ranking, targetRanking, serverRanking, pageRows, LEADERBOARD_PAGE_SIZE, targetSchedule, challengeCycleKey, isTargetWindow };
