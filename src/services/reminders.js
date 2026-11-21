// Custom Reminder: perintah, panel, dan siklus pemberian (award) oleh developer.
//
// PENGIRIMAN pengingat ada di engine `lucyReminder` (durasi + pingMode tiap
// kategori). Modul ini sengaja TIDAK mengirim sendiri.
//
// Distribusi rilis ini MANUAL dan dikendalikan developer — TIDAK ada giveaway
// otomatis, voting, atau pembayaran. Pemberian memakai `awardReminder()` yang
// generik: sumber ('manual' sekarang, 'giveaway' nanti) dicatat di kolom
// source/source_ref, dan UNIQUE(source, source_ref, recipient) membuat pemberian
// dari sumber yang sama idempoten. Jadi integrasi giveaway bisa ditambah nanti
// tanpa mengubah model kepemilikan.
//
// Otorisasi developer memakai ulang isDeveloper() yang sudah ada di
// commands/prefix.js (env DEVELOPER_IDS + pemilik aplikasi + pemilik server).
// Tidak ada daftar developer kedua.
const { getGuildSettings, updateGuildSettings, matchPrefix, DEFAULT_PREFIX } = require('../utils/storage');
const store = require('../utils/reminderStorage');
const validate = require('../utils/reminderValidate');
const variables = require('../utils/reminderVariables');
const cats = require('../utils/reminderCategories');
const resolver = require('../utils/reminderResolve');
const { isDeveloper } = require('../commands/prefix');
const { PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

// Konfirmasi tindakan destruktif/transfer. Disimpan di memori karena hanya
// berlaku singkat; yang penting (kepemilikan) tetap di SQLite.
const CONFIRM_TTL_MS = 60000;
const CONFIRM_COMMANDS = new Set(['confirm', 'konfirmasi', 'ya', 'yes']);
const CANCEL_COMMANDS = new Set(['cancel', 'batal', 'tidak', 'no']);
const pendingConfirms = new Map();

// Panel interaktif `d r`: tombol untuk bantuan dan daftar variabel.
const PANEL_PREFIX = 'rempanel';
const PANEL_HELP = PANEL_PREFIX + ':help';
const PANEL_VARS = PANEL_PREFIX + ':vars';
const PANEL_BACK = PANEL_PREFIX + ':back';

// Palet warna dan ikon agar semua balasan seragam dan mudah dipindai.
const COLOR = { info: 0x5865F2, ok: 0x57F287, warn: 0xFEE75C, error: 0xED4245, panel: 0xEB459E };
const ICON = {
  ok: '✅', error: '❌', warn: '⚠️', info: 'ℹ️',
  active: '🟢', inactive: '⚪', share: '🎉', lock: '🔒',
  reminder: '📦', category: '🏷️', format: '🎨', media: '🎞️', variable: '🧩', help: '📋'
};

function confirmKey(message) { return message.guildId + ':' + message.channelId + ':' + message.author.id; }

function rememberConfirm(message, action) {
  pendingConfirms.set(confirmKey(message), { action, at: Date.now() });
}
function takeConfirm(message) {
  const key = confirmKey(message);
  const entry = pendingConfirms.get(key);
  if (!entry) return null;
  pendingConfirms.delete(key);
  if (Date.now() - entry.at > CONFIRM_TTL_MS) return null;
  return entry.action;
}
function clearConfirm(message) { return pendingConfirms.delete(confirmKey(message)); }

function isAdmin(message) {
  return Boolean(message.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild));
}
function isOwner(message, reminder) {
  return Boolean(reminder && reminder.ownerId === message.author?.id);
}
// Pemilik reminder, admin server, atau developer boleh mengelola.
function canManage(message, reminder) {
  return isOwner(message, reminder) || isAdmin(message) || isDeveloper(message);
}

async function send(message, payload) {
  return message.reply({ ...payload, allowedMentions: { repliedUser: false, parse: [] } });
}

// Semua balasan dalam lingkup reminder memakai embed.
async function sendEmbed(message, { title = null, description = null, color = COLOR.info, footer = null, fields = null, components = null } = {}) {
  const embed = new EmbedBuilder().setColor(color);
  if (title) embed.setTitle(title);
  if (description) embed.setDescription(description);
  if (fields) embed.addFields(fields);
  if (footer) embed.setFooter({ text: footer });
  const payload = { embeds: [embed] };
  if (components) payload.components = components;
  return send(message, payload);
}
function sendOk(message, description, title = ICON.ok + ' Berhasil') {
  return sendEmbed(message, { title, description, color: COLOR.ok });
}
function sendError(message, description, title = ICON.error + ' Gagal') {
  return sendEmbed(message, { title, description, color: COLOR.error });
}
function sendWarn(message, description, title = ICON.warn + ' Perhatian') {
  return sendEmbed(message, { title, description, color: COLOR.warn });
}
// Pembungkus ringkas: tetap dikirim sebagai embed supaya seluruh lingkup
// reminder konsisten.
function sendText(message, content) {
  return sendEmbed(message, { title: ICON.reminder + ' Custom Reminder', description: String(content ?? ''), color: COLOR.info });
}

function parseUserArg(arg) {
  const match = String(arg || '').match(/^<@!?(\d{17,20})>$/);
  return match ? match[1] : null;
}

function prefixOf(message) {
  return getGuildSettings(message.guildId).prefix || DEFAULT_PREFIX;
}

