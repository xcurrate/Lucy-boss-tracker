const { getGuildSettings, updateGuildSettings, setUserMode, setUserWarnSeconds } = require('../utils/storage');
const { modeLabel, warnLabel, personalPanel, statusEmbed, helpEmbed } = require('../ui/panel');
const { PermissionFlagsBits, EmbedBuilder } = require('discord.js');

const ALIASES = {
  help: ['bantuan', 'help', '?'],
  notify: ['notif', 'pengingat', 'notify'],
  on: ['nyalakan', 'aktifkan', 'enable', 'on'],
  off: ['matikan', 'nonaktifkan', 'disable', 'off'],
  status: ['cek', 'info', 'state', 'status'],
  warn: ['peringatan', 'warn', 'ingatkan'],
  setup: ['set', 'atur', 'konfigurasi', 'config', 'setup'],
  'server-on': ['server-nyalakan', 'aktif', 'server-on', 'enable-server'],
  'server-off': ['server-matikan', 'nonaktif', 'server-off', 'disable-server'],
  server: ['server', 'sv'],
  prefix: ['awalan', 'prefix', 'pref'],
  menu: ['menu', 'panel', 'pengaturan'],
  'admin-help': ['bantuan-admin', 'admin-help', 'admin']
};

function expandAliases() {
  const map = {};
  for (const [canonical, list] of Object.entries(ALIASES)) {
    for (const alias of list) map[alias] = canonical;
  }
  return map;
}

const ALIAS_MAP = expandAliases();

function parsePrefixInput(content, prefix) {
  if (typeof content !== 'string' || typeof prefix !== 'string' || !content.startsWith(prefix)) return null;
  const rest = content.slice(prefix.length).trim();
  const parts = rest.split(/\s+/);
  if ((parts[0] || '').toLowerCase() !== 'boss') return null;
  const rawSub = (parts[1] || 'help').toLowerCase();
  return {
    sub: ALIAS_MAP[rawSub] || rawSub,
    rawSub,
    args: parts.slice(2)
  };
}

function isAdmin(message) {
  return Boolean(message.member?.permissions?.has(PermissionFlagsBits.ManageGuild));
}

function send(message, payload) {
  return message.reply({ ...payload, allowedMentions: { repliedUser: false, parse: [] } });
}

