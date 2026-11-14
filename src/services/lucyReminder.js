// Reminder aksi Lucy + penghitung/leaderboard per jenis.
//
// Tiga jenis reminder, masing-masing punya perintah prefix sendiri dan durasi
// tunggu sendiri:
//   1. pray / curse  -> 5 menit
//   2. battle / hunt -> 15 detik
//   3. say lucy      -> 10 detik
//
// Cara kerja: saat anggota memakai aksi (mis. menulis `lucy pray`), bot mencatat
// aksi itu, memberi balasan, lalu memasang pengingat. Setelah durasi habis, bot
// mengirim pesan pengingat dan mengarahkan anggota ke kotak interaksi (tombol)
// untuk memilih: tag, reply, atau tanpa keduanya.
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const { getGuildSettings, updateGuildSettings, DEFAULT_PREFIX, matchPrefix } = require('../utils/storage');
const store = require('../utils/lucyActionStorage');
const lucyStore = require('../utils/lucyCounterStorage');
const { parseIndonesianDate } = require('./lucyCounter');
const trigger = require('../utils/lucyTrigger');

const WIB = 'Asia/Jakarta';
const REMINDER_NAV = 'lrem';
const PAGE_SIZE = 10;
const MEDALS = ['🥇', '🥈', '🥉'];

// Definisi jenis reminder. `kind` dipakai sebagai kunci di penyimpanan.
const KINDS = {
  pray: { action: 'pray', label: 'Lucy Pray', waitMs: 5 * 60 * 1000, emoji: '🙏' },
  curse: { action: 'curse', label: 'Lucy Curse', waitMs: 5 * 60 * 1000, emoji: '💀' },
  battle: { action: 'battle', label: 'Lucy Battle', waitMs: 15 * 1000, emoji: '⚔️' },
  hunt: { action: 'hunt', label: 'Lucy Hunt', waitMs: 15 * 1000, emoji: '🏹' },
  lucy: { action: null, label: 'Lucy', waitMs: 10 * 1000, emoji: '🐉' }
};

// Pemicu aksi ditangani utils/lucyTrigger: `<prefix> <aksi>` dengan prefix yang
// bisa diatur admin per server (default `lucy`), plus bentuk pendek `l` dan
// alias (fight/war untuk battle, catch untuk hunt, dll).
// Kategori "lucy" memakai penghitung Lucy yang sudah ada (lucyCounter) sehingga
// tidak ada perintah baru; pengingatnya dipasang saat pesan Lucy terhitung.

// Balasan default per jenis (dipakai bila server belum mengatur balasan kustom).
const DEFAULT_REPLIES = {
  pray: '🙏 **{user}** memanjatkan doa untuk Lucy. Hasilnya akan diberitahukan.',
  curse: '💀 **{user}** mengutuk Lucy. Tunggu kabarnya...',
  battle: '⚔️ **{user}** menantang Lucy bertarung!',
  hunt: '🏹 **{user}** berburu bersama Lucy!',
  lucy: '🐉 Lucy terdeteksi dari **{user}**.'
};

// Ping mode yang valid. `none` = tanpa tag dan tanpa reply.
const PING_MODES = { tag: 'Tag', reply: 'Reply', both: 'Tag + Reply', none: 'Tanpa keduanya' };

// Timer notifikasi disimpan di memori saja. Kalau bot restart, timer hilang;
// ini disengaja supaya tidak perlu memulihkan timer lama. Cooldown tetap akurat
// karena disimpan di SQLite (lihat ready_at).
const timers = new Map();
// Jumlah reminder terjadwal per guild, untuk info `status`.
const scheduledByGuild = new Map();

function timerKey(guildId, userId, kind) {
  return `${guildId}:${userId}:${kind}`;
}

function dayKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: WIB, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

