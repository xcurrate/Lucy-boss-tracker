// Skor Matematika Cepat Tepat.
//
// Tabel terpisah dari Family 100 supaya leaderboard kedua game tidak tercampur.
// Skemanya sengaja meniru family100Storage (poin harian + agregasi rentang),
// dengan tambahan best_ms untuk mencatat waktu tercepat menjawab.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

let db = null;
let dbPath = null;

function paths() {
  const dir = path.resolve(process.cwd(), 'data');
  return { dir, dbFile: path.join(dir, 'math-race.db') };
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
    CREATE TABLE IF NOT EXISTS math_users (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS math_scores (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      day TEXT NOT NULL,
      points INTEGER NOT NULL DEFAULT 0,
      correct INTEGER NOT NULL DEFAULT 0,
      best_ms INTEGER,
      PRIMARY KEY (guild_id, user_id, day)
    );
  `);
  return db;
}

function addPoints({ guildId, userId, name, points, correct = 1, ms = null, day }) {
  if (!guildId || !userId || !day) return;
  const d = getDb();
  d.prepare(`
    INSERT INTO math_users (guild_id, user_id, name) VALUES (?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET name = COALESCE(excluded.name, math_users.name)`)
    .run(String(guildId), String(userId), name || null);
  const msValue = Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : null;
  d.prepare(`
    INSERT INTO math_scores (guild_id, user_id, day, points, correct, best_ms) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, user_id, day) DO UPDATE SET
      points = points + excluded.points,
      correct = correct + excluded.correct,
      best_ms = CASE
        WHEN excluded.best_ms IS NULL THEN math_scores.best_ms
        WHEN math_scores.best_ms IS NULL THEN excluded.best_ms
        ELSE MIN(math_scores.best_ms, excluded.best_ms) END`)
    .run(String(guildId), String(userId), String(day), Number(points) || 0, Number(correct) || 0, msValue);
}

function rowsToRanking(rows) {
  return rows.map(r => ({
    userId: r.user_id,
    name: r.name || undefined,
    points: Number(r.points) || 0,
    correct: Number(r.correct) || 0,
    bestMs: r.best_ms === null || r.best_ms === undefined ? null : Number(r.best_ms)
  }));
}

const SELECT = `
  SELECT s.user_id, u.name, SUM(s.points) AS points, SUM(s.correct) AS correct, MIN(s.best_ms) AS best_ms
  FROM math_scores s LEFT JOIN math_users u
    ON u.guild_id = s.guild_id AND u.user_id = s.user_id`;

function topByDay(guildId, day) {
  return rowsToRanking(getDb().prepare(SELECT + `
    WHERE s.guild_id = ? AND s.day = ?
    GROUP BY s.user_id ORDER BY points DESC, u.name ASC`).all(String(guildId), String(day)));
}

// Rentang hari inklusif, mis. '2026-11-02'..'2026-11-08'.
function topByRange(guildId, fromDay, toDay) {
  return rowsToRanking(getDb().prepare(SELECT + `
    WHERE s.guild_id = ? AND s.day BETWEEN ? AND ?
    GROUP BY s.user_id ORDER BY points DESC, u.name ASC`).all(String(guildId), String(fromDay), String(toDay)));
}

function topAllTime(guildId) {
  return rowsToRanking(getDb().prepare(SELECT + `
    WHERE s.guild_id = ?
    GROUP BY s.user_id ORDER BY points DESC, u.name ASC`).all(String(guildId)));
}

function resetGuild(guildId) {
  const d = getDb();
  d.prepare('DELETE FROM math_scores WHERE guild_id = ?').run(String(guildId));
  d.prepare('DELETE FROM math_users WHERE guild_id = ?').run(String(guildId));
}

module.exports = { getDb, addPoints, topByDay, topByRange, topAllTime, resetGuild };
