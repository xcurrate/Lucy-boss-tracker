// Pencocokan jawaban Family 100.
//
// Pemain mengetik bebas, jadi jawaban harus toleran: huruf besar/kecil, tanda
// baca, dan kata depan seperti "nasi goreng" vs "goreng" tidak boleh jadi
// penghalang. Normalisasi dilakukan sekali di bank soal, dan sekali per pesan.

// Kata yang sering dipakai sebagai awalan jawaban ("yang penting ...", "itu ...")
// dan tidak mengubah arti, jadi dibuang saat mencocokkan.
const STOPWORDS = new Set([
  'yang', 'itu', 'ini', 'adalah', 'ialah', 'merupakan', 'sebuah', 'para',
  'sang', 'si', 'ke', 'di', 'dari', 'the', 'a', 'an'
]);

function stripDiacritics(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeAnswer(text) {
  const base = stripDiacritics(String(text || '').toLowerCase())
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!base) return '';
  const words = base.split(' ').filter(w => !STOPWORDS.has(w));
  // Semua kata ternyata stopword (mis. jawaban "the") -> pakai bentuk aslinya.
  return (words.length ? words.join(' ') : base);
}

// Bentuk-bentuk alternatif yang bisa dipakai pemain: bentuk penuh, tanpa
// stopword, dan tanpa spasi/tanda hubung ("nasi goreng" -> "nasigoreng").
function variantsOf(text) {
  const raw = stripDiacritics(String(text || '').toLowerCase())
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return [];
  const out = new Set([raw, normalizeAnswer(raw)]);
  for (const v of [...out]) out.add(v.replace(/\s+/g, ''));
  return [...out].filter(Boolean);
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// Toleransi salah ketik: 1 huruf untuk kata pendek, 2 untuk kata panjang.
function isNearMatch(input, target) {
  if (!input || !target) return false;
  const maxDistance = Math.max(input.length, target.length) >= 8 ? 2 : 1;
  if (Math.abs(input.length - target.length) > maxDistance) return false;
  return levenshtein(input, target) <= maxDistance;
}

// Mencari jawaban yang cocok untuk `message` di antara `answers` (bentuk dari
// bank soal: { text, key }). Mengembalikan entri yang cocok atau null.
function matchAnswer(message, answers) {
  const inputVariants = variantsOf(message);
  if (!inputVariants.length) return null;
  const inputKeys = new Set(inputVariants.map(v => v.replace(/\s+/g, '')));

  for (const answer of answers) {
    const targetVariants = variantsOf(answer.text);
    if (targetVariants.some(v => inputKeys.has(v.replace(/\s+/g, '')))) return answer;
  }
  // Toleransi salah ketik hanya untuk jawaban satu kata, agar "goreng" tidak
  // dianggap cocok dengan "nasi goreng" atau sebaliknya.
  const singleWord = [...inputKeys].filter(k => !/\s/.test(k));
  for (const answer of answers) {
    if (/\s/.test(answer.key)) continue;
    if (singleWord.some(k => isNearMatch(k, answer.key.replace(/\s+/g, '')))) return answer;
  }
  return null;
}

module.exports = { normalizeAnswer, variantsOf, matchAnswer, isNearMatch, levenshtein };
