const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { getGuildSettings, updateGuildSettings } = require('../utils/storage');

const ADMIN = PermissionFlagsBits.ManageGuild;

const data = new SlashCommandBuilder()
  .setName('boss')
  .setDescription('Notifikasi boss Lucy')
  .addSubcommand(s => s.setName('help').setDescription('Panduan singkat untuk pengguna'))
  .addSubcommand(s => s.setName('status').setDescription('Lihat status notifikasi boss'))
  .addSubcommand(s => s.setName('on').setDescription('Aktifkan DM boss untuk akunmu'))
  .addSubcommand(s => s.setName('off').setDescription('Matikan DM boss untuk akunmu'))
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

function helpEmbed() {
  return new EmbedBuilder().setColor(0x5865F2).setTitle('🐉 Bantuan Boss Tracker')
    .setDescription('Boss Tracker akan mengirim pengingat saat boss Lucy diperkirakan muncul.')
    .addFields(
      { name: '/boss on', value: 'Aktifkan pengingat pribadi lewat DM.', inline: false },
      { name: '/boss off', value: 'Matikan pengingat pribadi lewat DM.', inline: false },
      { name: '/boss status', value: 'Cek status tracker dan waktu boss berikutnya.', inline: false },
      { name: '/boss help', value: 'Tampilkan panduan ini.', inline: false }
    )
    .setFooter({ text: 'Pengaturan server dikelola moderator/admin.' });
}

function adminHelpEmbed(prefix) {
  return new EmbedBuilder().setColor(0xFEE75C).setTitle('⚙️ Pengaturan Moderator/Admin')
    .setDescription('Perintah ini hanya untuk moderator dengan izin Manage Server atau administrator.')
    .addFields(
      { name: '/boss setup channel:#channel role:@role', value: 'Pilih channel notifikasi dan role yang akan ditag.', inline: false },
      { name: '/boss server-on', value: 'Aktifkan tracker untuk semua anggota server. Setup harus selesai terlebih dahulu.', inline: false },
      { name: '/boss server-off', value: 'Matikan notifikasi server tanpa menghapus konfigurasi.', inline: false },
      { name: '/boss prefix nilai:?', value: 'Lihat prefix saat ini. Isi nilai untuk menggantinya (1–5 karakter tanpa spasi).', inline: false },
      { name: prefix + 'boss setup #channel @role', value: 'Contoh pengaturan melalui prefix.', inline: false },
      { name: prefix + 'boss server on / off', value: 'Aktifkan atau matikan tracker server melalui prefix.', inline: false },
      { name: prefix + 'boss prefix ?', value: 'Lihat prefix; gunakan ' + prefix + 'boss prefix ! untuk mengubahnya menjadi !.', inline: false }
    );
}

function validPrefix(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 5 && !/\s/.test(value);
}

async function execute(i, tracker) {
  if (!i.guildId) return i.reply({ content: 'Gunakan perintah ini di server.', ephemeral: true });
  const sub = i.options.getSubcommand();

  if (sub === 'help') return i.reply({ embeds: [helpEmbed()], ephemeral: true });

  if (sub === 'on' || sub === 'off') {
    const enabled = sub === 'on';
    updateGuildSettings(i.guildId, s => {
      const users = new Set(s.dmUsers || []);
      enabled ? users.add(i.user.id) : users.delete(i.user.id);
      return { ...s, dmUsers: [...users] };
    });
    return i.reply({
      content: enabled ? '✅ Pengingat pribadi aktif. Kamu akan menerima DM saat boss muncul.' : '🔕 Pengingat pribadi dimatikan.',
      ephemeral: true
    });
  }

  if (sub === 'status') {
    const s = getGuildSettings(i.guildId);
    const ts = s.lastBossTimestamp;
    const embed = new EmbedBuilder().setColor(s.enabled ? 0x57F287 : 0xED4245).setTitle('🐉 Status Boss Tracker')
      .addFields(
        { name: 'Notifikasi server', value: s.enabled ? '✅ Aktif' : '🔕 Nonaktif', inline: true },
        { name: 'Pengingat DM kamu', value: (s.dmUsers || []).includes(i.user.id) ? '✅ Aktif' : '🔕 Nonaktif', inline: true },
        { name: 'Boss berikutnya', value: ts ? '<t:' + ts + ':F> (<t:' + ts + ':R>)' : 'Belum terdeteksi dari pesan Lucy.', inline: false }
      );
    return i.reply({ embeds: [embed], ephemeral: true });
  }

  if (sub === 'admin-help') {
    if (!isAdmin(i)) return i.reply({ content: 'Perintah ini khusus moderator/admin server.', ephemeral: true });
    return i.reply({ embeds: [adminHelpEmbed(getGuildSettings(i.guildId).prefix || '!')], ephemeral: true });
  }

  if (['setup', 'server-on', 'server-off', 'prefix'].includes(sub) && !isAdmin(i)) {
    return i.reply({ content: 'Pengaturan ini hanya bisa digunakan moderator/admin dengan izin Manage Server.', ephemeral: true });
  }

  if (sub === 'setup') {
    const channel = i.options.getChannel('channel', true);
    const role = i.options.getRole('role', true);
    if (!channel.isTextBased() || !channel.send) {
      return i.reply({ content: 'Pilih channel teks yang bisa dikirimi pesan.', ephemeral: true });
    }
    updateGuildSettings(i.guildId, s => ({ ...s, channelId: channel.id, roleId: role.id }));
    return i.reply({
      content: '✅ Channel notifikasi dan role tag berhasil disimpan. Aktifkan dengan /boss server-on.',
      ephemeral: true
    });
  }

  if (sub === 'server-on' || sub === 'server-off') {
    const enabled = sub === 'server-on';
    const current = getGuildSettings(i.guildId);
    if (enabled && (!current.channelId || !current.roleId)) {
      return i.reply({ content: 'Atur channel dan role terlebih dahulu dengan /boss setup.', ephemeral: true });
    }
    const s = updateGuildSettings(i.guildId, old => ({ ...old, enabled }));
    if (enabled && s.lastBossTimestamp) tracker.scheduleGuild(i.guildId, s.lastBossTimestamp);
    else if (!enabled) tracker.stopGuild(i.guildId);
    return i.reply({ content: enabled ? '✅ Tracker aktif untuk seluruh server.' : '🔕 Tracker server dimatikan.', ephemeral: true });
  }

  if (sub === 'prefix') {
    const value = i.options.getString('nilai');
    const current = getGuildSettings(i.guildId).prefix || '!';
    if (value === null) return i.reply({ content: 'Prefix server saat ini: `' + current + '`', ephemeral: true });
    if (!validPrefix(value)) return i.reply({ content: 'Prefix harus 1–5 karakter dan tidak boleh mengandung spasi.', ephemeral: true });
    updateGuildSettings(i.guildId, s => ({ ...s, prefix: value }));
    return i.reply({ content: '✅ Prefix server diubah menjadi `' + value + '`. Contoh: `' + value + 'boss help`', ephemeral: true });
  }
}

module.exports = { data, execute, helpEmbed, adminHelpEmbed, validPrefix };
