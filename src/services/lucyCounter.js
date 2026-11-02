const fs = require('node:fs');
const path = require('node:path');
const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { getGuildSettings, updateGuildSettings } = require('../utils/storage');

const file = path.resolve(process.cwd(), 'data', 'lucy-counter.json');
const WIB = 'Asia/Jakarta';
const DEFAULT_TARGET_MESSAGE = '🎉 Target Lucy tercapai!';

function read() {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
function write(data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
function dayKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: WIB, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function guildData(all, guildId) {
  if (!all[guildId]) all[guildId] = { users: {}, challengeKey: '', challengeCount: 0, notified: false };
  const g = all[guildId];
  g.users ||= {};
  g.challengeKey ||= '';
  g.challengeCount ||= 0;
  g.notified ||= false;
  return g;
}
function countLucy(content) { return (String(content || '').match(/\blucy\b/gi) || []).length; }
function total(user, day) {
  return Object.entries(user.days || {}).filter(([key]) => !day || key === day).reduce((sum, [, n]) => sum + n, 0);
}
function ranking(guild, day) {
  return Object.entries(guild.users).map(([id, u]) => ({ id, name: u.name || id, count: total(u, day) }))
    .filter(x => x.count > 0).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 25);
}
function leaderboardEmbed(guild, day, allTime = false) {
  const rows = ranking(guild, allTime ? null : day);
  const medals = ['🥇', '🥈', '🥉'];
  const desc = rows.length ? rows.map((r, i) => `${medals[i] || (i + 1) + '.'} ${r.count} - ${r.name}`).join('\n') : 'Belum ada data Lucy yang terhitung.';
  return new EmbedBuilder().setColor(0xFEE75C).setTitle('Daily Server Lucy Leaderboard')
    .setDescription(desc).setFooter({ text: `${allTime ? 'Sepanjang masa' : 'Harian'} • ${dayKey()}` });
}
function admin(message) { return Boolean(message.member?.permissions?.has(PermissionFlagsBits.ManageGuild)); }
function toWibTimestamp(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value || '')) return null;
  const timestamp = Date.parse(value + ':00+07:00');
  return Number.isFinite(timestamp) ? timestamp : null;
}
function challengeKey(config) {
  return [config.targetGoal, config.challengeStartAt, config.challengeEndAt].join('|');
}
function inChallenge(messageTimestamp, config) {
  const start = toWibTimestamp(config.challengeStartAt);
  const end = toWibTimestamp(config.challengeEndAt);
  return start !== null && end !== null && end > start && messageTimestamp >= start && messageTimestamp <= end;
}
async function handleCommand(message) {
  if (!message.guildId || message.author?.bot) return false;
  const settings = getGuildSettings(message.guildId);
  const config = settings.lucyCounter;
  const prefix = settings.prefix || '!';
  const text = message.content.trim();
  const lower = text.toLowerCase();
  const leaderboardCommands = [prefix + 'lcount', prefix + 'lcountd', prefix + 'lcountall', prefix + 'lucy count'];
  if (![...leaderboardCommands, prefix + 'lucytarget'].some(c => lower === c || lower.startsWith(c + ' '))) return false;

  if (leaderboardCommands.includes(lower)) {
    const data = guildData(read(), message.guildId);
    await message.reply({ embeds: [leaderboardEmbed(data, dayKey(), lower.endsWith('all'))], allowedMentions: { parse: [] } });
    return true;
  }

  const parts = text.slice(prefix.length).trim().split(/\s+/);
  const sub = (parts[1] || '').toLowerCase();
  const targetSub = (parts[2] || '').toLowerCase();
  if (sub === 'status') {
    const data = guildData(read(), message.guildId);
    const totalCount = ranking(data, null).reduce((n, r) => n + r.count, 0);
    const start = config.challengeStartAt ? config.challengeStartAt.replace('T', ' ') + ' WIB' : 'belum diatur';
    const end = config.challengeEndAt ? config.challengeEndAt.replace('T', ' ') + ' WIB' : 'belum diatur';
    return message.reply({ content: `🎯 Target Lucy: **${config.targetEnabled ? 'ON' : 'OFF'}** • Target: **${config.targetGoal || 0}** • Progress challenge: **${data.challengeCount || 0}/${config.targetGoal || 0}** • Total Lucy terhitung: **${totalCount}**\nRentang challenge: ${start} – ${end}`, allowedMentions: { parse: [] } });
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
  return message.reply(`Perintah: ${prefix}lucytarget on|off|target on|off|set <jumlah>|message <pesan>|status`);
}
async function handleMessage(message) {
  if (!message.guildId || message.author?.bot || !message.content) return;
  if (await handleCommand(message)) return;
  const prefix = getGuildSettings(message.guildId).prefix || '!';
  if (message.content.startsWith(prefix) && /^\s*(?:lcountd|lcountall|lcount|lucy count|lucytarget)(?:\s|$)/i.test(message.content.slice(prefix.length))) return;

  const settings = getGuildSettings(message.guildId);
  const config = settings.lucyCounter;
  if (!config.enabled || !countLucy(message.content)) return;

  const count = countLucy(message.content);
  const currentSettings = getGuildSettings(message.guildId);
  const currentConfig = currentSettings.lucyCounter;
  if (!currentConfig.enabled) return;

  // Server-wide cooldown: accept a Lucy message only if at least 10 seconds passed
  // since the last accepted Lucy message. Reactions are added immediately.
  const all = read();
  const data = guildData(all, message.guildId);
  const messageTime = message.createdTimestamp || Date.now();
  const lastLucyAt = Number(data.lastLucyAcceptedAt || 0);
  if (messageTime - lastLucyAt < 10000) return;

  data.lastLucyAcceptedAt = messageTime;
  write(all);

  try { await message.react('✅'); } catch (error) {
    console.warn('[LucyCounter] Gagal memberi reaksi verifikasi:', error.message);
    return;
  }

  const today = dayKey(new Date(messageTime));
  const user = data.users[message.author.id] ||= { name: message.author.username, days: {} };
  user.name = message.member?.displayName || message.author.username;
  user.days[today] = (user.days[today] || 0) + count;

  // Counting/leaderboards are independent of target challenge state.
  const targetKey = challengeKey(currentConfig);
  if (data.challengeKey !== targetKey) {
    data.challengeKey = targetKey;
    data.challengeCount = 0;
    data.notified = false;
  }
  const targetTime = verifiedMessage.createdTimestamp || Date.now();
  if (currentConfig.targetEnabled && currentConfig.targetGoal > 0 && inChallenge(targetTime, currentConfig)) {
    data.challengeCount += count;
  }
  write(all);

  if (currentConfig.targetEnabled && currentConfig.targetGoal > 0 && data.challengeCount >= currentConfig.targetGoal && !data.notified && inChallenge(targetTime, currentConfig)) {
    data.notified = true;
    write(all);
    const channel = currentConfig.targetChannelId ? await verifiedMessage.guild.channels.fetch(currentConfig.targetChannelId).catch(() => null) : verifiedMessage.channel;
    if (channel?.isTextBased()) await channel.send({ content: currentConfig.targetMessage || DEFAULT_TARGET_MESSAGE, allowedMentions: { parse: [] } }).catch(() => {});
  }
}
module.exports = { handleMessage, handleCommand, countLucy, dayKey, leaderboardEmbed };