function shiftDay(key, delta) {
  const d = new Date(key + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

const MONTHS_ID_LABEL = ['jan', 'feb', 'mar', 'apr', 'mei', 'jun', 'jul', 'agu', 'sep', 'okt', 'nov', 'des'];
function formatIndonesianDate(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!m) return String(key || '');
  return Number(m[3]) + ' ' + MONTHS_ID_LABEL[Number(m[2]) - 1] + ' ' + m[1];
}

function humanDuration(ms) {
  if (ms % 60000 === 0) return `${ms / 60000} menit`;
  return `${Math.round(ms / 1000)} detik`;
}

function guildConfig(guildId) {
  return getGuildSettings(guildId).lucyReminder || {};
}

// Kategori leaderboard. `lucy` membaca dari lucyCounterStorage; sisanya dari
// lucyActionStorage. `battle` mencakup battle + hunt.
const CATEGORIES = {
  pray: { label: 'Lucy Pray', groups: ['pray'] },
  curse: { label: 'Lucy Curse', groups: ['curse'] },
  battle: { label: 'Lucy Battle/Hunt', groups: ['battle'] },
  hunt: { label: 'Lucy Battle/Hunt', groups: ['battle'] },
  lucy: { label: 'Lucy', groups: [] },
  all: { label: 'Semua Aksi (Pray/Curse/Battle/Lucy)', groups: [] }
};
// Alias kategori -> kategori kanonik.
const CATEGORY_ALIASES = {
  pray: 'pray', doa: 'pray',
  curse: 'curse', kutuk: 'curse',
  battle: 'battle', hunt: 'hunt', war: 'battle',
  lucy: 'lucy', say: 'lucy'
};

function actionsFor(category) {
  const groups = CATEGORIES[category]?.groups || [];
  return groups.flatMap(g => store.GROUPS[g] || []);
}

// --- Balasan -------------------------------------------------------------
// Balasan kustom disimpan per jenis di settings.lucyReminder.replies[kind].
// Mendukung placeholder {user}, {mention}, {kind}, {durasi}, {count}.
function renderTemplate(template, vars) {
  return String(template).replace(/\{(user|mention|kind|durasi|count)\}/g, (_, key) => (vars[key] ?? ''));
}

function replyTemplate(guildId, kind) {
  const custom = guildConfig(guildId).replies?.[kind];
  return custom || DEFAULT_REPLIES[kind] || '';
}

// --- Papan reminder -----------------------------------------------------
// Satu baris tombol per jenis reminder yang tersedia, supaya anggota bisa
// mengatur semuanya dari satu kotak interaksi.
function kindRow(kind, pref) {
  const info = KINDS[kind];
  const modeLabel = PING_MODES[pref.pingMode] || PING_MODES.tag;
  const status = pref.enabled ? 'ON' : 'OFF';
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${REMINDER_NAV}:toggle:${kind}`)
      .setLabel(`${info.emoji} ${info.label} ${status}`)
      .setStyle(pref.enabled ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${REMINDER_NAV}:mode:${kind}`)
      .setLabel(modeLabel)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${REMINDER_NAV}:duration:${kind}`)
      .setLabel(humanDuration(info.waitMs))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true)
  );
  return row;
}

function panelEmbed(guildId, userId, name) {
  const prefs = store.getPrefs(userId);
  const lines = Object.entries(KINDS).map(([kind, info]) => {
    const pref = prefs[kind] || { enabled: true, pingMode: 'tag' };
    const mode = PING_MODES[pref.pingMode] || PING_MODES.tag;
    return `${info.emoji} **${info.label}** — ${pref.enabled ? 'ON' : 'OFF'} • ping: **${mode}** • tunggu **${humanDuration(info.waitMs)}**`;
  });
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🔔 Pengingat Aksi Lucy')
    .setDescription(lines.join('\n') + '\n\nKlik tombol kiri untuk on/off, tombol tengah untuk ganti cara ping.')
    .setFooter({ text: `Pengaturan pribadi untuk ${name} • berlaku di SEMUA server` });
}

function panelComponents(guildId, userId) {
  const prefs = store.getPrefs(userId);
  return Object.entries(KINDS).map(([kind]) => kindRow(kind, prefs[kind] || { enabled: true, pingMode: 'tag' }));
}

function isReminderNav(customId) {
  return typeof customId === 'string' && customId.startsWith(REMINDER_NAV + ':');
}

function cyclePingMode(mode) {
  const order = ['tag', 'reply', 'both', 'none'];
  const i = order.indexOf(mode);
  return order[(i === -1 ? 0 : i + 1) % order.length];
}

// Menangani klik tombol panel. Selalu membaca ulang data agar tampilan sinkron.
async function handleComponent(i) {
  if (!isReminderNav(i.customId)) return false;
  const [, verb, kind] = i.customId.split(':');
  if (!KINDS[kind]) return false;
  const guildId = i.guildId;
  const userId = i.user.id;
  const current = store.getPref(userId, kind);

  if (verb === 'toggle') {
    store.setPref(userId, kind, { enabled: !current.enabled });
  } else if (verb === 'mode') {
    store.setPref(userId, kind, { pingMode: cyclePingMode(current.pingMode) });
  } else {
    return false;
  }

  const name = i.member?.displayName || i.user.username || 'Pemain';
  await i.update({ embeds: [panelEmbed(guildId, userId, name)], components: panelComponents(guildId, userId) });
  return true;
}

// --- Pengiriman pengingat ----------------------------------------------
// Kirim pesan pengingat dan terapkan cara ping sesuai preferensi:
// - tag   : mention <@id> (anggota dapat notifikasi)
// - reply : balas pesan pemicunya
// - both  : reply + mention
// - none  : pesan biasa tanpa keduanya
async function deliverReminder(client, reminder) {
  const { guildId, channelId, userId, kind, messageId } = reminder;
  const pref = store.getPref(userId, kind);
  if (!pref.enabled) return;
  const info = KINDS[kind];
  let channel = null;
  try {
    channel = await client.channels.fetch(channelId);
  } catch {
    return;
  }
  if (!channel?.isTextBased?.()) return;

  const content = renderTemplate(replyTemplate(guildId, kind), {
    user: reminder.name || 'Pemain',
    mention: `<@${userId}>`,
    kind: info.label,
    durasi: humanDuration(info.waitMs),
    count: ''
  });

  const mention = pref.pingMode === 'tag' || pref.pingMode === 'both';
  const useReply = pref.pingMode === 'reply' || pref.pingMode === 'both';
  const payload = {
    content: (mention ? `<@${userId}> ` : '') + content,
    allowedMentions: mention ? { parse: [], users: [userId] } : { parse: [] }
  };
  if (useReply && messageId) payload.reply = { messageReference: messageId, failIfNotExists: false };

  try {
    await channel.send(payload);
  } catch (e) {
    console.error('[LucyReminder] gagal mengirim pengingat:', e.message);
  }
}

// Pasang reminder. `replace` = true membuang timer lama untuk jenis yang sama
// (dipakai saat aksi diulang dalam jendela tunggu).
function scheduleReminder(client, { guildId, channelId, userId, name, kind, messageId, replace = false, waitMs }) {
  const key = timerKey(guildId, userId, kind);
  if (replace && timers.has(key)) {
    clearTimeout(timers.get(key));
    timers.delete(key);
  }
  const info = KINDS[kind];
  const wait = Number.isFinite(waitMs) && waitMs >= 0 ? waitMs : info.waitMs;
  const reminder = { guildId, channelId, userId, name, kind, messageId, dueAt: Date.now() + wait };
  const timer = setTimeout(() => {
    timers.delete(key);
    decrementScheduled(guildId);
    deliverReminder(client, reminder).catch(e => console.error('[LucyReminder]', e.message));
  }, wait);
  timer.unref?.();
  timers.set(key, timer);
  incrementScheduled(guildId);
  return reminder;
}

function incrementScheduled(guildId) {
  scheduledByGuild.set(guildId, (scheduledByGuild.get(guildId) || 0) + 1);
}
function decrementScheduled(guildId) {
  scheduledByGuild.set(guildId, Math.max(0, (scheduledByGuild.get(guildId) || 0) - 1));
}
function scheduledCount(guildId) {
  return scheduledByGuild.get(guildId) || 0;
}

// --- Leaderboard --------------------------------------------------------
// Rentang: `1d`/`harian` (hari ini), `all` (semua waktu), tanggal tunggal
// (`5 nov`), atau rentang `7d` / `7day` (7 hari terakhir).
function parseRange(input, today = new Date()) {
  const text = String(input || '').trim().toLowerCase();
  if (!text) return { type: 'today', from: dayKey(today), to: dayKey(today) };
  if (text === 'all' || text === 'alltime' || text === 'semua') return { type: 'alltime' };
  if (text === 'today' || text === 'harian' || text === 'hari') return { type: 'today', from: dayKey(today), to: dayKey(today) };
  const days = /^(\d+)\s*d(?:ay|ays)?$/.exec(text);
  if (days) {
    const n = Math.max(1, Number(days[1]));
    const to = dayKey(today);
    return { type: 'range', from: shiftDay(to, -(n - 1)), to, days: n };
  }
  const key = parseIndonesianDate(text);
  return key ? { type: 'date', date: key } : { type: 'invalid', value: text };
}

function mergeRankings(a, b) {
  const map = new Map();
  for (const row of [...a, ...b]) {
    const cur = map.get(row.userId) || { userId: row.userId, name: row.name, count: 0 };
    cur.count += row.count;
    if (!cur.name && row.name) cur.name = row.name;
    map.set(row.userId, cur);
  }
  return [...map.values()].filter(r => r.count > 0)
    .sort((x, y) => y.count - x.count || String(x.name || '').localeCompare(String(y.name || '')));
}

function actionRanking(guildId, actions, range) {
  if (range.type === 'alltime') return store.topAllTime(guildId, actions);
  if (range.type === 'range') return store.topByRange(guildId, range.from, range.to, actions);
  const day = range.type === 'date' ? range.date : range.from;
  return store.topByDay(guildId, day, actions);
}

function actionRankingGlobal(actions, range) {
  if (range.type === 'alltime') return store.topAllTimeAll(actions);
  if (range.type === 'range') return store.topByRangeAll(range.from, range.to, actions);
  const day = range.type === 'date' ? range.date : range.from;
  return store.topByRangeAll(day, day, actions);
}

function rankingFor(guildId, category, range, { global = false } = {}) {
  if (category === 'lucy') return global ? lucyRankingGlobal(range) : lucyRanking(guildId, range);
  if (category === 'all') {
    const actions = Object.values(store.GROUPS).flat();
    const actionsRank = global ? actionRankingGlobal(actions, range) : actionRanking(guildId, actions, range);
    const lucy = global ? lucyRankingGlobal(range) : lucyRanking(guildId, range);
    return mergeRankings(actionsRank, lucy);
  }
  const actions = actionsFor(category);
  return global ? actionRankingGlobal(actions, range) : actionRanking(guildId, actions, range);
}

function rangeFilter(range) {
  if (range.type === 'date') return day => day === range.date;
  if (range.type === 'today') return day => day === range.from;
  if (range.type === 'range') return day => day >= range.from && day <= range.to;
  return null;
}

function sumDays(user, filter) {
  return Object.entries(user.days || {})
    .filter(([day]) => !filter || filter(day))
    .reduce((sum, [, n]) => sum + Number(n || 0), 0);
}

function lucyRanking(guildId, range, today = new Date()) {
  const data = lucyStore.getGuildData(guildId);
  const filter = rangeFilter(range);
  return Object.entries(data.users || {})
    .map(([userId, user]) => ({ userId, name: user.name || userId, count: sumDays(user, filter) }))
    .filter(r => r.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// Peringkat Lucy lintas server: jumlahkan hari yang sama dari semua guild.
function lucyRankingGlobal(range) {
  const all = lucyStore.getAllData();
  const filter = rangeFilter(range);
  const map = new Map();
  for (const guild of Object.values(all || {})) {
    for (const [userId, user] of Object.entries(guild?.users || {})) {
      const n = sumDays(user, filter);
      if (!n) continue;
      const cur = map.get(userId) || { userId, name: user.name || userId, count: 0 };
      cur.count += n;
      if (user.name) cur.name = user.name;
      map.set(userId, cur);
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function rangeLabel(range) {
  if (range.type === 'alltime') return 'semua tanggal';
  if (range.type === 'range') return `${formatIndonesianDate(range.from)} – ${formatIndonesianDate(range.to)} (${range.days} hari)`;
  const day = range.type === 'date' ? range.date : range.from;
  return formatIndonesianDate(day);
}

function leaderboardView(guildId, category, range, page = 1, { global = false } = {}) {
  const cat = CATEGORIES[category] || CATEGORIES.pray;
  const rows = rankingFor(guildId, category, range, { global });
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const offset = (current - 1) * PAGE_SIZE;
  const slice = rows.slice(offset, offset + PAGE_SIZE);
  const desc = slice.length
    ? slice.map((r, i) => `${MEDALS[offset + i] || (offset + i + 1) + '.'} **${r.count.toLocaleString('id-ID')}** — ${r.name || 'Pemain'}`).join('\n')
    : 'Belum ada data untuk rentang ini.';
  const embed = new EmbedBuilder()
    .setColor(0xEB459E)
    .setTitle(`🏆 Leaderboard ${cat.label}`)
    .setDescription(desc)
    .setFooter({ text: `Halaman ${current}/${totalPages} • ${rows.length} peserta • ${rangeLabel(range)} • ${global ? 'Global (semua server)' : 'Server ini'} (WIB)` });
  return { embed, page: current, totalPages };
}

// --- Perintah -----------------------------------------------------------
function isModerator(message) {
  return Boolean(message.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild));
}

function helpText(prefix) {
  return [
    '**Aksi Lucy** — tulis `<prefix-lucy> <aksi>`. Bentuk yang dikenali:',
    '`lucy pray` / `lpray` • `lucy curse` / `lcurse`',
    '`lucy battle` / `lucy fight` / `lbattle` / `lfight` / `lb` • `lucy hunt` / `lucy catch` / `lhunt` / `lh`',
    '',
    `\`${prefix} lucyprefix set <prefix>\` — atur prefix bot Lucy di server ini (admin)`,
    `\`${prefix} lreminder\` — kotak interaksi: on/off & cara ping (tag/reply/tanpa keduanya)`,
    `\`${prefix} lreminder reply <jenis> <teks>\` — balasan kustom (khusus premium)`,
    'Pengaturan reminder berlaku **global di semua server**.',
    '',
    '**Leaderboard**',
    `\`${prefix} llb <kategori> [rentang] [halaman] [global]\` — kategori: pray, curse, battle, hunt, lucy`,
    `  contoh: \`${prefix} llb pray\`, \`${prefix} llb battle 7d\`, \`${prefix} llb lucy all global\``,
    `\`${prefix} llb all [rentang]\` — gabungan semua kategori`
  ].join('\n');
}

