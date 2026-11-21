// Skema poin Family 100.
//
// Tiap soal bernilai total 100 poin (skema C): jawaban di urutan teratas dapat
// bagian terbesar, jawaban paling langka dapat terkecil. Bobotnya menurun
// linier (n, n-1, ..., 1), lalu dibulatkan dengan metode sisa terbesar supaya
// jumlahnya tepat 100 — pembulatan biasa bisa membuat total jadi 99 atau 101.

// Bobot menurun linier (n, n-1, ..., 1) dibulatkan dengan metode sisa terbesar
// supaya totalnya tepat 100 — pembulatan biasa bisa membuat total jadi 99/101.
// Untuk soal dengan banyak jawaban, bobot terbawah bisa jatuh ke 0; kekurangan
// itu diambil dari nilai terbesar, lalu daftarnya diurutkan menurun. Urutan
// menurun itulah yang memetakan poin ke jawaban (jawaban paling populer dapat
// poin terbesar), jadi mengurutkan di akhir tidak mengubah arti.
function pointsFor(count) {
  const n = Math.max(1, Number(count) || 0);
  if (n === 1) return [100];
  const totalWeight = (n * (n + 1)) / 2;
  const exact = Array.from({ length: n }, (_, i) => (100 * (n - i)) / totalWeight);
  const points = exact.map(v => Math.floor(v));
  let remainder = 100 - points.reduce((a, b) => a + b, 0);
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < order.length && remainder > 0; k++, remainder--) points[order[k].i]++;

  for (let i = n - 1; i >= 0 && points[i] < 1; i--) {
    points[i] = 1;
    points[points.indexOf(Math.max(...points))]--;
  }
  return points.sort((a, b) => b - a);
}

module.exports = { pointsFor };
