const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

let db = null;
let dbPath = null;

function paths() {
  const dir = path.resolve(process.cwd(), 'data');
  return { dir, dbFile: path.join(dir, 'lucy-counter.db'), legacyFile: path.join(dir, 'lucy-counter.json') };
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
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS lucy_users (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT,
      last_lucy_accepted_at INTEGER,
      challenge_cycle_key TEXT,
      challenge_count INTEGER NOT NULL DEFAULT 0,
      challenge_notified INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS lucy_daily (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      day TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id, day)
    );
    -- Riwayat progres Target Lucy per siklus. lucy_users hanya menyimpan siklus
    -- terakhir (ditimpa saat siklus baru), jadi tabel ini yang mempertahankan
    -- data lama agar bisa dibaca per tanggal.
    CREATE TABLE IF NOT EXISTS lucy_target_daily (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      cycle_key TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id, cycle_key)
    );
  `);
  migrateLegacyJson(db, paths().legacyFile);
  return db;
}

// Impor sekali dari data/lucy-counter.json bila tabel masih kosong. Penanda di
// schema_meta mencegah impor ulang yang bisa menimpa data yang lebih baru.
function migrateLegacyJson(database, legacyFile) {
  const marker = database.prepare('SELECT value FROM schema_meta WHERE key = ?').get('migrated_from_json');
  if (marker) return;
  let legacy = null;
  try { legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf8')); } catch { legacy = null; }
  const existing = database.prepare('SELECT COUNT(*) AS n FROM lucy_users').get().n;
  if (legacy && typeof legacy === 'object' && existing === 0) {
    importLegacy(database, legacy);
    console.info('[LucyCounter][migrate] imported legacy JSON into SQLite');
  }
  database.prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)')
    .run('migrated_from_json', new Date().toISOString());
}

function importLegacy(database, all) {
  const insertUser = database.prepare(`
    INSERT OR REPLACE INTO lucy_users
      (guild_id, user_id, name, last_lucy_accepted_at, challenge_cycle_key, challenge_count, challenge_notified)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const insertDay = database.prepare(`
    INSERT OR REPLACE INTO lucy_daily (guild_id, user_id, day, count) VALUES (?, ?, ?, ?)`);
  database.exec('BEGIN');
  try {
    for (const [guildId, guild] of Object.entries(all)) {
      for (const [userId, user] of Object.entries(guild?.users || {})) {
        insertUser.run(
          guildId, userId, user.name || null,
          Number.isFinite(Number(user.lastLucyAcceptedAt)) ? Number(user.lastLucyAcceptedAt) : null,
          user.challengeDayKey || null,
          Number(user.challengeCount) || 0,
          user.challengeNotified ? 1 : 0
        );
        for (const [day, count] of Object.entries(user.days || {})) {
          insertDay.run(guildId, userId, day, Number(count) || 0);
        }
      }
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function rowToUser(row, days) {
  return {
    name: row.name || undefined,
    days,
    challengeDayKey: row.challenge_cycle_key || '',
    challengeCount: Number(row.challenge_count) || 0,
    challengeNotified: Boolean(row.challenge_notified),
    lastLucyAcceptedAt: row.last_lucy_accepted_at == null ? undefined : Number(row.last_lucy_accepted_at)
  };
}

function getLastAcceptedAt(guildId, userId) {
  const row = getDb().prepare('SELECT last_lucy_accepted_at FROM lucy_users WHERE guild_id = ? AND user_id = ?').get(guildId, userId);
  return row?.last_lucy_accepted_at == null ? 0 : Number(row.last_lucy_accepted_at);
}

function getGuildData(guildId) {
  const database = getDb();
  const users = {};
  const userRows = database.prepare('SELECT * FROM lucy_users WHERE guild_id = ?').all(guildId);
  const dayRows = database.prepare('SELECT user_id, day, count FROM lucy_daily WHERE guild_id = ?').all(guildId);
  const daysByUser = new Map();
  for (const row of dayRows) {
    if (!daysByUser.has(row.user_id)) daysByUser.set(row.user_id, {});
    daysByUser.get(row.user_id)[row.day] = Number(row.count) || 0;
  }
  for (const row of userRows) users[row.user_id] = rowToUser(row, daysByUser.get(row.user_id) || {});
  return { users };
}

function getAllData() {
  const database = getDb();
  const all = {};
  const userRows = database.prepare('SELECT * FROM lucy_users').all();
  const dayRows = database.prepare('SELECT guild_id, user_id, day, count FROM lucy_daily').all();
  const daysByUser = new Map();
  for (const row of dayRows) {
    const key = row.guild_id + '\u0000' + row.user_id;
    if (!daysByUser.has(key)) daysByUser.set(key, {});
    daysByUser.get(key)[row.day] = Number(row.count) || 0;
  }
  for (const row of userRows) {
    all[row.guild_id] ||= { users: {} };
    all[row.guild_id].users[row.user_id] = rowToUser(row, daysByUser.get(row.guild_id + '\u0000' + row.user_id) || {});
  }
  return all;
}

function ensureUser(database, guildId, userId, name) {
  database.prepare(`
    INSERT INTO lucy_users (guild_id, user_id, name) VALUES (?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET name = COALESCE(excluded.name, lucy_users.name)`)
    .run(guildId, userId, name || null);
}

// Catat waktu Lucy terakhir diterima untuk cooldown per anggota.
function markAccepted(guildId, userId, name, timestamp) {
  const database = getDb();
  ensureUser(database, guildId, userId, name);
  database.prepare('UPDATE lucy_users SET last_lucy_accepted_at = ? WHERE guild_id = ? AND user_id = ?')
    .run(timestamp, guildId, userId);
}

// Atomik: naikkan hitungan harian, kelola reset siklus target, dan tandai
// notifikasi tercapai. Mengembalikan progres siklus terbaru.
function recordLucy({ guildId, userId, name, day, cycleKey, targetActive, goal }) {
  const database = getDb();
  database.exec('BEGIN IMMEDIATE');
  try {
    ensureUser(database, guildId, userId, name);
    database.prepare(`
      INSERT INTO lucy_daily (guild_id, user_id, day, count) VALUES (?, ?, ?, 1)
      ON CONFLICT(guild_id, user_id, day) DO UPDATE SET count = count + 1`)
      .run(guildId, userId, day);
    const row = database.prepare('SELECT challenge_cycle_key, challenge_count, challenge_notified FROM lucy_users WHERE guild_id = ? AND user_id = ?').get(guildId, userId);
    let cycle = row.challenge_cycle_key || '';
    let count = Number(row.challenge_count) || 0;
    let notified = Number(row.challenge_notified) || 0;
    if (cycle !== cycleKey) { cycle = cycleKey; count = 0; notified = 0; }
    if (targetActive) count += 1;
    let notifiedNow = false;
    if (targetActive && goal > 0 && count >= goal && !notified) { notified = 1; notifiedNow = true; }
    database.prepare('UPDATE lucy_users SET challenge_cycle_key = ?, challenge_count = ?, challenge_notified = ? WHERE guild_id = ? AND user_id = ?')
      .run(cycle, count, notified, guildId, userId);
    // Simpan juga ke riwayat per siklus agar leaderboard target per tanggal
    // tetap bisa dibaca setelah siklus berganti.
    if (targetActive) {
      database.prepare(`
        INSERT INTO lucy_target_daily (guild_id, user_id, cycle_key, count) VALUES (?, ?, ?, 1)
        ON CONFLICT(guild_id, user_id, cycle_key) DO UPDATE SET count = count + 1`)
        .run(guildId, userId, cycleKey);
    }
    database.exec('COMMIT');
    return { challengeCount: count, notifiedNow };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

// Reset progres target anggota saat siklus baru dimulai (dipakai perintah status).
function resetChallenge(guildId, userId, name, cycleKey) {
  const database = getDb();
  ensureUser(database, guildId, userId, name);
  database.prepare('UPDATE lucy_users SET challenge_cycle_key = ?, challenge_count = 0, challenge_notified = 0 WHERE guild_id = ? AND user_id = ?')
    .run(cycleKey, guildId, userId);
}

// Progres Target Lucy untuk satu siklus dari riwayat (lucy_target_daily),
// dipakai leaderboard target per tanggal setelah siklusnya berganti. Bentuk
// barisnya disamakan dengan state user agar bisa dipakai targetRanking apa adanya.
function getTargetCounts(guildId, cycleKey) {
  const rows = getDb().prepare(`
    SELECT t.user_id, t.count, u.name
    FROM lucy_target_daily t
    LEFT JOIN lucy_users u ON u.guild_id = t.guild_id AND u.user_id = t.user_id
    WHERE t.guild_id = ? AND t.cycle_key = ?`).all(guildId, String(cycleKey));
  const users = {};
  for (const row of rows) {
    users[row.user_id] = {
      name: row.name || undefined,
      challengeDayKey: String(cycleKey),
      challengeCount: Number(row.count) || 0
    };
  }
  return { users };
}

module.exports = { getDb, getGuildData, getAllData, getLastAcceptedAt, markAccepted, recordLucy, resetChallenge, getTargetCounts };
