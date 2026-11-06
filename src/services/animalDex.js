const { EmbedBuilder } = require('discord.js');
const store = require('../utils/animalDexStorage');

// Pemetaan emoji statistik/role/weapon berdasarkan nama shortcode Discord,
// bukan ID, supaya tahan terhadap perubahan aset Lucy.
const STAT_EMOJI = { hp: 'hp', att: 'attack', pr: 'protection', wp: 'wisdom', mg: 'magic', mr: 'mr' };
const STAT_LABELS = { hp: 'HP', attack: 'ATT', protection: 'PR', wisdom: 'WP', magic: 'MG', mr: 'MR' };
const STAT_ICONS = {
  hp: '<:hp:1541928276165922906>', attack: '<:att:1541928417069375498>',
  protection: '<:pr:1541928475454079077>', wisdom: '<:wp:1523723591194120354>',
  magic: '<:mg:1523723618016563210>', mr: '<:mr:1523723644243804281>'
};
const EMOJI_TOKEN = /<a?:(\w+):\d+>/g;

// Jumlahkan seluruh statistik (hp..mr) yang tersedia; null bila tak ada.
function totalStats(animal) {
  let total = 0;
  let found = false;
  for (const key of Object.keys(STAT_LABELS)) {
    const value = animal.stats?.[key];
    if (value != null && Number.isFinite(Number(value))) { total += Number(value); found = true; }
  }
  return found ? total : null;
}

// Emoji statistik milik aplikasi Lucy tidak bisa dirender oleh bot ini: Discord
// hanya mengizinkan aplikasi pemilik memakai emoji aplikasinya. Karena itu token
// sumber di-mirror menjadi emoji milik aplikasi bot (nama sama), lalu source_id
// dipetakan ke token hasil mirror agar tidak dibuat ulang tiap render.
let emojiClient = null;
function setClient(client) { emojiClient = client || null; }

function tokenParts(token) {
  const m = /^<(a?):(\w+):(\d+)>$/.exec(String(token || ''));
  return m ? { animated: Boolean(m[1]), name: m[2], id: m[3] } : null;
}

function tokenFromEmoji(emoji) {
  return '<' + (emoji.animated ? 'a' : '') + ':' + emoji.name + ':' + emoji.id + '>';
}

// Discord hanya menerima nama emoji 2–32 karakter [A-Za-z0-9_].
function emojiName(name) {
  const cleaned = String(name || '').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 32);
  return cleaned.length >= 2 ? cleaned : 'e_' + cleaned;
}

// Nama alternatif yang tetap dikenali saat mencocokkan emoji aplikasi bot,
// supaya emoji yang di-upload manual dengan nama berbeda tidak dibuat ulang.
const EMOJI_ALIASES = {
  hp: ['health'], att: ['attack'], pr: ['prot', 'protection'],
  wp: ['wisdom'], mg: ['mag', 'magic'], mr: ['mres']
};

function emojiNameCandidates(name) {
  const base = emojiName(name);
  return new Set([base, ...(EMOJI_ALIASES[base] || []).map(emojiName)]);
}

// Kumpulkan seluruh token emoji dari data dex agar bisa di-mirror sekaligus.
function collectEmojiTokens(animals) {
  const tokens = [];
  const push = token => { if (token && tokenParts(token)) tokens.push(token); };
  for (const animal of animals || []) {
    for (const token of Object.values(animal.statTokens || {})) push(token);
    const animalToken = animalEmoji(animal);
    if (animalToken) push(animalToken);
  }
  for (const token of Object.values(STAT_ICONS)) push(token);
  return [...new Set(tokens)];
}