async function handlePrefixCommand(message, tracker, deps = {}) {
  const _send = deps.send || send;
  const _sendText = deps.sendText || ((m, content) => _send(m, { content }));
  const _isAdmin = deps.isAdmin || isAdmin;

  if (!message.guildId || message.author?.bot) return;
  const settings = getGuildSettings(message.guildId);
  const prefix = settings.prefix || '!';
  const parsed = parsePrefixInput(message.content, prefix);
  if (!parsed) return;

  const { sub, args } = parsed;
  const current = getGuildSettings(message.guildId);

  if (sub === 'help') {
    return _send(message, {
      embeds: [helpEmbed(prefix), statusEmbed(settings, message.author.id)]
    });
  }

  if (sub === 'menu') {
    return _send(message, { ...personalPanel(settings, message.author.id, { includeFooter: true }) });
  }

  if (sub === 'notify') {
    const mode = (args[0] || '').toLowerCase();
    if (!['dm', 'channel', 'both'].includes(mode)) {
      return _sendText(message, 'Pilih mode: `' + prefix + 'boss notify dm`, `channel`, atau `both`.');
    }
    setUserMode(message.guildId, message.author.id, mode);
    return _sendText(message, '✅ Pilihan notifikasi kamu: **' + modeLabel(mode) + '**. Notifikasi channel server tetap berlaku untuk semua anggota.');
  }

  if (sub === 'on' || sub === 'off') {
    const mode = sub === 'on' ? 'both' : 'channel';
    setUserMode(message.guildId, message.author.id, mode);
    return _sendText(message, sub === 'on' ? '✅ DM pribadi aktif. Notifikasi channel server tetap tersedia.' : '🔕 DM pribadi dimatikan.');
  }

  if (sub === 'warn') {
    const arg = (args[0] || '').toLowerCase();
    if (!/^\d+$/.test(arg)) {
      return _sendText(message, 'Format: `' + prefix + 'boss warn <detik>` — misal `' + prefix + 'boss warn 60` untuk peringatan 60 detik sebelum boss. Gunakan `0` untuk mematikan.');
    }
    const seconds = Math.min(Number(arg), 86400);
    setUserWarnSeconds(message.guildId, message.author.id, seconds);
    return _sendText(message, seconds === 0
      ? '🔕 Peringatan DM dimatikan.'
      : '✅ DM peringatan disetel: **' + warnLabel(seconds) + '**. Kamu akan menerima DM pengingat saat waktunya tiba.');
  }

  if (sub === 'status') {
    return _send(message, { embeds: [statusEmbed(current, message.author.id)] });
  }

  if (sub === 'prefix') {
    if (!_isAdmin(message)) return _sendText(message, 'Pengaturan prefix hanya bisa digunakan moderator/admin.');
    const value = args[0];
    if (!value) return _sendText(message, 'Prefix server saat ini: `' + prefix + '`. Ubah dengan `' + prefix + 'boss prefix <prefix-baru>`.');
    if (value.length > 5 || /\s/.test(value)) return _sendText(message, 'Prefix harus 1–5 karakter tanpa spasi.');
    updateGuildSettings(message.guildId, s => ({ ...s, prefix: value }));
    return _sendText(message, '✅ Prefix diubah menjadi `' + value + '`. Contoh: `' + value + 'boss help`');
  }

  if (sub === 'admin-help') {
    if (!_isAdmin(message)) return _sendText(message, 'Panduan ini khusus moderator/admin server.');
    return _send(message, { embeds: [new EmbedBuilder().setColor(0xFEE75C).setTitle('⚙️ Pengaturan Moderator/Admin')
      .setDescription('Khusus moderator dengan izin Manage Server atau administrator.')
      .addFields(
        { name: prefix + 'boss setup #channel @role', value: 'Atur channel dan role tag (alias: set/atur/config).', inline: false },
        { name: prefix + 'boss server on / off', value: 'Aktifkan atau matikan tracker server (alias: server-nyalakan/server-matikan).', inline: false },
        { name: prefix + 'boss prefix <prefix>', value: 'Lihat atau ubah prefix server (alias: awalan).', inline: false },
        { name: 'Slash', value: '/boss setup, /boss server-on, /boss server-off, /boss prefix.', inline: false }
      )] });
  }

  if (['setup', 'server', 'server-on', 'server-off'].includes(sub) && !_isAdmin(message)) {
    return _sendText(message, 'Perintah ini hanya bisa digunakan moderator/admin dengan izin Manage Server.');
  }

  if (sub === 'setup') {
    const channelId = (args[0] || '').match(/^<#?(\d+)>?$/)?.[1];
    const roleId = (args[1] || '').match(/^<@&?(\d+)>?$/)?.[1];
    if (!channelId || !roleId) return _sendText(message, 'Format: `' + prefix + 'boss setup #channel @role`');
    const channel = await message.guild.channels.fetch(channelId).catch(() => null);
    const role = await message.guild.roles.fetch(roleId).catch(() => null);
    if (typeof channel?.send !== 'function' || !role) return _sendText(message, 'Channel teks atau role tidak ditemukan. Pastikan pilihan benar.');
    updateGuildSettings(message.guildId, s => ({ ...s, channelId, roleId }));
    return _sendText(message, '✅ Channel dan role notifikasi tersimpan. Aktifkan dengan `' + prefix + 'boss server on`.');
  }

  if (sub === 'server' || sub === 'server-on' || sub === 'server-off') {
    const action = sub === 'server-on' ? 'on' : sub === 'server-off' ? 'off' : (args[0] || '').toLowerCase();
    if (!['on', 'off'].includes(action)) return _sendText(message, 'Format: `' + prefix + 'boss server on` atau `' + prefix + 'boss server off`.');
    const s0 = getGuildSettings(message.guildId);
    if (action === 'on' && (!s0.channelId || !s0.roleId)) return _sendText(message, 'Atur channel dan role terlebih dahulu dengan `' + prefix + 'boss setup #channel @role`.');
    const enabled = action === 'on';
    const s = updateGuildSettings(message.guildId, old => ({ ...old, enabled }));
    if (enabled && s.lastBossTimestamp) tracker.scheduleGuild(message.guildId, s.lastBossTimestamp);
    else if (!enabled) tracker.stopGuild(message.guildId);
    return _sendText(message, enabled ? '✅ Tracker aktif untuk seluruh server.' : '🔕 Tracker server dimatikan.');
  }
  return _sendText(message, 'Perintah tidak dikenal. Gunakan `' + prefix + 'boss help`.');
}

module.exports = { handlePrefixCommand, parsePrefixInput, ALIASES, ALIAS_MAP, isAdmin };