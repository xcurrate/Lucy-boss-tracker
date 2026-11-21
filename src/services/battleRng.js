// RNG deterministik (mulberry32). Dipakai supaya simulasi bisa diulang persis
// dengan seed yang sama — syarat agar hasil bisa diuji dan dibandingkan.
function createRng(seed = 1) {
  let state = (Number(seed) >>> 0) || 1;
  function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  return {
    next,
    // Bilangan bulat 0..max-1.
    int: max => Math.floor(next() * max),
    // Seed lanjutan supaya tiap pertarungan dalam satu batch berbeda tapi tetap
    // bisa direproduksi dari seed induk.
    fork: () => createRng(Math.floor(next() * 4294967296)),
  };
}

// Seed acak untuk pemakaian nyata (bukan test).
function randomSeed() {
  return Math.floor(Math.random() * 4294967296) >>> 0;
}

module.exports = { createRng, randomSeed };
