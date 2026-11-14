// Aksi Lucy (pray, curse, battle, hunt) + preferensi reminder.
//
// Kategori "Lucy" TIDAK disimpan di sini: penghitung Lucy sudah ada di
// lucyCounterStorage (tabel lucy_daily) sejak fitur Target Lucy, jadi leaderboard
// kategori Lucy membaca dari sana supaya tidak ada dua hitungan untuk hal yang sama.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

let db = null;
let dbPath = null;

// Aksi yang dicatat modul ini, beserta grupnya. `battle` dan `hunt` digabung
// menjadi satu kategori leaderboard ("battle/hunt") sesuai daftar kategori.
const ACTIONS = {
  pray: { group: 'pray', label: 'Pray' },
  curse: { group: 'curse', label: 'Curse' },
  battle: { group: 'battle', label: 'Battle' },
  hunt: { group: 'battle', label: 'Hunt' }
};
// Kategori leaderboard -> daftar aksi. `lucy` ditangani terpisah (sumbernya
// lucyCounterStorage), jadi tidak ada di sini.
const GROUPS = {
  pray: ['pray'],
  curse: ['curse'],
  battle: ['battle', 'hunt']
};

function paths() {
  const dir = path.resolve(process.cwd(), 'data');
  return { dir, dbFile: path.join(dir, 'lucy-actions.db') };
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
    CREATE TABLE IF NOT EXISTS lucy_action_users (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS lucy_action_daily (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      day TEXT NOT NULL,
      action TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id, day, action)
    );
    -- Waktu (epoch ms) aksi boleh dilakukan lagi. Dipakai sebagai penentu
    -- cooldown yang otoritatif; timer notifikasi hanya di memori.
    CREATE TABLE IF NOT EXISTS lucy_action_cooldowns (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      ready_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, user_id, action)
    );
    -- Preferensi reminder per orang per jenis: on/off + cara ping.
    -- TANPA guild_id: pengaturan berlaku global di semua server, sesuai
    -- permintaan (anggota mengatur sekali, berlaku di mana pun ia bermain).
    CREATE TABLE IF NOT EXISTS lucy_reminder_prefs_global (
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      ping_mode TEXT NOT NULL DEFAULT 'tag',
      PRIMARY KEY (user_id, kind)
    );
  `);
  return db;
}

function ensureUser(database, guildId, userId, name) {
  database.prepare(`
    INSERT INTO lucy_action_users (guild_id, user_id, name) VALUES (?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET name = COALESCE(excluded.name, lucy_action_users.name)`)
    .run(String(guildId), String(userId), name || null);
}

function recordAction({ guildId, userId, name, day, action }) {
  if (!guildId || !userId || !day || !ACTIONS[action]) return;
  const database = getDb();
  database.exec('BEGIN IMMEDIATE');
  try {
    ensureUser(database, guildId, userId, name);
    database.prepare(`
      INSERT INTO lucy_action_daily (guild_id, user_id, day, action, count) VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(guild_id, user_id, day, action) DO UPDATE SET count = count + 1`)
      .run(String(guildId), String(userId), String(day), action);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function getCooldown(guildId, userId, action) {
  const row = getDb().prepare(
    'SELECT ready_at FROM lucy_action_cooldowns WHERE guild_id = ? AND user_id = ? AND action = ?'
  ).get(String(guildId), String(userId), String(action));
  return row ? Number(row.ready_at) : 0;
}

function setCooldown(guildId, userId, action, readyAt) {
  getDb().prepare(`
    INSERT INTO lucy_action_cooldowns (guild_id, user_id, action, ready_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id, user_id, action) DO UPDATE SET ready_at = excluded.ready_at`)
    .run(String(guildId), String(userId), String(action), Number(readyAt) || 0);
}

function getPrefs(userId) {
  const rows = getDb().prepare(
    'SELECT kind, enabled, ping_mode FROM lucy_reminder_prefs_global WHERE user_id = ?'
  ).all(String(userId));
  const prefs = {};
  for (const row of rows) prefs[row.kind] = { enabled: Boolean(row.enabled), pingMode: row.ping_mode };
  return prefs;
}

// Preferensi default (dipakai bila anggota belum pernah mengatur): nyala, ping tag.
function getPref(userId, kind, fallback = { enabled: true, pingMode: 'tag' }) {
  const row = getDb().prepare(
    'SELECT enabled, ping_mode FROM lucy_reminder_prefs_global WHERE user_id = ? AND kind = ?'
  ).get(String(userId), String(kind));
  if (!row) return { ...fallback };
  return { enabled: Boolean(row.enabled), pingMode: row.ping_mode };
}

function setPref(userId, kind, { enabled, pingMode } = {}) {
  const current = getPref(userId, kind);
  const nextEnabled = enabled === undefined ? current.enabled : Boolean(enabled);
  const nextMode = pingMode === undefined ? current.pingMode : String(pingMode);
  getDb().prepare(`
    INSERT INTO lucy_reminder_prefs_global (user_id, kind, enabled, ping_mode) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, kind) DO UPDATE SET enabled = excluded.enabled, ping_mode = excluded.ping_mode`)
    .run(String(userId), String(kind), nextEnabled ? 1 : 0, nextMode);
  return { enabled: nextEnabled, pingMode: nextMode };
}

function rowsToRanking(rows) {
  return rows.map(r => ({ userId: r.user_id, name: r.name || undefined, count: Number(r.count) || 0 }));
}

const SELECT = `
  SELECT s.user_id, u.name, SUM(s.count) AS count
  FROM lucy_action_daily s LEFT JOIN lucy_action_users u
    ON u.guild_id = s.guild_id AND u.user_id = s.user_id`;

function inClause(actions) {
  return actions.map(() => '?').join(', ');
}

function topByDay(guildId, day, actions) {
  return rowsToRanking(getDb().prepare(SELECT + `
    WHERE s.guild_id = ? AND s.day = ? AND s.action IN (${inClause(actions)})
    GROUP BY s.user_id ORDER BY count DESC, u.name ASC`)
    .all(String(guildId), String(day), ...actions));
}

function topByRange(guildId, fromDay, toDay, actions) {
  return rowsToRanking(getDb().prepare(SELECT + `
    WHERE s.guild_id = ? AND s.day BETWEEN ? AND ? AND s.action IN (${inClause(actions)})
    GROUP BY s.user_id ORDER BY count DESC, u.name ASC`)
    .all(String(guildId), String(fromDay), String(toDay), ...actions));
}

function topAllTime(guildId, actions) {
  return rowsToRanking(getDb().prepare(SELECT + `
    WHERE s.guild_id = ? AND s.action IN (${inClause(actions)})
    GROUP BY s.user_id ORDER BY count DESC, u.name ASC`)
    .all(String(guildId), ...actions));
}

// Peringkat lintas server, untuk leaderboard global.
function topByRangeAll(fromDay, toDay, actions) {
  return rowsToRanking(getDb().prepare(`
    SELECT s.user_id, MAX(u.name) AS name, SUM(s.count) AS count
    FROM lucy_action_daily s LEFT JOIN lucy_action_users u
      ON u.guild_id = s.guild_id AND u.user_id = s.user_id
    WHERE s.day BETWEEN ? AND ? AND s.action IN (${inClause(actions)})
    GROUP BY s.user_id ORDER BY count DESC, name ASC`)
    .all(String(fromDay), String(toDay), ...actions));
}

function topAllTimeAll(actions) {
  return rowsToRanking(getDb().prepare(`
    SELECT s.user_id, MAX(u.name) AS name, SUM(s.count) AS count
    FROM lucy_action_daily s LEFT JOIN lucy_action_users u
      ON u.guild_id = s.guild_id AND u.user_id = s.user_id
    WHERE s.action IN (${inClause(actions)})
    GROUP BY s.user_id ORDER BY count DESC, name ASC`)
    .all(...actions));
}

// Total per hari untuk satu anggota (dipakai ringkasan pribadi).
function userTotal(guildId, userId, fromDay, toDay, actions) {
  const row = getDb().prepare(`
    SELECT SUM(count) AS count FROM lucy_action_daily
    WHERE guild_id = ? AND user_id = ? AND day BETWEEN ? AND ? AND action IN (${inClause(actions)})`)
    .get(String(guildId), String(userId), String(fromDay), String(toDay), ...actions);
  return Number(row?.count) || 0;
}

function resetGuild(guildId) {
  const database = getDb();
  for (const table of ['lucy_action_daily', 'lucy_action_cooldowns', 'lucy_action_users']) {
    database.prepare(`DELETE FROM ${table} WHERE guild_id = ?`).run(String(guildId));
  }
}

module.exports = {
  getDb, recordAction, getCooldown, setCooldown, getPrefs, getPref, setPref,
  topByDay, topByRange, topAllTime, topByRangeAll, topAllTimeAll, userTotal, resetGuild, ACTIONS, GROUPS
};
