// Agregasi potongan pekerjaan simulasi global. Fungsi ini murni dan sinkron
// supaya bisa dipakai di worker thread maupun langsung di proses utama.
//
// Hasilnya diringkas, bukan daftar pertarungan: satu simulasi bisa berisi
// jutaan pertarungan, dan mengirim semuanya lewat pesan worker akan jauh lebih
// mahal daripada menjalankan pertarungannya.
const { runBattle } = require('./battleEngine');
const { createRng } = require('./battleRng');

const LEVEL_THRESHOLD = 35;

function maxLevelOf(specs) {
  return specs.reduce((max, spec) => Math.max(max, Number(spec.level) || 0), 0);
}

function emptyTally() {
  return { player: 0, enemy: 0, tie: 0 };
}

function rate(part, total) {
  return total ? Math.round((part / total) * 1000) / 10 : 0;
}

function emptyBucket(key) {
  const label = key === 'low'
    ? `Max level < ${LEVEL_THRESHOLD}`
    : `Max level ≥ ${LEVEL_THRESHOLD}`;
  return { key, label, teams: 0, battles: 0, levelSum: 0, tally: emptyTally() };
}

// Seed tiap pertarungan diturunkan dari (seed induk, nomor lawan, nomor run),
// bukan dari urutan pemakaian RNG. Pertarungan jadi saling lepas: hasilnya sama
// persis berapa pun jumlah worker dan bagaimana pekerjaan dibagi, dan satu
// rentang run bisa dihitung tanpa harus memajukan RNG lebih dulu.
function mixSeed(base, index) {
  let h = (Number(base) ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}

function runSeed(seed, opponentIndex, runIndex) {
  return mixSeed(mixSeed(seed, opponentIndex), runIndex);
}

// Berapa pertarungan sekali antara laporan kemajuan. Dipilih supaya worker
// besar tetap melapor beberapa kali per detik, dan worker kecil tidak dibanjiri
// pesan: satu potong berisi ratusan ribu pertarungan, jadi laporan per potong
// saja membuat progres tidak bergerak sampai potongan itu selesai.
const PROGRESS_STEP = 2000;

// Satu potong = daftar unit `{ opponentIndex, from, to }` (rentang run, `to`
// eksklusif) yang harus dijalankan berurutan.
//
// Ringkasan streak harus bisa digabung antar-potong tanpa menyimpan urutan
// pertarungan. Karena itu tiap potong melaporkan ekor dan kepalanya:
//
//   head        = kemenangan berturut-turut di awal potong
//   tail        = kemenangan berturut-turut di akhir potong
//   sum         = total panjang streak yang SELESAI di dalam potong
//   count       = jumlah streak tersebut
//   maxInternal = streak terpanjang yang seluruhnya berada di dalam potong
//
// Streak yang melewati batas potong tidak dihitung di sini; penggabung yang
// menghitungnya dari `tail` potong sebelumnya + `head` potong berikutnya.
// `maxInternal` tetap diperlukan karena streak yang terkurung di tengah potong
// tidak pernah muncul sebagai head atau tail, sehingga tanpa field ini streak
// terpanjang bisa hilang sama sekali.
function aggregateChunk(playerSpecs, opponents, { seed = 1, units = null, onStep = null } = {}) {
  const work = units || opponents.map((_, i) => ({
    opponentIndex: i, from: 0, to: opponents[i].runs ?? 0,
  }));

  const tally = emptyTally();
  const buckets = {
    low: emptyBucket('low'),
    high: emptyBucket('high'),
  };
  // Diringkas per tim lawan; satu tim bisa muncul di beberapa potong, jadi
  // penggabung menjumlahkan berdasarkan kuncinya.
  const perOpponent = new Map();

  let streak = 0;
  let sum = 0;
  let count = 0;
  let head = 0;
  let headFixed = false;
  let maxInternal = 0;
  let battles = 0;

  for (const unit of work) {
    const opponent = opponents[unit.opponentIndex];
    const level = maxLevelOf(opponent.specs);
    const bucket = level < LEVEL_THRESHOLD ? buckets.low : buckets.high;
    const key = opponent.teamId != null ? `t${opponent.teamId}` : `n${opponent.label}`;
    let entry = perOpponent.get(key);
    if (!entry) {
      entry = { ...opponent, level, battles: 0, tally: emptyTally() };
      perOpponent.set(key, entry);
    }

    for (let i = unit.from; i < unit.to; i++) {
      const rng = createRng(runSeed(seed, unit.opponentIndex, i));
      const result = runBattle(playerSpecs, opponent.specs, { rng });
      tally[result.winner] += 1;
      bucket.tally[result.winner] += 1;
      entry.tally[result.winner] += 1;
      entry.battles += 1;
      bucket.battles += 1;
      battles += 1;

      // Laporan kemajuan hanya membawa hitungan, bukan hasil pertarungan:
      // pemanggil menjumlahkannya sendiri dan tidak perlu data per pertarungan.
      if (onStep && battles % PROGRESS_STEP === 0) {
        onStep({ battles, tally: { ...tally } });
      }

      if (result.winner === 'player') {
        streak += 1;
        if (!headFixed) head += 1;
        if (streak > maxInternal) maxInternal = streak;
      } else {
        // Seri juga memutus streak: bukan kemenangan.
        // Streak pertama (head) sengaja TIDAK dihitung: penggabung yang
        // menyambungnya dengan ekor potongan sebelumnya, dan menghitungnya di
        // sini akan membuat streak itu terhitung dua kali.
        if (streak > 0 && headFixed) { sum += streak; count += 1; }
        streak = 0;
        headFixed = true;
      }
    }

    // Jumlah tim dihitung sekali per lawan, bukan per unit, supaya tim yang
    // terpecah antar-potong tidak terhitung berkali-kali.
    if (unit.from === 0) {
      bucket.teams += 1;
      bucket.levelSum += level;
    }
  }

  return {
    battles,
    tally,
    buckets,
    losses: [...perOpponent.values()].filter(entry => entry.tally.enemy > 0),
    streak: { head, tail: streak, sum, count, maxInternal },
  };
}

module.exports = {
  LEVEL_THRESHOLD, PROGRESS_STEP, maxLevelOf, emptyTally, emptyBucket, rate,
  mixSeed, runSeed, aggregateChunk,
};
