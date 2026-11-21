// Emoji untuk tampilan battle: hewan, senjata, pasif, dan stat.
//
// Token emoji OwO berasal dari aplikasi lain, jadi tidak bisa dirender bot ini
// sebelum di-mirror ke aplikasi bot (mekanismenya sama dengan dex, lihat
// `services/animalDex.js`). Mirror dijalankan sekali saat start; render hanya
// membaca cache supaya tetap sinkron.
const data = require('../data/owoBattle');
const passiveData = require('../data/owoPassives.json');
const dexStore = require('../utils/animalDexStorage');
const dex = require('./animalDex');

// Ambang rank OwO: 7 tingkat (common → fabled). Emoji senjata/pasif disusun
// mengikuti urutan ini, jadi index-nya ditentukan dari quality.
const RANK_THRESHOLDS = [0.2, 0.2, 0.2, 0.2, 0.14, 0.05, 0.01];
const RANK_NAMES = ['Common', 'Uncommon', 'Rare', 'Epic', 'Mythical', 'Legendary', 'Fabled'];

// Token asli OwO; setelah mirror, `resolve` mengembalikan token aplikasi bot.
const RANK_TOKENS = [
  '<:common:416520037713838081>',
  '<:uncommon:416520056269176842>',
  '<:rare:416520066629107712>',
  '<:epic:416520722987614208>',
  '<:mythic:416520808501084162>',
  '<a:legendary:417955061801680909>',
  '<a:fabled:438857004493307907>',
];
const RANK_FALLBACK = ['⚪', '🟢', '🔵', '🟣', '🟠', '🟡', '🔴'];

const FALLBACK = { weapon: '⚔️', passive: '✨', animal: '🐾', stat: '•' };

function rankIndex(quality) {
  const q = Math.min(100, Math.max(0, Number(quality) || 0)) / 100;
  let acc = 0;
  for (let i = 0; i < RANK_THRESHOLDS.length; i++) {
    acc += RANK_THRESHOLDS[i];
    if (q <= acc) return i;
  }
  return RANK_THRESHOLDS.length - 1;
}

function rankName(quality) {
  return RANK_NAMES[rankIndex(quality)];
}

function rankEmoji(quality) {
  const index = rankIndex(quality);
  return resolve(RANK_TOKENS[index], RANK_FALLBACK[index]);
}

// Token hasil mirror bila sudah ada. Token asli OwO dipakai apa adanya kalau bot
// ternyata punya akses ke emoji itu (emoji guild milik bot sendiri); selain itu
// pakai emoji unicode supaya tampilan tidak menampilkan teks mentah `<:nama:id>`.
function resolve(token, fallback) {
  if (!token) return fallback;
  const id = /:(\d+)>$/.exec(token)?.[1];
  if (!id) return fallback;
  const mapped = dexStore.getEmojiToken(id);
  if (mapped && dex.tokenIsLive(mapped)) return mapped;
  return dex.isRenderableToken(id) ? token : fallback;
}

// Quality kosong berarti tier tertinggi (lihat `DEFAULT_QUALITY`), bukan acak.
function pick(list, quality) {
  if (!Array.isArray(list) || !list.length) return null;
  const q = quality == null ? data.DEFAULT_QUALITY : quality;
  // Array yang belum lengkap 7 token tetap dipakai: token terakhir berlaku untuk
  // rank di atasnya. Tanpa ini, data 1-token jatuh ke ikon netral di semua rank
  // kecuali Common — rank Fabled (quality default) justru yang paling sering.
  return list[Math.min(rankIndex(q), list.length - 1)] || null;
}

function emojiFor(list, quality, fallback) {
  return resolve(pick(list, quality), fallback);
}

function weaponToken(id, quality) {
  const def = data.weapons().find(w => w.id === Number(id));
  // Sebagian senjata hanya punya satu emoji (tanpa varian per rank); emoji itu
  // dipakai untuk semua tier.
  if (def && !def.emojis?.length && def.defaultEmoji) return def.defaultEmoji;
  return pick(def?.emojis, quality);
}

function passiveToken(id, quality) {
  const def = passiveData.passives.find(p => p.id === Number(id));
  // Sama seperti senjata: pasif yang hanya punya satu token memakainya untuk
  // semua rank, bukan hanya rank yang cocok dengan urutan array.
  if (def && def.emojis?.length === 1 && def.defaultEmoji) return def.defaultEmoji;
  return pick(def?.emojis, quality);
}

function weaponEmoji(id, quality) {
  return resolve(weaponToken(id, quality), FALLBACK.weapon);
}

function passiveEmoji(id, quality) {
  return resolve(passiveToken(id, quality), FALLBACK.passive);
}

// Hewan memakai emoji dari dex (hasil tangkapan Lucy), bukan dari data battle.
// Pet yang baru ditangkap di-mirror saat kartunya masuk; kalau saat itu gagal
// (mis. koneksi), render berikutnya mencoba sekali lagi di latar belakang.
const retriedAnimals = new Set();
function animalEmoji(animal) {
  if (!animal) return FALLBACK.animal;
  const token = dex.animalEmoji(animal);
  const id = /:(\d+)>$/.exec(token || '')?.[1];
  const mapped = resolve(token, null);
  if (!mapped && id && !retriedAnimals.has(id)) {
    retriedAnimals.add(id);
    dex.syncAnimalEmoji(animal).catch(() => retriedAnimals.delete(id));
  }
  return mapped || FALLBACK.animal;
}

// Data battle memakai kunci pendek (att/pr/wp/mag), dex memakai nama panjang.
const STAT_KEY_MAP = { hp: 'hp', att: 'attack', pr: 'protection', wp: 'wisdom', mag: 'magic', mr: 'mr' };

function statIcon(key) {
  return resolve(dex.STAT_ICONS[STAT_KEY_MAP[key] || key], FALLBACK.stat);
}

// Semua token yang perlu di-mirror agar battle tampil penuh.
function allTokens() {
  const tokens = [];
  for (const weapon of data.weapons()) {
    tokens.push(...(weapon.emojis || []));
    if (weapon.defaultEmoji) tokens.push(weapon.defaultEmoji);
  }
  for (const passive of passiveData.passives) tokens.push(...(passive.emojis || []));
  tokens.push(...RANK_TOKENS);
  tokens.push(...Object.values(dex.STAT_ICONS));
  return [...new Set(tokens)];
}

async function syncEmojis() {
  await dex.mirrorEmojiTokens(allTokens());
}

module.exports = {
  RANK_NAMES, RANK_TOKENS, rankIndex, rankName, rankEmoji,
  weaponEmoji, passiveEmoji, animalEmoji, statIcon, allTokens, syncEmojis,
  weaponToken, passiveToken, emojiFor,
};
