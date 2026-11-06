const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

let db = null;
let dbPath = null;

function paths() {
  const dir = path.resolve(process.cwd(), 'data');
  return { dir, dbFile: path.join(dir, 'animal-dex.db') };
}

function getDb() {
  const { dir, dbFile } = paths();
  if (db && dbPath === dbFile) return db;
  if (db) { try { db.close(); } catch {} db = null; }
  fs.mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(dbFile);
  dbPath = dbFile;
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS dex_animals (
      guild_id TEXT NOT NULL,
      name_key TEXT NOT NULL,
      name TEXT NOT NULL,
      nickname TEXT,
      rank TEXT,
      quantity TEXT,
      alias TEXT,
      points INTEGER,
      sell TEXT,
      sacrifice TEXT,
      hp INTEGER,
      attack INTEGER,
      protection INTEGER,
      wisdom INTEGER,
      magic INTEGER,
      mr INTEGER,
      role TEXT,
      weapons TEXT,
      rarity TEXT,
      captured_total INTEGER,
      image_url TEXT,
      stat_tokens TEXT,
      raw TEXT,
      source_message_id TEXT,
      first_seen_at INTEGER,
      updated_at INTEGER,
      PRIMARY KEY (guild_id, name_key)
    );
  `);
  migrate();
  return db;
}

// Tabel lama mungkin belum punya kolom baru; tambahkan tanpa menghapus data.
function migrate() {
  const columns = db.prepare('PRAGMA table_info(dex_animals)').all().map(c => c.name);
  if (!columns.includes('stat_tokens')) db.exec('ALTER TABLE dex_animals ADD COLUMN stat_tokens TEXT;');
}

function toNumber(value) {
  if (value == null) return null;
  const n = Number(String(value).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Upsert by (guild, name). Data lama yang belum ada di kartu baru tetap dipertahankan
// (COALESCE), sehingga kartu parsial tidak menghapus informasi yang sudah tersimpan.
function upsertAnimal(guildId, animal, meta = {}) {
  const database = getDb();
  const now = Number(meta.updatedAt) || Date.now();
  const stats = animal.stats || {};
  const columns = {
    name: animal.name, nickname: animal.nickname, rank: animal.rank, quantity: animal.quantity,
    alias: animal.alias, points: toNumber(animal.points), sell: animal.sell, sacrifice: animal.sacrifice,
    hp: toNumber(stats.hp), attack: toNumber(stats.attack), protection: toNumber(stats.protection),
    wisdom: toNumber(stats.wisdom), magic: toNumber(stats.magic), mr: toNumber(stats.mr),
    role: animal.role, weapons: animal.weapons, rarity: animal.rarity,
    captured_total: toNumber(animal.capturedTotal), image_url: animal.imageUrl || null,
    stat_tokens: animal.statTokens ? JSON.stringify(animal.statTokens) : null,
    raw: meta.raw ? JSON.stringify(meta.raw) : null, source_message_id: meta.sourceMessageId || null
  };
  const existing = database.prepare('SELECT * FROM dex_animals WHERE guild_id = ? AND name_key = ?').get(guildId, animal.nameKey);
  if (!existing) {
    database.prepare(`
      INSERT INTO dex_animals
        (guild_id, name_key, name, nickname, rank, quantity, alias, points, sell, sacrifice,
         hp, attack, protection, wisdom, magic, mr, role, weapons, rarity, captured_total,
         image_url, stat_tokens, raw, source_message_id, first_seen_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(guildId, animal.nameKey, columns.name, columns.nickname, columns.rank, columns.quantity,
        columns.alias, columns.points, columns.sell, columns.sacrifice, columns.hp, columns.attack,
        columns.protection, columns.wisdom, columns.magic, columns.mr, columns.role, columns.weapons,
        columns.rarity, columns.captured_total, columns.image_url, columns.stat_tokens, columns.raw,
        columns.source_message_id, now, now);
    return { created: true };
  }
  const merged = {};
  for (const [key, value] of Object.entries(columns)) merged[key] = value == null ? existing[key] : value;
  database.prepare(`
    UPDATE dex_animals SET
      name = ?, nickname = ?, rank = ?, quantity = ?, alias = ?, points = ?, sell = ?, sacrifice = ?,
      hp = ?, attack = ?, protection = ?, wisdom = ?, magic = ?, mr = ?, role = ?, weapons = ?, rarity = ?,
      captured_total = ?, image_url = ?, stat_tokens = ?, raw = ?, source_message_id = ?, updated_at = ?
    WHERE guild_id = ? AND name_key = ?`)
    .run(merged.name, merged.nickname, merged.rank, merged.quantity, merged.alias, merged.points,
      merged.sell, merged.sacrifice, merged.hp, merged.attack, merged.protection, merged.wisdom,
      merged.magic, merged.mr, merged.role, merged.weapons, merged.rarity, merged.captured_total,
      merged.image_url, merged.stat_tokens, merged.raw, merged.source_message_id, now, guildId, animal.nameKey);
  return { created: false };
}

function rowToAnimal(row) {
  const stats = {};
  for (const key of ['hp', 'attack', 'protection', 'wisdom', 'magic', 'mr']) {
    if (row[key] != null) stats[key] = row[key];
  }
  let raw = null;
  if (row.raw) { try { raw = JSON.parse(row.raw); } catch {} }
  let statTokens = null;
  if (row.stat_tokens) { try { statTokens = JSON.parse(row.stat_tokens); } catch {} }
  return {
    nameKey: row.name_key, name: row.name, nickname: row.nickname, rank: row.rank, quantity: row.quantity,
    alias: row.alias, points: row.points, sell: row.sell, sacrifice: row.sacrifice, stats, statTokens,
    role: row.role, weapons: row.weapons, rarity: row.rarity, capturedTotal: row.captured_total,
    imageUrl: row.image_url, sourceMessageId: row.source_message_id,
    firstSeenAt: row.first_seen_at, updatedAt: row.updated_at, raw
  };
}

function getAnimal(guildId, nameKey) {
  const row = getDb().prepare('SELECT * FROM dex_animals WHERE guild_id = ? AND name_key = ?').get(guildId, nameKey);
  return row ? rowToAnimal(row) : null;
}

function listAnimals(guildId) {
  return getDb().prepare('SELECT * FROM dex_animals WHERE guild_id = ? ORDER BY name COLLATE NOCASE').all(guildId).map(rowToAnimal);
}

// Pencarian sederhana: cocokkan nama, alias, nickname, atau rank (case-insensitive).
function searchAnimals(guildId, query) {
  const q = String(query || '').trim().toLowerCase();
  const all = listAnimals(guildId);
  if (!q) return all;
  return all.filter(a => [a.name, a.alias, a.nickname, a.rank]
    .some(field => typeof field === 'string' && field.toLowerCase().includes(q)));
}

function countAnimals(guildId) {
  return getDb().prepare('SELECT COUNT(*) AS n FROM dex_animals WHERE guild_id = ?').get(guildId).n;
}

module.exports = { getDb, upsertAnimal, getAnimal, listAnimals, searchAnimals, countAnimals };
