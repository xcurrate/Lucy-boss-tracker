// Bank soal Family 100.
//
// Sumber: https://github.com/YangJunMing12/family100-database (lisensi Apache-2.0).
// Data mentah 7.162 entri, dideduplikasi dan dikurasi menjadi 1.709 soal dengan daftar
// jawaban yang digabung (lihat AGENTS.md). Berkas JSON-nya sengaja disimpan apa
// adanya; modul ini yang mengubahnya jadi bentuk siap pakai (sudah dinormalisasi
// sekali saat dimuat agar pencocokan jawaban tidak mengulang kerja yang sama).
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, 'family100.json');
const { normalizeAnswer } = require('../services/family100Match');

let cache = null;

function build() {
  const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  return raw.map((q, index) => {
    const answers = [];
    const seen = new Set();
    for (const a of q.jawaban || []) {
      const text = String(a || '').trim();
      if (!text) continue;
      const key = normalizeAnswer(text);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      answers.push({ text, key });
    }
    return { id: index, soal: String(q.soal || '').trim(), answers };
  }).filter(q => q.soal && q.answers.length > 0);
}

function all() {
  if (!cache) cache = build();
  return cache;
}

function count() {
  return all().length;
}

function byId(id) {
  return all().find(q => q.id === id) || null;
}

module.exports = { all, count, byId, FILE };
