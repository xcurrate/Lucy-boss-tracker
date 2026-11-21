// Simulasi global: tim aktif melawan SELURUH tim tersimpan milik user lain.
//
// Jumlah pertarungan bisa sangat besar (jutaan), jadi pekerjaan dipecah ke
// beberapa worker thread. Proses utama tetap bisa melayani pesan Discord
// selama simulasi berjalan, dan hasilnya dikirim sebagai ringkasan.
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { randomSeed } = require('./battleRng');
const {
  LEVEL_THRESHOLD, emptyTally, emptyBucket, rate, aggregateChunk,
} = require('./globalSimCore');

const WORKER_FILE = path.join(__dirname, 'globalSimWorker.js');

// Batas aman jumlah worker: hyperthread tidak menambah throughput pada beban
// ini, dan tiap worker memakai memori sendiri.
const MAX_WORKERS = Math.max(1, Math.min(4, os.availableParallelism()));

// Di bawah ambang ini, biaya membuat worker lebih besar dari manfaatnya.
const MIN_BATTLES_FOR_WORKERS = 20000;

// Jeda minimum antar laporan progres ke pemanggil. Worker melapor jauh lebih
// sering; menyaring di sini menjaga event loop tetap lapang tanpa mengubah
// ketelitian angka (laporan terakhir selalu dikirim).
const PROGRESS_EMIT_MS = 200;

// Hanya satu simulasi berat boleh berjalan pada satu waktu: dua simulasi
// jutaan pertarungan bersamaan akan berebut core yang sama, saling
// memperlambat, dan memakai memori dua kali. Permintaan lain mengantre.
const MAX_QUEUE = 3;
let active = 0;
const waiting = [];

function acquireSlot() {
  if (active === 0) {
    active += 1;
    return Promise.resolve();
  }
  if (waiting.length >= MAX_QUEUE) {
    return Promise.reject(new Error('Antrean simulasi penuh. Coba lagi sebentar lagi.'));
  }
  return new Promise(resolve => waiting.push(resolve));
}

function releaseSlot() {
  const next = waiting.shift();
  if (next) next();
  else active = 0;
}

function queueInfo() {
  return { active, waiting: waiting.length };
}

function planWorkers(opponentCount, runs) {
  if (opponentCount < 1) return 1;
  if (opponentCount * runs < MIN_BATTLES_FOR_WORKERS) return 1;
  // Pekerjaan dipecah per rentang run, jadi satu tim lawan pun bisa dibagi ke
  // beberapa worker selama jumlah pertarungannya cukup banyak.
  return MAX_WORKERS;
}

// Bagi pekerjaan menjadi potongan yang ukurannya hampir sama, menjaga urutan
// agar streak bisa disambung. Satuannya rentang run, bukan tim, supaya satu tim
// dengan jutaan pertarungan tetap bisa dibagi ke beberapa worker.
function splitWork(opponentCount, runs, parts) {
  const total = opponentCount * runs;
  const size = Math.ceil(total / parts);
  const chunks = [];
  let current = { units: [], battles: 0 };
  let remaining = size;

  for (let o = 0; o < opponentCount; o++) {
    let from = 0;
    while (from < runs) {
      const take = Math.min(runs - from, remaining);
      current.units.push({ opponentIndex: o, from, to: from + take });
      current.battles += take;
      remaining -= take;
      from += take;
      if (remaining <= 0) {
        chunks.push(current);
        current = { units: [], battles: 0 };
        remaining = size;
      }
    }
  }
  if (current.units.length) chunks.push(current);
  return chunks;
}

function runChunkInWorker(playerSpecs, opponents, chunk, { seed, onProgress }) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_FILE, {
      workerData: { playerSpecs, opponents, units: chunk.units, seed },
    });
    let settled = false;
    worker.on('message', message => {
      // Pesan `progress` datang berkali-kali; hasil akhir tidak bertipe dan
      // hanya dikirim sekali di akhir.
      if (message && message.type === 'progress') {
        if (onProgress) onProgress(message);
        return;
      }
      settled = true;
      worker.terminate().catch(() => {});
      resolve(message);
    });
    worker.once('error', error => {
      if (settled) return;
      settled = true;
      worker.terminate().catch(() => {});
      reject(error);
    });
    worker.once('exit', code => {
      // Worker keluar tanpa mengirim hasil: jangan biarkan Promise menggantung.
      if (settled) return;
      settled = true;
      reject(new Error(`Worker simulasi berhenti tanpa hasil (kode ${code}).`));
    });
  });
}

