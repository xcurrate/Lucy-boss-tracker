// Penyimpanan Custom Reminder (template, award, reminder milik user, audit).
//
// Memakai node:sqlite seperti lucyCounterStorage: handle malas (lazy), WAL,
// penanda versi di schema_meta, dan transaksi untuk operasi yang harus atomik.
// Semua data kepemilikan ada di sini — tidak ada kepemilikan penting yang hanya
// disimpan di memori, sehingga tetap utuh setelah bot restart.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const categories = require('./reminderCategories');

// Versi skema disimpan di schema_meta agar penambahan kolom di masa depan bisa
// dikenali tanpa merusak data lama (CREATE TABLE IF NOT EXISTS bersifat aditif).
const SCHEMA_VERSION = '3';

// Huruf/angka tanpa karakter rancu (0/O, 1/I/L) supaya ID mudah dibaca ulang.
// Panjang 5 karakter sesuai spesifikasi inventory; prefiks T-/C-/R- menjaga
// tiga jenis ID tetap tidak tertukar.
const ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ID_LENGTH = 5;

let db = null;
let dbPath = null;

function paths() {
  const dir = path.resolve(process.cwd(), 'data');
  return { dir, dbFile: path.join(dir, 'reminders.db') };
}

// ID pendek berprefiks supaya tiga jenis ID tidak tertukar saat dibaca manusia:
// T- = template, C- = claim (award), R- = reminder milik user.
function shortId(length = ID_LENGTH) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return out;
}
function newTemplateId() { return 'T-' + shortId(); }
function newClaimId() { return 'C-' + shortId(); }
function newReminderId() { return 'R-' + shortId(); }

