// Worker untuk simulasi global. Menerima satu potong daftar lawan, menjalankan
// pertarungannya, lalu mengirim ringkasan — bukan daftar pertarungan.
const { parentPort, workerData } = require('node:worker_threads');
const { aggregateChunk } = require('./globalSimCore');

const { playerSpecs, opponents, units, seed } = workerData;

// Laporan kemajuan dikirim bertahap supaya embed progres bergerak sejak detik
// pertama, bukan menunggu satu potong selesai. Pesan bertipe `progress`; hasil
// akhir tetap satu pesan tanpa tipe.
const result = aggregateChunk(playerSpecs, opponents, {
  seed,
  units,
  onStep: step => parentPort.postMessage({ type: 'progress', ...step }),
});
parentPort.postMessage(result);
