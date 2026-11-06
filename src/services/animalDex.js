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

function formatAnimalEmbed(animal) {
  const statLine = Object.keys(STAT_LABELS)
    .filter(key => animal.stats?.[key] != null)
    .map(key => (animal.statTokens?.[key] || STAT_ICONS[key]) + ' `' + animal.stats[key] + '`')
    .join(' ');
  const embed = new EmbedBuilder().setColor(0x9B59B6).setTitle('🐾 ' + animal.name);
  if (animal.imageUrl) embed.setThumbnail(animal.imageUrl);
  const fields = [];
  if (animal.nickname) fields.push({ name: 'Nickname', value: animal.nickname, inline: true });
  if (animal.quantity) fields.push({ name: 'Jumlah', value: animal.quantity, inline: true });
  if (animal.rank) fields.push({ name: 'Rank', value: animal.rank, inline: true });
  if (animal.alias) fields.push({ name: 'Alias', value: animal.alias, inline: false });
  if (animal.points != null) fields.push({ name: 'Points', value: String(animal.points), inline: true });
  if (animal.sell) fields.push({ name: 'Sell', value: animal.sell, inline: true });
  if (animal.sacrifice) fields.push({ name: 'Sacrifice', value: animal.sacrifice, inline: true });
  if (animal.role) fields.push({ name: 'Role', value: animal.role, inline: false });
  if (animal.weapons) fields.push({ name: 'Rekomendasi Weapon', value: animal.weapons, inline: false });
  if (statLine) fields.push({ name: 'Statistik', value: statLine, inline: false });
  if (animal.rarity) fields.push({ name: 'Kelangkaan', value: animal.rarity + (animal.capturedTotal != null ? ' • ' + animal.capturedTotal + ' total ditangkap' : ''), inline: false });
  if (fields.length) embed.addFields(fields);
  return embed;
}

function formatListEmbed(query, animals, compact = false) {
  const shown = animals.slice(0, compact ? 30 : 20);
  const desc = shown.length
    ? shown.map((a, i) => compact
        ? compactLine(i + 1, a)
        : (i + 1) + '. **' + a.name + '**' + (a.rank ? ' — ' + a.rank : '')).join('\n')
    : 'Tidak ada animal yang cocok dengan `' + query + '`.';
  const embed = new EmbedBuilder().setColor(0x9B59B6)
    .setTitle(query ? '🔎 Hasil Dex: ' + query : '📖 Animal Dex')
    .setDescription(desc)
    .setFooter({ text: animals.length + ' hasil • total dex: ' + store.countAnimals() });
  return embed;
}

function shortStat(key, animal) {
  if (animal.stats?.[key] == null) return null;
  return STAT_LABELS[key] + ':' + animal.stats[key];
}

// Satu baris ringkas untuk mode compact: `1. lawliet (DM ME) — cpatreon | HP:2 AT:0 ...`
function compactLine(index, animal) {
  const nick = animal.nickname ? ' (' + animal.nickname + ')' : '';
  const rank = animal.rank ? ' — ' + animal.rank : '';
  const stats = Object.keys(STAT_LABELS).map(k => shortStat(k, animal)).filter(Boolean).join(' ');
  const bits = [animal.points != null ? 'Pts:' + animal.points : null, stats].filter(Boolean).join(' | ');
  return index + '. **' + animal.name + '**' + nick + rank + (bits ? '\n' + bits : '');
}

// Ringkasan satu baris untuk mode compact pada kartu detail.
function formatCompactEmbed(animal) {
  const statLine = Object.keys(STAT_LABELS)
    .filter(key => animal.stats?.[key] != null)
    .map(key => (animal.statTokens?.[key] || STAT_ICONS[key]) + ' ' + animal.stats[key])
    .join('  ');
  const embed = new EmbedBuilder().setColor(0x9B59B6).setTitle('🐾 ' + animal.name);
  if (animal.imageUrl) embed.setThumbnail(animal.imageUrl);
  const head = [];
  if (animal.nickname) head.push('**' + animal.nickname + '**');
  if (animal.rank) head.push(animal.rank);
  if (animal.points != null) head.push(animal.points + ' pts');
  if (animal.rarity) head.push(animal.rarity);
  const lines = [];
  if (head.length) lines.push(head.join(' • '));
  if (animal.quantity) lines.push('Jumlah: ' + animal.quantity);
  if (statLine) lines.push(statLine);
  if (animal.role) lines.push('Role: ' + animal.role);
  if (animal.weapons) lines.push('Weapon: ' + animal.weapons);
  if (animal.sacrifice) lines.push('Sacrifice: ' + animal.sacrifice);
  embed.setDescription(lines.join('\n') || '—');
  return embed;
}

const MAX_DETAIL_EMBEDS = 10;

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

// Bangun payload balasan untuk `<prefix>dex [nama...] [-c]` / `<prefix>d ...`.
// - Tanpa query → seluruh daftar dex.
// - Setiap nama cocok tepat satu hewan → tampilkan kartu detail semuanya.
// - Selain itu → daftar gabungan hasil pencarian.
// Flag `-c`/`--compact` memakai tampilan ringkas.
function buildDexResponse(input) {
  const { compact, rest } = extractFlags(input);
  const queries = toQueries(rest);
  if (!queries.length) return { embeds: [formatListEmbed('', store.listAnimals(), compact)] };

  const perQuery = queries.map(q => ({ q, matches: store.searchAnimals(q) }));
  const allSingle = perQuery.every(r => r.matches.length === 1);
  if (allSingle) {
    const animals = [];
    const seen = new Set();
    for (const { matches } of perQuery) {
      if (!seen.has(matches[0].nameKey)) { seen.add(matches[0].nameKey); animals.push(matches[0]); }
    }
    if (animals.length <= MAX_DETAIL_EMBEDS) {
      return { embeds: animals.map(a => (compact ? formatCompactEmbed(a) : formatAnimalEmbed(a))) };
    }
  }

  const union = [];
  const seen = new Set();
  for (const { matches } of perQuery) {
    for (const animal of matches) {
      if (!seen.has(animal.nameKey)) { seen.add(animal.nameKey); union.push(animal); }
    }
  }
  return { embeds: [formatListEmbed(queries.join(' '), union, compact)] };
}

module.exports = {
  parseAnimalCard, isAnimalCard, captureMessage, buildDexResponse,
  formatAnimalEmbed, formatCompactEmbed, formatListEmbed, extractFlags, toQueries,
  normalizeName, parseStats, STAT_LABELS
};