const ID_PATTERNS = {
  template: /^T-[A-Z0-9]{4,16}$/,
  claim: /^C-[A-Z0-9]{4,16}$/,
  reminder: /^R-[A-Z0-9]{4,16}$/
};
function isValidTemplateId(value) { return ID_PATTERNS.template.test(String(value || '').trim().toUpperCase()); }
function isValidClaimId(value) { return ID_PATTERNS.claim.test(String(value || '').trim().toUpperCase()); }
function isValidReminderId(value) { return ID_PATTERNS.reminder.test(String(value || '').trim().toUpperCase()); }
function normalizeId(value) { return String(value || '').trim().toUpperCase(); }
// Discord snowflake: 17-20 digit. Divalidasi sebelum dipakai sebagai kunci DB.
function isValidUserId(value) { return /^\d{17,20}$/.test(String(value || '').trim()); }

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
    -- Template: cetakan reminder yang dibuat developer.
    CREATE TABLE IF NOT EXISTS reminder_templates (
      template_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'PRAY_CURSE',
      format TEXT NOT NULL DEFAULT 'NORMAL',
      message TEXT NOT NULL,
      embed_json TEXT,
      collectible TEXT,
      metadata_json TEXT,
      creator_id TEXT,
      created_at INTEGER NOT NULL,
      available INTEGER NOT NULL DEFAULT 1
    );
    -- Award: pemberian reminder kepada penerima. claim_id adalah ID yang
    -- dikirim ke penerima untuk di-redeem. UNIQUE(source, source_ref, recipient)
    -- membuat pemberian dari sumber yang sama idempoten (mis. giveaway yang
    -- eventnya diproses dua kali) tanpa membatasi pemberian manual developer.
    CREATE TABLE IF NOT EXISTS reminder_awards (
      claim_id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      issuer_id TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      source_ref TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      redeemed_at INTEGER,
      revoked_at INTEGER,
      reminder_id TEXT,
      UNIQUE(source, source_ref, recipient_id)
    );
    -- Reminder milik user. owner_id adalah SATU sumber kebenaran kepemilikan,
    -- jadi transfer otomatis mencabut akses pemilik lama.
    CREATE TABLE IF NOT EXISTS reminders (
      reminder_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      template_id TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'PRAY_CURSE',
      format TEXT NOT NULL DEFAULT 'NORMAL',
      name TEXT,
      message TEXT NOT NULL,
      embed_json TEXT,
      collectible TEXT,
      active INTEGER NOT NULL DEFAULT 0,
      shareable INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      activated_at INTEGER,
      last_delivered_at INTEGER
    );
    -- Pengaturan default pengingat per server. Kolom action menyimpan aksi KASAR
    -- kategori: 'pray' untuk PRAY_CURSE, 'battle' untuk HUNT_BATTLE, 'lucy' untuk
    -- LUCY. Satu baris mewakili satu kategori, jadi perintah s battle dan s hunt
    -- menulis baris yang sama dan tidak ada lagi pengingat terbelah dua.
    CREATE TABLE IF NOT EXISTS guild_reminder_settings (
      guild_id TEXT NOT NULL,
      action TEXT NOT NULL,
      format TEXT NOT NULL DEFAULT 'NORMAL',
      message TEXT,
      embed_json TEXT,
      updated_by TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, action)
    );
    CREATE TABLE IF NOT EXISTS reminder_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      action TEXT NOT NULL,
      reminder_id TEXT,
      claim_id TEXT,
      template_id TEXT,
      actor_id TEXT,
      from_user_id TEXT,
      to_user_id TEXT,
      source TEXT,
      source_ref TEXT,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_reminders_owner ON reminders(owner_id);
    CREATE INDEX IF NOT EXISTS idx_awards_recipient ON reminder_awards(recipient_id);
    CREATE INDEX IF NOT EXISTS idx_audit_reminder ON reminder_audit(reminder_id);
  `);
  ensureColumns(db);
  migrateGuildSettingsToCategoryKeys(db);
  db.prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)').run('schema_version', SCHEMA_VERSION);
  return db;
}

// Tambah kolom yang belum ada pada database lama. Aditif dan aman diulang,
// jadi upgrade dari skema versi 1 tidak menghapus data yang sudah ada.
function ensureColumns(database) {
  const columnsOf = table => {
    try { return new Set(database.prepare('PRAGMA table_info(' + table + ')').all().map(c => c.name)); }
    catch { return new Set(); }
  };
  const add = (table, column, definition) => {
    if (!columnsOf(table).has(column)) {
      try { database.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + definition); } catch {}
    }
  };
  add('reminder_templates', 'category', "TEXT NOT NULL DEFAULT 'PRAY_CURSE'");
  add('reminder_templates', 'format', "TEXT NOT NULL DEFAULT 'NORMAL'");
  add('reminders', 'category', "TEXT NOT NULL DEFAULT 'PRAY_CURSE'");
  add('reminders', 'format', "TEXT NOT NULL DEFAULT 'NORMAL'");
  add('reminders', 'name', 'TEXT');
  add('reminders', 'shareable', 'INTEGER NOT NULL DEFAULT 0');
}

// Gabungkan baris pengaturan server dari skema lama (per AKSI, sehingga pray +
// curse dan battle + hunt terpisah) menjadi satu baris per KATEGORI. Bila satu
// kategori punya beberapa baris lama, yang paling baru menang dan sisanya
// dibuang — kalau tidak, teks lama tetap terpisah dan bug-nya kembali. Kategori
// yang hanya punya satu baris dipertahankan apa adanya, jadi balasan kustom per
// aksi (mis. `s curse`) tidak berubah artinya.
// Aman diulang: hanya berjalan saat penanda versi masih di bawah 3.
function migrateGuildSettingsToCategoryKeys(database) {
  const version = Number(database.prepare(
    "SELECT value FROM schema_meta WHERE key = 'schema_version'"
  ).get()?.value || 1);
  if (version >= 3) return;
  const rows = database.prepare('SELECT * FROM guild_reminder_settings ORDER BY guild_id, updated_at').all();
  if (!rows.length) return;

  const byGuild = new Map();
  for (const row of rows) {
    if (!byGuild.has(row.guild_id)) byGuild.set(row.guild_id, []);
    byGuild.get(row.guild_id).push(row);
  }
  const upsert = database.prepare(`
    INSERT INTO guild_reminder_settings (guild_id, action, format, message, embed_json, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, action) DO UPDATE SET
      format = excluded.format, message = excluded.message, embed_json = excluded.embed_json,
      updated_by = excluded.updated_by, updated_at = excluded.updated_at`);

  for (const [guildId, guildRows] of byGuild) {
    const groups = new Map();
    const unknown = [];
    for (const row of guildRows) {
      const category = categories.categoryForAction(row.action);
      const canonical = category ? categories.canonicalAction(category) : null;
      if (!canonical) { unknown.push(row); continue; }
      if (!groups.has(canonical)) groups.set(canonical, []);
      groups.get(canonical).push(row);
    }
    const keep = [...unknown];
    for (const [canonical, groupRows] of groups) {
      if (groupRows.length === 1) { keep.push(groupRows[0]); continue; }
      const newest = groupRows.reduce((a, b) => (Number(b.updated_at) >= Number(a.updated_at) ? b : a));
      keep.push({ ...newest, action: canonical });
    }
    database.prepare('DELETE FROM guild_reminder_settings WHERE guild_id = ?').run(guildId);
    for (const row of keep) {
      upsert.run(guildId, row.action, row.format, row.message, row.embed_json, row.updated_by, row.updated_at);
    }
  }
}

// Jalankan operasi dalam transaksi IMMEDIATE; rollback bila gagal.
function inTransaction(fn) {
  const database = getDb();
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = fn(database);
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

// Coba beberapa kali bila ID acak kebetulan bertabrakan dengan baris yang ada.
function insertWithUniqueId(makeId, isTaken, insert, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    const id = makeId();
    if (isTaken(id)) continue;
    try { insert(id); return id; }
    catch (error) {
      if (!/UNIQUE|PRIMARY KEY/i.test(String(error?.message))) throw error;
    }
  }
  throw new Error('Gagal membuat ID unik, coba lagi.');
}

function addAudit(entry) {
  const at = Number(entry.at) || Date.now();
  getDb().prepare(`
    INSERT INTO reminder_audit
      (at, action, reminder_id, claim_id, template_id, actor_id, from_user_id, to_user_id, source, source_ref, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    at,
    String(entry.action || 'unknown'),
    entry.reminderId || null,
    entry.claimId || null,
    entry.templateId || null,
    entry.actorId || null,
    entry.fromUserId || null,
    entry.toUserId || null,
    entry.source || null,
    entry.sourceRef || null,
    entry.detail ? JSON.stringify(entry.detail) : null
  );
}

