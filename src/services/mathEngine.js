// Mesin soal Matematika Cepat Tepat.
//
// Dua tanggung jawab, sengaja dipisah dari alur game (mathRace.js):
//  1. Membuat soal aritmetika berjenjang (level 1–5) dengan jawaban bilangan
//     bulat supaya penilaian bisa eksak.
//  2. Memeriksa jawaban pemain secara EKSAK. Berbeda dari Family 100 yang
//     toleran salah ketik, di sini "3" tidak boleh dianggap sama dengan "8".
//     Jawaban pemain TIDAK pernah dieksekusi sebagai kode: hanya bentuk angka,
//     pecahan, atau desimal yang diterima (lihat parseAnswer).

const MAX_LEVEL = 5;

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function addSub(max) {
  const a = randInt(2, max);
  const b = randInt(2, max);
  return a >= b
    ? { text: `${a} − ${b}`, answer: a - b }
    : { text: `${b} − ${a}`, answer: b - a };
}

function mulSmall() {
  const a = randInt(2, 9);
  const b = randInt(2, 9);
  return { text: `${a} × ${b}`, answer: a * b };
}

function mulBig() {
  const a = randInt(11, 25);
  const b = randInt(3, 9);
  return { text: `${a} × ${b}`, answer: a * b };
}

// Pembagian dibuat dari hasil kali supaya selalu bilangan bulat.
function divExact(maxFactor = 9) {
  const b = randInt(2, maxFactor);
  const q = randInt(2, maxFactor);
  return { text: `${b * q} ÷ ${b}`, answer: q };
}

function mixedAddMul() {
  const a = randInt(3, 12);
  const b = randInt(3, 9);
  const c = randInt(2, 40);
  return { text: `${a} × ${b} + ${c}`, answer: a * b + c };
}

function mixedParen() {
  const a = randInt(3, 12);
  const b = randInt(3, 12);
  const c = randInt(2, 6);
  if (Math.random() < 0.5) return { text: `(${a} + ${b}) × ${c}`, answer: (a + b) * c };
  return { text: `${c} × (${a} + ${b})`, answer: c * (a + b) };
}

function mixedHard() {
  const a = randInt(4, 15);
  const b = randInt(3, 9);
  const c = randInt(3, 9);
  const d = randInt(2, 6);
  return { text: `${a} × ${b} − ${c} × ${d}`, answer: a * b - c * d };
}

// Soal untuk satu level. Level di luar rentang dijepit ke 1..MAX_LEVEL.
function makeQuestion(level = 1) {
  const lv = Math.min(Math.max(Math.floor(Number(level) || 1), 1), MAX_LEVEL);
  let q;
  if (lv === 1) q = pick([() => addSub(15), () => addSub(20)])();
  else if (lv === 2) q = pick([() => addSub(90), mulSmall, () => divExact(5)])();
  else if (lv === 3) q = pick([mulBig, () => divExact(9), mixedAddMul])();
  else if (lv === 4) q = pick([mixedAddMul, mixedParen, () => divExact(12)])();
  else q = pick([mixedParen, mixedHard, mixedHard])();
  return { ...q, level: lv };
}

// --- Parser ekspresi aritmetika (aman, tanpa eval) -------------------------
// Dipakai bila nanti jawaban berupa ekspresi, mis. "12×3+4". Sekarang pemain
// hanya mengirim angka/pecahan, tapi parser ini menjaga agar tidak pernah ada
// jalur eval() terhadap input pengguna.

function tokenize(text) {
  const s = String(text || '').replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-');
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === ' ') { i++; continue; }
    if (/[0-9.]/.test(ch)) {
      let num = '';
      while (i < s.length && /[0-9.]/.test(s[i])) num += s[i++];
      if ((num.match(/\./g) || []).length > 1) return null;
      tokens.push({ type: 'num', value: Number(num) });
      continue;
    }
    if ('+-*/()'.includes(ch)) { tokens.push({ type: ch }); i++; continue; }
    return null;
  }
  return tokens;
}

function evaluate(text) {
  const tokens = tokenize(text);
  if (!tokens || !tokens.length) return null;
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = type => (peek() && peek().type === type ? tokens[pos++] : null);

  function parsePrimary() {
    const unary = eat('-') ? -1 : (eat('+') ? 1 : 1);
    const tok = peek();
    if (!tok) return null;
    if (tok.type === 'num') { pos++; return unary * tok.value; }
    if (tok.type === '(') {
      pos++;
      const v = parseExpr();
      if (v === null || !eat(')')) return null;
      return unary * v;
    }
    return null;
  }

  function parseTerm() {
    let left = parsePrimary();
    if (left === null) return null;
    for (;;) {
      const op = eat('*') ? '*' : (eat('/') ? '/' : null);
      if (!op) return left;
      const right = parsePrimary();
      if (right === null) return null;
      if (op === '/' && right === 0) return null;
      left = op === '*' ? left * right : left / right;
    }
  }

  function parseExpr() {
    let left = parseTerm();
    if (left === null) return null;
    for (;;) {
      const op = eat('+') ? '+' : (eat('-') ? '-' : null);
      if (!op) return left;
      const right = parseTerm();
      if (right === null) return null;
      left = op === '+' ? left + right : left - right;
    }
  }

  const value = parseExpr();
  if (value === null || pos !== tokens.length) return null;
  return value;
}

// --- Pemeriksaan jawaban ---------------------------------------------------
// Hanya menerima angka, desimal (titik atau koma), dan pecahan sederhana.
function parseAnswer(text) {
  const t = String(text ?? '').trim().replace(/\s+/g, '');
  if (!t) return null;
  const frac = /^([+-]?\d+)\/(\d+)$/.exec(t);
  if (frac) {
    const den = Number(frac[2]);
    if (!den) return null;
    return Number(frac[1]) / den;
  }
  const dec = t.replace(',', '.');
  if (/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(dec)) return Number(dec);
  return null;
}

// Toleransi hanya untuk pembulatan float (mis. 1/3), bukan untuk angka berbeda.
const EPSILON = 1e-9;

function isCorrect(text, answer) {
  const value = parseAnswer(text);
  if (value === null || !Number.isFinite(value)) return false;
  return Math.abs(value - Number(answer)) < EPSILON;
}

// Poin dasar per level. Soal lebih sulit bernilai lebih besar.
function basePoints(level) {
  const lv = Math.min(Math.max(Math.floor(Number(level) || 1), 1), MAX_LEVEL);
  return 40 + lv * 20;
}

module.exports = {
  makeQuestion, evaluate, parseAnswer, isCorrect, basePoints, MAX_LEVEL
};