async function handleCommand(message) {
  if (!message.guildId || message.author?.bot || !message.content) return false;
  const prefix = getGuildSettings(message.guildId).prefix || DEFAULT_PREFIX;
  const rest = matchPrefix(message.content.trim(), prefix);
  if (rest === null) return false;
  const parts = rest.trim().split(/\s+/);
  const command = (parts[0] || '').toLowerCase();

  if (['lreminder', 'lrem', 'reminder'].includes(command)) return handleReminderCommand(message, prefix, parts);
  if (['llb', 'llbboard', 'lboard'].includes(command)) return handleLeaderboardCommand(message, prefix, parts);
  if (['lucyprefix', 'lprefix', 'lucyconfig', 'lconfig'].includes(command)) return handleLucyPrefixCommand(message, prefix, parts);
  return false;
}

// Admin mengatur prefix bot Lucy di server mereka. Default `lucy`; bentuk
// pendek `l` selalu ikut dikenali di samping prefix yang diatur.
async function handleLucyPrefixCommand(message, prefix, parts) {
  const sub = (parts[1] || '').toLowerCase();
  const current = guildConfig(message.guildId).lucyPrefix || trigger.DEFAULT_LUCY_PREFIX;

  if (!sub || sub === 'show' || sub === 'status' || sub === 'lihat') {
    const list = trigger.lucyPrefixes(current);
    await message.reply({
      content: `Prefix bot Lucy di server ini: **${current}**\n` +
        `Bentuk yang dikenali: ${list.map(p => '`' + p + ' <aksi>`').join(', ')}\n` +
        `Ubah dengan \`${prefix} lucyprefix set <prefix>\` (huruf/angka, maks 16).`,
      allowedMentions: { parse: [] }
    });
    return true;
  }

  if (!isModerator(message)) {
    await message.reply('Hanya moderator/admin yang bisa mengubah prefix bot Lucy.');
    return true;
  }

  if (sub === 'set' || sub === 'atur') {
    const value = (parts[2] || '').toLowerCase();
    if (value === 'reset' || value === 'default') {
      updateGuildSettings(message.guildId, s => ({ ...s, lucyReminder: { ...s.lucyReminder, lucyPrefix: null } }));
      await message.reply(`Prefix bot Lucy dikembalikan ke default: **${trigger.DEFAULT_LUCY_PREFIX}**.`);
      return true;
    }
    const normalized = trigger.normalizePrefix(value);
    if (!normalized) {
      await message.reply(`Prefix tidak valid. Gunakan huruf/angka tanpa spasi, maks 16 karakter. Contoh: \`${prefix} lucyprefix set lucy\`.`);
      return true;
    }
    updateGuildSettings(message.guildId, s => ({ ...s, lucyReminder: { ...s.lucyReminder, lucyPrefix: normalized } }));
    await message.reply(`Prefix bot Lucy disetel ke **${normalized}**. Contoh: \`${normalized} battle\`, \`${normalized} hunt\`. Bentuk pendek \`l <aksi>\` tetap jalan.`);
    return true;
  }

  await message.reply(helpText(prefix));
  return true;
}

