const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

let tempDir;
let notes;

function resetModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('noteStorage.js')) delete require.cache[key];
  }
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-tracker-notes-'));
  process.chdir(tempDir);
  resetModules();
  notes = require('../src/utils/noteStorage');
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('note storage', () => {
  it('adds, lists, updates, and deletes notes per guild', () => {
    const first = notes.addNote('guildA', { title: 'Rencana', body: 'Beli crate' });
    notes.addNote('guildA', { title: 'Pengingat', body: 'Cek reward' });
    notes.addNote('guildB', { title: 'Server lain', body: 'Tidak terlihat' });

    assert.strictEqual(first.id.length > 0, true);
    assert.strictEqual(notes.listNotes('guildA').length, 2);
    assert.strictEqual(notes.listNotes('guildB').length, 1);
    assert.strictEqual(notes.listNotes('guildC').length, 0);

    const updated = notes.updateNote('guildA', first.id, { title: 'Rencana baru', body: 'Beli 2 crate' });
    assert.strictEqual(updated.title, 'Rencana baru');
    assert.strictEqual(updated.body, 'Beli 2 crate');
    assert.ok(updated.updatedAt >= updated.createdAt);
    assert.strictEqual(notes.listNotes('guildA').find(n => n.id === first.id).title, 'Rencana baru');

    notes.deleteNote('guildA', first.id);
    assert.strictEqual(notes.listNotes('guildA').length, 1);
  });

  it('rejects empty and oversized notes and unknown ids', () => {
    assert.throws(() => notes.addNote('guildA', { title: '  ', body: '' }), /wajib diisi/);
    assert.throws(() => notes.addNote('guildA', { title: 'x'.repeat(121), body: '' }), /maksimal 120/);
    assert.throws(() => notes.addNote('guildA', { title: 'ok', body: 'y'.repeat(4001) }), /maksimal 4000/);
    assert.throws(() => notes.updateNote('guildA', 'tidak-ada', { title: 'a', body: 'b' }), /tidak ditemukan/);
    assert.throws(() => notes.deleteNote('guildA', 'tidak-ada'), /tidak ditemukan/);
  });

  it('persists notes to data/notes.json and survives a reload', () => {
    const note = notes.addNote('guildA', { title: 'Tetap ada', body: 'Setelah reload' });
    assert.ok(fs.existsSync(path.join(tempDir, 'data', 'notes.json')));

    resetModules();
    const reloaded = require('../src/utils/noteStorage');
    const list = reloaded.listNotes('guildA');
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].id, note.id);
    assert.strictEqual(list[0].title, 'Tetap ada');
  });
});
