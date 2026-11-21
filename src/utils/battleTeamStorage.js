// Penyimpanan tim kustom untuk simulasi battle.
//
// Satu tim = satu baris `teams`; isi slot ada di `team_slots` (maks 3 per tim,
// mengikuti batas OwO). Tim bersifat global per user: tim yang sama dipakai di
// server mana pun. Kolom `guild_id` masih ada demi kompatibilitas skema lama,
// tetapi selalu diisi string kosong dan tidak pernah dipakai untuk memfilter.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const dexStore = require('./animalDexStorage');

const MAX_SLOTS = 3;
// ID tim 1-21 sekaligus menjadi batas jumlah tim per user.
const MAX_TEAM_ID = 21;
const MAX_TEAMS = MAX_TEAM_ID;

// Semua tim disimpan pada satu lingkup global; kolom `guild_id` hanya diisi
// nilai ini supaya skema lama tetap valid.
const GLOBAL_SCOPE = '';

let db = null;
let dbPath = null;

function paths() {
  const dir = path.resolve(process.cwd(), 'data');
  return { dir, dbFile: path.join(dir, 'battle-teams.db') };
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
    CREATE TABLE IF NOT EXISTS teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      slot_id INTEGER,
      created_at INTEGER,
      updated_at INTEGER,
      UNIQUE (guild_id, user_id, name_key)
    );
    CREATE TABLE IF NOT EXISTS team_slots (
      team_id INTEGER NOT NULL,
      slot INTEGER NOT NULL,
      label TEXT,
      animal_key TEXT,
      custom_hp INTEGER, custom_att INTEGER, custom_pr INTEGER,
      custom_wp INTEGER, custom_mag INTEGER, custom_mr INTEGER,
      final_hp INTEGER, final_att INTEGER, final_pr INTEGER,
      final_wp INTEGER, final_mag INTEGER, final_mr INTEGER,
      level INTEGER NOT NULL DEFAULT 1,
      weapon_id INTEGER,
      weapon_quality INTEGER,
      passives TEXT,
      PRIMARY KEY (team_id, slot),
      FOREIGN KEY (team_id) REFERENCES teams (id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS team_import_messages (
      source_message_id TEXT PRIMARY KEY,
      guild_id TEXT,
      channel_id TEXT,
      discovered_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS team_imports (
      user_id TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      team_name TEXT NOT NULL,
      imported_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, source_message_id)
    );
    CREATE TABLE IF NOT EXISTS active_team (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      team_id INTEGER,
      PRIMARY KEY (guild_id, user_id)
    );
    -- Cooldown perintah simulasi, per user dan per aksi. Disimpan di database
    -- supaya tetap berlaku setelah bot restart, bukan hanya di memori.
    CREATE TABLE IF NOT EXISTS command_cooldowns (
      user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      ready_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, action)
    );
  `);
  try { db.exec('ALTER TABLE teams ADD COLUMN slot_id INTEGER'); } catch {}
  for (const column of [
    'final_hp INTEGER', 'final_att INTEGER', 'final_pr INTEGER',
    'final_wp INTEGER', 'final_mag INTEGER', 'final_mr INTEGER',
  ]) {
    try { db.exec(`ALTER TABLE team_slots ADD COLUMN ${column}`); } catch {}
  }
  migrateToGlobal(db);
  backfillSlotIds();
  backfillAnimalKeys();
  return db;
}

// Slot lama (dibuat sebelum `animalKey` disimpan, termasuk import tim Lucy versi
// awal) hanya punya label. Kalau labelnya kebetulan nama hewan di dex, kuncinya
// diisi supaya panel menampilkan emoji pet, bukan 🐾. Label yang berupa nama
// panggilan tidak cocok dan dibiarkan apa adanya.
function backfillAnimalKeys() {
  const rows = getDb().prepare(`
    SELECT s.team_id, s.slot, s.label FROM team_slots s
    WHERE s.animal_key IS NULL AND s.label IS NOT NULL
  `).all();
  if (!rows.length) return 0;
  const update = getDb().prepare('UPDATE team_slots SET animal_key = ?, label = ? WHERE team_id = ? AND slot = ?');
  let filled = 0;
  for (const row of rows) {
    // Import versi lama menyimpan token emoji mentah sebagai label. Nama di
    // dalam token dipakai sebagai petunjuk hewan sekaligus label yang terbaca.
    const tokenName = (/<a?:(\w+):\d+>/.exec(row.label) || [])[1] || null;
    const cleaned = row.label.replace(/<a?:\w+:\d+>/g, '').trim() || tokenName;
    if (!cleaned) continue;
    const animal = dexStore.resolveAnimal(cleaned) || (tokenName ? dexStore.resolveAnimal(tokenName) : null);
    const animalKey = animal ? animal.nameKey : null;
    const label = cleaned === row.label ? row.label : cleaned;
    if (animalKey) filled++;
    if (label !== row.label || animalKey) update.run(animalKey, label, row.team_id, row.slot);
  }
  return filled;
}

// Tim dulu dipisah per guild. Saat pertama kali dibuka, satukan baris lama:
// untuk tiap user+nama dipilih satu tim (yang paling baru diperbarui), tim lain
// dibuang beserta slotnya, lalu semua baris ditandai lingkup global.
function migrateToGlobal(database) {
  const legacy = database.prepare('SELECT COUNT(*) AS n FROM teams WHERE guild_id <> ?').get(GLOBAL_SCOPE).n;
  if (!legacy) return;
  database.exec('BEGIN');
  try {
    const duplicates = database.prepare(`
      SELECT user_id, name_key, MAX(id) AS keep_id
      FROM teams GROUP BY user_id, name_key HAVING COUNT(*) > 1
    `).all();
    for (const { user_id, name_key, keep_id } of duplicates) {
      const losers = database.prepare('SELECT id FROM teams WHERE user_id = ? AND name_key = ? AND id <> ?')
        .all(user_id, name_key, keep_id).map(r => r.id);
      for (const id of losers) {
        database.prepare('DELETE FROM team_slots WHERE team_id = ?').run(id);
        database.prepare('DELETE FROM active_team WHERE team_id = ?').run(id);
        database.prepare('DELETE FROM teams WHERE id = ?').run(id);
      }
    }
    database.prepare('UPDATE teams SET guild_id = ? WHERE guild_id <> ?').run(GLOBAL_SCOPE, GLOBAL_SCOPE);

    // Satu baris active_team per user: pertahankan yang menunjuk tim hidup.
    const actives = database.prepare('SELECT rowid, user_id, team_id FROM active_team ORDER BY rowid').all();
    const seen = new Set();
    for (const row of actives) {
      const alive = database.prepare('SELECT 1 FROM teams WHERE id = ?').get(row.team_id);
      if (!alive || seen.has(row.user_id)) {
        database.prepare('DELETE FROM active_team WHERE rowid = ?').run(row.rowid);
        continue;
      }
      seen.add(row.user_id);
      database.prepare('UPDATE active_team SET guild_id = ? WHERE rowid = ?').run(GLOBAL_SCOPE, row.rowid);
    }
    database.exec('COMMIT');
  } catch (e) {
    database.exec('ROLLBACK');
    throw e;
  }
}

function normalizeName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').slice(0, 32);
}

function keyOf(name) {
  return normalizeName(name).toLowerCase();
}

function rowToSlot(row) {
  const custom = row.custom_hp != null
    ? { hp: row.custom_hp, att: row.custom_att, pr: row.custom_pr, wp: row.custom_wp, mag: row.custom_mag, mr: row.custom_mr }
    : null;
  let passives = null;
  if (row.passives) { try { passives = JSON.parse(row.passives); } catch {} }
  const finalStats = row.final_hp != null
    ? { hp: row.final_hp, att: row.final_att, pr: row.final_pr, wp: row.final_wp, mag: row.final_mag, mr: row.final_mr }
    : null;
  return {
    slot: row.slot,
    label: row.label,
    finalStats,
    animalKey: row.animal_key,
    custom,
    level: row.level || 1,
    weaponId: row.weapon_id,
    weaponQuality: row.weapon_quality,
    passives,
  };
}

function rowToTeam(row, slots = []) {
  return {
    id: row.id,
    slotId: row.slot_id ?? null,
    guildId: row.guild_id,
    userId: row.user_id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    slots: slots.sort((a, b) => a.slot - b.slot),
  };
}

function listTeams(userId) {
  const rows = getDb().prepare(
    'SELECT * FROM teams WHERE user_id = ? ORDER BY name COLLATE NOCASE'
  ).all(String(userId));
  return rows.map(row => rowToTeam(row, loadSlots(row.id)));
}

function loadSlots(teamId) {
  return getDb().prepare('SELECT * FROM team_slots WHERE team_id = ? ORDER BY slot').all(teamId).map(rowToSlot);
}

function getTeam(userId, name) {
  const row = getDb().prepare(
    'SELECT * FROM teams WHERE user_id = ? AND name_key = ?'
  ).get(String(userId), keyOf(name));
  if (!row) return null;
  return rowToTeam(row, loadSlots(row.id));
}

function getTeamById(teamId) {
  const row = getDb().prepare('SELECT * FROM teams WHERE id = ?').get(Number(teamId));
  if (!row) return null;
  return rowToTeam(row, loadSlots(row.id));
}

function countTeams(userId) {
  return getDb().prepare('SELECT COUNT(*) AS n FROM teams WHERE user_id = ?')
    .get(String(userId)).n;
}

// Semua tim milik semua user. Dipakai simulasi global yang mengadu satu tim
// melawan seluruh tim tersimpan; tim tanpa slot tetap ikut terambil lalu
// dibuang pemanggil karena tidak bisa dipertarungkan.
function listAllTeams() {
  const rows = getDb().prepare('SELECT * FROM teams ORDER BY user_id, slot_id, id').all();
  return rows.map(row => rowToTeam(row, loadSlots(row.id)));
}

// Tim yang bisa dipakai sebagai lawan: semua tim berisi slot, termasuk tim
// lain milik user sendiri. Hanya tim yang sedang dipakai bertarung yang
// dikecualikan supaya tidak mengadu tim dengan dirinya sendiri.
function listOpponentTeams(userId, activeTeamId = null) {
  return listAllTeams().filter(team => team.id !== activeTeamId && team.slots.length);
}

// ID tim 1..MAX_TEAM_ID milik satu user. ID bebas terkecil dipakai lebih dulu,
// jadi menghapus tim benar-benar mengosongkan slot ID-nya.
function usedSlotIds(userId) {
  const rows = getDb().prepare('SELECT slot_id FROM teams WHERE user_id = ?').all(String(userId));
  return new Set(rows.map(row => row.slot_id).filter(id => id != null));
}

function nextFreeSlotId(userId) {
  const used = usedSlotIds(userId);
  for (let id = 1; id <= MAX_TEAM_ID; id++) if (!used.has(id)) return id;
  return null;
}

// `normalizeName` memotong ke 32 karakter, jadi menambah sufiks di belakang nama
// yang sudah penuh menghasilkan nama yang identik lagi dan pencarian berikutnya
// tidak pernah selesai. Sufiks dipotong dari nama dasar dulu agar hasilnya beda.
function uniqueName(userId, desired, limit = 50) {
  const base = normalizeName(desired);
  if (!base) return null;
  if (!getTeam(userId, base)) return base;
  for (let suffix = 2; suffix <= limit; suffix++) {
    const tag = ` ${suffix}`;
    const candidate = normalizeName(base.slice(0, 32 - tag.length) + tag);
    if (candidate !== base && !getTeam(userId, candidate)) return candidate;
  }
  return null;
}

function createTeam(userId, name) {
  const clean = normalizeName(name);
  if (!clean) return { error: 'Nama tim tidak boleh kosong.' };
  if (countTeams(userId) >= MAX_TEAMS) {
    return { error: `Semua slot ID 1-${MAX_TEAM_ID} sudah terpakai. Hapus salah satu tim dulu dengan \`d team del <id>\`.` };
  }
  if (getTeam(userId, clean)) return { error: `Tim **${clean}** sudah ada.` };
  const slotId = nextFreeSlotId(userId);
  if (slotId == null) return { error: `Semua slot ID 1-${MAX_TEAM_ID} sudah terpakai.` };
  const now = Date.now();
  const info = getDb().prepare(
    'INSERT INTO teams (guild_id, user_id, name, name_key, slot_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(GLOBAL_SCOPE, String(userId), clean, keyOf(clean), slotId, now, now);
  return { team: getTeamById(info.lastInsertRowid) };
}

