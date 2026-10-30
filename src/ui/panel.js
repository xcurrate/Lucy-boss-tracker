const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, EmbedBuilder } = require('discord.js');

const IDS = {
  notifyMode: 'boss_notify_mode',
  on: 'boss_dm_on',
  off: 'boss_dm_off',
  warn: 'boss_warn_select',
  help: 'boss_panel_help',
  status: 'boss_panel_status',
  adminHelp: 'boss_panel_admin_help',
  refresh: 'boss_panel_refresh'
};

const MODE_VALUES = ['dm', 'channel', 'both'];
const WARN_VALUES = ['0', '10', '30', '60', '120', '300', '600', '900'];

function modeLabel(mode) {
  return {
    dm: 'DM pribadi (channel server tetap aktif)',
    channel: 'Channel server tanpa DM',
    both: 'DM pribadi + channel server'
  }[mode] || 'Channel server tanpa DM';
}

function warnLabel(seconds) {
  if (!seconds) return 'Tidak ada peringatan';
  if (seconds % 60 === 0) return seconds / 60 + ' menit sebelum boss';
  return seconds + ' detik sebelum boss';
}

function notifySelect(settings, userId) {
  const current = settings.userModes?.[userId] ||
    ((settings.dmUsers || []).includes(userId) ? 'both' : 'channel');
  const options = [
    { name: 'DM saja', value: 'dm', desc: 'DM pribadi saat boss muncul (channel server tetap aktif)' },
    { name: 'Tanpa DM', value: 'channel', desc: 'Matikan DM, pantau channel notifikasi server' },
    { name: 'DM dan channel', value: 'both', desc: 'DM pribadi sekaligus pantau channel server' }
  ].map(o => new StringSelectMenuOptionBuilder()
    .setLabel(o.name)
    .setValue(o.value)
    .setDescription(o.desc)
    .setDefault(o.value === current));
  return new StringSelectMenuBuilder()
    .setCustomId(IDS.notifyMode)
    .setPlaceholder('Pilih pengingat pribadi')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options);
}

function warnSelect(settings, userId) {
  const current = String(settings.userWarnSeconds?.[userId] ?? 0);
  const options = WARN_VALUES.map(v => new StringSelectMenuOptionBuilder()
    .setLabel(warnLabel(Number(v)))
    .setValue(v)
    .setDefault(v === current));
  return new StringSelectMenuBuilder()
    .setCustomId(IDS.warn)
    .setPlaceholder('DM peringatan berapa detik sebelum boss muncul?')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options);
}

function panelEmbed(settings, userId, extra = {}) {
  const mode = settings.userModes?.[userId] ||
    ((settings.dmUsers || []).includes(userId) ? 'both' : 'channel');
  const warnSeconds = settings.userWarnSeconds?.[userId] ?? 0;
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🐉 Boss Tracker — Pengaturan Pribadi')
    .setDescription('Atur notifikasi boss Lucy dengan menu di bawah.')
    .addFields(
      { name: '📣 Mode notifikasi', value: modeLabel(mode), inline: true },
      { name: '⏰ DM peringatan', value: warnLabel(warnSeconds), inline: true }
    );
  if (extra.status) embed.addFields({ name: '📡 Status & bos berikutnya', value: extra.status, inline: false });
  if (extra.tip) embed.setFooter({ text: extra.tip });
  return embed;
}

function dmRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.on).setLabel('DM ON').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(IDS.off).setLabel('DM OFF').setStyle(ButtonStyle.Danger)
  );
}

function warnRow(settings, userId) {
  return new ActionRowBuilder().addComponents(warnSelect(settings, userId));
}

function notifyRow(settings, userId) {
  return new ActionRowBuilder().addComponents(notifySelect(settings, userId));
}

function footerRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(IDS.status).setLabel('Status').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(IDS.help).setLabel('Bantuan').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(IDS.adminHelp).setLabel('Admin Help').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(IDS.refresh).setLabel('🔄 Perbarui').setStyle(ButtonStyle.Primary)
  );
}

function personalPanel(settings, userId, extra = {}) {
  const rows = [notifyRow(settings, userId), warnRow(settings, userId), dmRow()];
  if (extra.includeFooter) rows.push(footerRow());
  return { embeds: [panelEmbed(settings, userId, extra)], components: rows };
}