async function handleAction(message, kind, prefix) {
  const info = KINDS[kind];
  const userId = message.author.id;
  const name = message.member?.displayName || message.author?.username || 'Pemain';
  const now = Date.now();

  // Cooldown: aksi sama tidak boleh diulang sebelum jendela tunggu habis. Kalau
  // diulang, timer lama diganti (bukan ditambah), supaya pengingat tidak menumpuk.
  const readyAt = store.getCooldown(message.guildId, userId, kind);
  const replaced = now < readyAt;

  store.recordAction({ guildId: message.guildId, userId, name, day: dayKey(new Date(now)), action: info.action });
  store.setCooldown(message.guildId, userId, kind, now + info.waitMs);

  const content = renderTemplate(replyTemplate(message.guildId, kind), {
    user: name, mention: `<@${userId}>`, kind: info.label, durasi: humanDuration(info.waitMs), count: ''
  });
  const note = replaced
    ? `Pengingat ${info.label} diatur ulang — kamu akan diingatkan lagi dalam ${humanDuration(info.waitMs)}.`
    : `Pengingat ${info.label} dipasang — kamu akan diingatkan dalam ${humanDuration(info.waitMs)}.`;

  let replyPayload = null;
  try {
    replyPayload = await message.reply({ content, allowedMentions: { parse: [] } });
  } catch (e) {
    console.error('[LucyReminder] gagal membalas aksi:', e.message);
  }

  scheduleReminder(message.client, {
    guildId: message.guildId,
    channelId: message.channelId,
    userId,
    name,
    kind,
    messageId: replyPayload?.id || message.id,
    replace: true
  });

  try {
    await message.channel.send({
      content: `${note} Atur cara ping lewat \`${prefix} lreminder\` (tombol).`,
      allowedMentions: { parse: [] }
    });
  } catch (e) {
    console.error('[LucyReminder] gagal mengirim catatan:', e.message);
  }
  return true;
}