// Bangun konteks variabel dari objek pengguna/guild Discord.
function contextFor(message, user, guild) {
  const settings = getGuildSettings(message.guildId);
  const member = message.member;
  return variables.createRenderContext({
    guildId: message.guildId,
    settings,
    user: {
      id: user.id,
      name: user.username,
      displayName: member?.displayName || user.globalName || user.username,
      nickname: member?.nickname || null,
      mention: '<@' + user.id + '>',
      avatarUrl: user.displayAvatarURL?.({ size: 256 }) || user.avatarURL?.({ size: 256 }) || null,
      serverAvatarUrl: member?.displayAvatarURL?.({ size: 256 }) || null
    },
    guild: guild ? { name: guild.name, iconUrl: guild.iconURL?.({ size: 256 }) || null } : null
  });
}

function reminderEmbed(reminder, context) {
  const rendered = variables.render(reminder.message || '', context);
  const config = reminder.embed ? variables.renderEmbed(reminder.embed, context) : {};
  // Builder bersama dipakai engine pengingat dan perintah view, supaya render
  // embed hanya ada di satu tempat.
  return resolver.buildEmbed({ color: 0x5865F2, ...config }, rendered);
}

// Reminder boleh dipindahbukukan hanya bila formatnya NORMAL dan pemiliknya
// sudah menyalakan `shareable`. Format EMBED tidak pernah bisa dibagikan.
function isShareable(reminder) {
  return Boolean(reminder) && reminder.format !== 'EMBED' && Boolean(reminder.shareable);
}
// Alasan penolakan, dipakai bersama oleh `r shareable`, `r send`, dan eksekusi
// transfer supaya pesannya konsisten.
function shareBlockReason(reminder) {
  if (!reminder) return null;
  if (reminder.format === 'EMBED') return 'Reminder berformat **Embed** tidak bisa dibagikan — hanya reminder **Normal** yang bisa dipindahbukukan.';
  return null;
}

// Baris ringkas untuk inventory: status, ID, nama kategori+format, shareable.
function inventoryLine(reminder) {
  const active = reminder.active ? ICON.active : ICON.inactive;
  const share = isShareable(reminder) ? ICON.share : ICON.lock;
  const collectible = reminder.collectible ? ' • 🏅 ' + reminder.collectible : '';
  return active + ' `' + reminder.reminderId + '` — ' + cats.displayNameFor(reminder.category, reminder.format) + ' ' + share + collectible;
}

const INVENTORY_LEGEND = [
  ICON.active + ' **Aktif** — pengingat dinyalakan.',
  ICON.share + ' **Shareable** — reminder Normal yang boleh dipindahbukukan ke user lain.',
  ICON.lock + ' **Tidak shareable** — hanya bisa dipakai sendiri (semua reminder Embed).',
  ICON.inactive + ' **Tidak aktif** — tetap bisa diubah.'
].join('\n');

// Embed inventory. Judul memakai nama pengguna dan avatar-nya sebagai ikon.
function inventoryEmbed(message, user, list) {
  const embed = new EmbedBuilder().setColor(COLOR.panel).setTitle('Custom Reminders — ' + user.displayName);
  const icon = user.avatarUrl;
  if (icon) embed.setThumbnail(icon);
  if (list.length) {
    embed.setDescription(list.map(inventoryLine).join('\n'));
    embed.addFields({ name: 'Legenda', value: INVENTORY_LEGEND });
    embed.setFooter({ text: list.length + ' reminder • pakai tombol di bawah untuk bantuan & variabel' });
  } else {
    embed.setDescription('Kamu belum punya reminder.\nKlaim award dari developer dengan `' + prefixOf(message) + ' r redeem <CLAIM_ID>`.');
  }
  return embed;
}

// Baris tombol panel: "Cara menggunakan" dan "Variabel".
function panelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(PANEL_HELP).setLabel('Cara menggunakan').setEmoji(ICON.help).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(PANEL_VARS).setLabel('Variabel').setEmoji(ICON.variable).setStyle(ButtonStyle.Secondary)
  );
}
// Baris tombol kembali dari halaman bantuan/variabel.
function panelBackRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(PANEL_BACK).setLabel('Kembali').setEmoji('↩️').setStyle(ButtonStyle.Secondary)
  );
}

function collectibleSuffix(reminder) {
  return reminder.collectible ? ' • 🏅 ' + reminder.collectible : '';
}

// --------------------------------------------------------------- award flow --
// Beri reminder kepada penerima. Idempoten bila sourceRef diisi.
function awardReminder({ templateId, recipientId, issuerId = null, source = 'manual', sourceRef = null, expiresAt = null, now = Date.now() }) {
  const template = store.getTemplate(templateId);
  if (!template) return { ok: false, errors: ['Template ' + templateId + ' tidak ditemukan.'] };
  if (!template.available) return { ok: false, errors: ['Template ' + templateId + ' sudah tidak tersedia.'] };
  if (!store.isValidUserId(recipientId)) return { ok: false, errors: ['ID penerima tidak valid.'] };
  const { award, created } = store.createAward({
    templateId: template.templateId, recipientId, issuerId, source, sourceRef, expiresAt, now
  });
  return { ok: true, award, created, template };
}

