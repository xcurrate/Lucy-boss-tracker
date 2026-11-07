const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

let db = null;
let dbPath = null;

function paths() {
  const dir = path.resolve(process.cwd(), 'data');
  return { dir, dbFile: path.join(dir, 'family100.db') };
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
    CREATE TABLE IF NOT EXISTS family100_users (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT,
      PRIMARY KEY (guild_id, user_id)
    );
    -- Poin per pemain per hari (WIB). Leaderboard mingguan dihitung dengan
    -- menjumlahkan rentang 7 hari, jadi tidak perlu tabel mingguan terpisah.
    CREATE TABLE IF NOT EXISTS family100_scores (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      day TEXT NOT NULL,
      points INTEGER NOT NULL DEFAULT 0,
      correct INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id, day)
    );
  `);
  return db;
}

function addPoints({ guildId, userId, name, points, correct = 1, day }) {
  if (!guildId || !userId || !day) return;
  const d = getDb();
  d.prepare(`
    INSERT INTO family100_users (guild_id, user_id, name) VALUES (?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET name = COALESCE(excluded.name, family100_users.name)`)
    .run(String(guildId), String(userId), name || null);
  d.prepare(`
    INSERT INTO family100_scores (guild_id, user_id, day, points, correct) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, user_id, day) DO UPDATE SET
      points = points + excluded.points,
      correct = correct + excluded.correct`)
    .run(String(guildId), String(userId), String(day), Number(points) || 0, Number(correct) || 0);
}

function rowsToRanking(rows) {
  return rows.map(r => ({ userId: r.user_id, name: r.name || undefined, points: Number(r.points) || 0, correct: Number(r.correct) || 0 }));
}

function topByDay(guildId, day) {
  return rowsToRanking(getDb().prepare(`
    SELECT s.user_id, u.name, s.points, s.correct
    FROM family100_scores s LEFT JOIN family100_users u
      ON u.guild_id = s.guild_id AND u.user_id = s.user_id
    WHERE s.guild_id = ? AND s.day = ?
    ORDER BY s.points DESC, u.name ASC`).all(String(guildId), String(day)));
}

// Rentang minggu inklusif, mis. '2026-11-02'..'2026-11-08'.
function topByRange(guildId, fromDay, toDay) {
  return rowsToRanking(getDb().prepare(`
    SELECT s.user_id, u.name, SUM(s.points) AS points, SUM(s.correct) AS correct
    FROM family100_scores s LEFT JOIN family100_users u
      ON u.guild_id = s.guild_id AND u.user_id = s.user_id
    WHERE s.guild_id = ? AND s.day BETWEEN ? AND ?
    GROUP BY s.user_id
    ORDER BY points DESC, u.name ASC`).all(String(guildId), String(fromDay), String(toDay)));
}

function topAllTime(guildId) {
  return rowsToRanking(getDb().prepare(`
    SELECT s.user_id, u.name, SUM(s.points) AS points, SUM(s.correct) AS correct
    FROM family100_scores s LEFT JOIN family100_users u
      ON u.guild_id = s.guild_id AND u.user_id = s.user_id
    WHERE s.guild_id = ?
    GROUP BY s.user_id
    ORDER BY points DESC, u.name ASC`).all(String(guildId)));
}

function resetGuild(guildId) {
  const d = getDb();
  d.prepare('DELETE FROM family100_scores WHERE guild_id = ?').run(String(guildId));
  d.prepare('DELETE FROM family100_users WHERE guild_id = ?').run(String(guildId));
}

module.exports = { getDb, addPoints, topByDay, topByRange, topAllTime, resetGuild };
