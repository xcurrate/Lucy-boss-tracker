const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags } = require('discord.js');
const { getGuildSettings, updateGuildSettings } = require('../utils/storage');

const ADMIN = PermissionFlagsBits.ManageGuild;
const MODES = ['dm', 'channel', 'both'];

const data = new SlashCommandBuilder()
  .setName('boss')
  .setDescription('Notifikasi boss Lucy')
  .addSubcommand(s => s.setName('help').setDescription('Panduan singkat untuk pengguna'))
  .addSubcommand(s => s.setName('status').setDescription('Lihat status notifikasi boss'))
  .addSubcommand(s => s.setName('notify').setDescription('Pilih pengingat pribadi: DM, channel, atau keduanya')
    .addStringOption(o => o.setName('mode').setDescription('Cara kamu ingin menerima pengingat pribadi').setRequired(true)
      .addChoices(
        { name: 'DM saja (plus notifikasi channel server)', value: 'dm' },
        { name: 'Tanpa DM (pantau channel server)', value: 'channel' },
        { name: 'DM dan channel server', value: 'both' }
      )))
  .addSubcommand(s => s.setName('on').setDescription('Aktifkan pengingat pribadi lewat DM'))
  .addSubcommand(s => s.setName('off').setDescription('Matikan pengingat pribadi lewat DM'))
  .addSubcommand(s => s.setName('setup').setDescription('Atur channel dan role notifikasi server')
    .addChannelOption(o => o.setName('channel').setDescription('Channel notifikasi boss').setRequired(true))
    .addRoleOption(o => o.setName('role').setDescription('Role yang akan ditag').setRequired(true)))
  .addSubcommand(s => s.setName('server-on').setDescription('Aktifkan tracker untuk seluruh server'))
  .addSubcommand(s => s.setName('server-off').setDescription('Matikan tracker untuk seluruh server'))
  .addSubcommand(s => s.setName('prefix').setDescription('Lihat atau ubah prefix perintah server')
    .addStringOption(o => o.setName('nilai').setDescription('Prefix baru, 1–5 karakter tanpa spasi').setRequired(false).setMaxLength(5)))
  .addSubcommand(s => s.setName('admin-help').setDescription('Panduan pengaturan khusus moderator/admin'));

function isAdmin(i) {
  return Boolean(i.memberPermissions?.has(ADMIN));
}

function getMode(settings, userId) {
  return settings.userModes?.[userId] || ((settings.dmUsers || []).includes(userId) ? 'both' : 'channel');
}

function setMode(guildId, userId, mode) {
  updateGuildSettings(guildId, s => {
    const userModes = { ...(s.userModes || {}), [userId]: mode };
    const dmUsers = new Set(s.dmUsers || []);
    if (mode === 'dm' || mode === 'both') dmUsers.add(userId);
    else dmUsers.delete(userId);
    return { ...s, userModes, dmUsers: [...dmUsers] };
  });
}

function helpEmbed() {
  return new EmbedBuilder().setColor(0x5865F2).setTitle('🐉 Bantuan Boss Tracker')
    .setDescription('Boss Tracker memberi pengingat saat boss Lucy diperkirakan muncul.')
    .addFields(
      { name: '/boss notify mode:DM saja', value: 'Pilih pengingat DM pribadi. Notifikasi channel server tetap dikirim sesuai pengaturan moderator.', inline: false },
      { name: '/boss notify mode:Tanpa DM', value: 'Matikan DM pribadi dan pantau channel notifikasi server.', inline: false },
      { name: '/boss notify mode:DM dan channel', value: 'Aktifkan DM pribadi sekaligus pantau channel notifikasi server.', inline: false },
      { name: '/boss status', value: 'Cek status tracker dan waktu boss berikutnya.', inline: false },
      { name: '/boss help', value: 'Tampilkan panduan ini.', inline: false }
    )
    .setFooter({ text: 'Channel notifikasi berlaku untuk seluruh server; pilihan anggota mengatur DM pribadi.' });
}

function adminHelpEmbed(prefix) {
  return new EmbedBuilder().setColor(0xFEE75C).setTitle('⚙️ Pengaturan Moderator/Admin')
    .setDescription('Khusus moderator dengan izin Manage Server atau administrator.')
    .addFields(
      { name: '/boss setup channel:#channel role:@role', value: 'Pilih channel notifikasi dan role yang akan ditag.', inline: false },
      { name: '/boss server-on', value: 'Aktifkan tracker untuk semua anggota server.', inline: false },
      { name: '/boss server-off', value: 'Matikan notifikasi server tanpa menghapus konfigurasi.', inline: false },
      { name: '/boss prefix', value: 'Lihat atau ubah prefix server (1–5 karakter tanpa spasi).', inline: false },
      { name: prefix + 'boss setup #channel @role', value: 'Contoh pengaturan melalui prefix.', inline: false },
      { name: prefix + 'boss server on / off', value: 'Aktifkan atau matikan tracker server.', inline: false },
      { name: prefix + 'boss prefix ?', value: 'Lihat prefix; tambahkan nilai baru untuk mengubahnya.', inline: false }
    );
}