// Redeem oleh penerima. Atomik: klaim ganda ditolak oleh guard di SQL.
function redeemAward({ claimId, userId, now = Date.now() }) {
  if (!store.isValidClaimId(claimId)) return { ok: false, errors: ['Format claim ID tidak valid (contoh: C-ABC123).'] };
  const id = store.normalizeId(claimId);
  const award = store.getAward(id);
  if (!award) return { ok: false, errors: ['Award ' + id + ' tidak ditemukan.'] };
  if (award.recipientId !== userId) return { ok: false, errors: ['Award ini bukan milikmu.'] };
  if (award.status === 'redeemed') return { ok: false, errors: ['Award ini sudah diklaim sebelumnya (reminder ' + award.reminderId + ').'], reminderId: award.reminderId };
  if (award.status === 'revoked') return { ok: false, errors: ['Award ini sudah dicabut oleh developer.'] };
  if (award.expiresAt && award.expiresAt <= now) return { ok: false, errors: ['Award ini sudah kedaluwarsa.'] };

  const template = store.getTemplate(award.templateId);
  if (!template) return { ok: false, errors: ['Template sumber tidak ditemukan lagi.'] };

  try {
    return store.inTransaction(() => {
      const reminder = store.createReminder({
        ownerId: userId, templateId: template.templateId, message: template.message,
        embed: template.embed, collectible: template.collectible, active: false, now,
        category: template.category, format: template.format, name: template.name
      });
      const won = store.markAwardRedeemed({ claimId: id, recipientId: userId, reminderId: reminder.reminderId, now });
      // Balapan klaim: award sudah diklaim/dicabut di antara pemeriksaan awal dan
      // transaksi ini. Harus DILEMPAR supaya transaksi di-ROLLBACK — kalau hanya
      // mengembalikan hasil gagal, transaksi justru COMMIT dan reminder yang baru
      // dibuat tertinggal. Hasilnya ditangkap di bawah sebagai kegagalan biasa
      // agar pengguna tetap menerima pesan yang jelas.
      if (!won) throw new Error('CLAIM_RACE');
      return { ok: true, reminder, template };
    });
  } catch (error) {
    if (error?.message === 'CLAIM_RACE') {
      return { ok: false, errors: ['Award ini baru saja diklaim. Kode hanya bisa dipakai sekali.'], race: true };
    }
    throw error;
  }
}

// ------------------------------------------------------------ confirmation --
async function askConfirm(message, prefix, action, prompt) {
  rememberConfirm(message, action);
  return sendText(message, prompt + '\nKonfirmasi dengan `' + prefix + ' r confirm` atau batalkan dengan `' + prefix + ' r cancel` (berlaku 60 detik).');
}

// ----------------------------------------------------------------- commands --
// Delapan perintah pengguna untuk kategori reminder, plus perintah developer.
function userCommandList(prefix) {
  return [
    { cmd: prefix + ' r redeem <CLAIM_ID>', desc: 'Klaim reminder dari claim ID yang dikirim developer.' },
    { cmd: prefix + ' r view <ID>', desc: 'Lihat pratinjau pesan/embed reminder milikmu.' },
    { cmd: prefix + ' r send <@user> <ID>', desc: 'Bagikan reminder Normal ke user lain (perlu konfirmasi).' },
    { cmd: prefix + ' r update <ID> <pesan>', desc: 'Ubah pesan biasa reminder.' },
    { cmd: prefix + ' r embed <ID> <JSON>', desc: 'Atur embed (JSON hasil salin dari discohook juga diterima).' },
    { cmd: prefix + ' r media <URL>', desc: 'Ambil URL media dari Tenor atau Klipy.' },
    { cmd: prefix + ' r enable <ID>', desc: 'Nyalakan satu reminder.' },
    { cmd: prefix + ' r disable <ID>', desc: 'Matikan satu reminder (otomatis kembali ke default server).' }
  ];
}

// Teks bantuan (dipakai tombol "Cara menggunakan").
function helpText(prefix) {
  const rows = userCommandList(prefix).map(c => '`' + c.cmd + '`\n┗ ' + c.desc).join('\n');
  return [
    '**Perintah reminder**',
    rows,
    '',
    '**Developer**',
    '`' + prefix + ' r create <KATEGORI> <FORMAT>` — buat template; bot membalas kode template',
    '`' + prefix + ' r give <@user> <KODE>` — beri reminder ke pemenang',
    '`' + prefix + ' r delete <ID>` — hapus reminder siapa pun (perlu konfirmasi)',
    '`' + prefix + ' r templates` — daftar kode template',
    '`' + prefix + ' r awards` / `' + prefix + ' r revoke <CLAIM_ID>` — kelola claim',
    '',
    '**Server (admin/pemilik)**',
    '`' + prefix + ' s <aksi> set text <teks>` / `' + prefix + ' s <aksi> reset`',
    'Aksi: ' + cats.ACTIONS.join(', ') + '.',
    '',
    'Urutan pemakaian: Custom Reminder aktif → default server → bawaan bot.'
  ].join('\n');
}

function usageEmbed(prefix) {
  return new EmbedBuilder()
    .setColor(COLOR.panel)
    .setTitle(ICON.help + ' Cara Menggunakan Custom Reminder')
    .setDescription(helpText(prefix));
}

function variablesText() {
  return variables.variableReference().map(v => '`' + v.name + '` — ' + v.description).join('\n');
}

function variablesEmbed() {
  return new EmbedBuilder()
    .setColor(COLOR.panel)
    .setTitle(ICON.variable + ' Variabel yang Tersedia')
    .setDescription(variablesText() + '\n\nContoh timestamp relatif:\n`Halo {USER}, reset <t:{DAILY_TOMORROW}:R>`');
}

