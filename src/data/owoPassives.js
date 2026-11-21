// Data pasif battle OwO (21 pasif), dipakai sebagai acuan fitur simulasi battle.
//
// Sumber: https://github.com/ChristopherBThai/Discord-OwO-Bot (CC BY-NC-SA 4.0),
// dibaca dari `src/commands/commandList/battle/passives/`. Angka di
// `owoPassives.json` sudah diverifikasi dengan menjalankan class aslinya pada
// quality 0/50/100, bukan hasil perkiraan dari dokumentasi.
const data = require('./owoPassives.json');

// Dibaca dari modul mekanik supaya daftar ini tidak pernah menyimpang dari
// implementasinya. `battlePassives` tidak mengimpor balik file ini, jadi aman.
const MECHANIC_IDS = new Set(
  Object.keys(require('../services/battlePassives').PASSIVES).map(Number)
);

const pending = require('./owoPending.json');
const pendingByAlias = new Map();
for (const item of pending.passives) {
  for (const key of [item.name, ...(item.aliases || [])]) {
    const k = String(key).toLowerCase();
    if (!pendingByAlias.has(k)) pendingByAlias.set(k, item);
  }
}

const byId = new Map();
const byName = new Map();
for (const passive of data.passives) {
  byId.set(passive.id, passive);
  for (const key of [passive.name, ...(passive.aliases || [])]) {
    const k = String(key).toLowerCase();
    if (!byName.has(k)) byName.set(k, passive);
  }
}

// Nilai stat untuk satu quality (0-100). Sama dengan PassiveInterface.toStats,
// tanpa bonus wear karena wear tidak dipakai di simulasi.
function statsAt(passive, quality) {
  const q = Math.min(100, Math.max(0, Number(quality) || 0));
  return passive.qualityList.map(([min, max]) => Math.round((min + (max - min) * (q / 100)) * 100) / 100);
}

function get(idOrName) {
  if (typeof idOrName === 'number') return byId.get(idOrName) || null;
  return byName.get(String(idOrName).toLowerCase()) || null;
}

// Pasif yang punya implementasi hook di `battlePassives`. Dipakai untuk
// membedakan "belum didukung" dari "tidak dikenal" saat dipasang ke senjata.
function hasMechanic(id) {
  return MECHANIC_IDS.has(Number(id));
}

// Pasif yang namanya dikenal tetapi hook-nya belum diimplementasikan.
function findPending(query) {
  const key = String(query || '').trim().toLowerCase();
  if (!key) return null;
  return pendingByAlias.get(key) || null;
}

module.exports = {
  source: data.source,
  sourceLicense: data.sourceLicense,
  categories: data.categories,
  all: () => data.passives,
  byCategory: category => data.passives.filter(p => p.category === category),
  get,
  statsAt,
  hasMechanic,
  findPending,
  pending,
};