// Gabungkan ringkasan potongan. Urutan potongan harus urutan asli lawan supaya
// streak yang melewati batas potong bisa disambung.
function mergeChunks(chunks) {
  const tally = emptyTally();
  const buckets = { low: emptyBucket('low'), high: emptyBucket('high') };
  // Satu tim bisa terpecah ke beberapa potong, jadi hasilnya dijumlahkan per
  // kunci tim sebelum dipakai sebagai daftar kekalahan.
  const perOpponent = new Map();

  let battles = 0;
  let maxStreak = 0;
  let sum = 0;
  let count = 0;
  let run = 0; // streak yang sedang berjalan dan belum ditutup

  for (const chunk of chunks) {
    battles += chunk.battles;
    for (const key of ['player', 'enemy', 'tie']) {
      tally[key] += chunk.tally[key];
      buckets.low.tally[key] += chunk.buckets.low.tally[key];
      buckets.high.tally[key] += chunk.buckets.high.tally[key];
    }
    for (const key of ['low', 'high']) {
      buckets[key].teams += chunk.buckets[key].teams;
      buckets[key].battles += chunk.buckets[key].battles;
      buckets[key].levelSum += chunk.buckets[key].levelSum;
    }
    for (const loss of chunk.losses) {
      const key = loss.teamId != null ? `t${loss.teamId}` : `n${loss.label}`;
      const entry = perOpponent.get(key);
      if (!entry) {
        perOpponent.set(key, { ...loss, tally: { ...loss.tally } });
      } else {
        for (const k of ['player', 'enemy', 'tie']) entry.tally[k] += loss.tally[k];
        entry.battles += loss.battles;
      }
    }

    const s = chunk.streak;
    if (s.maxInternal > maxStreak) maxStreak = s.maxInternal;

    // Rangkaian yang dibuka potongan sebelumnya disambung ke ekor potongan ini.
    run += s.head;
    if (s.head === chunk.battles) {
      // Seluruh potong menang: rangkaian masih terbuka.
      if (run > maxStreak) maxStreak = run;
      continue;
    }
    // Potong ini punya kekalahan, jadi rangkaian tertutup di sini.
    if (run > 0) { sum += run; count += 1; if (run > maxStreak) maxStreak = run; }
    sum += s.sum;
    count += s.count;
    run = s.tail;
    if (run > maxStreak) maxStreak = run;
  }
  if (run > 0) { sum += run; count += 1; if (run > maxStreak) maxStreak = run; }

  const summarize = bucket => ({
    ...bucket,
    avgLevel: bucket.teams ? Math.round((bucket.levelSum / bucket.teams) * 10) / 10 : 0,
    winRate: rate(bucket.tally.player, bucket.battles),
    lossRate: rate(bucket.tally.enemy, bucket.battles),
    tieRate: rate(bucket.tally.tie, bucket.battles),
    avgWins: bucket.teams ? Math.round((bucket.tally.player / bucket.teams) * 10) / 10 : 0,
    avgLosses: bucket.teams ? Math.round((bucket.tally.enemy / bucket.teams) * 10) / 10 : 0,
  });

  const opponentCount = buckets.low.teams + buckets.high.teams;
  const losses = [...perOpponent.values()];
  return {
    battles,
    tally,
    winRate: rate(tally.player, battles),
    lossRate: rate(tally.enemy, battles),
    tieRate: rate(tally.tie, battles),
    streak: { avg: count ? Math.round((sum / count) * 10) / 10 : 0, max: maxStreak, count },
    avgLosses: opponentCount ? Math.round((tally.enemy / opponentCount) * 10) / 10 : 0,
    buckets: { low: summarize(buckets.low), high: summarize(buckets.high) },
    losses,
  };
}

// `opponents` = [{ label, teamId, slotId, specs }]. Setiap lawan dijalankan
// `runs` kali; urutannya tetap supaya streak bermakna.
async function runGlobalSim(playerSpecs, opponents, {
  runs = 100, seed = randomSeed(), workers = null, onProgress,
} = {}) {
  await acquireSlot();
  try {
    return await runSimulation(playerSpecs, opponents, { runs, seed, workers, onProgress });
  } finally {
    releaseSlot();
  }
}

