// Chart "say Lucy" bergaya monitor detak jantung untuk `d chart`.
//
// Garis digambar sebagai polyline tajam (bukan kurva) dengan glow, meniru trace
// monitor jantung: puncak mengikuti jumlah harian, dan hari tanpa aksi jatuh ke
// garis dasar sehingga jeda terlihat sebagai garis datar — bukan dilewati.
//
// Warna mengikuti token dashboard supaya senada dengan tampilan web.

const { createCanvas } = require('@napi-rs/canvas');
const { formatIndonesianDate } = require('./lucyCounter');

const THEME = {
  bg: '#10131b',
  surface: '#171c27',
  grid: '#2a3343',
  text: '#edf1f8',
  muted: '#8e9aae',
  accent: '#a6f36b',
  fillTop: 'rgba(166, 243, 107, 0.20)',
  fillBottom: 'rgba(166, 243, 107, 0.00)'
};

const WIDTH = 900;
const HEIGHT = 340;
const PAD = { top: 84, right: 40, bottom: 52, left: 62 };

// Di atas ambang ini, titik harian digabung per minggu lalu per bulan supaya
// garisnya tetap terbaca (bukan jadi noise).
const DAILY_LIMIT = 62;
const WEEKLY_LIMIT = 130;

function aggregate(series) {
  if (series.length <= DAILY_LIMIT) return { points: series, unit: 'hari' };
  if (series.length <= WEEKLY_LIMIT) return { points: groupBy(series, 7, 'minggu'), unit: 'minggu' };
  return { points: groupBy(series, 30, 'bulan'), unit: 'bulan' };
}

function groupBy(series, size, unit) {
  const points = [];
  for (let i = 0; i < series.length; i += size) {
    const chunk = series.slice(i, i + size);
    points.push({
      day: chunk[0].day,
      count: chunk.reduce((sum, p) => sum + p.count, 0),
      unit
    });
  }
  return points;
}

function niceMax(value) {
  if (value <= 0) return 4;
  const step = Math.pow(10, Math.floor(Math.log10(value)));
  for (const factor of [1, 2, 2.5, 5, 10]) {
    const candidate = step * factor;
    if (candidate >= value) return candidate;
  }
  return step * 10;
}

function shortDate(key) {
  const [, , day] = String(key).split('-');
  return `${Number(day)} ${formatIndonesianDate(key).split(' ')[1]}`;
}

// Polyline: sambungan LURUS antar titik, tanpa lekukan. Dipakai untuk garis
// utama maupun area di bawahnya supaya bentuknya konsisten.
function straightPath(ctx, coords) {
  ctx.beginPath();
  ctx.moveTo(coords[0].x, coords[0].y);
  for (let i = 1; i < coords.length; i++) ctx.lineTo(coords[i].x, coords[i].y);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function renderLucyChart({ name, series, rangeLabel }) {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');
  const { points, unit } = aggregate(series);

  const total = points.reduce((sum, p) => sum + p.count, 0);
  const peak = points.reduce((best, p) => (p.count > best.count ? p : best), points[0] || { count: 0 });
  const max = niceMax(Math.max(...points.map(p => p.count), 0));

  ctx.fillStyle = THEME.bg;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.fillStyle = THEME.surface;
  roundRect(ctx, 16, 16, WIDTH - 32, HEIGHT - 32, 16);
  ctx.fill();

  // Judul + ringkasan
  ctx.fillStyle = THEME.accent;
  ctx.font = 'bold 24px sans-serif';
  ctx.fillText('Say Lucy', 40, 56);
  const titleWidth = ctx.measureText('Say Lucy').width;
  ctx.fillStyle = THEME.text;
  ctx.fillText(`— ${name}`, 40 + titleWidth + 10, 56);

  ctx.fillStyle = THEME.muted;
  ctx.font = '15px sans-serif';
  ctx.fillText(rangeLabel, 40, 78);

  ctx.textAlign = 'right';
  ctx.fillStyle = THEME.accent;
  ctx.font = 'bold 30px sans-serif';
  ctx.fillText(String(total), WIDTH - 40, 56);
  ctx.fillStyle = THEME.muted;
  ctx.font = '13px sans-serif';
  ctx.fillText(`total • puncak ${peak.count}`, WIDTH - 40, 78);
  ctx.textAlign = 'left';

  const plot = {
    x: PAD.left,
    y: PAD.top,
    w: WIDTH - PAD.left - PAD.right,
    h: HEIGHT - PAD.top - PAD.bottom
  };
  const baseY = plot.y + plot.h;
  const stepX = points.length > 1 ? plot.w / (points.length - 1) : 0;
  const yFor = value => baseY - (value / max) * plot.h;
  const coords = points.map((p, i) => ({ x: plot.x + i * stepX, y: yFor(p.count) }));

  // Grid + label sumbu Y (rata kiri supaya tidak bertumpuk garis).
  ctx.strokeStyle = THEME.grid;
  ctx.lineWidth = 1;
  ctx.font = '12px sans-serif';
  for (let i = 0; i <= 4; i++) {
    const value = Math.round((max / 4) * i);
    const y = baseY - (i / 4) * plot.h;
    ctx.beginPath();
    ctx.moveTo(plot.x, y);
    ctx.lineTo(plot.x + plot.w, y);
    ctx.stroke();
    ctx.fillStyle = THEME.muted;
    ctx.fillText(String(value), 20, y + 4);
  }

  // Area di bawah kurva
  const fill = ctx.createLinearGradient(0, plot.y, 0, baseY);
  fill.addColorStop(0, THEME.fillTop);
  fill.addColorStop(1, THEME.fillBottom);
  straightPath(ctx, coords);
  ctx.lineTo(coords[coords.length - 1].x, baseY);
  ctx.lineTo(coords[0].x, baseY);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();

  // Glow tipis lalu garis utama — inilah yang memberi kesan monitor.
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(166, 243, 107, 0.18)';
  ctx.lineWidth = 9;
  straightPath(ctx, coords);
  ctx.stroke();
  ctx.strokeStyle = THEME.accent;
  ctx.lineWidth = 2.5;
  straightPath(ctx, coords);
  ctx.stroke();

  // Titik pada hari yang ada aksinya
  ctx.fillStyle = THEME.accent;
  points.forEach((p, i) => {
    if (p.count <= 0) return;
    ctx.beginPath();
    ctx.arc(coords[i].x, coords[i].y, 3.5, 0, Math.PI * 2);
    ctx.fill();
  });

  // Label sumbu X: maksimal 6 supaya tidak bertumpuk.
  const ticks = Math.min(6, points.length);
  ctx.fillStyle = THEME.muted;
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'center';
  for (let i = 0; i < ticks; i++) {
    const index = Math.round((i / Math.max(1, ticks - 1)) * (points.length - 1));
    ctx.fillText(shortDate(points[index].day), coords[index].x, baseY + 24);
  }
  ctx.textAlign = 'left';

  ctx.fillStyle = THEME.muted;
  ctx.font = '12px sans-serif';
  const perPoint = unit === 'hari' ? 'per hari' : `per ${unit}`;
  ctx.fillText(`${points.length} titik • ${perPoint}`, plot.x, HEIGHT - 24);

  return canvas.toBuffer('image/png');
}

module.exports = { renderLucyChart, aggregate, niceMax, THEME, WIDTH, HEIGHT };
