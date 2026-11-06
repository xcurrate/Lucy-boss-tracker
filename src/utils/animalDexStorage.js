const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

let db = null;
let dbPath = null;

function paths() {
  const dir = path.resolve(process.cwd(), 'data');
  return { dir, dbFile: path.join(dir, 'animal-dex.db') };
}

// Dex bersifat GLOBAL: satu baris per nama hewan, digabung dari semua server.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS dex_animals (
    name_key TEXT NOT NULL PRIMARY KEY,
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
    emoji_name TEXT,
    source_guild_id TEXT,
    raw TEXT,
    source_message_id TEXT,
    first_seen_at INTEGER,
    updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS emoji_map (
    source_id TEXT NOT NULL PRIMARY KEY,
    app_token TEXT NOT NULL,
    updated_at INTEGER
  );
`;

function getDb() {
  const { dir, dbFile } = paths();
  if (db && dbPath === dbFile) return db;
  if (db) { try { db.close(); } catch {} db = null; }
  fs.mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(dbFile);
  dbPath = dbFile;
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate();
  return db;
}

function columnsOf(table) {
  return db.prepare('PRAGMA table_info(' + table + ')').all().map(c => c.name);
}

function addColumn(name, ddl) {
  if (!columnsOf('dex_animals').includes(name)) db.exec('ALTER TABLE dex_animals ADD COLUMN ' + ddl + ';');
}

// Skema lama menyimpan dex per server (PK guild_id + name_key). Migrasikan ke
// global sekali: ambil baris terbaru per nama, lalu ganti tabel.
function migrateLegacyGuildSchema() {
  const cols = columnsOf('dex_animals');
  if (!cols.includes('guild_id')) return;
  addColumn('stat_tokens', 'stat_tokens TEXT');
  addColumn('emoji_name', 'emoji_name TEXT');
  addColumn('source_guild_id', 'source_guild_id TEXT');
  db.exec('BEGIN');
  db.exec(SCHEMA.replace('IF NOT EXISTS dex_animals', 'IF NOT EXISTS dex_animals_global'));
  db.exec(`
    INSERT INTO dex_animals_global
      (name_key, name, nickname, rank, quantity, alias, points, sell, sacrifice,
       hp, attack, protection, wisdom, magic, mr, role, weapons, rarity, captured_total,
       image_url, stat_tokens, emoji_name, source_guild_id, raw, source_message_id, first_seen_at, updated_at)
    SELECT
       d.name_key, d.name, d.nickname, d.rank, d.quantity, d.alias, d.points, d.sell, d.sacrifice,
       d.hp, d.attack, d.protection, d.wisdom, d.magic, d.mr, d.role, d.weapons, d.rarity, d.captured_total,
       d.image_url, d.stat_tokens, d.emoji_name, COALESCE(d.source_guild_id, d.guild_id), d.raw, d.source_message_id,
       d.first_seen_at, d.updated_at
    FROM dex_animals d
    WHERE d.updated_at = (SELECT MAX(x.updated_at) FROM dex_animals x WHERE x.name_key = d.name_key)
    GROUP BY d.name_key
  `);
  db.exec('DROP TABLE dex_animals');
  db.exec('ALTER TABLE dex_animals_global RENAME TO dex_animals');
  db.exec('COMMIT');
}

function migrate() {
  migrateLegacyGuildSchema();
  addColumn('stat_tokens', 'stat_tokens TEXT');
  addColumn('emoji_name', 'emoji_name TEXT');
  addColumn('source_guild_id', 'source_guild_id TEXT');
}

function toNumber(value) {
  if (value == null) return null;
  const n = Number(String(value).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Upsert global by nama hewan. Data lama yang belum ada di kartu baru tetap
// dipertahankan (COALESCE), sehingga kartu parsial tidak menghapus informasi lama.
function upsertAnimal(animal, meta = {}) {
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
    emoji_name: animal.emojiName || null,
    source_guild_id: meta.guildId || null,
    raw: meta.raw ? JSON.stringify(meta.raw) : null, source_message_id: meta.sourceMessageId || null
  };
  const existing = database.prepare('SELECT * FROM dex_animals WHERE name_key = ?').get(animal.nameKey);
  if (!existing) {
    database.prepare(`
      INSERT INTO dex_animals
        (name_key, name, nickname, rank, quantity, alias, points, sell, sacrifice,
         hp, attack, protection, wisdom, magic, mr, role, weapons, rarity, captured_total,
         image_url, stat_tokens, emoji_name, source_guild_id, raw, source_message_id, first_seen_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(animal.nameKey, columns.name, columns.nickname, columns.rank, columns.quantity,
        columns.alias, columns.points, columns.sell, columns.sacrifice, columns.hp, columns.attack,
        columns.protection, columns.wisdom, columns.magic, columns.mr, columns.role, columns.weapons,
        columns.rarity, columns.captured_total, columns.image_url, columns.stat_tokens, columns.emoji_name,
        columns.source_guild_id, columns.raw, columns.source_message_id, now, now);
    return { created: true };
  }
  const merged = {};
  for (const [key, value] of Object.entries(columns)) merged[key] = value == null ? existing[key] : value;
  database.prepare(`
    UPDATE dex_animals SET
      name = ?, nickname = ?, rank = ?, quantity = ?, alias = ?, points = ?, sell = ?, sacrifice = ?,
      hp = ?, attack = ?, protection = ?, wisdom = ?, magic = ?, mr = ?, role = ?, weapons = ?, rarity = ?,
      captured_total = ?, image_url = ?, stat_tokens = ?, emoji_name = ?, source_guild_id = ?, raw = ?, source_message_id = ?, updated_at = ?
    WHERE name_key = ?`)
    .run(merged.name, merged.nickname, merged.rank, merged.quantity, merged.alias, merged.points,
      merged.sell, merged.sacrifice, merged.hp, merged.attack, merged.protection, merged.wisdom,
      merged.magic, merged.mr, merged.role, merged.weapons, merged.rarity, merged.captured_total,
      merged.image_url, merged.stat_tokens, merged.emoji_name, merged.source_guild_id, merged.raw,
      merged.source_message_id, now, animal.nameKey);
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
    imageUrl: row.image_url, emojiName: row.emoji_name,
    sourceGuildId: row.source_guild_id, sourceMessageId: row.source_message_id,
    firstSeenAt: row.first_seen_at, updatedAt: row.updated_at, raw
  };
}