// Handler utama. Mengembalikan true bila pesan ini adalah perintah reminder.
async function handleMessage(message, deps = {}) {
  if (!message?.guildId || message.author?.bot || !message.content) return false;
  const prefix = prefixOf(message);
  const matched = matchPrefix(message.content, prefix);
  if (matched === null) return false;
  const parts = matched.trim().split(/\s+/);
  const head = (parts[0] || '').toLowerCase();
  if (!['reminder', 'r'].includes(head)) return false;
  const sub = (parts[1] || '').toLowerCase();
  const args = parts.slice(2);
  const dev = (deps.isDeveloper || isDeveloper)(message);

  // --- konfirmasi / batal ---
  if (CONFIRM_COMMANDS.has(sub) || CANCEL_COMMANDS.has(sub)) {
    if (CANCEL_COMMANDS.has(sub)) {
      const had = clearConfirm(message);
      await sendWarn(message, had ? 'Tindakan dibatalkan.' : 'Tidak ada tindakan yang menunggu konfirmasi.', '↩️ Dibatalkan');
      return true;
    }
    const action = takeConfirm(message);
    if (!action) { await sendWarn(message, 'Tidak ada tindakan yang menunggu konfirmasi, atau sudah kedaluwarsa.'); return true; }
    return runConfirmed(message, prefix, action, deps);
  }

  // --- panel (tanpa argumen / inventory) ---
  if (!sub || sub === 'help' || sub === 'bantuan' || sub === 'inventory' || sub === 'inv' || sub === 'daftar'
      || sub === 'active' || sub === 'aktif') {
    const user = await panelUser(message);
    const activeOnly = sub === 'active' || sub === 'aktif';
    const list = store.listRemindersByOwner(message.author.id, activeOnly ? { activeOnly: true } : undefined);
    await send(message, { embeds: [inventoryEmbed(message, user, list)], components: [panelRow()] });
    return true;
  }

  // --- redeem ---
  if (sub === 'redeem' || sub === 'klaim') {
    let result;
    try {
      result = redeemAward({ claimId: args[0], userId: message.author.id });
    } catch (error) {
      result = { ok: false, errors: ['Klaim gagal diproses. Coba lagi sebentar lagi.'] };
      console.error('[Reminders] redeem gagal:', error?.message);
    }
    if (!result.ok) { await sendError(message, result.errors.join(' ')); return true; }
    await sendEmbed(message, {
      title: ICON.ok + ' Reminder Diklaim',
      color: COLOR.ok,
      description: 'Reminder kamu: `' + result.reminder.reminderId + '`\nDari template `' + result.template.name + '`.',
      fields: [
        { name: 'Kategori', value: cats.categoryLabel(result.reminder.category), inline: true },
        { name: 'Format', value: cats.formatLabel(result.reminder.format), inline: true }
      ],
      footer: 'Nyalakan dengan ' + prefix + ' r enable ' + result.reminder.reminderId
    });
    return true;
  }

  // --- view ---
  if (sub === 'view' || sub === 'lihat' || sub === 'info') {
    if (!store.isValidReminderId(args[0])) { await sendError(message, 'Format: `' + prefix + ' r view <ID>` — contoh `' + prefix + ' r view R-ABC12`.'); return true; }
    const reminder = store.getReminder(args[0]);
    if (!reminder) { await sendError(message, 'Reminder `' + store.normalizeId(args[0]) + '` tidak ditemukan.'); return true; }
    if (!canManage(message, reminder)) { await sendError(message, 'Reminder itu bukan milikmu.'); return true; }
    const user = await message.client.users.fetch(reminder.ownerId).catch(() => null);
    const context = contextFor(message, user || message.author, message.guild);
    const embed = reminderEmbed(reminder, context);
    embed.setTitle(embed.data.title || (ICON.info + ' ' + reminder.reminderId + ' — ' + cats.displayNameFor(reminder.category, reminder.format)));
    embed.setFooter({ text: (reminder.active ? ICON.active + ' aktif' : ICON.inactive + ' nonaktif') + ' • ' + (isShareable(reminder) ? ICON.share + ' shareable' : ICON.lock + ' tidak shareable') + ' • ' + reminder.reminderId });
    await send(message, { embeds: [embed] });
    return true;
  }

  // --- update ---
  if (sub === 'update' || sub === 'ubah') {
    const id = args[0];
    const newMessage = args.slice(1).join(' ');
    if (!store.isValidReminderId(id) || !newMessage) { await sendError(message, 'Format: `' + prefix + ' r update <ID> <pesan baru>`. Pakai variabel seperti `{USER}`.'); return true; }
    const reminder = store.getReminder(id);
    if (!reminder) { await sendError(message, 'Reminder tidak ditemukan.'); return true; }
    if (!isOwner(message, reminder)) { await sendError(message, 'Kamu hanya bisa mengubah reminder milikmu sendiri.'); return true; }
    if (newMessage.length > validate.LIMITS.totalEmbed) { await sendError(message, 'Pesan terlalu panjang (maks ' + validate.LIMITS.totalEmbed + ' karakter).'); return true; }
    store.updateReminder(id, { message: newMessage });
    await sendOk(message, 'Pesan `' + store.normalizeId(id) + '` diperbarui.', ICON.ok + ' Pesan Diperbarui');
    return true;
  }

  // --- embed ---
  if (sub === 'embed') {
    const id = args[0];
    const json = args.slice(1).join(' ');
    if (!store.isValidReminderId(id) || !json) {
      await sendError(message, 'Format: `' + prefix + ' r embed <ID> <JSON>`.\nContoh: `{"title":"Halo {USER}","color":"#5865F2"}`\nJSON hasil salin dari discohook.org juga diterima.');
      return true;
    }
    const reminder = store.getReminder(id);
    if (!reminder) { await sendError(message, 'Reminder tidak ditemukan.'); return true; }
    if (!isOwner(message, reminder)) { await sendError(message, 'Kamu hanya bisa mengubah reminder milikmu sendiri.'); return true; }
    const result = validate.parseAndValidateEmbed(json);
    if (!result.ok) { await sendError(message, 'Embed ditolak:\n• ' + result.errors.join('\n• '), ICON.error + ' Embed Ditolak'); return true; }
    const resolved = await validate.resolveEmbedMedia(result.value);
    store.updateReminder(id, { embed: resolved });
    await sendEmbed(message, {
      title: ICON.ok + ' Embed Tersimpan',
      color: COLOR.ok,
      description: 'Embed `' + store.normalizeId(id) + '` diperbarui.',
      fields: [{ name: 'Pratinjau', value: 'Lihat dengan `' + prefix + ' r view ' + store.normalizeId(id) + '`.' }]
    });
    return true;
  }

  // --- enable / disable ---
  if (sub === 'enable' || sub === 'aktifkan' || sub === 'disable' || sub === 'matikan') {
    const enable = sub === 'enable' || sub === 'aktifkan';
    const id = args[0];
    if (!store.isValidReminderId(id)) { await sendError(message, 'Format: `' + prefix + ' r ' + (enable ? 'enable' : 'disable') + ' <ID>`.'); return true; }
    const reminder = store.getReminder(id);
    if (!reminder) { await sendError(message, 'Reminder tidak ditemukan.'); return true; }
    if (!isOwner(message, reminder)) { await sendError(message, 'Hanya pemilik yang bisa mengubah status reminder ini.'); return true; }
    store.updateReminder(id, { active: enable, activatedAt: enable ? Date.now() : reminder.activatedAt });
    if (enable) {
      await sendEmbed(message, {
        title: ICON.active + ' Reminder Diaktifkan',
        color: COLOR.ok,
        description: '`' + store.normalizeId(id) + '` aktif. Pengingat dikirim saat kamu melakukan aksi ' + cats.categoryLabel(reminder.category) + '.'
      });
    } else {
      await sendEmbed(message, {
        title: ICON.inactive + ' Reminder Dimatikan',
        color: COLOR.warn,
        description: '`' + store.normalizeId(id) + '` dimatikan.\nOtomatis kembali ke **default server** untuk aksi ini; kalau server belum mengatur, dipakai bawaan bot.'
      });
    }
    return true;
  }

  // --- send (transfer) ---
  if (sub === 'send' || sub === 'kirim' || sub === 'gift') {
    const targetId = parseUserArg(args[0]);
    const id = args[1];
    if (!targetId || !store.isValidReminderId(id)) { await sendError(message, 'Format: `' + prefix + ' r send <@user> <ID>`.'); return true; }
    if (targetId === message.author.id) { await sendError(message, 'Kamu sudah memiliki reminder itu.'); return true; }
    const reminder = store.getReminder(id);
    if (!reminder) { await sendError(message, 'Reminder tidak ditemukan.'); return true; }
    if (!isOwner(message, reminder)) { await sendError(message, 'Kamu hanya bisa menghadiahkan reminder milikmu sendiri.'); return true; }
    const blocked = shareBlockReason(reminder);
    if (blocked) { await sendError(message, blocked); return true; }
    if (!reminder.shareable) {
      await sendError(message, 'Reminder ini belum ditandai shareable, jadi tidak bisa dipindahbukukan.\nAktifkan dulu dengan `' + prefix + ' r shareable ' + store.normalizeId(id) + ' on`.');
      return true;
    }
    return askConfirm(message, prefix, { kind: 'transfer', reminderId: store.normalizeId(id), toUserId: targetId },
      'Kirim `' + store.normalizeId(id) + '` ke <@' + targetId + '>? Ini **memindahkan kepemilikan** — kamu tidak bisa lagi mengubahnya.');
  }

  // --- delete (khusus developer) ---
  // Developer perlu bisa membersihkan reminder kapan saja — mis. data uji atau
  // reminder yang salah diberikan. Sengaja TIDAK dibuka untuk pemilik/admin
  // supaya tidak ada yang kehilangan reminder karena salah hapus.
  if (sub === 'delete' || sub === 'hapus' || sub === 'buang') {
    if (!dev) { await sendError(message, 'Hanya developer bot yang bisa menghapus reminder.'); return true; }
    const id = args[0];
    if (!store.isValidReminderId(id)) { await sendError(message, 'Format: `' + prefix + ' r delete <ID>`.\nLihat ID-nya dengan `' + prefix + ' r inventory`.'); return true; }
    const reminder = store.getReminder(id);
    if (!reminder) { await sendError(message, 'Reminder tidak ditemukan.'); return true; }
    return askConfirm(message, prefix, { kind: 'delete', reminderId: store.normalizeId(id) },
      'Hapus reminder `' + store.normalizeId(id) + '` (' + cats.categoryLabel(reminder.category) + ') milik <@' + reminder.ownerId + '>?\nTindakan ini **permanen** dan tidak bisa dibatalkan.');
  }

  // --- shareable (pendukung aturan transfer) ---
  if (sub === 'shareable' || sub === 'bagikan') {
    const id = args[0];
    const action = (args[1] || '').toLowerCase();
    if (!store.isValidReminderId(id) || !['on', 'off'].includes(action)) {
      await sendError(message, 'Format: `' + prefix + ' r shareable <ID> on|off`.');
      return true;
    }
    const reminder = store.getReminder(id);
    if (!reminder) { await sendError(message, 'Reminder tidak ditemukan.'); return true; }
    if (!isOwner(message, reminder)) { await sendError(message, 'Kamu hanya bisa mengubah reminder milikmu sendiri.'); return true; }
    // Reminder Embed tidak pernah bisa dibagikan, jadi menyalakan shareable
    // ditolak sejak awal — bukan hanya diabaikan saat `r send`.
    if (action === 'on') {
      const blocked = shareBlockReason(reminder);
      if (blocked) { await sendError(message, blocked); return true; }
    }
    store.updateReminder(id, { shareable: action === 'on' });
    await sendOk(message, action === 'on'
      ? ICON.share + ' Reminder `' + store.normalizeId(id) + '` sekarang shareable (boleh dipindahbukukan).'
      : ICON.lock + ' Reminder `' + store.normalizeId(id) + '` sekarang tidak shareable.',
      action === 'on' ? ICON.share + ' Shareable Aktif' : ICON.lock + ' Shareable Dimatikan');
    return true;
  }

  // --- media (Tenor + Klipy) ---
  if (sub === 'media' || sub === 'tenor' || sub === 'klipy') {
    const provider = sub === 'klipy' ? 'klipy' : sub === 'tenor' ? 'tenor' : 'any';
    const result = provider === 'any' ? await validate.resolveAnyMedia(args[0])
      : provider === 'klipy' ? await validate.resolveKlipy(args[0])
      : await validate.resolveTenor(args[0]);
    if (!result.ok) { await sendError(message, result.errors.join(' '), ICON.error + ' Media Tidak Valid'); return true; }
    await sendEmbed(message, {
      title: ICON.media + ' URL Media',
      color: COLOR.ok,
      description: result.value,
      fields: [{ name: 'Penyedia', value: /klipy\.com/i.test(result.value) ? 'Klipy' : 'Tenor', inline: true }],
      footer: 'Tempel URL ini ke pesan atau field image/thumbnail embed.'
    });
    return true;
  }

  // --- setcollectible / reset (pengelolaan lanjutan) ---
  if (sub === 'setcollectible' || sub === 'collectible') {
    const id = args[0];
    if (!store.isValidReminderId(id) || !args[1]) {
      await sendError(message, 'Format: `' + prefix + ' r setcollectible <ID> <tipe>`. Pilihan: ' + validate.collectibleRegistry(getGuildSettings(message.guildId)).join(', ') + '.');
      return true;
    }
    const reminder = store.getReminder(id);
    if (!reminder) { await sendError(message, 'Reminder tidak ditemukan.'); return true; }
    if (!isOwner(message, reminder)) { await sendError(message, 'Kamu hanya bisa mengubah reminder milikmu sendiri.'); return true; }
    const result = validate.validateCollectible(args[1], getGuildSettings(message.guildId));
    if (!result.ok) { await sendError(message, result.errors.join(' ')); return true; }
    store.updateReminder(id, { collectible: result.value });
    await sendOk(message, 'Collectible `' + store.normalizeId(id) + '` disetel ke **' + result.value + '**.');
    return true;
  }

  if (sub === 'reset' || sub === 'aturulang') {
    const id = args[0];
    if (!store.isValidReminderId(id)) { await sendError(message, 'Format: `' + prefix + ' r reset <ID>`. Perlu konfirmasi.'); return true; }
    const reminder = store.getReminder(id);
    if (!reminder) { await sendError(message, 'Reminder tidak ditemukan.'); return true; }
    if (!isOwner(message, reminder)) { await sendError(message, 'Kamu hanya bisa mengubah reminder milikmu sendiri.'); return true; }
    const template = store.getTemplate(reminder.templateId);
    if (!template) { await sendError(message, 'Template sumber tidak ditemukan, tidak bisa reset.'); return true; }
    return askConfirm(message, prefix, { kind: 'reset', reminderId: store.normalizeId(id) },
      'Reset `' + store.normalizeId(id) + '` akan mengembalikan pesan, embed, dan collectible ke bawaan template `' + template.name + '`.');
  }

  // --- developer ---
  if (sub === 'create' || sub === 'buat') {
    if (!dev) { await sendError(message, 'Hanya developer bot yang bisa membuat template.'); return true; }
    // Terima nama kategori resmi atau nama aksi (`battle`, `hunt`, `pray`).
    const category = cats.resolveCategoryInput(args[0]);
    const format = cats.normalizeFormat(args[1]);
    if (!category || !format) {
      await sendError(message, 'Format: `' + prefix + ' r create <KATEGORI> <FORMAT>`.\n' +
        'Kategori: ' + cats.CATEGORY_KEYS.join(', ') + '\nFormat: ' + cats.FORMAT_KEYS.join(', ') + '\n' +
        'Contoh: `' + prefix + ' r create battle embed` atau `' + prefix + ' r create PRAY_CURSE NORMAL`.');
      return true;
    }
    // Tanpa nama/isi: template dibuat kosong dan isinya diatur penerima lewat
    // `r update` / `r embed`. Kalau developer menyertakan isi, tetap dipakai.
    const rest = args.slice(2).join(' ');
    const segments = rest.split('|').map(x => x.trim());
    const explicitName = segments[0] || '';
    const templateMessage = segments.length > 1 ? segments[1] : '';
    const embedJson = segments.length > 2 ? segments[2] : null;
    const name = explicitName || cats.displayNameFor(category, format);
    let embed = null;
    if (embedJson) {
      const result = validate.parseAndValidateEmbed(embedJson);
      if (!result.ok) { await sendError(message, 'Embed ditolak:\n• ' + result.errors.join('\n• ')); return true; }
      embed = result.value;
    }
    const template = store.createTemplate({ name, message: templateMessage, embed, creatorId: message.author.id, category, format });
    await sendEmbed(message, {
      title: ICON.ok + ' Template Dibuat',
      color: COLOR.ok,
      description: '**' + cats.displayNameFor(category, format) + '**',
      fields: [
        { name: 'Kode template', value: '`' + template.templateId + '`', inline: true },
        { name: 'Kategori', value: cats.categoryLabel(category), inline: true },
        { name: 'Format', value: cats.formatLabel(format), inline: true }
      ],
      footer: 'Beri ke pemenang: ' + prefix + ' r give @user ' + template.templateId
    });
    return true;
  }

  if (sub === 'templates' || sub === 'template') {
    if (!dev) { await sendError(message, 'Hanya developer bot yang bisa melihat daftar template.'); return true; }
    const list = store.listTemplates({ includeUnavailable: true });
    if (!list.length) { await sendWarn(message, 'Belum ada template. Buat dengan `' + prefix + ' r create <KATEGORI> <FORMAT>`.', ICON.reminder + ' Belum Ada Template'); return true; }
    const lines = list.map(t => (t.available ? ICON.active : ICON.inactive) + ' `' + t.templateId + '` — **' + t.name + '** • ' + cats.displayNameFor(t.category, t.format) + (t.collectible ? ' • 🏅 ' + t.collectible : ''));
    await sendEmbed(message, { title: ICON.reminder + ' Template (' + list.length + ')', color: COLOR.panel, description: lines.join('\n') });
    return true;
  }

  if (sub === 'give' || sub === 'beri') {
    if (!dev) { await sendError(message, 'Hanya developer bot yang bisa memberi reminder.'); return true; }
    const targetId = parseUserArg(args[0]);
    const templateId = args[1];
    if (!targetId || !store.isValidTemplateId(templateId)) {
      await sendError(message, 'Format: `' + prefix + ' r give <@user> <KODE>` — contoh `' + prefix + ' r give @user T-ABC12`.');
      return true;
    }
    const result = awardReminder({ templateId, recipientId: targetId, issuerId: message.author.id });
    if (!result.ok) { await sendError(message, result.errors.join(' ')); return true; }
    const { award, created } = result;
    if (!created) {
      await sendWarn(message, 'Award untuk <@' + targetId + '> dari template ini sudah ada: `' + award.claimId + '` (status: ' + award.status + ').');
      return true;
    }
    const dm = await dmAward(client(message), targetId, award, result.template, prefix);
    await sendEmbed(message, {
      title: ICON.ok + ' Award Dibuat',
      color: dm.ok ? COLOR.ok : COLOR.warn,
      description: 'Untuk <@' + targetId + '>',
      fields: [
        { name: 'Claim ID', value: '`' + award.claimId + '`', inline: true },
        { name: 'Template', value: '`' + result.template.templateId + '`', inline: true },
        { name: 'DM', value: dm.ok ? ICON.ok + ' terkirim' : ICON.warn + ' gagal — sampaikan claim ID manual', inline: false }
      ],
      footer: dm.ok ? undefined : 'DM gagal: ' + dm.error
    });
    return true;
  }

  if (sub === 'awards') {
    if (!dev) { await sendError(message, 'Hanya developer bot yang bisa melihat daftar award.'); return true; }
    const list = store.listAwards({ limit: 50 });
    if (!list.length) { await sendWarn(message, 'Belum ada award.', ICON.reminder + ' Belum Ada Award'); return true; }
    const icon = { pending: '⏳', redeemed: '✅', revoked: '🚫', expired: '⌛' };
    const lines = list.map(a => (icon[a.status] || '•') + ' `' + a.claimId + '` → <@' + a.recipientId + '> • ' + a.status + ' • `' + a.templateId + '` • <t:' + Math.floor(a.createdAt / 1000) + ':R>');
    await sendEmbed(message, { title: ICON.reminder + ' Award Terakhir (' + list.length + ')', color: COLOR.panel, description: lines.join('\n') });
    return true;
  }

  if (sub === 'revoke' || sub === 'cabut') {
    if (!dev) { await sendError(message, 'Hanya developer bot yang bisa mencabut award.'); return true; }
    const id = args[0];
    if (!store.isValidClaimId(id)) { await sendError(message, 'Format: `' + prefix + ' r revoke <CLAIM_ID>`. Perlu konfirmasi.'); return true; }
    const award = store.getAward(id);
    if (!award) { await sendError(message, 'Award tidak ditemukan.'); return true; }
    if (award.status !== 'pending') { await sendError(message, 'Award `' + store.normalizeId(id) + '` berstatus **' + award.status + '**, hanya award `pending` yang bisa dicabut.'); return true; }
    return askConfirm(message, prefix, { kind: 'revoke', claimId: store.normalizeId(id) },
      'Cabut award `' + store.normalizeId(id) + '` milik <@' + award.recipientId + '>?');
  }

  await sendWarn(message, 'Perintah tidak dikenal. Buka `' + prefix + ' r` untuk melihat daftar perintah.');
  return true;
}

