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
function collect(raw) {
  const out = { texts: [], imageUrl: null };
  const seen = new Set();
  function walk(node) {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { for (const child of node) walk(child); return; }
    if (Number(node.type) === 10 && typeof node.content === 'string') out.texts.push(node.content);
    if (!out.imageUrl && node.accessory?.media?.url) out.imageUrl = node.accessory.media.url;
    if (!out.imageUrl && Number(node.type) === 12) {
      const url = node.items?.[0]?.media?.url || node.media?.url;
      if (typeof url === 'string') out.imageUrl = url;
    }
    for (const key of ['components', 'accessory']) walk(node[key]);
  }
  walk(raw?.components || []);
  return out;
}

function parseStats(text) {
  const stats = {};
  const pairs = String(text || '').matchAll(/<a?:(\w+):\d+>\s*`([^`]+)`/g);
  for (const [, emojiName, value] of pairs) {
    const field = STAT_EMOJI[emojiName];
    if (field) {
      const n = Number(String(value).replace(/[^\d-]/g, ''));
      if (Number.isFinite(n)) stats[field] = n;
    }
  }
  return stats;
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
    stats: parseStats(statsText),
    role: stripEmoji(roleLine) || null,
    weapons: weaponNames.length ? weaponNames.join(', ') + (moreWeapons ? ', + more' : '') : null,
    rarity: stripEmoji(rarityPart || '') || null,
    capturedTotal: captured ? Number(captured[1]) : null,
    imageUrl: imageUrl || null
  };
}

function isAnimalCard(raw) {
  return collect(raw).texts.some(t => /Informasi animal/i.test(t));
}

// Simpan/merge kartu animal dari sebuah pesan. Mengembalikan animal atau null.
function captureMessage(message) {
  if (!message?.guildId) return null;
  const raw = typeof message.toJSON === 'function' ? message.toJSON() : message;
  const animal = parseAnimalCard(raw);
  if (!animal || !animal.nameKey) return null;
  store.upsertAnimal(message.guildId, animal, { raw, sourceMessageId: message.id, updatedAt: Date.now() });
  return animal;
}

function formatAnimalEmbed(animal) {
  const statLine = Object.keys(STAT_LABELS)
    .filter(key => animal.stats?.[key] != null)
    .map(key => STAT_ICONS[key] + ' `' + animal.stats[key] + '`')
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

function formatListEmbed(guildId, query, animals) {
  const shown = animals.slice(0, 20);
  const desc = shown.length
    ? shown.map((a, i) => (i + 1) + '. **' + a.name + '**' + (a.rank ? ' — ' + a.rank : '')).join('\n')
    : 'Tidak ada animal yang cocok dengan `' + query + '`.';
  const embed = new EmbedBuilder().setColor(0x9B59B6)
    .setTitle(query ? '🔎 Hasil Dex: ' + query : '📖 Animal Dex')
    .setDescription(desc)
    .setFooter({ text: animals.length + ' hasil • total dex: ' + store.countAnimals(guildId) });
  return embed;
}

// Bangun payload balasan untuk `<prefix>dex [query]` / `<prefix>d [query]`.
// Satu hasil cocok → kartu detail; selain itu → daftar hasil.
function buildDexResponse(guildId, query) {
  const q = String(query || '').trim();
  const matches = store.searchAnimals(guildId, q);
  if (q && matches.length === 1) return { embeds: [formatAnimalEmbed(matches[0])] };
  return { embeds: [formatListEmbed(guildId, q, matches)] };
}

module.exports = {
  parseAnimalCard, isAnimalCard, captureMessage, buildDexResponse,
  formatAnimalEmbed, formatListEmbed, normalizeName, parseStats, STAT_LABELS
};
