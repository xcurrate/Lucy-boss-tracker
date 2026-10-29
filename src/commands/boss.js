const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { getGuildSettings, updateGuildSettings } = require('../utils/storage');

const data = new SlashCommandBuilder()
  .setName('boss').setDescription('Atur notifikasi Lucy Boss Tracker')
  .addSubcommand(s => s.setName('help').setDescription('Lihat panduan penggunaan'))
  .addSubcommand(s => s.setName('status').setDescription('Lihat status Boss Tracker'))
  .addSubcommand(s => s.setName('enable').setDescription('Aktifkan tracker server'))
  .addSubcommand(s => s.setName('disable').setDescription('Nonaktifkan tracker server'))
  .addSubcommand(s => s.setName('setup').setDescription('Atur channel dan role notifikasi')
    .addChannelOption(o => o.setName('channel').setDescription('Channel notifikasi boss').setRequired(true))
    .addRoleOption(o => o.setName('role').setDescription('Role yang ditag, misalnya Boss slayer').setRequired(true))
    )
  .addSubcommand(s => s.setName('dm').setDescription('Atur DM notifikasi untuk dirimu')
    .addBooleanOption(o => o.setName('aktif').setDescription('True untuk aktif, false untuk nonaktif').setRequired(true)));

async function execute(i, tracker) {
  if (!i.guildId) return i.reply({ content: 'Gunakan perintah ini di server.', ephemeral: true });
  const sub = i.options.getSubcommand();
  if (['setup', 'enable', 'disable'].includes(sub) && !i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return i.reply({ content: 'Perintah ini memerlukan izin Manage Server.', ephemeral: true });
  if (sub === 'help') {
    const e = new EmbedBuilder().setColor(0x5865F2).setTitle('📖 Lucy Boss Tracker — Bantuan')
      .setDescription('Bot membaca timestamp pada baris **Boss baru** dari pesan **Guild Boss Telah Dikalahkan!** milik Lucy.')
      .addFields(
        { name: '/boss setup channel:#channel role:@Boss slayer', value: 'Atur channel notifikasi dan role yang di-mention (Manage Server).', inline: false },
        { name: '/boss enable', value: 'Aktifkan tracker server (Manage Server).', inline: false },
        { name: '/boss disable', value: 'Nonaktifkan tracker server (Manage Server).', inline: false },
        { name: '/boss dm aktif:true', value: 'Aktifkan DM untuk dirimu. Gunakan false untuk mematikan.', inline: false },
        { name: '/boss status', value: 'Lihat konfigurasi dan waktu boss berikutnya.', inline: false },
        { name: '/boss help', value: 'Tampilkan panduan ini.', inline: false }
      ).setFooter({ text: 'Bot memerlukan akses ke channel Lucy dan izin mengirim pesan di channel notifikasi.' });
    return i.reply({ embeds: [e], ephemeral: true });
  }
  if (sub === 'dm') {
    const enabled = i.options.getBoolean('aktif', true);
    updateGuildSettings(i.guildId, s => {
      const users = new Set(s.dmUsers || []);
      enabled ? users.add(i.user.id) : users.delete(i.user.id);
      return { ...s, dmUsers: [...users] };
    });
    return i.reply({ content: enabled ? '✅ DM Boss Tracker aktif untukmu.' : '🔕 DM Boss Tracker dinonaktifkan untukmu.', ephemeral: true });
  }
  if (sub === 'setup') {
    const channel = i.options.getChannel('channel', true), role = i.options.getRole('role', true);
    if (!channel.isTextBased() || !channel.send) return i.reply({ content: 'Pilih channel teks.', ephemeral: true });
    updateGuildSettings(i.guildId, s => ({ ...s, channelId: channel.id, roleId: role.id }));
    return i.reply({ content: '✅ Notifikasi disetel ke <#' + channel.id + '> dengan role <@&' + role.id + '>. Jalankan /boss enable untuk mengaktifkan.', allowedMentions: { parse: [] }, ephemeral: true });
  }
  if (sub === 'enable' || sub === 'disable') {
    const enabled = sub === 'enable';
    const s = updateGuildSettings(i.guildId, old => ({ ...old, enabled }));
    if (enabled && s.lastBossTimestamp) tracker.scheduleGuild(i.guildId, s.lastBossTimestamp);
    else if (!enabled) tracker.stopGuild(i.guildId);
    return i.reply({ content: enabled ? '✅ Boss Tracker aktif.' + (!s.channelId ? ' Atur channel dengan /boss setup.' : '') : '🔕 Boss Tracker dinonaktifkan.', ephemeral: true });
  }
  if (sub === 'status') {
    const s = getGuildSettings(i.guildId), ts = s.lastBossTimestamp;
    const e = new EmbedBuilder().setColor(s.enabled ? 0x57F287 : 0xED4245).setTitle('🐉 Status Boss Tracker')
      .addFields(
        { name: 'Tracker server', value: s.enabled ? '✅ Aktif' : '🔕 Nonaktif', inline: true },
        { name: 'Channel', value: s.channelId ? '<#' + s.channelId + '>' : 'Belum diatur', inline: true },
        { name: 'Role', value: s.roleId ? '<@&' + s.roleId + '>' : 'Belum diatur', inline: true },
        { name: 'Boss berikutnya', value: ts ? '<t:' + ts + ':F> (<t:' + ts + ':R>)' : 'Belum terdeteksi dari pesan Lucy', inline: false },
        { name: 'DM milikmu', value: (s.dmUsers || []).includes(i.user.id) ? '✅ Aktif' : '🔕 Nonaktif', inline: true }
      );
    return i.reply({ embeds: [e], ephemeral: true });
  }
}
module.exports = { data, execute };