// Tim hasil `d team new` sebelum ada ID diberi nomor urut sekali saja.
function backfillSlotIds() {
  const rows = getDb().prepare(
    'SELECT id, user_id FROM teams WHERE slot_id IS NULL ORDER BY user_id, id'
  ).all();
  if (!rows.length) return 0;
  const used = new Map();
  const touchId = getDb().prepare('UPDATE teams SET slot_id = ? WHERE id = ?');
  for (const row of rows) {
    if (!used.has(row.user_id)) used.set(row.user_id, usedSlotIds(row.user_id));
    const set = used.get(row.user_id);
    const free = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]
      .find(id => !set.has(id));
    if (free == null) continue;
    touchId.run(free, row.id);
    set.add(free);
  }
  return rows.length;
}

// Mencari tim berdasarkan ID (angka) atau nama. ID dicoba lebih dulu supaya
// tim bernama "3" tetap bisa dipilih lewat namanya bila ada tim ber-ID 3.
function findTeam(userId, query) {
  const text = String(query == null ? '' : query).trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const byId = getDb().prepare(
      'SELECT * FROM teams WHERE user_id = ? AND slot_id = ?'
    ).get(String(userId), Number(text));
    if (byId) return rowToTeam(byId, loadSlots(byId.id));
  }
  return getTeam(userId, text);
}

