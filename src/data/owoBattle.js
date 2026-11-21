// Data battle OwO: hewan, senjata, buff. Acuan fitur simulasi battle.
//
// Sumber: https://github.com/ChristopherBThai/Discord-OwO-Bot (CC BY-NC-SA 4.0).
// Angka di `owoBattle.json` dibaca dari kode `battle/` lalu divalidasi dengan
// menjalankan class aslinya, bukan dari dokumentasi.
const data = require('./owoBattle.json');
const pending = require('./owoPending.json');

const animalsByName = new Map();
const animalAliases = new Map();
for (const animal of data.animals) {
  animalsByName.set(animal.name.toLowerCase(), animal);
  for (const alias of animal.alias || []) {
    const key = String(alias).toLowerCase();
    if (!animalAliases.has(key)) animalAliases.set(key, animal);
  }
}

const weaponsById = new Map();
const weaponsByAlias = new Map();
for (const weapon of data.weapons) {
  weaponsById.set(weapon.id, weapon);
  const keys = [weapon.name, ...(weapon.aliases || [])].map(k => k.toLowerCase());
  for (const key of keys) if (!weaponsByAlias.has(key)) weaponsByAlias.set(key, weapon);
}

const buffsById = new Map(data.buffs.map(b => [b.id, b]));

// Tanpa `quality=` di slot dan tanpa `-qp`/`-qe`, senjata dianggap tier
// tertinggi (Fabled). Ini membuat tampilan dan simulasi konsisten: apa yang
// terlihat di `d team show` itulah yang dipakai `d sim`.
const DEFAULT_QUALITY = 100;

// Senjata kini boleh memakai satu pasif lebih banyak dari `passiveCount`
// bawaannya. Batas ini berlaku global, dan senjata tertentu bisa menimpanya
// lewat field `passiveBonus` di datanya (Rune of the Forgotten: 0 -> 2).
const PASSIVE_BONUS = data.passiveBonus ?? 0;

// Rentang jumlah pasif yang sah untuk satu senjata.
function passiveRange(weapon) {
  if (!weapon) return { min: 0, max: 0 };
  const min = weapon.passiveCount ?? 0;
  const bonus = weapon.passiveBonus ?? PASSIVE_BONUS;
  return { min, max: min + bonus };
}

// Level default hewan saat dimasukkan ke tim, dan batas atas level.
const DEFAULT_LEVEL = 50;
const MAX_LEVEL = 1000;

function findAnimal(query) {
  const key = String(query || '').trim().toLowerCase();
  if (!key) return null;
  return animalsByName.get(key) || animalAliases.get(key) || null;
}

// Senjata yang namanya sudah dikenal tapi mekaniknya belum ada di
// `owoBattle.json`. Dipisah supaya pesan errornya jelas, bukan "tidak dikenal".
const pendingWeaponsByAlias = new Map();
for (const weapon of pending.weapons) {
  for (const key of [weapon.name, ...(weapon.aliases || [])]) {
    const k = String(key).toLowerCase();
    if (!pendingWeaponsByAlias.has(k)) pendingWeaponsByAlias.set(k, weapon);
  }
}

function findWeapon(query) {
  const key = String(query || '').trim().toLowerCase();
  if (!key) return null;
  return weaponsByAlias.get(key) || null;
}

function findPendingWeapon(query) {
  const key = String(query || '').trim().toLowerCase();
  if (!key) return null;
  return pendingWeaponsByAlias.get(key) || null;
}

// Stat dasar hewan pada level tertentu. Mengikuti animalUtil.parseStats.
function baseStats(animal, level) {
  const lvl = Math.max(1, Math.floor(Number(level) || 1));
  return {
    hp: 500 + lvl * animal.hp * 2,
    wp: 500 + lvl * animal.wp * 2,
    att: 100 + lvl * animal.att,
    mag: 100 + lvl * animal.mag,
    pr: 25 + lvl * animal.pr * 2,
    mr: 25 + lvl * animal.mr * 2,
  };
}

// Stat hewan dari kombinasi angka manual (urutan statOrder).
function statsFromArray(values) {
  const [hp, att, pr, wp, mag, mr] = values.map(Number);
  return { hp, att, pr, wp, mag, mr };
}

module.exports = {
  source: data.source,
  sourceLicense: data.sourceLicense,
  formulas: data.formulas,
  statOrder: data.statOrder,
  limits: data.limits,
  DEFAULT_QUALITY, DEFAULT_LEVEL, MAX_LEVEL, PASSIVE_BONUS,
  animals: () => data.animals,
  weapons: () => data.weapons,
  buffs: () => data.buffs,
  buffById: id => buffsById.get(Number(id)) || null,
  findAnimal,
  findWeapon,
  findPendingWeapon,
  passiveRange,
  pending,
  baseStats,
  statsFromArray,
};