function statusText(settings, userId) {
  const ts = settings.lastBossTimestamp;
  const mode = settings.userModes?.[userId] ||
    ((settings.dmUsers || []).includes(userId) ? 'both' : 'channel');
  const warnSeconds = settings.userWarnSeconds?.[userId] ?? 0;
  return [
    '**Notifikasi server:** ' + (settings.enabled ? '✅ Aktif' : '🔕 Nonaktif'),
    '**Bos berikutnya:** ' + (ts ? '<t:' + ts + ':F> (<t:' + ts + ':R>)' : 'Belum terdeteksi dari pesan Lucy.'),
    '',
    modeLabel(mode) + (warnSeconds ? ' · ⏰ DM peringatan ' + warnLabel(warnSeconds) : '')
  ].join('\n');
}

function statusEmbed(settings, userId) {
  return new EmbedBuilder().setColor(0x5865F2).setTitle('📡 Status Boss Tracker')
    .setDescription(statusText(settings, userId));
}

function helpEmbed(prefix, { isAdmin = false } = {}) {
  const fields = [
    // 👤 Pengguna — daftar perintah slash yang bisa dipakai semua anggota.
    { name: '👤 Pengguna — Slash Command', value: [
      '`/boss menu` — panel pengaturan pribadi (dropdown + tombol)',
      '`/boss notify mode:` — pilih DM, channel, atau keduanya',
      '`/boss warn detik:` — peringatan DM sebelum boss muncul',
      '`/boss on` / `/boss off` — aktifkan/matikan DM pribadi',
      '`/boss status` — cek status tracker & waktu boss berikutnya',
      '`/boss help` — panduan ini'
    ].join('\n'), inline: false },

    // 👤 Pengguna — padanan prefix, prefix server diambil dari settings.
    { name: '📝 Pengguna — Prefix Command', value: [
      '`' + prefix + 'boss menu` — panel pengaturan pribadi',
      '`' + prefix + 'boss notify dm|channel|both` — pilih mode notifikasi',
      '`' + prefix + 'boss warn <detik>` — peringatan DM (0 = matikan)',
      '`' + prefix + 'boss on` / `' + prefix + 'boss off` — aktifkan/matikan DM',
      '`' + prefix + 'boss status` — cek status tracker',
      '`' + prefix + 'boss help` — panduan ini'
    ].join('\n'), inline: false },

    // ⚙️ Admin — daftar perintah slash admin, hanya tampil jika isAdmin.
    { name: '⚙️ Admin — Slash Command', value: [
      '`/boss setup channel:#channel role:@role` — atur channel & role tag',
      '`/boss server-on` — aktifkan tracker seluruh server',
      '`/boss server-off` — matikan tracker server',
      '`/boss prefix` — lihat prefix server',
      '`/boss admin-help` — panduan moderator'
    ].join('\n'), inline: false },

    // ⚙️ Admin — padanan prefix untuk perintah admin, hanya tampil jika isAdmin.
    { name: '⚙️ Admin — Prefix Command', value: [
      '`' + prefix + 'boss setup #channel @role` — atur channel & role tag',
      '`' + prefix + 'boss server on` — aktifkan tracker seluruh server',
      '`' + prefix + 'boss server off` — matikan tracker server',
      '`' + prefix + 'boss prefix` — lihat/ubah prefix server',
      '`' + prefix + 'boss admin-help` — panduan moderator'
    ].join('\n'), inline: false },

    // 🎛️ Panel — menjelaskan elemen interaktif pada panel /boss menu.
    { name: '🎛️ Panel Interaktif', value: [
      '**Dropdown notifikasi** — pilih DM saja, tanpa DM, atau DM + channel.',
      '**Dropdown peringatan** — atur berapa detik sebelum boss kamu diingatkan via DM.',
      '**Tombol DM ON/OFF** — nyalakan atau matikan DM pribadi dengan cepat.',
      '**Tombol bawah** — Status, Bantuan, Admin Help, dan tombol 🔄 untuk memperbarui panel.'
    ].join('\n'), inline: false }
  ];
  const embed = new EmbedBuilder().setColor(0x5865F2)
    .setTitle('🐉 Bantuan Boss Tracker')
    .setDescription('Boss Tracker memberi pengingat saat boss Lucy diperkirakan muncul.')
    .addFields(isAdmin ? fields : fields.filter(f => !f.name.startsWith('⚙️')));
  // Footer: jelaskan bahwa pengaturan server bersifat global, panel hanya pribadi.
  embed.setFooter({ text: 'Mode channel server berlaku untuk seluruh server; panel ini hanya mengubah pengaturan pribadimu.' });
  return embed;
}

module.exports = {
  IDS,
  MODE_VALUES,
  WARN_VALUES,
  modeLabel,
  warnLabel,
  notifySelect,
  warnSelect,
  panelEmbed,
  dmRow,
  warnRow,
  notifyRow,
  footerRow,
  personalPanel,
  statusEmbed,
  statusText,
  helpEmbed
};