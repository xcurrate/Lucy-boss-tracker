const fs = require('node:fs');
const { PNG } = require('pngjs');
const { createWorker } = require('tesseract.js');

const REGIONS = Object.freeze({
  weapon_shards: [0.08, 0.245],
  weapon_crate: [0.32, 0.493],
  fabled_lootbox: [0.57, 0.738],
  experience: [0.82, 0.984]
});

let workerPromise;
let workerClosed = false;

// Radius blur kotak sebelum threshold: menghaluskan tepi bertingkat (aliasing)
// pada digit agar bentuknya mendekati font yang dikenali Tesseract.
const BLUR_RADIUS = 3;
const ENLARGE_SCALE = 4;

function cropNumber(image, xStart, xEnd) {
  const x = Math.floor(image.width * xStart);
  const x2 = Math.floor(image.width * xEnd);
  const y = Math.floor(image.height * 0.27);
  const y2 = Math.floor(image.height * 0.57);
  if (x2 <= x || y2 <= y) throw new Error('Area OCR tidak valid.');
  const w = x2 - x;
  const h = y2 - y;
  // 1) Grayscale + rata-rata luminance untuk tahu polaritas kartu. Kartu gelap
  //    memakai angka putih, kartu terang memakai angka gelap; tanpa ini angka
  //    putih di latar gelap ikut terhapus saat threshold.
  const gray = new Float64Array(w * h);
  let luminance = 0;
  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      const si = ((y + cy) * image.width + (x + cx)) * 4;
      const g = 0.299 * image.data[si] + 0.587 * image.data[si + 1] + 0.114 * image.data[si + 2];
      gray[cy * w + cx] = g;
      luminance += g;
    }
  }
  const darkBackground = luminance / (w * h) < 128;
  // 2) Blur kotak supaya tepi digit tidak "bergerigi".
  const blurred = new Float64Array(w * h);
  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      let sum = 0;
      let n = 0;
      for (let dy = -BLUR_RADIUS; dy <= BLUR_RADIUS; dy++) {
        for (let dx = -BLUR_RADIUS; dx <= BLUR_RADIUS; dx++) {
          const yy = cy + dy;
          const xx = cx + dx;
          if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue;
          sum += gray[yy * w + xx];
          n++;
        }
      }
      blurred[cy * w + cx] = sum / n;
    }
  }
  // 3) Threshold. Hasilnya selalu tinta gelap di kertas putih: pada kartu
  //    gelap piksel terang adalah tintanya, pada kartu terang piksel gelap.
  const crop = new PNG({ width: w, height: h });
  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      const ti = (cy * w + cx) * 4;
      const lum = blurred[cy * w + cx];
      const ink = darkBackground ? lum > 140 : lum <= 140;
      const v = ink ? 0 : 255;
      crop.data[ti] = crop.data[ti + 1] = crop.data[ti + 2] = v;
      crop.data[ti + 3] = 255;
    }
  }
  // 4) Perbesar sebelum masuk Tesseract.
  const scale = ENLARGE_SCALE;
  const enlarged = new PNG({ width: w * scale, height: h * scale });
  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      const si = (cy * w + cx) * 4;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const ti = (((cy * scale + sy) * enlarged.width) + (cx * scale + sx)) * 4;
          enlarged.data[ti] = crop.data[si];
          enlarged.data[ti + 1] = crop.data[si + 1];
          enlarged.data[ti + 2] = crop.data[si + 2];
          enlarged.data[ti + 3] = 255;
        }
      }
    }
  }
  return PNG.sync.write(enlarged);
}

async function getWorker() {
  if (workerClosed) throw new Error('OCR worker sudah ditutup.');
  if (!workerPromise) {
    workerPromise = createWorker('eng').then(async worker => {
      // PSM 6 (blok teks seragam) lebih andal daripada 7 (satu baris) untuk
      // crop yang hanya berisi satu digit.
      await worker.setParameters({ tessedit_char_whitelist: '0123456789,', tessedit_pageseg_mode: '6' });
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
  // Setiap region diuji dengan beberapa mode segmentasi lalu dipilih lewat
  // SUARA MAYORITAS. PSM 6/7 andal untuk angka panjang, 8/13 untuk digit
  // tunggal; digit tunggal sering tidak terbaca sama sekali pada satu mode,
  // dan mode lain bisa salah baca dengan confidence tinggi — jadi satu mode
  // atau confidence tertinggi saja tidak cukup.
  const recognizeDigits = async (crop) => {
    const tally = new Map(); // digits -> { count, confidence, psm }
    for (const psm of ['6', '7', '8', '13']) {
      await worker.setParameters({ tessedit_char_whitelist: '0123456789,', tessedit_pageseg_mode: psm });
      const { data } = await worker.recognize(crop);
      const digits = String(data.text || '').replace(/[^\d]/g, '');
      if (!digits) continue;
      const confidence = Number(data.confidence || 0);
      const cur = tally.get(digits) || { count: 0, confidence: 0, psm };
      cur.count += 1;
      if (confidence > cur.confidence) {
        cur.confidence = confidence;
        cur.psm = psm;
      }
      tally.set(digits, cur);
    }
    if (!tally.size) return { digits: '', confidence: 0, psm: '-' };
    // Mayoritas menang; seri dipecah dengan confidence tertinggi.
    let best = null;
    for (const [digits, info] of tally) {
      if (!best || info.count > best.info.count
        || (info.count === best.info.count && info.confidence > best.info.confidence)) {
        best = { digits, info };
      }
    }
    return { digits: best.digits, confidence: best.info.confidence, psm: best.info.psm };
  };

  for (const [name, [start, end]] of Object.entries(REGIONS)) {
    const crop = cropNumber(image, start, end);
    const { digits, confidence, psm } = await recognizeDigits(crop);
    const value = digits ? Number(digits) : null;
    results[name] = Number.isSafeInteger(value) ? value : null;
    console.info('[RewardOCR][region] category=' + name + ' cropBytes=' + crop.length + ' digits=' + digits + ' parsed=' + results[name] + ' confidence=' + confidence.toFixed(1) + '% psm=' + psm);
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