// ---------------------------------------------------------------- template --
function rowToTemplate(row) {
  if (!row) return null;
  return {
    templateId: row.template_id,
    name: row.name,
    category: row.category || 'PRAY_CURSE',
    format: row.format || 'NORMAL',
    message: row.message,
    embed: row.embed_json ? JSON.parse(row.embed_json) : null,
    collectible: row.collectible || null,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
    creatorId: row.creator_id || null,
    createdAt: Number(row.created_at),
    available: Boolean(row.available)
  };
}

function createTemplate({ name, message, embed = null, collectible = null, metadata = {}, creatorId = null, category = 'PRAY_CURSE', format = 'NORMAL', now = Date.now() }) {
  const database = getDb();
  const templateId = insertWithUniqueId(
    newTemplateId,
    id => Boolean(database.prepare('SELECT 1 FROM reminder_templates WHERE template_id = ?').get(id)),
    id => database.prepare(`
      INSERT INTO reminder_templates (template_id, name, category, format, message, embed_json, collectible, metadata_json, creator_id, created_at, available)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(
      id, name, category, format, message, embed ? JSON.stringify(embed) : null, collectible,
      JSON.stringify(metadata || {}), creatorId, now
    )
  );
  addAudit({ action: 'template_create', templateId, actorId: creatorId, detail: { name, category, format }, at: now });
  return getTemplate(templateId);
}

function getTemplate(templateId) {
  return rowToTemplate(getDb().prepare('SELECT * FROM reminder_templates WHERE template_id = ?').get(normalizeId(templateId)));
}

function listTemplates({ includeUnavailable = false } = {}) {
  const sql = includeUnavailable
    ? 'SELECT * FROM reminder_templates ORDER BY created_at DESC'
    : 'SELECT * FROM reminder_templates WHERE available = 1 ORDER BY created_at DESC';
  return getDb().prepare(sql).all().map(rowToTemplate);
}

function setTemplateAvailable(templateId, available, actorId = null) {
  const id = normalizeId(templateId);
  const result = getDb().prepare('UPDATE reminder_templates SET available = ? WHERE template_id = ?').run(available ? 1 : 0, id);
  if (result.changes === 0) return false;
  addAudit({ action: 'template_availability', templateId: id, actorId, detail: { available: Boolean(available) } });
  return true;
}

// ------------------------------------------------------------------- award --
function rowToAward(row) {
  if (!row) return null;
  return {
    claimId: row.claim_id,
    templateId: row.template_id,
    recipientId: row.recipient_id,
    issuerId: row.issuer_id || null,
    source: row.source,
    sourceRef: row.source_ref || null,
    status: row.status,
    createdAt: Number(row.created_at),
    expiresAt: row.expires_at == null ? null : Number(row.expires_at),
    redeemedAt: row.redeemed_at == null ? null : Number(row.redeemed_at),
    revokedAt: row.revoked_at == null ? null : Number(row.revoked_at),
    reminderId: row.reminder_id || null
  };
}

// Buat award baru. Bila `sourceRef` diisi, pemberian dari sumber yang sama
// bersifat idempoten: pemanggilan ulang mengembalikan award yang sudah ada
// (dedupe) alih-alih membuat award kedua.
function createAward({ templateId, recipientId, issuerId = null, source = 'manual', sourceRef = null, expiresAt = null, now = Date.now() }) {
  const database = getDb();
  if (sourceRef) {
    // Sumber berulang (mis. giveaway yang eventnya diproses dua kali): pemberian
    // yang sama harus menghasilkan satu award saja.
    const existing = database.prepare(
      'SELECT * FROM reminder_awards WHERE source = ? AND source_ref = ? AND recipient_id = ?'
    ).get(source, sourceRef, recipientId);
    if (existing) return { award: rowToAward(existing), created: false };
  } else {
    // Pemberian manual: cegah award ganda yang tidak sengaja untuk template dan
    // penerima yang sama selama award sebelumnya belum diklaim. Setelah diklaim
    // (redeemed) atau dicabut (revoked), pemberian baru tetap boleh.
    const existing = database.prepare(
      "SELECT * FROM reminder_awards WHERE template_id = ? AND recipient_id = ? AND status = 'pending'"
    ).get(templateId, recipientId);
    if (existing) return { award: rowToAward(existing), created: false };
  }
  const claimId = insertWithUniqueId(
    newClaimId,
    id => Boolean(database.prepare('SELECT 1 FROM reminder_awards WHERE claim_id = ?').get(id)),
    id => database.prepare(`
      INSERT INTO reminder_awards (claim_id, template_id, recipient_id, issuer_id, source, source_ref, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).run(
      id, templateId, recipientId, issuerId, source, sourceRef, now, expiresAt
    )
  );
  addAudit({ action: 'award_create', claimId, templateId, actorId: issuerId, toUserId: recipientId, source, sourceRef, at: now });
  return { award: rowToAward(database.prepare('SELECT * FROM reminder_awards WHERE claim_id = ?').get(claimId)), created: true };
}

function getAward(claimId) {
  return rowToAward(getDb().prepare('SELECT * FROM reminder_awards WHERE claim_id = ?').get(normalizeId(claimId)));
}

function listAwards({ recipientId = null, status = null, limit = 50 } = {}) {
  const clauses = [];
  const params = [];
  if (recipientId) { clauses.push('recipient_id = ?'); params.push(recipientId); }
  if (status) { clauses.push('status = ?'); params.push(status); }
  const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
  params.push(Math.max(1, Math.min(200, Number(limit) || 50)));
  return getDb().prepare('SELECT * FROM reminder_awards' + where + ' ORDER BY created_at DESC LIMIT ?')
    .all(...params).map(rowToAward);
}

function revokeAward({ claimId, actorId = null, now = Date.now() }) {
  const id = normalizeId(claimId);
  const result = getDb().prepare(
    "UPDATE reminder_awards SET status = 'revoked', revoked_at = ? WHERE claim_id = ? AND status = 'pending'"
  ).run(now, id);
  if (result.changes === 0) return null;
  addAudit({ action: 'award_revoke', claimId: id, actorId, at: now });
  return getAward(id);
}

// Klaim atomik: hanya satu pemanggil yang bisa menang. Guard dilakukan di SQL
// (status masih 'pending' + milik penerima + belum kedaluwarsa), lalu `changes`
// dipakai untuk memastikan tidak ada klaim ganda.
function markAwardRedeemed({ claimId, recipientId, reminderId, now = Date.now() }) {
  const id = normalizeId(claimId);
  const result = getDb().prepare(`
    UPDATE reminder_awards
       SET status = 'redeemed', redeemed_at = ?, reminder_id = ?
     WHERE claim_id = ? AND recipient_id = ? AND status = 'pending'
       AND (expires_at IS NULL OR expires_at > ?)`).run(now, reminderId, id, recipientId, now);
  if (result.changes === 0) return false;
  addAudit({ action: 'award_redeem', claimId: id, reminderId, actorId: recipientId, toUserId: recipientId, at: now });
  return true;
}

// ---------------------------------------------------------------- reminder --
function rowToReminder(row) {
  if (!row) return null;
  return {
    reminderId: row.reminder_id,
    ownerId: row.owner_id,
    templateId: row.template_id,
    category: row.category || 'PRAY_CURSE',
    format: row.format || 'NORMAL',
    name: row.name || null,
    message: row.message,
    embed: row.embed_json ? JSON.parse(row.embed_json) : null,
    collectible: row.collectible || null,
    active: Boolean(row.active),
    shareable: Boolean(row.shareable),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    activatedAt: row.activated_at == null ? null : Number(row.activated_at),
    lastDeliveredAt: row.last_delivered_at == null ? null : Number(row.last_delivered_at)
  };
}

function createReminder({ ownerId, templateId, message, embed = null, collectible = null, active = false, now = Date.now(), category = 'PRAY_CURSE', format = 'NORMAL', name = null, shareable = false }) {
  const database = getDb();
  const reminderId = insertWithUniqueId(
    newReminderId,
    id => Boolean(database.prepare('SELECT 1 FROM reminders WHERE reminder_id = ?').get(id)),
    id => database.prepare(`
      INSERT INTO reminders (reminder_id, owner_id, template_id, category, format, name, message, embed_json, collectible, active, shareable, created_at, updated_at, activated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, ownerId, templateId, category, format, name, message, embed ? JSON.stringify(embed) : null, collectible,
      active ? 1 : 0, shareable ? 1 : 0, now, now, active ? now : null
    )
  );
  addAudit({ action: 'reminder_create', reminderId, templateId, actorId: ownerId, toUserId: ownerId, detail: { category, format }, at: now });
  return getReminder(reminderId);
}

function getReminder(reminderId) {
  return rowToReminder(getDb().prepare('SELECT * FROM reminders WHERE reminder_id = ?').get(normalizeId(reminderId)));
}

function listRemindersByOwner(ownerId, { activeOnly = false } = {}) {
  const sql = activeOnly
    ? 'SELECT * FROM reminders WHERE owner_id = ? AND active = 1 ORDER BY created_at DESC'
    : 'SELECT * FROM reminders WHERE owner_id = ? ORDER BY created_at DESC';
  return getDb().prepare(sql).all(ownerId).map(rowToReminder);
}

function listAllActive() {
  return getDb().prepare('SELECT * FROM reminders WHERE active = 1 ORDER BY owner_id').all().map(rowToReminder);
}

// Pembaruan field secara terarah. Field yang tidak disebut tidak disentuh, jadi
// pemilik tidak bisa menghapus kolom lain lewat perintah tunggal.
function updateReminder(reminderId, fields, { now = Date.now() } = {}) {
  const id = normalizeId(reminderId);
  const sets = [];
  const params = [];
  const map = {
    message: v => v,
    embed: v => (v == null ? null : JSON.stringify(v)),
    collectible: v => v,
    ownerId: v => v,
    active: v => (v ? 1 : 0),
    activatedAt: v => v,
    lastDeliveredAt: v => v,
    shareable: v => (v ? 1 : 0),
    name: v => v
  };
  const columns = {
    message: 'message', embed: 'embed_json', collectible: 'collectible',
    ownerId: 'owner_id', active: 'active', activatedAt: 'activated_at',
    lastDeliveredAt: 'last_delivered_at', shareable: 'shareable', name: 'name'
  };
  for (const [key, toColumn] of Object.entries(map)) {
    if (!(key in fields)) continue;
    sets.push(columns[key] + ' = ?');
    params.push(toColumn(fields[key]));
  }
  if (!sets.length) return getReminder(id);
  sets.push('updated_at = ?');
  params.push(now, id);
  const result = getDb().prepare('UPDATE reminders SET ' + sets.join(', ') + ' WHERE reminder_id = ?').run(...params);
  if (result.changes === 0) return null;
  return getReminder(id);
}

function transferReminder({ reminderId, fromUserId, toUserId, actorId = null, now = Date.now() }) {
  const id = normalizeId(reminderId);
  const result = getDb().prepare(
    'UPDATE reminders SET owner_id = ?, updated_at = ? WHERE reminder_id = ? AND owner_id = ?'
  ).run(toUserId, now, id, fromUserId);
  if (result.changes === 0) return null;
  addAudit({
    action: 'reminder_transfer', reminderId: id, actorId: actorId || fromUserId,
    fromUserId, toUserId, at: now
  });
  return getReminder(id);
}

// Hapus reminder milik user. Mengembalikan reminder yang dihapus (untuk pesan
// konfirmasi) atau null bila tidak ada / bukan miliknya. Award yang sudah
// diklaim tetap disimpan sebagai riwayat; hanya baris reminder-nya yang hilang.
function deleteReminder({ reminderId, ownerId, actorId = null, now = Date.now() }) {
  const id = normalizeId(reminderId);
  const existing = getReminder(id);
  if (!existing) return null;
  if (ownerId && existing.ownerId !== ownerId) return null;
  const result = getDb().prepare('DELETE FROM reminders WHERE reminder_id = ? AND owner_id = ?').run(id, existing.ownerId);
  if (result.changes === 0) return null;
  addAudit({
    action: 'reminder_delete', reminderId: id, actorId: actorId || existing.ownerId,
    fromUserId: existing.ownerId, templateId: existing.templateId, at: now
  });
  return existing;
}

function listAudit({ reminderId = null, claimId = null, limit = 50 } = {}) {
  const clauses = [];
  const params = [];
  if (reminderId) { clauses.push('reminder_id = ?'); params.push(normalizeId(reminderId)); }
  if (claimId) { clauses.push('claim_id = ?'); params.push(normalizeId(claimId)); }
  const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
  params.push(Math.max(1, Math.min(200, Number(limit) || 50)));
  return getDb().prepare('SELECT * FROM reminder_audit' + where + ' ORDER BY id DESC LIMIT ?').all(...params).map(row => ({
    at: Number(row.at),
    action: row.action,
    reminderId: row.reminder_id || null,
    claimId: row.claim_id || null,
    templateId: row.template_id || null,
    actorId: row.actor_id || null,
    fromUserId: row.from_user_id || null,
    toUserId: row.to_user_id || null,
    source: row.source || null,
    sourceRef: row.source_ref || null,
    detail: row.detail ? JSON.parse(row.detail) : null
  }));
}

// ------------------------------------------------------- server defaults --
// Pengaturan default pengingat per server per AKSI. Baris di sini HANYA
// menyimpan konfigurasi server; tidak pernah menyentuh reminder milik user dan
// tidak pernah ditimpa oleh suntingan user (dan sebaliknya).
function rowToGuildSetting(row) {
  if (!row) return null;
  return {
    guildId: row.guild_id,
    action: row.action,
    format: row.format || 'NORMAL',
    message: row.message || null,
    embed: row.embed_json ? JSON.parse(row.embed_json) : null,
    updatedBy: row.updated_by || null,
    updatedAt: Number(row.updated_at)
  };
}

// Kunci baris = aksi KASAR kategori, jadi `s hunt` dan `s battle` tidak lagi
// menulis dua baris terpisah yang membuat pengingat terbelah.
function settingKeyFor(action) {
  const category = categories.categoryForAction(action);
  return (category && categories.canonicalAction(category)) || action;
}
function setGuildReminderSetting({ guildId, action, format = 'NORMAL', message = null, embed = null, updatedBy = null, now = Date.now() }) {
  const key = settingKeyFor(action);
  getDb().prepare(`
    INSERT INTO guild_reminder_settings (guild_id, action, format, message, embed_json, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, action) DO UPDATE SET
      format = excluded.format,
      message = excluded.message,
      embed_json = excluded.embed_json,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at`).run(
    guildId, key, format, message, embed ? JSON.stringify(embed) : null, updatedBy, now
  );
  addAudit({ action: 'guild_setting_set', actorId: updatedBy, detail: { guildId, action: key, requested: action, format }, at: now });
  return getGuildReminderSetting(guildId, action);
}

function getGuildReminderSetting(guildId, action) {
  const key = settingKeyFor(action);
  return rowToGuildSetting(getDb().prepare(
    'SELECT * FROM guild_reminder_settings WHERE guild_id = ? AND action = ?'
  ).get(guildId, key));
}

function listGuildReminderSettings(guildId) {
  return getDb().prepare('SELECT * FROM guild_reminder_settings WHERE guild_id = ? ORDER BY action').all(guildId).map(rowToGuildSetting);
}

// Reset menghapus HANYA baris pengaturan server untuk aksi itu, sehingga
// perilaku kembali ke bawaan Dragneel. Reminder milik user tidak disentuh.
function deleteGuildReminderSetting(guildId, action) {
  const key = settingKeyFor(action);
  const result = getDb().prepare('DELETE FROM guild_reminder_settings WHERE guild_id = ? AND action = ?').run(guildId, key);
  if (result.changes === 0) return false;
  addAudit({ action: 'guild_setting_reset', detail: { guildId, action: key, requested: action } });
  return true;
}

module.exports = {
  SCHEMA_VERSION, ID_PATTERNS, settingKeyFor,
  getDb, newTemplateId, newClaimId, newReminderId,
  isValidTemplateId, isValidClaimId, isValidReminderId, isValidUserId, normalizeId,
  createTemplate, getTemplate, listTemplates, setTemplateAvailable,
  createAward, getAward, listAwards, revokeAward, markAwardRedeemed,
  createReminder, getReminder, listRemindersByOwner, listAllActive, updateReminder, transferReminder, deleteReminder,
  setGuildReminderSetting, getGuildReminderSetting, listGuildReminderSettings, deleteGuildReminderSetting,
  addAudit, listAudit, inTransaction
};
