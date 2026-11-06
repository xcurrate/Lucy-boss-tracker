const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const dir = path.resolve(process.cwd(), 'data');
const file = path.join(dir, 'notes.json');

const MAX_TITLE = 120;
const MAX_BODY = 4000;

function readAll() {
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, '{}\n');
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function writeAll(data) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function cleanText(value, max, label) {
  const text = String(value == null ? '' : value).trim();
  if (text.length > max) throw new Error(label + ' maksimal ' + max + ' karakter.');
  return text;
}

function listNotes(guildId) {
  const notes = readAll()[String(guildId)] || [];
  return notes.slice().sort((a, b) => b.updatedAt - a.updatedAt);
}

function addNote(guildId, input = {}) {
  const title = cleanText(input.title, MAX_TITLE, 'Judul note');
  const body = cleanText(input.body, MAX_BODY, 'Isi note');
  if (!title && !body) throw new Error('Judul atau isi note wajib diisi.');
  const now = Date.now();
  const note = { id: crypto.randomUUID(), title, body, createdAt: now, updatedAt: now };
  const all = readAll();
  const key = String(guildId);
  all[key] = [...(all[key] || []), note];
  writeAll(all);
  return note;
}

function updateNote(guildId, id, input = {}) {
  const all = readAll();
  const key = String(guildId);
  const notes = all[key] || [];
  const index = notes.findIndex(note => note.id === id);
  if (index === -1) throw Object.assign(new Error('Note tidak ditemukan.'), { status: 404 });
  const title = cleanText(input.title, MAX_TITLE, 'Judul note');
  const body = cleanText(input.body, MAX_BODY, 'Isi note');
  if (!title && !body) throw new Error('Judul atau isi note wajib diisi.');
  const updated = { ...notes[index], title, body, updatedAt: Date.now() };
  notes[index] = updated;
  all[key] = notes;
  writeAll(all);
  return updated;
}

function deleteNote(guildId, id) {
  const all = readAll();
  const key = String(guildId);
  const notes = all[key] || [];
  const remaining = notes.filter(note => note.id !== id);
  if (remaining.length === notes.length) throw Object.assign(new Error('Note tidak ditemukan.'), { status: 404 });
  all[key] = remaining;
  writeAll(all);
  return { ok: true };
}

module.exports = { listNotes, addNote, updateNote, deleteNote, MAX_TITLE, MAX_BODY };