async function handleReminderCommand(message, prefix, parts) {
  const sub = (parts[1] || '').toLowerCase();
  const name = message.member?.displayName || message.author?.username || 'Pemain';

  if (!sub || sub === 'panel' || sub === 'menu') {
    await message.reply({
      embeds: [panelEmbed(message.guildId, message.author.id, name)],
      components: panelComponents(message.guildId, message.author.id),
      allowedMentions: { parse: [] }
    });
    return true;
  }

  if (sub === 'status') {
    const prefs = store.getPrefs(message.author.id);
    const lines = Object.entries(KINDS).map(([kind, info]) => {
      const pref = prefs[kind] || { enabled: true, pingMode: 'tag' };
      return `${info.emoji} ${info.label}: ${pref.enabled ? 'ON' : 'OFF'} • ping ${PING_MODES[pref.pingMode] || pref.pingMode}`;
    });
    await message.reply({ content: lines.join('\n') + `\nTerjadwal di server ini: **${scheduledCount(message.guildId)}**`, allowedMentions: { parse: [] } });
    return true;
  }

  // Balasan kustom — fitur premium (belum aktif). Kerangkanya sudah ada supaya
  // tinggal dinyalakan saat sistem premium siap.
  if (sub === 'reply' || sub === 'balas' || sub === 'message') {
    const premium = guildConfig(message.guildId).premium === true;
    if (!premium) {
      await message.reply('Balasan kustom (dan embed) adalah fitur **premium**. Aktifkan premium dulu untuk memakainya.');
      return true;
    }
    if (!isModerator(message)) {
      await message.reply('Hanya moderator/admin yang bisa mengubah balasan kustom.');
      return true;
    }
    const kind = (parts[2] || '').toLowerCase();
    if (!KINDS[kind]) { await message.reply(`Jenis tidak dikenal. Pilih: ${Object.keys(KINDS).join(', ')}.`); return true; }
    const value = parts.slice(3).join(' ').trim();
    if (!value) { await message.reply(`Format: \`${prefix} lreminder reply ${kind} <teks>\`. Placeholder: {user}, {mention}, {kind}, {durasi}`); return true; }
    if (value.length > 1500) { await message.reply('Balasan maksimal 1500 karakter.'); return true; }
    updateGuildSettings(message.guildId, s => ({ ...s, lucyReminder: { ...s.lucyReminder, replies: { ...(s.lucyReminder?.replies || {}), [kind]: value } } }));
    await message.reply(`Balasan kustom ${KINDS[kind].label} disimpan.`);
    return true;
  }

  if (sub === 'reset' || sub === 'hapus') {
    if (!isModerator(message)) { await message.reply('Hanya moderator/admin yang bisa menghapus balasan kustom.'); return true; }
    updateGuildSettings(message.guildId, s => ({ ...s, lucyReminder: { ...s.lucyReminder, replies: {} } }));
    await message.reply('Semua balasan kustom dihapus, kembali ke balasan default.');
    return true;
  }

  await message.reply(helpText(prefix));
  return true;
}