// Pastikan setiap token punya padanan emoji di aplikasi bot. Gagal mirror
// (mis. tanpa izin/koneksi) tidak fatal: token asli tetap dikembalikan apa adanya.
async function mirrorEmojiTokens(tokens) {
  const out = new Map();
  const byId = new Map();
  for (const token of tokens || []) {
    out.set(token, token);
    const p = tokenParts(token);
    if (p) byId.set(p.id, { ...p, token });
  }
  if (!emojiClient || !byId.size) return out;

  const pending = new Map();
  for (const [id, p] of byId) {
    // Emoji guild yang bot sudah punya akses (mis. emoji buatan sendiri di
    // server bot) langsung dipakai apa adanya — tidak perlu di-mirror.
    if (emojiClient.emojis?.cache?.has?.(id)) continue;
    const cached = store.getEmojiToken(id);
    if (cached) out.set(p.token, cached);
    else pending.set(id, p);
  }
  if (!pending.size) return out;

  // Pakai emoji aplikasi bot yang namanya sudah sama (hasil mirror sebelumnya).
  try {
    const existing = await emojiClient.application.emojis.fetch();
    for (const emoji of existing.values()) {
      for (const [id, p] of pending) {
        if (!emojiNameCandidates(p.name).has(emoji.name)) continue;
        const appToken = tokenFromEmoji(emoji);
        store.setEmojiToken(id, appToken);
        out.set(p.token, appToken);
        pending.delete(id);
      }
    }
  } catch (e) { /* lanjut: token asli dipertahankan */ }

  // Buat emoji baru untuk yang belum ada di aplikasi bot.
  for (const [id, p] of pending) {
    try {
      const emoji = await emojiClient.application.emojis.create({
        attachment: 'https://cdn.discordapp.com/emojis/' + p.id + '.' + (p.animated ? 'gif' : 'png'),
        name: emojiName(p.name)
      });
      const appToken = tokenFromEmoji(emoji);
      store.setEmojiToken(id, appToken);
      out.set(p.token, appToken);
    } catch (e) { /* token asli dipertahankan */ }
  }
  return out;
}

// Seluruh token emoji yang dipakai dex saat ini (untuk mirror saat startup).
function allEmojiTokens() {
  return collectEmojiTokens(store.listAnimals());
}

// Ganti semua token emoji pada teks memakai peta hasil mirror.
function applyEmojiMap(text, map) {
  if (!map || !map.size) return text;
  return String(text).replace(/<a?:\w+:\d+>/g, token => map.get(token) || token);
}

// Batas panjang bagian embed yang diterapkan Discord; query user bisa panjang.
const LIMITS = { title: 256, description: 4096, field: 1024, footer: 2048 };