function isSlotIdTaken(userId, slotId, exceptTeamId = null) {
  const row = getDb().prepare(
    'SELECT id FROM teams WHERE user_id = ? AND slot_id = ? AND id <> ?'
  ).get(String(userId), Number(slotId), exceptTeamId == null ? -1 : Number(exceptTeamId));
  return Boolean(row);
}

function renameTeam(userId, from, to) {
  const team = findTeam(userId, from);
  if (!team) return { error: `Tim **${from}** tidak ditemukan.` };
  const clean = normalizeName(to);
  if (!clean) return { error: 'Nama baru tidak boleh kosong.' };
  if (getTeam(userId, clean)) return { error: `Tim **${clean}** sudah ada.` };
  getDb().prepare('UPDATE teams SET name = ?, name_key = ?, updated_at = ? WHERE id = ?')
    .run(clean, keyOf(clean), Date.now(), team.id);
  return { team: getTeamById(team.id) };
}

function deleteTeam(userId, name) {
  const team = findTeam(userId, name);
  if (!team) return { error: `Tim **${name}** tidak ditemukan.` };
  const d = getDb();
  d.prepare('DELETE FROM team_slots WHERE team_id = ?').run(team.id);
  d.prepare('DELETE FROM teams WHERE id = ?').run(team.id);
  d.prepare('DELETE FROM active_team WHERE team_id = ?').run(team.id);
  // Catatan import ikut dihapus, kalau tidak kartu sumbernya dianggap sudah
  // pernah diimpor dan tidak bisa dipakai lagi setelah timnya dibuang.
  d.prepare('DELETE FROM team_imports WHERE user_id = ? AND team_name = ?').run(String(userId), team.name);
  return { team };
}