async function handleLeaderboardCommand(message, prefix, parts) {
  const args = parts.slice(1);
  const categoryToken = (args[0] || '').toLowerCase();
  // Token `global` di posisi mana pun menandai leaderboard lintas server.
  const global = args.some(a => ['global', 'semua', 'allserver'].includes(String(a).toLowerCase()));
  const positional = args.filter(a => !['global', 'semua', 'allserver'].includes(String(a).toLowerCase()));

  if (categoryToken === 'all' || categoryToken === 'gabungan') {
    const range = parseRange(positional[1]);
    if (range.type === 'invalid') return badRange(message, prefix, range.value);
    return sendLeaderboard(message, 'all', range, positional[2], global);
  }

  const category = CATEGORY_ALIASES[categoryToken];
  if (!category) {
    await message.reply(helpText(prefix));
    return true;
  }
  const range = parseRange(positional[1]);
  if (range.type === 'invalid') return badRange(message, prefix, range.value);
  return sendLeaderboard(message, category, range, positional[2], global);
}

async function badRange(message, prefix, value) {
  await message.reply(`Rentang tidak dikenali: **${value}**. Contoh: \`${prefix} llb pray 7d\`, \`${prefix} llb lucy all\`, \`${prefix} llb curse 5 nov\`.`);
  return true;
}

