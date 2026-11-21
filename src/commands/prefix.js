const { getGuildSettings, updateGuildSettings, setUserMode, setUserWarnSeconds, DEFAULT_PREFIX, matchPrefix, normalizePrefix } = require('../utils/storage');
const { modeLabel, warnLabel, personalPanel, statusEmbed, helpEmbed } = require('../ui/panel');
const { PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { handlePersonalCommand } = require('./bossRewardNotify');
const { buildDexResponse } = require('../services/animalDex');
const { handleTeamCommand } = require('./battleTeam');
const { handleSimCommand } = require('./battleSim');
const reminderStore = require('../utils/reminderStorage');
const reminderCategories = require('../utils/reminderCategories');
const reminderValidate = require('../utils/reminderValidate');

const ALIASES = {
  help: ['bantuan', 'help', '?'],
  notify: ['notif', 'pengingat', 'notify', 'n'],
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
  'admin-help': ['bantuan-admin', 'admin-help', 'admin'],
  count: ['count', 'counter', 'hitung'],
  settings: ['s', 'settings', 'setelan'],
  team: ['team', 'tim', 'timku', 'tm'],
  sim: ['sim', 'simulasi', 'simbattle', 'battle-sim']
};

function expandAliases() {
  const map = {};
  for (const [canonical, list] of Object.entries(ALIASES)) {
    for (const alias of list) map[alias] = canonical;
  }
  return map;
}

const ALIAS_MAP = expandAliases();

// Subcommand yang dikenal di bawah kategori `boss`. Sub di luar daftar ini
// diabaikan (tidak dibalas) supaya chat biasa yang kebetulan berawalan prefix —
// mis. "duh"/"dah" saat prefix = "d" — tidak memicu balasan bot.
const KNOWN_SUBS = new Set(Object.keys(ALIAS_MAP));
// Perintah tingkat bot, tidak di bawah kategori `boss`: bantuan & ubah prefix.
const TOP_SUBS = new Set(['help', 'prefix', 'count', 'settings', 'team', 'sim']);

function parsePrefixInput(content, prefix) {
  const matched = matchPrefix(content, prefix);
  if (matched === null) return null;
  const rest = matched.trim();
  const parts = rest.split(/\s+/);
  let head = (parts[0] || '').toLowerCase();
  if (head === '') head = 'help'; // `<prefix>` saja = bantuan
  const headSub = ALIAS_MAP[head] || head;

  // Tingkat bot: `<prefix> prefix [nilai]`, `<prefix> help`, dan `<prefix> s count`.
  if (TOP_SUBS.has(headSub)) {
    const args = parts.slice(1);
    // `s` adalah akar pengaturan; subnya dipetakan ke perintahnya (kini `count`).
    if (headSub === 'settings') {
      const setting = (args[0] || '').toLowerCase();
      if (ALIAS_MAP[setting] === 'count') return { sub: 'count', rawSub: setting, args: args.slice(1) };
      // Pengaturan pengingat per aksi: `s pray set text <teks>`, `s pray reset`.
      // Pengaturan tetap per AKSI (pray dan curse terpisah), bukan per kategori
      // gabungan, supaya perilaku lama yang sudah terpisah tidak berubah.
      if (reminderCategories.normalizeAction(setting)) {
        return { sub: 'reminder-setting', action: reminderCategories.normalizeAction(setting), rawSub: setting, args: args.slice(1) };
      }
      return { sub: 'settings', rawSub: head, args };
    }
    return { sub: headSub, rawSub: head, args };
  }

  // Kategori boss: `<prefix> boss <sub>` — `boss` adalah nama kategorinya.
  if (head !== 'boss') return null;
  const rawSub = (parts[1] || 'help').toLowerCase();
  if (!KNOWN_SUBS.has(rawSub)) return null;
  return { sub: ALIAS_MAP[rawSub] || rawSub, rawSub, args: parts.slice(2) };
}

// Perintah ping gaya bot Discord umum: `<prefix>ping`, berdiri sendiri di luar
// root `boss`. Mendukung alias singkat `p`.
function parsePingInput(content, prefix) {
  const matched = matchPrefix(content, prefix);
  if (matched === null) return null;
  const rest = matched.trim();
  const parts = rest.split(/\s+/);
  if (!['ping', 'p'].includes((parts[0] || '').toLowerCase())) return null;
  return { args: parts.slice(1) };
}

function pingContent(tracker, message) {
  const created = Number.isFinite(message?.createdTimestamp) ? message.createdTimestamp : Date.now();
  const roundtrip = Math.max(0, Date.now() - created);
  const wsPing = tracker?.client?.ws?.ping;
  const wsText = Number.isFinite(wsPing) && wsPing >= 0 ? wsPing + 'ms' : 'tidak tersedia';
  return '🏓 **Pong!**\n' +
    '⏱️ Roundtrip: **' + roundtrip + 'ms**\n' +
    '💓 WebSocket: **' + wsText + '**';
}

// Perintah dex hewan: `<prefix>dex [query]` (alias `d`), berdiri sendiri di luar root `boss`.
function parseDexInput(content, prefix) {
  const matched = matchPrefix(content, prefix);
  if (matched === null) return null;
  const rest = matched.trim();
  const parts = rest.split(/\s+/);
  if (!['dex', 'd'].includes((parts[0] || '').toLowerCase())) return null;
  return { args: parts.slice(1) };
}

function isAdmin(message) {
  return Boolean(message.member?.permissions?.has(PermissionFlagsBits.ManageGuild));
}

// "Developer" = pemilik bot (application owner), ID di env DEVELOPER_IDS, atau
// pemilik server. Dipakai untuk sakelar counter agar pengelola bot tetap bisa
// mengubahnya di server tempat ia bukan moderator.
function isDeveloper(message) {
  const ids = new Set(String(process.env.DEVELOPER_IDS || '').split(',').map(s => s.trim()).filter(Boolean));
  const owner = message.client?.application?.owner;
  if (owner?.id) ids.add(owner.id);
  else if (owner?.members) for (const id of owner.members.keys()) ids.add(id);
  if (ids.has(message.author?.id)) return true;
  return Boolean(message.guild?.ownerId && message.guild.ownerId === message.author.id);
}

function send(message, payload) {
  return message.reply({ ...payload, allowedMentions: { repliedUser: false, parse: [] } });
}

async function handlePrefixCommand(message, tracker, deps = {}) {
  const _send = deps.send || send;
  const _sendText = deps.sendText || ((m, content) => _send(m, { content }));
  const _sendEmbed = deps.sendEmbed || ((m, embed) => _send(m, { embeds: [embed] }));
  const _isAdmin = deps.isAdmin || isAdmin;
  const _isDeveloper = deps.isDeveloper || isDeveloper;

  if (!message.guildId || message.author?.bot) return;
  const settings = getGuildSettings(message.guildId);
  const prefix = settings.prefix || DEFAULT_PREFIX;

  if (parsePingInput(message.content, prefix)) {
    return _sendText(message, pingContent(tracker, message));
  }

  const dex = parseDexInput(message.content, prefix);
  if (dex) {
    const payload = await buildDexResponse(dex.args, { prefix });
    // Tabel ringkas yang panjang datang sebagai beberapa pesan; kirim berurutan
    // supaya semua hewan tampil, bukan terpotong di pesan pertama.
    if (payload.messages) {
      await _send(message, payload.messages[0]);
      for (const extra of payload.messages.slice(1)) await _send(message, extra);
      return;
    }
    return _send(message, payload);
  }

  const parsed = parsePrefixInput(message.content, prefix);
  if (!parsed) return;

  const { sub, args } = parsed;
  const current = getGuildSettings(message.guildId);

  if (sub === 'help') {
    // statusEmbed() sekarang string biasa → dipindah ke `content`,
    // helpEmbed() tetap EmbedBuilder → tetap di `embeds`.
    // Teruskan isAdmin agar moderator melihat bagian ⚙️ Admin (termasuk cara
    // mengubah prefix); tanpa ini bagian tersebut selalu tersembunyi.
    return _send(message, {
      content: statusEmbed(settings, message.author.id),
      embeds: [helpEmbed(prefix, { isAdmin: _isAdmin(message) })]
    });
  }

  if (sub === 'team') {
    return handleTeamCommand(message, args, prefix, { sendEmbed: _sendEmbed, sendPayload: _send });
  }

  if (sub === 'sim') {
    // Simulasi global memakai tombol interaksi, jadi butuh jalur payload penuh
    // (embed + components) selain jalur embed biasa.
    return handleSimCommand(message, args, prefix, {
      sendEmbed: _sendEmbed,
      sendPayload: _send,
      isDeveloper: _isDeveloper,
    });
  }

  if (sub === 'menu') {
    return _send(message, { ...personalPanel(settings, message.author.id, { includeFooter: true }) });
  }

  if (sub === 'notify') {
    const mode = (args[0] || '').toLowerCase();
    if (!['dm', 'channel', 'both'].includes(mode)) return handlePersonalCommand(message, args, prefix);
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
      return _sendText(message, 'Format: `' + prefix + ' boss warn <detik>` — misal `' + prefix + ' boss warn 60` untuk peringatan 60 detik sebelum boss. Gunakan `0` untuk mematikan.');
    }
    const seconds = Math.min(Number(arg), 86400);
    setUserWarnSeconds(message.guildId, message.author.id, seconds);
    return _sendText(message, seconds === 0
      ? '🔕 Peringatan DM dimatikan.'
      : '✅ DM peringatan disetel: **' + warnLabel(seconds) + '**. Kamu akan menerima DM pengingat saat waktunya tiba.');
  }

  if (sub === 'status') {
    // statusEmbed() sekarang string biasa.
    return _send(message, { content: statusEmbed(current, message.author.id) });
  }

  if (sub === 'prefix') {
    if (!_isAdmin(message)) return _sendText(message, 'Pengaturan prefix hanya bisa digunakan moderator/admin.');
    const value = args[0];
    if (!value) return _sendText(message, 'Prefix server saat ini: `' + prefix + '`. Ubah dengan `' + prefix + ' prefix <prefix-baru>`.');
    if (value.length > 10 || /\s/.test(value)) return _sendText(message, 'Prefix harus 1–10 karakter tanpa spasi.');
    const normalized = normalizePrefix(value);
    updateGuildSettings(message.guildId, s => ({ ...s, prefix: normalized }));
    return _sendText(message, '✅ Prefix diubah menjadi `' + normalized + '`. Contoh: `' + normalized + ' boss status`');
  }

  if (sub === 'settings') {
    const coarse = reminderCategories.ACTIONS.filter(a => reminderCategories.isCoarseAction(a));
    const single = reminderCategories.ACTIONS.filter(a => !reminderCategories.isCoarseAction(a));
    return _sendText(message, 'Pengaturan server: `' + prefix + ' s count on|off` — sakelar seluruh counter Lucy (admin/developer).\n' +
      'Pengingat default server: `' + prefix + ' s <aksi> set text <teks>` dan `' + prefix + ' s <aksi> reset` (admin/pemilik server).\n' +
      'Per kategori (berlaku untuk dua aksi sekaligus): ' + coarse.join(', ') + '.\n' +
      'Per aksi saja: ' + single.join(', ') + '.');
  }

  // Pengaturan default pengingat server. HANYA pemilik server atau admin dengan
  // izin Manage Server — developer bot TIDAK otomatis boleh (sesuai kebijakan
  // izin server yang ada). Reminder milik user tidak pernah disentuh di sini.
  if (sub === 'reminder-setting') {
    const action = parsed.action;
    const canManage = _isAdmin(message) || Boolean(message.guild?.ownerId && message.guild.ownerId === message.author?.id);
    if (!canManage) return _sendText(message, 'Only server admins & owners can change this setting.');

    const verb = (args[0] || '').toLowerCase();

    // `s pray`/`s battle` mengatur SATU KATEGORI (pray+curse, hunt+battle) supaya
    // pengingat tidak terbelah dua. `s curse`/`s hunt` hanya mengatur aksi itu.
    const coversAll = reminderCategories.isCoarseAction(action);
    const label = coversAll
      ? reminderCategories.categoryLabel(reminderCategories.categoryForAction(action))
      : (reminderCategories.ACTION_LABELS[action] || action);
    const scopeNote = coversAll
      ? '\nMencakup aksi ' + reminderCategories.actionsForCategory(reminderCategories.categoryForAction(action)).join(' + ') + '.'
      : '';

    if (verb === 'reset') {
      const had = reminderStore.deleteGuildReminderSetting(message.guildId, action);
      return _sendText(message, had
        ? '✅ Pengingat server untuk **' + label + '** dikembalikan ke bawaan Dragneel.' + scopeNote
        : 'Pengingat server untuk **' + label + '** memang masih memakai bawaan Dragneel.');
    }

    if (verb === 'set') {
      const field = (args[1] || '').toLowerCase();
      if (field !== 'text') {
        return _sendText(message, 'Format: `' + prefix + ' s ' + action + ' set text <teks>`.\n' +
          'Balasan default server saat ini hanya mendukung teks; embed hanya tersedia untuk Custom Reminder milik user.');
      }
      const text = args.slice(2).join(' ');
      if (!text) return _sendText(message, 'Teks tidak boleh kosong. Contoh: `' + prefix + ' s ' + action + ' set text {mention} ayo ' + action + '!`');
      if (text.length > 1000) return _sendText(message, 'Teks terlalu panjang (maks 1000 karakter).');
      reminderStore.setGuildReminderSetting({
        guildId: message.guildId, action, format: 'NORMAL', message: text, updatedBy: message.author.id
      });
      return _sendText(message, '✅ Pengingat server untuk **' + label + '** disimpan.' + scopeNote + '\n' +
        'Berlaku untuk anggota yang tidak punya Custom Reminder aktif pada kategori ini.');
    }

    const current = reminderStore.getGuildReminderSetting(message.guildId, action);
    const line = current?.message
      ? '**' + label + '**: `' + current.message + '`'
      : '**' + label + '**: (bawaan Dragneel)';
    return _sendText(message, line + scopeNote + '\nUbah dengan `' + prefix + ' s ' + action + ' set text <teks>` atau `' + prefix + ' s ' + action + ' reset`.');
  }

  if (sub === 'count') {
    if (!(_isAdmin(message) || _isDeveloper(message))) {
      return _sendText(message, 'Pengaturan counter hanya bisa digunakan admin server atau developer bot.');
    }
    const action = (args[0] || '').toLowerCase();
    if (!['on', 'off'].includes(action)) {
      const now = getGuildSettings(message.guildId).lucyCounter?.enabled ? 'ON' : 'OFF';
      return _sendText(message, 'Counter Lucy server ini sedang **' + now + '**. Ubah dengan `' + prefix + ' s count on` atau `' + prefix + ' s count off`.');
    }
    const enabled = action === 'on';
    updateGuildSettings(message.guildId, old => ({ ...old, lucyCounter: { ...old.lucyCounter, enabled } }));
    return _sendText(message, enabled
      ? '✅ Counter Lucy diaktifkan untuk server ini. Semua aksi (pray, curse, battle, hunt) dan mention Lucy kembali dihitung.'
      : '🔕 Counter Lucy dimatikan untuk server ini. Aktivitas tidak lagi dihitung atau dicatat.');
  }

  if (sub === 'admin-help') {
    if (!_isAdmin(message)) return _sendText(message, 'Panduan ini khusus moderator/admin server.');
    return _send(message, { embeds: [new EmbedBuilder().setColor(0xFEE75C).setTitle('⚙️ Pengaturan Moderator/Admin')
      .setDescription('Khusus moderator dengan izin Manage Server atau administrator.')
      .addFields(
        { name: prefix + ' boss setup #channel @role', value: 'Atur channel dan role tag (alias: set/atur/config).', inline: false },
        { name: prefix + ' boss server on / off', value: 'Aktifkan atau matikan tracker server (alias: server-nyalakan/server-matikan).', inline: false },
        { name: prefix + ' prefix <prefix>', value: 'Lihat atau ubah prefix server (alias: awalan).', inline: false },
        { name: prefix + ' s count on / off', value: 'Sakelar seluruh counter Lucy untuk server ini (aksi Lucy, battle/hunt, pray, curse).', inline: false },
        { name: 'Slash', value: '/boss setup, /boss server-on, /boss server-off, /boss prefix.', inline: false }
      )] });
  }

  if (['setup', 'server', 'server-on', 'server-off'].includes(sub) && !_isAdmin(message)) {
    return _sendText(message, 'Perintah ini hanya bisa digunakan moderator/admin dengan izin Manage Server.');
  }

  if (sub === 'setup') {
    const channelId = (args[0] || '').match(/^<#?(\d+)>?$/)?.[1];
    const roleId = (args[1] || '').match(/^<@&?(\d+)>?$/)?.[1];
    if (!channelId || !roleId) return _sendText(message, 'Format: `' + prefix + ' boss setup #channel @role`');
    const channel = await message.guild.channels.fetch(channelId).catch(() => null);
    const role = await message.guild.roles.fetch(roleId).catch(() => null);
    if (typeof channel?.send !== 'function' || !role) return _sendText(message, 'Channel teks atau role tidak ditemukan. Pastikan pilihan benar.');
    updateGuildSettings(message.guildId, s => ({ ...s, channelId, roleId }));
    return _sendText(message, '✅ Channel dan role notifikasi tersimpan. Aktifkan dengan `' + prefix + ' boss server on`.');
  }

  if (sub === 'server' || sub === 'server-on' || sub === 'server-off') {
    const action = sub === 'server-on' ? 'on' : sub === 'server-off' ? 'off' : (args[0] || '').toLowerCase();
    if (!['on', 'off'].includes(action)) return _sendText(message, 'Format: `' + prefix + ' boss server on` atau `' + prefix + ' boss server off`.');
    const s0 = getGuildSettings(message.guildId);
    if (action === 'on' && (!s0.channelId || !s0.roleId)) return _sendText(message, 'Atur channel dan role terlebih dahulu dengan `' + prefix + ' boss setup #channel @role`.');
    const enabled = action === 'on';
    const s = updateGuildSettings(message.guildId, old => ({ ...old, enabled }));
    if (enabled && s.lastBossTimestamp) tracker.scheduleGuild(message.guildId, s.lastBossTimestamp);
    else if (!enabled) tracker.stopGuild(message.guildId);
    return _sendText(message, enabled ? '✅ Tracker aktif untuk seluruh server.' : '🔕 Tracker server dimatikan.');
  }
  return _sendText(message, 'Perintah tidak dikenal. Gunakan `' + prefix + ' boss help`.');
}

module.exports = { handlePrefixCommand, parsePrefixInput, parsePingInput, pingContent, parseDexInput, ALIASES, ALIAS_MAP, isAdmin, isDeveloper };