// Tombol panel: bantuan, variabel, dan kembali ke inventory.
function isPanelNav(customId) {
  return typeof customId === 'string' && customId.startsWith(PANEL_PREFIX + ':');
}

async function handleComponent(i) {
  if (!isPanelNav(i.customId)) return false;
  const id = i.customId;
  const user = await panelUser(i);
  if (id === PANEL_HELP) {
    await i.update({ embeds: [usageEmbed(prefixOf(i))], components: [panelBackRow()] });
    return true;
  }
  if (id === PANEL_VARS) {
    await i.update({ embeds: [variablesEmbed()], components: [panelBackRow()] });
    return true;
  }
  if (id === PANEL_BACK) {
    const list = store.listRemindersByOwner(i.user.id);
    await i.update({ embeds: [inventoryEmbed(i, user, list)], components: [panelRow()] });
    return true;
  }
  return false;
}

// Data pengguna untuk judul + avatar inventory (pesan maupun interaksi).
async function panelUser(source) {
  const author = source.author || source.user;
  const displayName = source.member?.displayName || author?.globalName || author?.username || 'Kamu';
  let avatarUrl = author?.displayAvatarURL?.({ size: 256 }) || author?.avatarURL?.({ size: 256 }) || null;
  if (!avatarUrl && author?.id && source.client?.users?.fetch) {
    const fetched = await source.client.users.fetch(author.id).catch(() => null);
    avatarUrl = fetched?.displayAvatarURL?.({ size: 256 }) || null;
  }
  return { displayName, avatarUrl };
}