function validPrefix(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 5 && !/\s/.test(value);
}

async function execute(i, tracker) {
  if (!i.guildId) return i.reply({ content: 'Gunakan perintah ini di server.', flags: MessageFlags.Ephemeral });
  const sub = i.options.getSubcommand();

  if (sub === 'help') return i.reply({ embeds: [helpEmbed()], flags: MessageFlags.Ephemeral });

  if (sub === 'notify') {
    const mode = i.options.getString('mode', true);
    setMode(i.guildId, i.user.id, mode);
    const descriptions = {
      dm: 'DM pribadi aktif. Notifikasi channel server juga tetap tersedia.',
      channel: 'DM pribadi dimatikan. Pantau channel notifikasi server.',
      both: 'DM pribadi aktif. Kamu juga bisa memantau channel notifikasi server.'
    };
    return i.reply({ content: '✅ ' + descriptions[mode], flags: MessageFlags.Ephemeral });
  }

  if (sub === 'on' || sub === 'off') {
    const mode = sub === 'on' ? 'both' : 'channel';
    setMode(i.guildId, i.user.id, mode);
    return i.reply({
      content: sub === 'on' ? '✅ DM pribadi aktif. Notifikasi channel server tetap tersedia.' : '🔕 DM pribadi dimatikan.',
      flags: MessageFlags.Ephemeral
    });
  }

  if (sub === 'status') {
    const s = getGuildSettings(i.guildId);
    const ts = s.lastBossTimestamp;
    const mode = getMode(s, i.user.id);
    const modeLabel = { dm: 'DM pribadi', channel: 'Channel server (tanpa DM)', both: 'DM pribadi + channel server' }[mode];
    return i.reply({
      content: [
        '**🐉 Status Boss Tracker**',
        'Notifikasi server: ' + (s.enabled ? '✅ Aktif' : '🔕 Nonaktif'),
        'Pilihan notifikasi kamu: ' + modeLabel,
        'Boss berikutnya: ' + (ts ? '<t:' + ts + ':F> (<t:' + ts + ':R>)' : 'Belum terdeteksi dari pesan Lucy.')
      ].join('\n')
    });
  }

  if (sub === 'admin-help') {
    if (!isAdmin(i)) return i.reply({ content: 'Perintah ini khusus moderator/admin server.', flags: MessageFlags.Ephemeral });
    return i.reply({ embeds: [adminHelpEmbed(getGuildSettings(i.guildId).prefix || '!')], flags: MessageFlags.Ephemeral });
  }

  if (['setup', 'server-on', 'server-off', 'prefix'].includes(sub) && !isAdmin(i)) {
    return i.reply({ content: 'Pengaturan ini hanya bisa digunakan moderator/admin dengan izin Manage Server.', flags: MessageFlags.Ephemeral });
  }

  if (sub === 'setup') {
    const channel = i.options.getChannel('channel', true);
    const role = i.options.getRole('role', true);
    if (typeof channel?.send !== 'function') {
      return i.reply({ content: 'Pilih channel teks yang bisa dikirimi pesan.', flags: MessageFlags.Ephemeral });
    }
    updateGuildSettings(i.guildId, s => ({ ...s, channelId: channel.id, roleId: role.id }));
    return i.reply({ content: '✅ Channel notifikasi dan role tag berhasil disimpan. Aktifkan dengan /boss server-on.', flags: MessageFlags.Ephemeral });
  }

  if (sub === 'server-on' || sub === 'server-off') {
    const enabled = sub === 'server-on';
    const current = getGuildSettings(i.guildId);
    if (enabled && (!current.channelId || !current.roleId)) {
      return i.reply({ content: 'Atur channel dan role terlebih dahulu dengan /boss setup.', flags: MessageFlags.Ephemeral });
    }
    const s = updateGuildSettings(i.guildId, old => ({ ...old, enabled }));
    if (enabled && s.lastBossTimestamp) tracker.scheduleGuild(i.guildId, s.lastBossTimestamp);
    else if (!enabled) tracker.stopGuild(i.guildId);
    return i.reply({ content: enabled ? '✅ Tracker aktif untuk seluruh server.' : '🔕 Tracker server dimatikan.', flags: MessageFlags.Ephemeral });
  }

  if (sub === 'prefix') {
    const value = i.options.getString('nilai');
    const current = getGuildSettings(i.guildId).prefix || '!';
    if (value === null) return i.reply({ content: 'Prefix server saat ini: `' + current + '`', flags: MessageFlags.Ephemeral });
    if (!validPrefix(value)) return i.reply({ content: 'Prefix harus 1–5 karakter dan tidak boleh mengandung spasi.', flags: MessageFlags.Ephemeral });
    updateGuildSettings(i.guildId, s => ({ ...s, prefix: value }));
    return i.reply({ content: '✅ Prefix server diubah menjadi `' + value + '`. Contoh: `' + value + 'boss help`', flags: MessageFlags.Ephemeral });
  }
}

module.exports = { data, execute, helpEmbed, adminHelpEmbed, validPrefix, getMode, setMode };
