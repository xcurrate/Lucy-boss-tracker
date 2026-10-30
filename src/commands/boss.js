const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, EmbedBuilder } = require('discord.js');
const { getGuildSettings, updateGuildSettings, setUserMode, setUserWarnSeconds } = require('../utils/storage');
const {
  IDS, MODE_VALUES, WARN_VALUES, modeLabel, warnLabel, personalPanel, statusEmbed, statusText, helpEmbed, parseCustomId
} = require('../ui/panel');

const ADMIN = PermissionFlagsBits.ManageGuild;

const WARN_CHOICES = WARN_VALUES.map(v => ({ name: warnLabel(Number(v)), value: v }));

const data = new SlashCommandBuilder()
  .setName('boss')
  .setDescription('Notifikasi boss Lucy')
  .addSubcommand(s => s.setName('help').setDescription('Panduan singkat untuk pengguna'))
  .addSubcommand(s => s.setName('menu').setDescription('Panel pengaturan pribadi (v2 components)'))
  .addSubcommand(s => s.setName('status').setDescription('Lihat status notifikasi boss'))
  .addSubcommand(s => s.setName('notify').setDescription('Pilih pengingat pribadi: DM, channel, atau keduanya')
    .addStringOption(o => o.setName('mode').setDescription('Cara kamu ingin menerima pengingat pribadi').setRequired(true)
      .addChoices(
        { name: 'DM saja (plus notifikasi channel server)', value: 'dm' },
        { name: 'Tanpa DM (pantau channel server)', value: 'channel' },
        { name: 'DM dan channel server', value: 'both' }
      )))
  .addSubcommand(s => s.setName('warn').setDescription('DM peringatan berapa detik sebelum boss muncul')
    .addStringOption(o => o.setName('detik').setDescription('Detik sebelum boss untuk menerima DM (0 = matikan)').setRequired(true)
      .addChoices(...WARN_CHOICES)))
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
  setUserMode(guildId, userId, mode);
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
      { name: prefix + 'boss server-on', value: 'Aktifkan tracker untuk semua anggota server.', inline: false },
      { name: prefix + 'boss server-off', value: 'Matikan tracker server.', inline: false },
      { name: prefix + 'boss prefix ?', value: 'Lihat prefix; tambahkan nilai baru untuk mengubahnya.', inline: false }
    );
}

function validPrefix(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 5 && !/\s/.test(value);
}