function client(message) { return message.client; }

// Jalankan tindakan yang sudah dikonfirmasi.
async function runConfirmed(message, prefix, action, deps) {
  if (action.kind === 'transfer') {
    const reminder = store.getReminder(action.reminderId);
    if (!reminder) { await sendError(message, 'Reminder tidak ditemukan lagi.'); return true; }
    if (!isOwner(message, reminder)) { await sendError(message, 'Kamu bukan lagi pemilik reminder itu.'); return true; }
    const blocked = shareBlockReason(reminder);
    if (blocked) { await sendError(message, blocked); return true; }
    const moved = store.transferReminder({ reminderId: action.reminderId, fromUserId: message.author.id, toUserId: action.toUserId });
    if (!moved) { await sendError(message, 'Transfer gagal — kepemilikan mungkin sudah berubah.'); return true; }
    await sendEmbed(message, {
      title: '🎉 Reminder Dipindahbukukan',
      color: COLOR.ok,
      description: '`' + action.reminderId + '` kini milik <@' + action.toUserId + '>.',
      footer: 'Kamu tidak bisa lagi mengubahnya.'
    });
    return true;
  }
  if (action.kind === 'reset') {
    const reminder = store.getReminder(action.reminderId);
    if (!reminder) { await sendError(message, 'Reminder tidak ditemukan lagi.'); return true; }
    if (!isOwner(message, reminder)) { await sendError(message, 'Kamu bukan lagi pemilik reminder itu.'); return true; }
    const template = store.getTemplate(reminder.templateId);
    if (!template) { await sendError(message, 'Template sumber tidak ditemukan.'); return true; }
    store.updateReminder(action.reminderId, { message: template.message, embed: template.embed, collectible: template.collectible });
    await sendOk(message, '`' + action.reminderId + '` dikembalikan ke bawaan template `' + template.name + '`.', '♻️ Reminder Direset');
    return true;
  }
  if (action.kind === 'delete') {
    if (!(deps.isDeveloper || isDeveloper)(message)) { await sendError(message, 'Hanya developer bot yang bisa menghapus reminder.'); return true; }
    const reminder = store.getReminder(action.reminderId);
    if (!reminder) { await sendError(message, 'Reminder itu sudah tidak ada.'); return true; }
    const removed = store.deleteReminder({ reminderId: action.reminderId, actorId: message.author.id });
    if (!removed) { await sendError(message, 'Penghapusan gagal — reminder mungkin sudah hilang.'); return true; }
    await sendEmbed(message, {
      title: '🗑️ Reminder Dihapus',
      color: COLOR.ok,
      description: '`' + removed.reminderId + '` (' + cats.categoryLabel(removed.category) + ') milik <@' + removed.ownerId + '> sudah dihapus.',
      footer: 'Award yang sudah diklaim tetap tercatat sebagai riwayat.'
    });
    return true;
  }
  if (action.kind === 'revoke') {
    const dev = (deps.isDeveloper || isDeveloper)(message);
    if (!dev) { await sendError(message, 'Hanya developer bot yang bisa mencabut award.'); return true; }
    const revoked = store.revokeAward({ claimId: action.claimId, actorId: message.author.id });
    if (revoked) await sendEmbed(message, { title: '🚫 Award Dicabut', color: COLOR.warn, description: 'Award `' + action.claimId + '` dicabut.' });
    else await sendWarn(message, 'Award itu sudah tidak berstatus pending.');
    return true;
  }
  await sendError(message, 'Tindakan tidak dikenal.');
  return true;
}

