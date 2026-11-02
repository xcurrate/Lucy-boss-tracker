const fs = require('node:fs');
const path = require('node:path');
const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');

const file = path.resolve(process.cwd(), 'data', 'lucy-counter.json');
const WIB = 'Asia/Jakarta';
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
  return new Intl.DateTimeFormat('en-CA', { timeZone: WIB, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function guildData(all, guildId) {
  if (!all[guildId]) all[guildId] = { enabled: false, users: {}, targets: { goal: 0, message: '🎉 Target Lucy tercapai!', channelId: null, startAt: null, deadlineAt: null } };
  const g = all[guildId];
  g.users ||= {};
  g.targets ||= { goal: 0, message: '🎉 Target Lucy tercapai!', channelId: null, startAt: null, deadlineAt: null };
  return g;
}
function countLucy(content) { return (String(content || '').match(/\blucy\b/gi) || []).length; }
function validCount(content) { return countLucy(content); }
function total(user, day) {
  return Object.entries(user.days || {}).filter(([key]) => !day || key === day).reduce((sum, [, n]) => sum + n, 0);
}
function ranking(guild, day) {
  return Object.entries(guild.users).map(([id, u]) => ({ id, name: u.name || id, count: total(u, day) }))
    .filter(x => x.count > 0).sort((a,b) => b.count-a.count || a.name.localeCompare(b.name)).slice(0, 25);
}
function leaderboardEmbed(guild, day, allTime = false) {
  const rows = ranking(guild, allTime ? null : day);
  const medals = ['🥇','🥈','🥉'];
  const desc = rows.length ? rows.map((r,i) => `${medals[i] || (i+1)+'.'} ${r.count} - ${r.name}`).join('\n') : 'Belum ada data Lucy yang terhitung.';
  return new EmbedBuilder().setColor(0xFEE75C).setTitle('Daily Server Lucy Leaderboard')
    .setDescription(desc).setFooter({ text: `${allTime ? 'Sepanjang masa' : 'Harian'} • ${dayKey()}` });
}
function admin(message) { return Boolean(message.member?.permissions?.has(PermissionFlagsBits.ManageGuild)); }
async function handleCommand(message) {
  if (!message.guildId || message.author?.bot) return false;
  const all = read(), g = guildData(all, message.guildId);
  const prefix = require('../utils/storage').getGuildSettings(message.guildId).prefix || '!';
  const text = message.content.trim();
  const lower = text.toLowerCase();
  if (![prefix+'lcount', prefix+'lcountd', prefix+'lcountall', prefix+'lucy count', prefix+'lucytarget'].some(c => lower === c || lower.startsWith(c+' '))) return false;
  if ([prefix+'lcount', prefix+'lcountd', prefix+'lcountall', prefix+'lucy count'].includes(lower)) {
    await message.reply({ embeds: [leaderboardEmbed(g, dayKey(), lower.endsWith('all'))], allowedMentions: { parse: [] } });
    return true;
  }
  const parts = text.slice(prefix.length).trim().split(/\s+/);
  const sub = (parts[1] || '').toLowerCase();
  const t = g.targets;
  if (sub === 'status') {
    const count = ranking(g, null).reduce((n, r) => n + r.count, 0);
    return message.reply({ content: `🎯 Target Lucy: **${t.goal || 0}** • Total terhitung: **${count}**\nStatus: ${t.goal && count >= t.goal ? 'tercapai' : 'berjalan'}${t.startAt ? '\nMulai: '+new Date(t.startAt).toLocaleString('id-ID',{timeZone:WIB})+' WIB' : ''}${t.deadlineAt ? '\nBatas laporan: '+new Date(t.deadlineAt).toLocaleString('id-ID',{timeZone:WIB})+' WIB' : ''}`, allowedMentions: { parse: [] } });
  }
  if (!admin(message)) return message.reply('Pengaturan Lucy hanya untuk moderator/admin dengan izin Manage Server.');
  if (sub === 'on' || sub === 'off') {
    g.enabled = sub === 'on'; write(all);
    return message.reply(`Lucy Counter ${g.enabled ? 'diaktifkan' : 'dimatikan'} untuk server ini.`);
  }
  if (sub === 'message') {
    const value = parts.slice(2).join(' ').trim();
    if (!value || value.length > 1500) return message.reply(`Format: ${prefix}lucytarget message <pesan>`);
    t.message = value; write(all); return message.reply('Pesan target tercapai berhasil disimpan.');
  }
  if (sub === 'set') {
    const goal = Number(parts[2]);
    if (!Number.isSafeInteger(goal) || goal < 1) return message.reply(`Format: ${prefix}lucytarget set <jumlah>`);
    t.goal = goal; t.notified = false; write(all); return message.reply(`Target Lucy disetel ke ${goal}.`);
  }
  if (sub === 'challenge') {
    const goal = Number(parts[2]), start = parts[3], deadline = parts[4], channelId = (parts[5] || '').match(/^<#?(\d+)>?$/)?.[1];
    const parse = (time) => {
      if (!/^\d{2}:\d{2}$/.test(time || '')) return null;
      const [h,m] = time.split(':').map(Number); if (h>23 || m>59) return null;
      const now = new Date(), parts = new Intl.DateTimeFormat('en-CA',{timeZone:WIB,year:'numeric',month:'2-digit',day:'2-digit'}).format(now).split('-');
      return new Date(`${parts[0]}-${parts[1]}-${parts[2]}T${time}:00+07:00`).getTime();
    };
    const startAt = parse(start), deadlineAt = parse(deadline);
    if (!Number.isSafeInteger(goal) || goal<1 || !startAt || !deadlineAt || deadlineAt<=startAt || !channelId) return message.reply(`Format: ${prefix}lucytarget challenge <jumlah> <mulai-HH:mm> <batas-HH:mm> #channel (WIB hari ini)`);
    t.goal = goal; t.startAt = startAt; t.deadlineAt = deadlineAt; t.channelId = channelId; t.notified = false; write(all);
    return message.reply('Challenge disimpan. Waktu challenge tidak mengubah reset leaderboard harian.');
  }
  return message.reply(`Perintah: ${prefix}lucytarget on|off|set <jumlah>|message <pesan>|challenge <jumlah> <mulai-HH:mm> <batas-HH:mm> #channel|status`);
}
async function handleMessage(message) {
  if (!message.guildId || message.author?.bot || !message.content) return;
  const all = read(), g = guildData(all, message.guildId);
  const prefix = require('../utils/storage').getGuildSettings(message.guildId).prefix || '!';
  if (await handleCommand(message)) return;
  if (/^\s*(?:lcountd|lcountall|lcount)$/i.test(message.content.slice(prefix.length).trim()) && message.content.startsWith(prefix)) return;
  if (!g.enabled || !/\blucy\b/i.test(message.content)) return;
  const count = validCount(message.content);
  if (!count) return;
  try { await message.react('✅'); } catch {}
  await new Promise(resolve => setTimeout(resolve, 10000));
  const current = read(), currentGuild = guildData(current, message.guildId);
  if (!currentGuild.enabled) return;
  const today = dayKey();
  const user = currentGuild.users[message.author.id] ||= { name: message.author.username, days: {} };
  user.name = message.member?.displayName || message.author.username;
  user.days[today] = (user.days[today] || 0) + count;
  const target = currentGuild.targets;
  const totalCount = ranking(currentGuild, null).reduce((n, row) => n + row.count, 0);
  write(current);
  if (target.goal > 0 && !target.notified && totalCount >= target.goal) {
    target.notified = true; write(current);
    const channel = target.channelId ? await message.guild.channels.fetch(target.channelId).catch(() => null) : message.channel;
    if (channel?.isTextBased()) await channel.send({ content: target.message || '🎉 Target Lucy tercapai!', allowedMentions: { parse: [] } }).catch(() => {});
  }
}
module.exports = { handleMessage, handleCommand, countLucy, dayKey, leaderboardEmbed };