async function execute(i, tracker) {
  if (!i.guildId) return i.reply({ content: 'Gunakan perintah ini di server.', flags: MessageFlags.Ephemeral });
  const sub = i.options.getSubcommand();
  const settings = getGuildSettings(i.guildId);
  const prefix = settings.prefix || '!';

  if (sub === 'help') return i.reply({
    embeds: [helpEmbed(prefix, { isAdmin: isAdmin(i) })],
    flags: MessageFlags.Ephemeral
  });

  if (sub === 'menu') return i.reply({ ...refreshView(i), flags: MessageFlags.Ephemeral });

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

  if (sub === 'warn') {
    const seconds = Number(i.options.getString('detik', true));
    if (!Number.isFinite(seconds) || !WARN_VALUES.includes(String(seconds))) {
      return i.reply({ content: 'Nilai detik tidak valid. Pilih salah satu: `' + WARN_VALUES.map(v => warnLabel(Number(v)) + ' (' + v + ')').join('`, `') + '`.', flags: MessageFlags.Ephemeral });
    }
    setUserWarnSeconds(i.guildId, i.user.id, seconds);
    if (tracker) tracker.refreshWarns(i.guildId, settings.lastBossTimestamp);
    return i.reply({
      content: seconds === 0
        ? '🔕 DM peringatan dimatikan.'
        : '✅ DM peringatan disetel: **' + warnLabel(seconds) + '**. Kamu akan menerima DM pengingat saat waktunya tiba.',
      flags: MessageFlags.Ephemeral
    });
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
    return i.reply({ embeds: [statusEmbed(settings, i.user.id)], flags: MessageFlags.Ephemeral });
  }

  if (sub === 'admin-help') {
    if (!isAdmin(i)) return i.reply({ content: 'Perintah ini khusus moderator/admin server.', flags: MessageFlags.Ephemeral });
    return i.reply({ embeds: [adminHelpEmbed(prefix)], flags: MessageFlags.Ephemeral });
  }

  if (['setup', 'server-on', 'server-off', 'prefix'].includes(sub) && !isAdmin(i)) {
    return i.reply({ content: 'Pengaturan ini hanya bisa digunakan moderator/admin dengan izin Manage Server.', flags: MessageFlags.Ephemeral });
  }

  if (sub === 'setup') {
    const channel = i.options.getChannel('channel', true);
    const role = i.options.getRole('role', true);
    if (typeof channel?.isTextBased !== 'function' || !channel.isTextBased()) {
      return i.reply({ content: 'Pilih channel teks. Channel suara tidak didukung.', flags: MessageFlags.Ephemeral });
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

  return i.reply({ content: 'Subcommand tidak dikenali.', flags: MessageFlags.Ephemeral });
}

// Perbarui panel pribadi menjadi SATU embed (mode, peringatan, status) + row footer.
function refreshView(i, extra = {}) {
  const settings = getGuildSettings(i.guildId);
  return personalPanel(settings, i.user.id, {
    includeFooter: true,
    status: statusText(settings, i.user.id),
    ...extra
  });
}

async function handleComponent(i, tracker) {
  if (!i.guildId) return i.reply({ content: 'Gunakan perintah ini di server.', flags: MessageFlags.Ephemeral });
  const settings = getGuildSettings(i.guildId);
  const prefix = settings.prefix || '!';

  // Setiap komponen panel di-scope ke pemiliknya (customId berisi userId).
  const p = parseCustomId(i.customId);
  const known = p.ok && Object.values(IDS).includes(p.base);
  if (!known) {
    return i.reply({ content: 'Komponen kedaluwarsa. Jalankan /boss menu lagi.', flags: MessageFlags.Ephemeral });
  }
  if (p.userId !== i.user.id) {
    return i.reply({ content: 'Panel ini hanya bisa digunakan oleh pemiliknya. Jalankan /boss menu untuk panel kamu sendiri.', flags: MessageFlags.Ephemeral });
  }

  if (i.isStringSelectMenu() && p.base === IDS.notifyMode) {
    const mode = i.values[0];
    if (!MODE_VALUES.includes(mode)) return i.reply({ content: 'Mode tidak dikenal.', flags: MessageFlags.Ephemeral });
    setMode(i.guildId, i.user.id, mode);
    await i.update(refreshView(i));
    return i.followUp({ content: '✅ Pilihan notifikasi kamu: **' + modeLabel(mode) + '**.', flags: MessageFlags.Ephemeral });
  }

  if (i.isStringSelectMenu() && p.base === IDS.warn) {
    const seconds = Number(i.values[0]);
    if (!WARN_VALUES.includes(String(seconds))) return i.reply({ content: 'Nilai peringatan tidak dikenal.', flags: MessageFlags.Ephemeral });
    setUserWarnSeconds(i.guildId, i.user.id, seconds);
    if (tracker) tracker.refreshWarns(i.guildId, settings.lastBossTimestamp);
    await i.update(refreshView(i));
    return i.followUp({
      content: seconds === 0
        ? '🔕 DM peringatan dimatikan.'
        : '✅ DM peringatan disetel: **' + warnLabel(seconds) + '**.',
      flags: MessageFlags.Ephemeral
    });
  }

  if (i.isButton() && (p.base === IDS.on || p.base === IDS.off)) {
    const mode = p.base === IDS.on ? 'both' : 'channel';
    setMode(i.guildId, i.user.id, mode);
    await i.update(refreshView(i));
    return i.followUp({
      content: mode === 'both' ? '✅ DM pribadi aktif. Notifikasi channel server tetap tersedia.' : '🔕 DM pribadi dimatikan.',
      flags: MessageFlags.Ephemeral
    });
  }

  if (i.isButton() && p.base === IDS.status) {
    return i.reply({ embeds: [statusEmbed(getGuildSettings(i.guildId), i.user.id)], flags: MessageFlags.Ephemeral });
  }

  if (i.isButton() && p.base === IDS.help) {
    return i.reply({ embeds: [helpEmbed(prefix, { isAdmin: isAdmin(i) })], flags: MessageFlags.Ephemeral });
  }

  if (i.isButton() && p.base === IDS.adminHelp) {
    if (!isAdmin(i)) return i.reply({ content: 'Perintah ini khusus moderator/admin server.', flags: MessageFlags.Ephemeral });
    return i.reply({ embeds: [adminHelpEmbed(prefix)], flags: MessageFlags.Ephemeral });
  }

  if (i.isButton() && p.base === IDS.refresh) {
    await i.update(refreshView(i));
    return i.followUp({ content: '🔄 Panel diperbarui.', flags: MessageFlags.Ephemeral });
  }

  return i.reply({ content: 'Komponen kedaluwarsa. Jalankan /boss menu lagi.', flags: MessageFlags.Ephemeral });
}

module.exports = { data, execute, handleComponent, helpEmbed, adminHelpEmbed, validPrefix, getMode, setMode, WARN_CHOICES };