function getAnimal(nameKey) {
  const row = getDb().prepare('SELECT * FROM dex_animals WHERE name_key = ?').get(nameKey);
  return row ? rowToAnimal(row) : null;
}

function listAnimals() {
  return getDb().prepare('SELECT * FROM dex_animals ORDER BY name COLLATE NOCASE').all().map(rowToAnimal);
}

// Pencarian sederhana: cocokkan nama, alias, nickname, atau rank (case-insensitive).
function searchAnimals(query) {
  const q = String(query || '').trim().toLowerCase();
  const all = listAnimals();
  if (!q) return all;
  return all.filter(a => [a.name, a.alias, a.nickname, a.rank, a.emojiName]
    .some(field => typeof field === 'string' && field.toLowerCase().includes(q)));
}

function countAnimals() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM dex_animals').get().n;
}

// Cache pemetaan emoji sumber Lucy (source_id) → token emoji milik aplikasi bot
// (app_token). Emoji milik aplikasi lain tidak bisa dirender bot ini, jadi token
// perlu di-mirror; pemetaan disimpan agar tidak dibuat ulang tiap render.
function getEmojiToken(sourceId) {
  const row = getDb().prepare('SELECT app_token FROM emoji_map WHERE source_id = ?').get(String(sourceId));
  return row ? row.app_token : null;
}

function setEmojiToken(sourceId, appToken) {
  getDb().prepare(`INSERT INTO emoji_map (source_id, app_token, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(source_id) DO UPDATE SET app_token = excluded.app_token, updated_at = excluded.updated_at`)
    .run(String(sourceId), appToken, Date.now());
}

module.exports = {
  getDb, upsertAnimal, getAnimal, listAnimals, searchAnimals, countAnimals,
  getEmojiToken, setEmojiToken
};