// Kirim DM berisi claim ID + instruksi. Kegagalan DM tidak fatal: pemanggil
// memberi tahu developer supaya claim ID bisa disampaikan manual.
async function dmAward(client, recipientId, award, template, prefix) {
  try {
    const user = await client.users.fetch(recipientId);
    const embed = new EmbedBuilder()
      .setColor(COLOR.panel)
      .setTitle('🎁 Kamu Menerima Custom Reminder!')
      .setDescription('Template: **' + template.name + '**')
      .addFields(
        { name: 'Claim ID', value: '`' + award.claimId + '`', inline: true },
        { name: 'Kategori', value: cats.categoryLabel(template.category), inline: true },
        { name: 'Format', value: cats.formatLabel(template.format), inline: true }
      )
      .setFooter({ text: 'Klaim dengan: ' + prefix + ' r redeem ' + award.claimId });
    await user.send({ embeds: [embed] });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || 'tidak diketahui' };
  }
}

// Hook yang bisa dipanggil dari alur giveaway di masa depan tanpa mengubah model
// kepemilikan. Belum dipakai rilis ini (distribusi manual), tapi disediakan agar
// integrasi otomatis tidak memerlukan perancangan ulang.
async function onGiveawayWinner({ client, guildId, giveawayId, winnerId, templateId, prefix = DEFAULT_PREFIX }) {
  const result = awardReminder({
    templateId, recipientId: winnerId, issuerId: null, source: 'giveaway', sourceRef: giveawayId
  });
  if (!result.ok) return result;
  if (result.created) await dmAward(client, winnerId, result.award, result.template, prefix);
  return { ok: true, award: result.award, created: result.created };
}

module.exports = {
  handleMessage, handleComponent, awardReminder, redeemAward, onGiveawayWinner,
  helpText, variablesText, usageEmbed, variablesEmbed, reminderEmbed, contextFor, dmAward,
  inventoryEmbed, inventoryLine, panelRow, panelBackRow, isPanelNav, panelUser,
  isAdmin, isOwner, canManage, isShareable, shareBlockReason,
  // untuk pengujian
  pendingConfirms, CONFIRM_TTL_MS
};