// Menulis satu slot. `slot` 1..MAX_SLOTS. Data hewan bisa dari dex (`animalKey`)
// atau stat manual (`custom`), tidak keduanya.
function setSlot(userId, teamName, slot, data) {
  const team = findTeam(userId, teamName);
  if (!team) return { error: `Tim **${teamName}** tidak ditemukan.` };
  const index = Number(slot);
  if (!Number.isInteger(index) || index < 1 || index > MAX_SLOTS) {
    return { error: `Slot harus 1-${MAX_SLOTS}.` };
  }
  const custom = data.custom || null;
  if (!data.animalKey && !custom && !data.finalStats) return { error: 'Isi nama hewan dex atau stat manual.' };
  // `animalKey` + `finalStats` memang berpasangan: import tim Lucy menyimpan
  // hewan (untuk emoji/nama) sekaligus stat tampilan kartu (yang sudah final,
  // termasuk senjata). Hanya `custom` yang eksklusif terhadap keduanya.
  if (custom && (data.animalKey || data.finalStats)) {
    return { error: 'Pilih satu format stat: hewan, stat manual, atau stat import.' };
  }

  const level = Math.max(1, Math.min(1000, Number(data.level) || 1));
  const passives = Array.isArray(data.passives) ? JSON.stringify(data.passives) : null;
  getDb().prepare(`
    INSERT INTO team_slots
      (team_id, slot, label, animal_key, custom_hp, custom_att, custom_pr, custom_wp, custom_mag, custom_mr,
       final_hp, final_att, final_pr, final_wp, final_mag, final_mr,
       level, weapon_id, weapon_quality, passives)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(team_id, slot) DO UPDATE SET
      label = excluded.label, animal_key = excluded.animal_key,
      custom_hp = excluded.custom_hp, custom_att = excluded.custom_att, custom_pr = excluded.custom_pr,
      custom_wp = excluded.custom_wp, custom_mag = excluded.custom_mag, custom_mr = excluded.custom_mr,
      final_hp = excluded.final_hp, final_att = excluded.final_att, final_pr = excluded.final_pr,
      final_wp = excluded.final_wp, final_mag = excluded.final_mag, final_mr = excluded.final_mr,
      level = excluded.level, weapon_id = excluded.weapon_id,
      weapon_quality = excluded.weapon_quality, passives = excluded.passives
  `).run(
    team.id, index, data.label || null, data.animalKey || null,
    custom ? custom.hp : null, custom ? custom.att : null, custom ? custom.pr : null,
    custom ? custom.wp : null, custom ? custom.mag : null, custom ? custom.mr : null,
    data.finalStats?.hp ?? null, data.finalStats?.att ?? null, data.finalStats?.pr ?? null,
    data.finalStats?.wp ?? null, data.finalStats?.mag ?? null, data.finalStats?.mr ?? null,
    level, data.weaponId ?? null, data.weaponQuality ?? null, passives
  );
  touch(team.id);
  return { team: getTeamById(team.id) };
}