async function runSimulation(playerSpecs, opponents, { runs, seed, workers, onProgress }) {
  const runCount = Math.max(1, Math.floor(Number(runs) || 1));
  const startedAt = Date.now();
  const total = runCount * opponents.length;
  const parts = workers || planWorkers(opponents.length, runCount);

  // Simulasi besar selalu lewat worker, termasuk saat hanya ada satu worker
  // (mesin satu core): dengan begitu loop tidak memblokir bot dan progres tetap
  // bisa dilaporkan bertahap. `workers` yang diminta eksplisit selalu dihormati
  // supaya pemanggil dan tes bisa memaksa pembagian tertentu.
  const useWorkers = workers != null ? parts > 1 : total >= MIN_BATTLES_FOR_WORKERS;

  let chunks;
  if (!useWorkers) {
    // Satu potong: jalankan di proses ini. Simulasi kecil selesai lebih cepat
    // tanpa biaya membuat worker.
    chunks = [aggregateChunk(playerSpecs, opponents, {
      seed,
      units: splitWork(opponents.length, runCount, 1)[0].units,
    })];
    if (onProgress) {
      await onProgress({
        done: total,
        total,
        etaMs: 0,
        tally: { ...chunks[0].tally },
        winRate: rate(chunks[0].tally.player, total),
        lossRate: rate(chunks[0].tally.enemy, total),
        tieRate: rate(chunks[0].tally.tie, total),
        avgTurns: 0,
      });
    }
  } else {
    const plan = splitWork(opponents.length, runCount, parts);
    const startedAt = Date.now();
    const results = new Array(plan.length);
    // Hitungan disimpan per potong, bukan sebagai akumulator: laporan dari
    // worker datang bertahap, jadi total yang benar adalah menjumlahkan nilai
    // TERAKHIR tiap potong. Menambahkan delta akan menghitung ganda.
    const chunkBattles = new Array(plan.length).fill(0);
    const chunkTally = plan.map(() => emptyTally());

    const emit = () => {
      if (!onProgress) return;
      let done = 0;
      const tally = emptyTally();
      for (let i = 0; i < plan.length; i++) {
        done += chunkBattles[i];
        for (const k of ['player', 'enemy', 'tie']) tally[k] += chunkTally[i][k];
      }
      const elapsed = Date.now() - startedAt;
      onProgress({
        done,
        total,
        etaMs: done > 0 ? Math.round((elapsed / done) * (total - done)) : null,
        tally,
        winRate: rate(tally.player, done),
        lossRate: rate(tally.enemy, done),
        tieRate: rate(tally.tie, done),
        avgTurns: 0,
      });
    };

    // Laporan pertama dikirim sebelum worker dijalankan supaya embed progres
    // muncul sejak awal, bukan menunggu potongan pertama selesai.
    emit();

    let lastEmit = Date.now();
    const handleStep = (i, step) => {
      chunkBattles[i] = step.battles;
      chunkTally[i] = step.tally;
      if (Date.now() - lastEmit < PROGRESS_EMIT_MS) return;
      lastEmit = Date.now();
      emit();
    };

    await Promise.all(plan.map((chunk, i) => runChunkInWorker(playerSpecs, opponents, chunk, {
      seed,
      onProgress: step => handleStep(i, step),
    }).then(result => {
      results[i] = result;
      chunkBattles[i] = result.battles;
      chunkTally[i] = result.tally;
      emit();
    })));
    chunks = results;
  }

  const merged = mergeChunks(chunks);
  merged.losses.sort((a, b) => b.tally.enemy - a.tally.enemy || a.label.localeCompare(b.label));

  return {
    seed,
    runs: runCount,
    opponents: opponents.length,
    workers: parts,
    battles: merged.battles,
    durationMs: Date.now() - startedAt,
    ...merged,
  };
}

module.exports = {
  LEVEL_THRESHOLD, runGlobalSim, rate, mergeChunks, planWorkers, splitWork,
  MAX_WORKERS, queueInfo, MAX_QUEUE, MIN_BATTLES_FOR_WORKERS,
};