function clip(text, max) {
  const s = String(text == null ? '' : text);
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

// Susun baris sebanyak yang muat dalam batas karakter, sisanya diringkas jadi
// satu baris "…dan N lainnya". Dipakai agar tabel/daftar tidak terpotong di
// tengah baris sekaligus tidak melewati batas panjang embed Discord.
function fitRows(header, rows, max) {
  const note = n => '…dan ' + n + ' lainnya tidak ditampilkan.';
  const out = header ? [header] : [];
  let len = header ? header.length : 0;
  let shown = 0;
  for (const row of rows) {
    const hiddenAfter = rows.length - shown - 1;
    const reserve = hiddenAfter > 0 ? 1 + note(hiddenAfter).length : 0;
    const add = 1 + row.length;
    if (len + add + reserve > max) break;
    out.push(row);
    len += add;
    shown++;
  }
  const hidden = rows.length - shown;
  if (hidden > 0) out.push(note(hidden));
  return out.join('\n');
}

function stripEmoji(text) {
  return String(text || '').replace(EMOJI_TOKEN, '').replace(/\s+/g, ' ').trim();
}
function emojiNames(text) {
  const names = [];
  for (const match of String(text || '').matchAll(EMOJI_TOKEN)) names.push(match[1]);
  return names;
}
function normalizeName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
// Lucy menulis field info sebagai `**Label:** nilai` (titik dua di dalam bold),
// jadi terima `**Label**` maupun `**Label:**`.
function fieldValue(text, label) {
  const match = String(text || '').match(new RegExp('\\*\\*\\s*' + label + '\\s*:?\\s*\\*\\*:?\\s*([^\\n]*)'));
  return match ? match[1].trim() : null;
}

// Kumpulkan seluruh teks + URL gambar/emoji dari struktur Components V2.
// Gambar kartu Lucy ada di accessory Section (type 11) atau item MediaGallery
// (type 12), dan berupa URL (mis. GIF emoji) — bukan file terpisah.
function collect(raw) {
  const out = { texts: [], imageUrl: null };
  const seen = new Set();
  function captureMedia(media) {
    const url = media?.url || media?.proxy_url;
    if (!out.imageUrl && typeof url === 'string') out.imageUrl = url;
  }
  function walk(node) {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { for (const child of node) walk(child); return; }
    if (Number(node.type) === 10 && typeof node.content === 'string') out.texts.push(node.content);
    captureMedia(node.accessory?.media);
    captureMedia(node.media);
    if (Number(node.type) === 12) {
      for (const item of node.items || []) captureMedia(item?.media);
    }
    for (const key of ['components', 'accessory', 'items']) walk(node[key]);
  }
  walk(raw?.components || []);
  return out;
}

// Kembalikan statistik sekaligus token emoji aslinya, supaya tampilan dex
// memakai emoji yang sama persis dengan kartu Lucy (hp, att, pr, wp, mg, mr).
function parseStats(text) {
  const stats = {};
  const statTokens = {};
  const pairs = String(text || '').matchAll(/(<a?:\w+:\d+>)\s*`([^`]+)`/g);
  for (const [, token, value] of pairs) {
    const field = STAT_EMOJI[emojiNames(token)[0]];
    if (field) {
      const n = Number(String(value).replace(/[^\d-]/g, ''));
      if (Number.isFinite(n)) {
        stats[field] = n;
        statTokens[field] = token;
      }
    }
  }
  return { stats, statTokens };
}

// Ubah satu pesan Lucy (raw JSON Components V2) menjadi objek animal.
// Mengembalikan null bila pesan bukan kartu "Informasi animal".
function parseAnimalCard(raw) {
  const { texts, imageUrl } = collect(raw);
  const infoText = texts.find(t => /Informasi animal/i.test(t));
  if (!infoText) return null;

  const heading = texts.find(t => /^\s*##\s/.test(t) && !t.includes('`'));
  const headingLine = String(heading || '').split('\n')[0];
  const name = stripEmoji(headingLine.replace(/^\s*##\s*/, '').replace(/\*Requested by.*$/i, ''));
  if (!name) return null;
  // Emoji hewan biasanya memuat nama hewan, jadi simpan namanya untuk pencarian
  // ketika user menyalin emoji tersebut sebagai query.
  const emojiName = emojiNames(headingLine)[0] || null;

  const statsText = texts.find(t => /<a?:\w+:\d+>\s*`/.test(t)) || '';
  const roleText = texts.find(t => /^\s*[-*]\s*\*\*Role\b/i.test(t)) || '';
  const weaponText = texts.find(t => /Rekomendasi Weapon/i.test(t)) || '';
  const rarityText = texts.find(t => /Kelangkaan/i.test(t)) || '';

  const roleLine = (roleText.split('\n').slice(1).join(' ').trim() || roleText).replace(/^[-*]\s*/, '');
  const weaponLine = (weaponText.split('\n').slice(1).join(' ').trim() || weaponText).replace(/^[-*]\s*/, '');
  const weaponNames = emojiNames(weaponLine);
  const moreWeapons = /\+|\bmore\b/i.test(stripEmoji(weaponLine));

  const rarityRaw = rarityText.replace(/^.*Kelangkaan:?/i, '');
  const [rarityPart, capturedPart] = rarityRaw.split('•');
  const captured = (capturedPart || '').match(/(\d+)\s*total/i);

  const aliasRaw = fieldValue(infoText, 'Alias');
  const aliases = aliasRaw ? [...new Set(aliasRaw.split(',').map(s => s.trim()).filter(Boolean))] : [];
  const { stats, statTokens } = parseStats(statsText);

  return {
    name,
    nameKey: normalizeName(name),
    nickname: fieldValue(infoText, 'Nickname')?.replace(/^['"]|['"]$/g, '') || null,
    quantity: fieldValue(infoText, 'Jumlah') || null,
    rank: stripEmoji(fieldValue(infoText, 'Rank') || '') || null,
    alias: aliases.join(', ') || null,
    points: fieldValue(infoText, 'Points') || null,
    sell: fieldValue(infoText, 'Sell') || null,
    sacrifice: fieldValue(infoText, 'Sacrifice') || null,
    stats,
    statTokens,
    role: stripEmoji(roleLine) || null,
    weapons: weaponNames.length ? weaponNames.join(', ') + (moreWeapons ? ', + more' : '') : null,
    rarity: stripEmoji(rarityPart || '') || null,
    capturedTotal: captured ? Number(captured[1]) : null,
    imageUrl: imageUrl || null,
    emojiName
  };
}

function isAnimalCard(raw) {
  return collect(raw).texts.some(t => /Informasi animal/i.test(t));
}

// Simpan/merge kartu animal dari sebuah pesan (global, lintas server).
// Mengembalikan animal atau null.
function captureMessage(message) {
  const raw = typeof message.toJSON === 'function' ? message.toJSON() : message;
  const animal = parseAnimalCard(raw);
  if (!animal || !animal.nameKey) return null;
  store.upsertAnimal(animal, { raw, guildId: message?.guildId || null, sourceMessageId: message?.id, updatedAt: Date.now() });
  return animal;
}

function formatAnimalEmbed(animal, emojiMap) {
  const statLine = Object.keys(STAT_LABELS)
    .filter(key => animal.stats?.[key] != null)
    .map(key => applyEmojiMap(animal.statTokens?.[key] || STAT_ICONS[key], emojiMap) + ' `' + animal.stats[key] + '`')
    .join(' ');
  const embed = new EmbedBuilder().setColor(0x9B59B6).setTitle(clip('🐾 ' + animal.name, LIMITS.title));
  if (animal.imageUrl) embed.setThumbnail(animal.imageUrl);
  const fields = [];
  if (animal.quantity) fields.push({ name: 'Jumlah', value: clip(animal.quantity, LIMITS.field), inline: true });
  if (animal.rank) fields.push({ name: 'Rank', value: clip(animal.rank, LIMITS.field), inline: true });
  if (animal.alias) fields.push({ name: 'Alias', value: clip(animal.alias, LIMITS.field), inline: false });
  if (animal.role) fields.push({ name: 'Role', value: clip(animal.role, LIMITS.field), inline: false });
  if (statLine) fields.push({ name: 'Statistik', value: clip(statLine, LIMITS.field), inline: false });
  const total = totalStats(animal);
  if (total != null) fields.push({ name: 'Total Stat', value: String(total), inline: true });
  if (fields.length) embed.addFields(fields);
  return embed;
}

function formatListEmbed(query, animals) {
  const rows = animals.slice(0, 20).map((a, i) => (i + 1) + '. **' + a.name + '**' + (a.rank ? ' — ' + a.rank : ''));
  const desc = rows.length
    ? fitRows('', rows, LIMITS.description)
    : 'Tidak ada animal yang cocok dengan `' + query + '`.';
  const embed = new EmbedBuilder().setColor(0x9B59B6)
    .setTitle(clip(query ? '🔎 Hasil Dex: ' + query : '📖 Animal Dex', LIMITS.title))
    .setDescription(clip(desc, LIMITS.description))
    .setFooter({ text: clip(animals.length + ' hasil • total dex: ' + store.countAnimals(), LIMITS.footer) });
  return embed;
}

const STAT_COLUMNS = ['hp', 'attack', 'protection', 'wisdom', 'magic', 'mr'];
const TABLE_MAX_ROWS = 30;

// Bangun ulang token emoji hewan dari URL gambar (mis. .../emojis/<id>.gif),
// supaya baris tabel bisa memakai emoji hewan sebagai label.
function animalEmoji(animal) {
  const m = /\/emojis\/(\d+)\.(gif|png|webp)/.exec(animal.imageUrl || '');
  if (!m || !animal.emojiName) return null;
  return '<' + (m[2] === 'gif' ? 'a' : '') + ':' + animal.emojiName + ':' + m[1] + '>';
}

// Tampilan ringkas: satu blok mirip tabel (tanpa tabel embed) — baris judul
// berisi emoji statistik, baris data berisi emoji hewan + angka statistiknya.
function formatCompactTable(query, animals, emojiMap) {
  const icon = key => applyEmojiMap(STAT_ICONS[key], emojiMap);
  const groups = [
    STAT_COLUMNS.slice(0, 3).map(icon).join(' '),
    STAT_COLUMNS.slice(3).map(icon).join(' ')
  ];
  const rows = animals.slice(0, TABLE_MAX_ROWS).map(animal => {
    const label = applyEmojiMap(animalEmoji(animal), emojiMap) || '**' + animal.name + '**';
    const cells = group => group.map(k => (animal.stats?.[k] != null ? String(animal.stats[k]) : '–')).join(' ');
    const total = totalStats(animal);
    return label + ' | ' + cells(STAT_COLUMNS.slice(0, 3)) + ' | ' + cells(STAT_COLUMNS.slice(3)) +
      ' | ' + (total != null ? total : '–');
  });
  const desc = rows.length
    ? fitRows('Animal | ' + groups[0] + ' | ' + groups[1] + ' | Total', rows, LIMITS.description)
    : 'Tidak ada animal yang cocok dengan `' + query + '`.';
  return new EmbedBuilder().setColor(0x9B59B6)
    .setTitle(clip(query ? '📖 Dex (ringkas): ' + query : '📖 Animal Dex (ringkas)', LIMITS.title))
    .setDescription(clip(desc, LIMITS.description))
    .setFooter({ text: clip(animals.length + ' hewan • total dex: ' + store.countAnimals(), LIMITS.footer) });
}

// Batas jumlah kartu detail agar total karakter embed tetap di bawah 6000
// (batas total Discord), mencegah error saat banyak nama sekaligus.
const MAX_DETAIL_EMBEDS = 6;

// Pisahkan flag di akhir perintah. `-c` / `--compact` = tampilan ringkas.
function extractFlags(input) {
  const raw = (Array.isArray(input) ? input.join(' ') : String(input || ''))
    .replace(/<a?:(\w+):\d+>/g, ' $1 ');
  const compact = /(^|\s)-{1,2}c(ompact)?(\s|$)/i.test(raw);
  return { compact, rest: raw.replace(/(^|\s)-{1,2}c(ompact)?(\s|$)/gi, ' ') };
}

// Pecah input menjadi daftar query. Nama dipisah spasi dan/atau koma:
// `lawliet buaya` atau `lawliet, buaya`. Emoji hewan (mis. <a:lawliet:123>)
// dianggap sebagai nama hewanya, sehingga user boleh menempel emoji dari kartu.
function toQueries(input) {
  return String(input || '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
}

// Gabungkan hasil semua query tanpa duplikat, urut sesuai urutan query.
function unionMatches(perQuery) {
  const out = [];
  const seen = new Set();
  for (const { matches } of perQuery) {
    for (const animal of matches) {
      if (!seen.has(animal.nameKey)) { seen.add(animal.nameKey); out.push(animal); }
    }
  }
  return out;
}

// Bangun payload balasan untuk `<prefix>dex [nama...] [-c]` / `<prefix>d ...`.
// - Tanpa query → seluruh daftar dex.
// - Setiap nama cocok tepat satu hewan → tampilkan kartu detail semuanya.
// - Selain itu → daftar gabungan hasil pencarian.
// Flag `-c`/`--compact` menampilkan tabel ringkas (emoji stat + angka) untuk
// semua hasil dalam satu pesan.
async function buildDexResponse(input) {
  const { compact, rest } = extractFlags(input);
  const queries = toQueries(rest);

  const all = store.listAnimals();
  const perQuery = queries.map(q => ({ q, matches: store.searchAnimals(q) }));
  const results = queries.length ? unionMatches(perQuery) : all;
  const emojiMap = await mirrorEmojiTokens(collectEmojiTokens(results));

  if (!queries.length) {
    return { embeds: [compact ? formatCompactTable('', all, emojiMap) : formatListEmbed('', all)] };
  }

  if (compact) return { embeds: [formatCompactTable(queries.join(' '), results, emojiMap)] };

  if (perQuery.every(r => r.matches.length === 1) && results.length <= MAX_DETAIL_EMBEDS) {
    return { embeds: results.map(a => formatAnimalEmbed(a, emojiMap)) };
  }
  return { embeds: [formatListEmbed(queries.join(' '), results)] };
}

module.exports = {
  parseAnimalCard, isAnimalCard, captureMessage, buildDexResponse,
  formatAnimalEmbed, formatCompactTable, formatListEmbed, extractFlags, toQueries,
  normalizeName, parseStats, STAT_LABELS, setClient, mirrorEmojiTokens, collectEmojiTokens,
  applyEmojiMap, allEmojiTokens
};