async function sendLeaderboard(message, category, range, pageArg, global = false) {
  const page = Number(pageArg) > 0 ? Math.floor(Number(pageArg)) : 1;
  const view = leaderboardView(message.guildId, category, range, page, { global });
  await message.reply({ embeds: [view.embed], allowedMentions: { parse: [] } });
  return true;
}

// Dipanggil dari lucyCounter saat pesan Lucy terhitung, untuk memasang
// pengingat kategori "lucy" (10 detik).
function onLucyCounted(message, name) {
  scheduleReminder(message.client, {
    guildId: message.guildId,
    channelId: message.channelId,
    userId: message.author.id,
    name,
    kind: 'lucy',
    messageId: message.id,
    replace: true
  });
}

async function handleMessage(message) {
  if (!message.guildId || message.author?.bot || !message.content) return false;
  if (await handleCommand(message)) return true;
  // Pemicu aksi (mis. `lucy battle`, `lb`, `l hunt`, `lucy catch`). Prefix bot
  // Lucy diambil dari pengaturan server; kategori "lucy" ditangani lucyCounter.
  const kind = trigger.matchAction(message.content, guildConfig(message.guildId).lucyPrefix);
  if (kind) return handleAction(message, kind, getGuildSettings(message.guildId).prefix || DEFAULT_PREFIX);
  return false;
}

module.exports = {
  handleMessage, handleCommand, handleComponent, isReminderNav, helpText,
  panelEmbed, panelComponents, leaderboardView, parseRange, rangeLabel,
  scheduleReminder, deliverReminder, scheduledCount, renderTemplate, replyTemplate,
  dayKey, shiftDay, humanDuration, KINDS, PING_MODES, CATEGORIES, DEFAULT_REPLIES,
  handleLucyPrefixCommand, lucyRankingGlobal, rankingFor,
  onLucyCounted, timers
};