// Memasang atau mengganti senjata pada slot yang sudah berisi hewan. Hanya
// kolom senjata yang disentuh, jadi level dan stat hewan tidak ikut berubah.
function setWeapon(userId, teamName, slot, { weaponId, weaponQuality = null, passives = null }) {
  const team = findTeam(userId, teamName);
  if (!team) return { error: `Tim **${teamName}** tidak ditemukan.` };
  const index = Number(slot);
  if (!Number.isInteger(index) || index < 1 || index > MAX_SLOTS) {
    return { error: `Slot harus 1-${MAX_SLOTS}.` };
  }
  const entry = team.slots.find(s => s.slot === index);
  if (!entry) return { error: `Slot ${index} masih kosong. Isi hewannya dulu.` };

  getDb().prepare(
    'UPDATE team_slots SET weapon_id = ?, weapon_quality = ?, passives = ? WHERE team_id = ? AND slot = ?'
  ).run(
    weaponId ?? null, weaponQuality ?? null,
    Array.isArray(passives) ? JSON.stringify(passives) : null,
    team.id, index
  );
  touch(team.id);
  return { team: getTeamById(team.id) };
}

function clearSlot(userId, teamName, slot) {
  const team = findTeam(userId, teamName);
  if (!team) return { error: `Tim **${teamName}** tidak ditemukan.` };
  getDb().prepare('DELETE FROM team_slots WHERE team_id = ? AND slot = ?').run(team.id, Number(slot));
  touch(team.id);
  return { team: getTeamById(team.id) };
}

