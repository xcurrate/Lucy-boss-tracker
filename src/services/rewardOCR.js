const fs = require('node:fs');
const { PNG } = require('pngjs');
const { createWorker } = require('tesseract.js');

const REGIONS = Object.freeze({
  weapon_shards: [0.10, 0.245],
  weapon_crate: [0.35, 0.493],
  fabled_lootbox: [0.596, 0.738],
  experience: [0.842, 0.984]
});

let workerPromise;
let workerClosed = false;

function cropNumber(image, xStart, xEnd) {
  const x = Math.floor(image.width * xStart);
  const x2 = Math.floor(image.width * xEnd);
  const y = Math.floor(image.height * 0.27);
  const y2 = Math.floor(image.height * 0.57);
  if (x2 <= x || y2 <= y) throw new Error('Area OCR tidak valid.');
  const crop = new PNG({ width: x2 - x, height: y2 - y });
  for (let cy = 0; cy < crop.height; cy++) {
    for (let cx = 0; cx < crop.width; cx++) {
      const si = ((y + cy) * image.width + (x + cx)) * 4;
      const ti = (cy * crop.width + cx) * 4;
      const gray = 0.299 * image.data[si] + 0.587 * image.data[si + 1] + 0.114 * image.data[si + 2];
      const value = gray > 150 ? 0 : 255;
      crop.data[ti] = crop.data[ti + 1] = crop.data[ti + 2] = value;
      crop.data[ti + 3] = 255;
    }
  }
  return PNG.sync.write(crop);
}

async function getWorker() {
  if (workerClosed) throw new Error('OCR worker sudah ditutup.');
  if (!workerPromise) {
    workerPromise = createWorker('eng').then(async worker => {
      await worker.setParameters({ tessedit_char_whitelist: '0123456789,', tessedit_pageseg_mode: '7' });
      return worker;
    }).catch(error => { workerPromise = null; throw error; });
  }
  return workerPromise;
}

// Satu pemanggilan membaca seluruh kategori; null berarti tidak terbaca, bukan nol.
async function readRewards(input) {
  const buffer = Buffer.isBuffer(input) ? input : fs.readFileSync(input);
  const image = PNG.sync.read(buffer);
  if (image.width < 100 || image.height < 50) throw new Error('Resolusi gambar reward terlalu kecil.');
  const worker = await getWorker();
  const results = {};
  for (const [name, [start, end]] of Object.entries(REGIONS)) {
    const { data } = await worker.recognize(cropNumber(image, start, end));
    const digits = String(data.text || '').replace(/[^\\d]/g, '');
    const value = digits ? Number(digits) : null;
    results[name] = Number.isSafeInteger(value) ? value : null;
    console.log('[RewardOCR]', name, results[name], 'confidence:', Number(data.confidence || 0).toFixed(1) + '%');
  }
  return results;
}

async function shutdownOCR() {
  if (!workerPromise) return;
  const worker = await workerPromise.catch(() => null);
  workerClosed = true;
  workerPromise = null;
  if (worker) await worker.terminate();
}

module.exports = { readRewards, shutdownOCR, REGIONS };
