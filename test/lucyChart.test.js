const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');

let dir;
let svc;
let lucyStore;
let chart;

function loadFresh() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}src${path.sep}`)) delete require.cache[key];
  }
  const root = path.resolve(__dirname, '..');
  const { updateGuildSettings } = require(path.join(root, 'src/utils/storage'));
  updateGuildSettings('guild1', s => ({ ...s, lucyCounter: { ...s.lucyCounter, enabled: true } }));
  svc = require(path.join(root, 'src/services/lucyReminder'));
  lucyStore = require(path.join(root, 'src/utils/lucyCounterStorage'));
  chart = require(path.join(root, 'src/services/lucyChart'));
}

const USER = '1444167701080703027';

function dayKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' })
    .format(date);
}

function shift(key, days) {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function seed(counts) {
  const today = dayKey();
  const start = shift(today, -(counts.length - 1));
  counts.forEach((count, i) => {
    const day = shift(start, i);
    for (let n = 0; n < count; n++) {
      lucyStore.recordLucy({
        guildId: 'guild1', userId: USER, name: 'Tester', day,
        cycleKey: 'c', targetActive: false, goal: 0
      });
    }
  });
  return start;
}

function makeMessage(content, userId = USER) {
  const replies = [];
  return {
    id: 'm' + Math.random(),
    content,
    guildId: 'guild1',
    channelId: 'chan1',
    author: { id: userId, bot: false, username: 'Tester' },
    member: { displayName: 'Tester', permissions: { has: () => false } },
    guild: { id: 'guild1', members: { cache: new Map() } },
    client: {},
    createdTimestamp: Date.now(),
    react: async () => {},
    reply: async payload => { replies.push(payload); return { id: 'r' }; },
    replies
  };
}

function stopTimers() {
  for (const timer of svc.timers.values()) clearTimeout(timer);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucychart-'));
  process.chdir(dir);
  loadFresh();
});

afterEach(() => {
  stopTimers();
  process.chdir(path.resolve(__dirname, '..'));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('d chart — detak jantung say Lucy', () => {
  test('default 7 hari mengirim PNG, bukan teks', async () => {
    seed([1, 0, 2, 3, 0, 5, 1]);
    const msg = makeMessage('d chart');
    await svc.handleMessage(msg);
    const reply = msg.replies[0];
    assert.ok(reply?.files?.[0], 'harus mengirim file');
    assert.equal(reply.files[0].name, 'say-lucy.png');
    const png = PNG.sync.read(reply.files[0].attachment);
    assert.equal(png.width, chart.WIDTH);
    assert.equal(png.height, chart.HEIGHT);
  });

  test('gambar memakai garis (bukan batang): ada piksel aksen tersebar horizontal', async () => {
    seed([2, 6, 1, 9, 3, 7, 4]);
    const msg = makeMessage('d chart 7d');
    await svc.handleMessage(msg);
    const png = PNG.sync.read(msg.replies[0].files[0].attachment);
    // Hitung kolom yang memuat warna aksen pada area plot.
    let columns = 0;
    for (let x = 62; x < png.width - 40; x++) {
      for (let y = 84; y < 290; y++) {
        const i = (png.width * y + x) << 2;
        if (Math.abs(png.data[i] - 166) < 50 && Math.abs(png.data[i + 1] - 243) < 50 && Math.abs(png.data[i + 2] - 107) < 50) {
          columns++;
          break;
        }
      }
    }
    assert.ok(columns > 300, `garis harus membentang, dapat ${columns} kolom`);
  });

  test('-sincestart memakai hari pertama user, bukan hari pertama server', async () => {
    // Hari pertama HARUS punya aksi: baris database hanya dibuat saat ada aksi,
    // jadi `-sincestart` berarti hari pertama yang benar-benar tercatat.
    const start = seed([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5]);
    const msg = makeMessage('d chart -sincestart');
    await svc.handleMessage(msg);
    assert.ok(msg.replies[0]?.files?.[0], 'harus mengirim chart');
    const series = lucyStore.dailySeries('guild1', USER, lucyStore.firstDayForUser('guild1', USER), dayKey());
    assert.equal(series[0].day, start);
    assert.equal(series.length, 25);
  });

  test('hari tanpa aksi diisi nol sehingga jeda tidak menyambung', async () => {
    seed([4, 0, 0, 0, 4]);
    const from = shift(dayKey(), -4);
    const series = lucyStore.dailySeries('guild1', USER, from, dayKey());
    assert.equal(series.length, 5);
    assert.deepEqual(series.map(p => p.count), [4, 0, 0, 0, 4]);
  });

  test('chart sangat pendek dilebarkan ke minimal 7 titik', async () => {
    seed([0, 0, 0, 0, 0, 3]);
    const msg = makeMessage('d chart 1d');
    await svc.handleMessage(msg);
    assert.ok(msg.replies[0]?.files?.[0]);
    const series = lucyStore.dailySeries('guild1', USER, shift(dayKey(), -6), dayKey());
    assert.equal(series.length, 7, 'minimal 7 titik');
  });

  test('tanpa data sama sekali dibalas teks, bukan gambar kosong', async () => {
    const msg = makeMessage('d chart');
    await svc.handleMessage(msg);
    assert.equal(msg.replies[0].files, undefined);
    assert.match(msg.replies[0].content, /Belum ada "say Lucy"/);
  });

  test('rentang tidak dikenali ditolak dengan contoh', async () => {
    const msg = makeMessage('d chart 9x');
    await svc.handleMessage(msg);
    assert.equal(msg.replies[0].files, undefined);
    assert.match(msg.replies[0].content, /Rentang tidak dikenali/);
  });

  test('agregasi: rentang panjang digabung per minggu lalu per bulan', () => {
    const make = n => Array.from({ length: n }, (_, i) => ({ day: shift('2026-01-01', i), count: 1 }));
    assert.equal(chart.aggregate(make(7)).unit, 'hari');
    assert.equal(chart.aggregate(make(62)).unit, 'hari');
    const weekly = chart.aggregate(make(63));
    assert.equal(weekly.unit, 'minggu');
    assert.equal(weekly.points.length, 9);
    const monthly = chart.aggregate(make(200));
    assert.equal(monthly.unit, 'bulan');
    assert.ok(monthly.points.length < 200);
  });

  test('agregasi menjumlahkan, tidak menghilangkan data', () => {
    const series = Array.from({ length: 70 }, (_, i) => ({ day: shift('2026-01-01', i), count: 2 }));
    const { points } = chart.aggregate(series);
    assert.equal(points.reduce((s, p) => s + p.count, 0), 140);
  });

  test('garis memakai sambungan lurus, bukan kurva', async () => {
    // Data zigzag ekstrem: kurva halus akan membulat melewati titik, polyline
    // akan tetap lurus dan tajam. Cek bahwa tiap kolom hanya memuat segmen
    // tipis (tidak ada "gundukan" tebal hasil interpolasi).
    seed([0, 12, 0, 12, 0, 12, 0]);
    const msg = makeMessage('d chart 7d');
    await svc.handleMessage(msg);
    const png = PNG.sync.read(msg.replies[0].files[0].attachment);
    const heights = [];
    for (let x = 62; x < png.width - 40; x++) {
      let n = 0;
      for (let y = 84; y < 290; y++) {
        const i = (png.width * y + x) << 2;
        if (Math.abs(png.data[i] - 166) < 50 && Math.abs(png.data[i + 1] - 243) < 50 && Math.abs(png.data[i + 2] - 107) < 50) n++;
      }
      if (n) heights.push(n);
    }
    heights.sort((a, b) => a - b);
    const median = heights[Math.floor(heights.length / 2)];
    assert.ok(median <= 12, `segmen harus tipis (lurus), median ${median}px`);
  });

  test('niceMax membulatkan ke atas dan tidak pernah nol', () => {
    assert.equal(chart.niceMax(0), 4);
    assert.ok(chart.niceMax(7) >= 7);
    assert.ok(chart.niceMax(23) >= 23);
    assert.ok(chart.niceMax(101) >= 101);
  });
});