function touch(teamId) {
  getDb().prepare('UPDATE teams SET updated_at = ? WHERE id = ?').run(Date.now(), teamId);
}

function setActiveTeam(userId, name) {
  const team = findTeam(userId, name);
  if (!team) return { error: `Tim **${name}** tidak ditemukan.` };
  getDb().prepare(`
    INSERT INTO active_team (guild_id, user_id, team_id) VALUES (?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET team_id = excluded.team_id
  `).run(GLOBAL_SCOPE, String(userId), team.id);
  return { team };
}

function getActiveTeam(userId) {
  const row = getDb().prepare('SELECT team_id FROM active_team WHERE user_id = ?')
    .get(String(userId));
  if (!row || row.team_id == null) return null;
  return getTeamById(row.team_id);
}

// Sisa waktu tunggu sebuah aksi untuk user ini. 0 berarti sudah boleh dipakai.
function cooldownRemaining(userId, action, now = Date.now()) {
  const row = getDb().prepare(
    'SELECT ready_at FROM command_cooldowns WHERE user_id = ? AND action = ?'
  ).get(String(userId), String(action));
  return Math.max(0, Number(row?.ready_at || 0) - now);
}

function setCooldown(userId, action, readyAt) {
  getDb().prepare(`
    INSERT INTO command_cooldowns (user_id, action, ready_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id, action) DO UPDATE SET ready_at = excluded.ready_at`)
    .run(String(userId), String(action), Number(readyAt) || 0);
}

function clearCooldown(userId, action) {
  getDb().prepare('DELETE FROM command_cooldowns WHERE user_id = ? AND action = ?')
    .run(String(userId), String(action));
}

function markTeamImportMessage(messageId, guildId, channelId) {
  getDb().prepare(
    'INSERT OR IGNORE INTO team_import_messages (source_message_id, guild_id, channel_id, discovered_at) VALUES (?, ?, ?, ?)'
  ).run(String(messageId), guildId == null ? null : String(guildId), channelId == null ? null : String(channelId), Date.now());
}
function isTeamImportMessage(messageId) {
  return Boolean(getDb().prepare(
    'SELECT 1 FROM team_import_messages WHERE source_message_id = ?'
  ).get(String(messageId)));
}

function hasTeamImport(userId, sourceMessageId) {
  return Boolean(getDb().prepare(
    'SELECT 1 FROM team_imports WHERE user_id = ? AND source_message_id = ?'
  ).get(String(userId), String(sourceMessageId)));
}

function markTeamImport(userId, sourceMessageId, teamName) {
  getDb().prepare(
    'INSERT OR IGNORE INTO team_imports (user_id, source_message_id, team_name, imported_at) VALUES (?, ?, ?, ?)'
  ).run(String(userId), String(sourceMessageId), String(teamName), Date.now());
}

module.exports = {
  MAX_SLOTS,
  MAX_TEAMS,
  MAX_TEAM_ID,
  getDb,
  cooldownRemaining,
  setCooldown,
  clearCooldown,
  normalizeName,
  uniqueName,
  listTeams,
  listAllTeams,
  listOpponentTeams,
  getTeam,
  findTeam,
  getTeamById,
  nextFreeSlotId,
  isSlotIdTaken,
  createTeam,
  renameTeam,
  setWeapon,
  deleteTeam,
  setSlot,
  clearSlot,
  setActiveTeam,
  getActiveTeam,
  hasTeamImport,
  markTeamImport,
  markTeamImportMessage,
  isTeamImportMessage,
};
