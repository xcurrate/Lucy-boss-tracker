const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const store = require(path.join(ROOT, 'src/utils/battleTeamStorage'));
const globalSim = require(path.join(ROOT, 'src/services/globalSim'));
const panel = require(path.join(ROOT, 'src/ui/battlePanel'));
const {
  handleSimCommand, handleGlobalLossButton, resolveRunCount,
  GLOBAL_COOLDOWN_MS, DEFAULT_GLOBAL_RUNS, MAX_GLOBAL_BATTLES,
} = require(path.join(ROOT, 'src/commands/battleSim'));
const engine = require(path.join(ROOT, 'src/services/battleEngine'));
const core = require(path.join(ROOT, 'src/services/globalSimCore'));
const rngModule = require(path.join(ROOT, 'src/services/battleRng'));

// Stat kuat vs lemah supaya arah hasilnya pasti, bukan acak.
const COEFFS_STRONG = { hp: 8, att: 6, pr: 2, wp: 3, mag: 5, mr: 1 };
const COEFFS_WEAK = { hp: 4, att: 2, pr: 3, wp: 1, mag: 1, mr: 2 };

function message(content, id = 'me') {
  return { guildId: 'g', author: { id }, content };
}

// Tim lawan dengan level berbeda untuk menguji pemisahan kelompok.
function seedWorld() {
  store.createTeam('me', 'Milikku');
  store.setSlot('me', 'Milikku', 1, { custom: COEFFS_STRONG, level: 80 });
  store.setActiveTeam('me', 'Milikku');

  store.createTeam('rival', 'Lemah');
  store.setSlot('rival', 'Lemah', 1, { custom: COEFFS_WEAK, level: 20 });

  store.createTeam('rival', 'Kuat');
  store.setSlot('rival', 'Kuat', 1, { custom: COEFFS_STRONG, level: 90 });
}

describe('simulasi global', () => {
  let tempDir;
  let replies;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucy-global-sim-'));
    process.chdir(tempDir);
    store.getDb();
    replies = [];
  });

  afterEach(() => {
    // Kembali ke root sebelum direktori sementara dihapus: worker thread butuh
    // cwd yang masih ada.
    process.chdir(ROOT);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // Tanpa `.edit`, pengirim dianggap tidak bisa diedit: hasil akhir dikirim
  // lewat sendPayload. Ini jalur yang dipakai tes untuk memeriksa payload.
  const sendEmbed = (m, embed) => { replies.push(embed.toJSON()); return null; };

  it('memakai semua tim tersimpan sebagai lawan, kecuali tim yang dipilih', () => {
    seedWorld();
    store.createTeam('me', 'Cadanganku');
    store.setSlot('me', 'Cadanganku', 1, { custom: COEFFS_WEAK, level: 40 });
    const active = store.getActiveTeam('me');
    const opponents = store.listOpponentTeams('me', active.id);
    // Tim lain milik user sendiri tetap ikut; hanya tim yang dipilih yang keluar.
    assert.strictEqual(opponents.length, 3);
    assert.ok(!opponents.some(t => t.id === active.id));
    assert.ok(opponents.some(t => t.userId === 'me'), 'tim lain milik sendiri ikut diadu');
    assert.ok(opponents.some(t => t.userId === 'rival'));
  });

  it('membagi hasil menurut level tim lawan pada batas 35', async () => {
    seedWorld();
    const player = require(path.join(ROOT, 'src/commands/battleSim')).resolveTeamSpecs(store.getActiveTeam('me'));
    const opponents = store.listOpponentTeams('me', store.getActiveTeam('me').id).map(t => ({
      label: t.name,
      specs: require(path.join(ROOT, 'src/commands/battleSim')).resolveTeamSpecs(t).specs,
    }));

    const result = await globalSim.runGlobalSim(player.specs, opponents, { runs: 20, seed: 7, yieldEvery: 0 });

    assert.strictEqual(result.battles, 40);
    assert.strictEqual(result.buckets.low.teams, 1, 'satu tim di bawah 35');
    assert.strictEqual(result.buckets.high.teams, 1, 'satu tim 35 ke atas');
    assert.strictEqual(result.buckets.low.avgLevel, 20);
    assert.strictEqual(result.buckets.high.avgLevel, 90);
    // Total kedua kelompok harus sama dengan rekap keseluruhan.
    const sum = result.buckets.low.tally.player + result.buckets.high.tally.player;
    assert.strictEqual(sum, result.tally.player);
  });

  it('menghitung streak hanya dari kemenangan berturut-turut', async () => {
    // Tim sangat kuat melawan tim sangat lemah: semua menang, streak = jumlah laga.
    store.createTeam('me', 'Dewa');
    store.setSlot('me', 'Dewa', 1, { custom: { hp: 40, att: 40, pr: 10, wp: 10, mag: 40, mr: 10 }, level: 500 });
    store.createTeam('rival', 'Cupu');
    store.setSlot('rival', 'Cupu', 1, { custom: COEFFS_WEAK, level: 1 });

    const cmd = require(path.join(ROOT, 'src/commands/battleSim'));
    const player = cmd.resolveTeamSpecs(store.getTeam('me', 'Dewa'));
    const opponent = cmd.resolveTeamSpecs(store.getTeam('rival', 'Cupu'));
    const result = await globalSim.runGlobalSim(player.specs, [{ label: 'Cupu', specs: opponent.specs }], {
      runs: 10, seed: 3, yieldEvery: 0,
    });

    assert.strictEqual(result.tally.player, 10);
    assert.strictEqual(result.streak.max, 10);
    assert.strictEqual(result.streak.avg, 10);
  });

  it('mencatat tim yang mengalahkan pemain beserta jumlah kekalahannya', async () => {
    store.createTeam('me', 'Lemah');
    store.setSlot('me', 'Lemah', 1, { custom: COEFFS_WEAK, level: 5 });
    store.createTeam('rival', 'Kuat');
    store.setSlot('rival', 'Kuat', 1, { custom: { hp: 40, att: 40, pr: 10, wp: 10, mag: 40, mr: 10 }, level: 500 });

    const cmd = require(path.join(ROOT, 'src/commands/battleSim'));
    const player = cmd.resolveTeamSpecs(store.getTeam('me', 'Lemah'));
    const opponent = cmd.resolveTeamSpecs(store.getTeam('rival', 'Kuat'));
    const result = await globalSim.runGlobalSim(player.specs, [{ label: 'Kuat', specs: opponent.specs }], {
      runs: 5, seed: 11, yieldEvery: 0,
    });

    assert.strictEqual(result.tally.enemy, 5);
    assert.strictEqual(result.losses.length, 1);
    assert.strictEqual(result.losses[0].label, 'Kuat');
    assert.strictEqual(result.losses[0].tally.enemy, 5);
    assert.strictEqual(result.avgLosses, 5);
  });

  it('menyembunyikan ikon senjata pada daftar kekalahan', async () => {
    store.createTeam('me', 'Lemah');
    store.setSlot('me', 'Lemah', 1, { custom: COEFFS_WEAK, level: 5 });
    store.createTeam('rival', 'Bersenjata');
    store.setSlot('rival', 'Bersenjata', 1, {
      custom: { hp: 40, att: 40, pr: 10, wp: 10, mag: 40, mr: 10 },
      level: 500,
      weaponId: 1,
      weaponQuality: 90,
    });

    const cmd = require(path.join(ROOT, 'src/commands/battleSim'));
    const player = cmd.resolveTeamSpecs(store.getTeam('me', 'Lemah'));
    const opponent = cmd.resolveTeamSpecs(store.getTeam('rival', 'Bersenjata'));
    const result = await globalSim.runGlobalSim(player.specs, [{ label: 'Bersenjata', specs: opponent.specs }], {
      runs: 5, seed: 13, yieldEvery: 0,
    });

    const embed = panel.globalLossesEmbed(result, { playerLabel: 'Lemah' }).toJSON();
    const body = JSON.stringify(embed);
    assert.ok(body.includes('❓'), 'senjata diganti tanda tanya');
    assert.ok(body.includes('Bersenjata'));
    assert.ok(!body.includes('Great Sword'), 'nama senjata tidak bocor');
  });

  // Slot tanpa senjata jangan diberi tanda tanya: itu menyiratkan ada senjata
  // yang disembunyikan padahal kosong.
  it('tidak menaruh tanda tanya pada slot tanpa senjata', async () => {
    store.createTeam('me', 'Lemah');
    store.setSlot('me', 'Lemah', 1, { custom: COEFFS_WEAK, level: 5 });
    store.createTeam('rival', 'Kosong');
    store.setSlot('rival', 'Kosong', 1, { custom: { hp: 40, att: 40, pr: 10, wp: 10, mag: 40, mr: 10 }, level: 500 });

    const cmd = require(path.join(ROOT, 'src/commands/battleSim'));
    const player = cmd.resolveTeamSpecs(store.getTeam('me', 'Lemah'));
    const opponent = cmd.resolveTeamSpecs(store.getTeam('rival', 'Kosong'));
    const result = await globalSim.runGlobalSim(player.specs, [{ label: 'Kosong', specs: opponent.specs }], {
      runs: 5, seed: 17, yieldEvery: 0,
    });

    const body = JSON.stringify(panel.globalLossesEmbed(result, { playerLabel: 'Lemah' }).toJSON());
    assert.ok(!body.includes('❓'), 'tidak ada tanda tanya untuk slot kosong');
  });

  it('menjawab tombol kekalahan sebagai pesan ephemeral', async () => {
    seedWorld();
    let payload = null;
    await handleSimCommand(message('d sim global -m 5 -s 5'), ['global', '-m', '5', '-s', '5'], 'd', {
      sendEmbed,
      sendPayload: (m, p) => { payload = p; return { edit: async () => {} }; },
      isDeveloper: () => true,
    });
    assert.ok(payload?.components?.length, 'hasil global mengirim tombol');

    const customId = payload.components[0].components[0].toJSON().custom_id;
    let reply = null;
    await handleGlobalLossButton({
      customId,
      user: { id: 'me' },
      reply: async p => { reply = p; },
    });
    assert.ok(reply.flags & 64, 'balasan ephemeral');
    assert.ok(reply.embeds[0].toJSON().title.includes('mengalahkan'));
  });

  it('menolak membuka tombol milik user lain', async () => {
    let reply = null;
    await handleGlobalLossButton({
      customId: `battle_global_losses:someone-else:abc`,
      user: { id: 'u' },
      reply: async p => { reply = p; },
    });
    assert.ok(reply.flags & 64);
    assert.ok(reply.content.includes('milik orang lain'));
  });

  it('memberi cooldown 10 detik untuk selain developer', async () => {
    seedWorld();
    const deps = { sendEmbed, isDeveloper: () => false };
    await handleSimCommand(message('d sim global -m 2 -s 1'), ['global', '-m', '2', '-s', '1'], 'd', deps);
    const left = store.cooldownRemaining('me', 'sim-global');
    assert.ok(left > 0 && left <= GLOBAL_COOLDOWN_MS, `sisa cooldown ${left}`);

    replies = [];
    await handleSimCommand(message('d sim global -m 2 -s 2'), ['global', '-m', '2', '-s', '2'], 'd', deps);
    assert.strictEqual(replies.length, 1);
    assert.ok(replies[0].description.includes('baru bisa dipakai lagi'));
  });

  it('developer melewati cooldown simulasi global', async () => {
    seedWorld();
    const deps = { sendEmbed, isDeveloper: () => true };
    await handleSimCommand(message('d sim global -m 2 -s 1'), ['global', '-m', '2', '-s', '1'], 'd', deps);
    assert.strictEqual(store.cooldownRemaining('me', 'sim-global'), 0);
  });

  it('`d sim g` adalah alias yang sama dengan `d sim global`', async () => {
    seedWorld();
    let payload = null;
    await handleSimCommand(message('d sim g -m 2 -s 4'), ['g', '-m', '2', '-s', '4'], 'd', {
      sendEmbed,
      sendPayload: (m, p) => { payload = p; return { edit: async () => {} }; },
      isDeveloper: () => true,
    });
    const embed = payload.embeds[0].toJSON();
    assert.ok(embed.title.includes('Simulasi Global'));
  });

  it('menolak bila belum ada tim lawan dari user lain', async () => {
    store.createTeam('me', 'Sendiri');
    store.setSlot('me', 'Sendiri', 1, { custom: COEFFS_STRONG, level: 50 });
    store.setActiveTeam('me', 'Sendiri');

    await handleSimCommand(message('d sim global -m 1'), ['global', '-m', '1'], 'd', { sendEmbed, isDeveloper: () => true });
    assert.ok(replies[0].description.includes('Belum ada tim lawan'));
  });

  it('embed hasil memuat semua angka yang diminta', async () => {
    seedWorld();
    let payload = null;
    await handleSimCommand(message('d sim global -m 5 -s 9'), ['global', '-m', '5', '-s', '9'], 'd', {
      sendEmbed,
      sendPayload: (m, p) => { payload = p; return { edit: async () => {} }; },
      isDeveloper: () => true,
    });
    const embed = payload.embeds[0].toJSON();
    const names = embed.fields.map(f => f.name).join(' | ');
    const body = JSON.stringify(embed);

    assert.ok(names.includes('Max level < 35'));
    assert.ok(names.includes('Max level ≥ 35'));
    assert.ok(body.includes('Streak'), 'ada rata-rata streak');
    assert.ok(body.includes('Kalah per tim'), 'ada rata-rata kalah');
    assert.ok(body.includes('menang') && body.includes('seri') && body.includes('kalah'));
  });
});

describe('jumlah pertarungan simulasi global', () => {
  it('memakai default yang besar supaya winrate stabil', () => {
    assert.ok(DEFAULT_GLOBAL_RUNS >= 1000, `default ${DEFAULT_GLOBAL_RUNS}`);
    const out = resolveRunCount({}, 5);
    assert.strictEqual(out.value, DEFAULT_GLOBAL_RUNS);
    assert.strictEqual(out.total, DEFAULT_GLOBAL_RUNS * 5);
  });

  it('menerima -m sebagai jumlah per tim', () => {
    assert.strictEqual(resolveRunCount({ '-m': '500' }, 4).value, 500);
    assert.strictEqual(resolveRunCount({ '-m': '500' }, 4).total, 2000);
  });

  it('membagi -total rata ke semua tim', () => {
    const out = resolveRunCount({ '-total': '1000000' }, 8);
    assert.strictEqual(out.value, 125000);
    assert.strictEqual(out.total, 1000000);
    // Pembulatan ke bawah: total tidak boleh melebihi yang diminta.
    const odd = resolveRunCount({ '-total': '1000' }, 3);
    assert.strictEqual(odd.value, 333);
    assert.ok(odd.value * 3 <= 1000);
  });

  it('menolak permintaan di atas batas dan menyebut nilai maksimumnya', () => {
    const out = resolveRunCount({ '-m': String(MAX_GLOBAL_BATTLES) }, 10);
    assert.ok(out.error.includes('Terlalu besar'));
    assert.ok(out.error.includes('Maksimum'));
    assert.ok(resolveRunCount({ '-total': String(MAX_GLOBAL_BATTLES + 1) }, 2).error.includes('Maksimum'));
  });

  it('menolak -m dan -total sekaligus', () => {
    const out = resolveRunCount({ '-m': '10', '-total': '100' }, 3);
    assert.ok(out.error.includes('salah satu'));
  });

  it('menolak angka nol, negatif, dan bukan angka', () => {
    for (const bad of ['0', '-5', 'abc', '1.5']) {
      assert.ok(resolveRunCount({ '-m': bad }, 3).error, `-m ${bad} harus ditolak`);
    }
  });
});

describe('paralelisasi simulasi global', () => {
  const COEFFS_A = { hp: 6, att: 5, pr: 4, wp: 4, mag: 5, mr: 4 };
  const P = [{ slot: 1, label: 'p', level: 80, coeffs: COEFFS_A, customStats: true, animal: null, finalStats: null }];
  const mk = (lv, i) => [{
    slot: 1, label: 'e' + i, level: lv, coeffs: COEFFS_A,
    customStats: true, animal: null, finalStats: null,
    weapon: { id: 3, quality: 50 + i * 5, passives: [1] },
  }];
  const opps = [60, 80, 95, 101, 70].map((lv, i) => ({ label: 't' + i, teamId: i, specs: mk(lv, i) }));

  // Referensi: jalankan sendiri lalu hitung streak dengan cara paling lugas.
  function reference(seed, runs) {
    const seq = [];
    opps.forEach((o, idx) => {
      for (let i = 0; i < runs; i++) {
        seq.push(engine.runBattle(P, o.specs, { rng: rngModule.createRng(core.runSeed(seed, idx, i)) }).winner);
      }
    });
    let cur = 0; let sum = 0; let count = 0; let max = 0;
    const tally = { player: 0, enemy: 0, tie: 0 };
    for (const w of seq) {
      tally[w] += 1;
      if (w === 'player') { cur += 1; max = Math.max(max, cur); }
      else { if (cur > 0) { sum += cur; count += 1; } cur = 0; }
    }
    if (cur > 0) { sum += cur; count += 1; }
    return { tally, max, avg: count ? Math.round((sum / count) * 10) / 10 : 0, count };
  }

  it('hasil sama persis antara 1, 3, dan 4 worker', async () => {
    for (const seed of [7, 2024]) {
      const ref = reference(seed, 20);
      for (const workers of [1, 3, 4]) {
        const r = await globalSim.runGlobalSim(P, opps, { runs: 20, seed, workers });
        assert.deepStrictEqual(r.tally, ref.tally, `seed ${seed} worker ${workers}`);
        assert.strictEqual(r.streak.max, ref.max, `streak max seed ${seed} worker ${workers}`);
        assert.strictEqual(r.streak.avg, ref.avg, `streak avg seed ${seed} worker ${workers}`);
        assert.strictEqual(r.streak.count, ref.count, `streak count seed ${seed} worker ${workers}`);
      }
    }
  });

  it('menghitung setiap pertarungan tepat satu kali walau dipecah antar-worker', async () => {
    const r = await globalSim.runGlobalSim(P, opps, { runs: 37, seed: 11, workers: 4 });
    assert.strictEqual(r.battles, 37 * opps.length);
    const sum = r.tally.player + r.tally.enemy + r.tally.tie;
    assert.strictEqual(sum, r.battles);
    // Jumlah tim di kedua kelompok harus utuh, tidak terhitung per potongan.
    assert.strictEqual(r.buckets.low.teams + r.buckets.high.teams, opps.length);
  });

  it('satu tim lawan pun tetap bisa dibagi ke beberapa worker', async () => {
    const solo = [{ label: 'solo', teamId: 0, specs: mk(101, 0) }];
    const r = await globalSim.runGlobalSim(P, solo, { runs: 30000, seed: 5 });
    assert.strictEqual(r.battles, 30000);
    assert.strictEqual(r.workers, globalSim.MAX_WORKERS);
  });

  it('memakai satu proses untuk simulasi kecil', () => {
    assert.strictEqual(globalSim.planWorkers(5, 10), 1, '500 pertarungan terlalu kecil');
    assert.strictEqual(globalSim.planWorkers(5, 100000), globalSim.MAX_WORKERS);
  });

  it('menggabungkan streak yang melewati batas potongan', async () => {
    // Tim super kuat: semua menang, jadi streak harus sepanjang total pertarungan
    // meski dipecah ke beberapa worker.
    const dewa = [{
      slot: 1, label: 'dewa', level: 900, customStats: true, animal: null, finalStats: null,
      coeffs: { hp: 40, att: 40, pr: 10, wp: 10, mag: 40, mr: 10 },
    }];
    const cupu = [{ label: 'cupu', teamId: 1, specs: mk(1, 1) }];
    const r = await globalSim.runGlobalSim(dewa, cupu, { runs: 50000, seed: 3 });
    assert.strictEqual(r.tally.enemy, 0);
    assert.strictEqual(r.streak.max, 50000, 'streak melintasi batas potongan');
  });

  it('menghitung streak yang terkurung di tengah potongan', async () => {
    // Pola kalah-menang-kalah: streak kemenangan tidak menyentuh awal maupun
    // akhir potongan, jadi hanya terbaca kalau potongan melaporkan streak
    // internalnya sendiri. Tanpa itu `max` jatuh ke 0 padahal `avg` benar.
    const kuat = mk(50, 0).map(s => ({
      ...s, coeffs: { hp: 500, att: 500, pr: 500, wp: 500, mag: 500, mr: 500 },
    }));
    const dewa = mk(999, 1).map(s => ({
      ...s, coeffs: { hp: 99999, att: 99999, pr: 99999, wp: 99999, mag: 99999, mr: 99999 },
    }));
    const lawan = [
      { label: 'dewa1', teamId: 1, specs: dewa },
      { label: 'lemah', teamId: 2, specs: kuat },
      { label: 'dewa2', teamId: 3, specs: dewa },
    ];
    for (const workers of [1, 3]) {
      const r = await globalSim.runGlobalSim(kuat, lawan, { runs: 10, workers, seed: 9 });
      assert.strictEqual(r.tally.player, 10, 'menang 10 kali di tengah');
      assert.strictEqual(r.streak.max, 10, `streak terkurung worker ${workers}`);
      assert.strictEqual(r.streak.avg, 10, `rata-rata streak worker ${workers}`);
    }
  });
});

describe('antrean simulasi global', () => {
  const C = { hp: 6, att: 5, pr: 4, wp: 4, mag: 5, mr: 4 };
  const P = [{ slot: 1, label: 'p', level: 80, coeffs: C, customStats: true, animal: null, finalStats: null }];
  const opps = [70, 90].map((lv, i) => ({
    label: 't' + i,
    teamId: i,
    specs: [{ slot: 1, label: 'e' + i, level: lv, coeffs: C, customStats: true, animal: null, finalStats: null }],
  }));

  it('menjalankan simulasi berat satu per satu, bukan bersamaan', async () => {
    let peak = 0;
    const runs = [1, 2, 3].map(seed => globalSim.runGlobalSim(P, opps, { runs: 2000, seed })
      .then(result => {
        peak = Math.max(peak, globalSim.queueInfo().active);
        return result;
      }));
    const results = await Promise.all(runs);
    assert.strictEqual(results.length, 3);
    assert.strictEqual(peak, 1, 'hanya satu simulasi aktif pada satu waktu');
    assert.deepStrictEqual(globalSim.queueInfo(), { active: 0, waiting: 0 });
  });

  it('menolak dengan pesan jelas saat antrean penuh', async () => {
    // Isi antrean sampai batasnya.
    const held = [];
    for (let i = 0; i <= globalSim.MAX_QUEUE; i++) {
      held.push(globalSim.runGlobalSim(P, opps, { runs: 3000, seed: 100 + i }));
    }
    await assert.rejects(
      () => globalSim.runGlobalSim(P, opps, { runs: 10, seed: 9 }),
      /Antrean simulasi penuh/
    );
    await Promise.all(held);
    assert.deepStrictEqual(globalSim.queueInfo(), { active: 0, waiting: 0 });
  });
});

describe('tampilan hasil simulasi global', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucy-global-view-'));
    process.chdir(tempDir);
    store.getDb();
  });

  afterEach(() => {
    process.chdir(ROOT);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function runGlobal(args = ['-m', '50']) {
    let payload = null;
    await handleSimCommand(message('x'), ['global', ...args], 'd', {
      sendEmbed: () => null,
      sendPayload: (m, p) => { payload = p; return null; },
      isDeveloper: () => true,
    });
    return payload ? payload.embeds[0].toJSON() : null;
  }

  it('memakai warna biru, bukan warna hasil menang/kalah', async () => {
    seedWorld();
    const embed = await runGlobal();
    assert.strictEqual(embed.color, panel.COLOR.blue);
  });

  it('menampilkan komposisi pet dan level tanpa senjata atau pasif', async () => {
    store.createTeam('me', 'Milikku');
    store.setSlot('me', 'Milikku', 1, { custom: COEFFS_STRONG, level: 77 });
    store.setSlot('me', 'Milikku', 2, { custom: COEFFS_WEAK, level: 42 });
    store.setActiveTeam('me', 'Milikku');
    store.createTeam('rival', 'Lawan');
    store.setSlot('rival', 'Lawan', 1, { custom: COEFFS_WEAK, level: 30 });

    const embed = await runGlobal();
    const field = embed.fields.find(f => f.name.includes('Komposisi'));
    assert.ok(field, 'field komposisi harus ada');
    assert.match(field.value, /L\.77/);
    assert.match(field.value, /L\.42/);
    // Nama senjata dan pasif tidak boleh muncul di ringkasan komposisi.
    const weapons = require(path.join(ROOT, 'src/data/owoBattle')).weapons();
    for (const weapon of weapons) {
      assert.ok(!field.value.includes(weapon.name), `nama senjata "${weapon.name}" bocor`);
    }
    assert.ok(!/pasif|passive/i.test(field.value));
  });

  it('menyebut tim kosong dan tim berstat belum lengkap yang tidak diadu', async () => {
    store.createTeam('me', 'Milikku');
    store.setSlot('me', 'Milikku', 1, { custom: COEFFS_STRONG, level: 80 });
    store.setActiveTeam('me', 'Milikku');
    store.createTeam('rival', 'LawanSah');
    store.setSlot('rival', 'LawanSah', 1, { custom: COEFFS_WEAK, level: 30 });
    store.createTeam('rival', 'TimKosong');
    store.createTeam('rival', 'StatKurang');
    store.setSlot('rival', 'StatKurang', 1, { animalKey: 'hewan-tidak-ada', level: 50 });

    const embed = await runGlobal();
    assert.match(embed.description, /1 tim/, 'hanya tim sah yang diadu');
    const field = embed.fields.find(f => f.name.includes('dilewati'));
    assert.ok(field, 'field tim dilewati harus ada');
    assert.match(field.value, /TimKosong \(kosong\)/);
    assert.match(field.value, /StatKurang \(stat belum lengkap\)/);
  });

  it('mengadu tim lain milik sendiri, hanya tim terpilih yang dikecualikan', async () => {
    store.createTeam('me', 'Milikku');
    store.setSlot('me', 'Milikku', 1, { custom: COEFFS_STRONG, level: 80 });
    store.setActiveTeam('me', 'Milikku');
    store.createTeam('me', 'Cadanganku');
    store.setSlot('me', 'Cadanganku', 1, { custom: COEFFS_WEAK, level: 60 });
    store.createTeam('rival', 'LawanSah');
    store.setSlot('rival', 'LawanSah', 1, { custom: COEFFS_WEAK, level: 30 });

    const embed = await runGlobal();
    assert.match(embed.description, /2 tim/, 'tim lain milik sendiri ikut diadu');
    assert.match(embed.description, /3 tim di `dtm`/);
    assert.match(embed.description, /1 sedang dipilih \(tidak diadu\)/);
    assert.match(embed.description, /0 dilewati/);
  });

  it('tidak menampilkan field tim dilewati kalau semua tim bisa diadu', async () => {
    seedWorld();
    const embed = await runGlobal();
    assert.ok(!embed.fields.some(f => f.name.includes('dilewati')));
  });
});

describe('progres simulasi global', () => {
  const C = { hp: 6, att: 5, pr: 4, wp: 4, mag: 5, mr: 4 };
  const player = [{ slot: 1, label: 'p', level: 100, coeffs: C, customStats: true, animal: null, finalStats: null }];
  const opps = [40, 70, 100].map((lv, i) => ({
    label: 't' + i,
    teamId: i,
    specs: [{ slot: 1, label: 'e' + i, level: lv, coeffs: C, customStats: true, animal: null, finalStats: null }],
  }));

  it('melaporkan progres bertahap, bukan hanya di akhir', async () => {
    const seen = [];
    const result = await globalSim.runGlobalSim(player, opps, {
      runs: 60000,
      seed: 3,
      onProgress: p => seen.push(p),
    });

    assert.ok(seen.length > 2, `harus ada beberapa laporan, dapat ${seen.length}`);
    // Laporan pertama dikirim sebelum satu pertarungan pun selesai.
    assert.strictEqual(seen[0].done, 0);
    // Harus ada laporan di tengah jalan, bukan hanya 0 lalu total.
    assert.ok(seen.some(p => p.done > 0 && p.done < p.total), 'ada laporan di tengah');
    assert.strictEqual(seen.at(-1).done, result.battles);
  });

  it('progres tidak pernah mundur dan tally akhir sama dengan hasil', async () => {
    const seen = [];
    const result = await globalSim.runGlobalSim(player, opps, {
      runs: 60000,
      seed: 4,
      onProgress: p => seen.push(p),
    });

    for (let i = 1; i < seen.length; i++) {
      assert.ok(seen[i].done >= seen[i - 1].done, 'progres mundur');
    }
    const last = seen.at(-1);
    assert.deepStrictEqual(last.tally, result.tally);
    assert.strictEqual(last.total, result.battles);
  });

  it('laporan awal berisi total yang benar walau belum ada hasil', async () => {
    const seen = [];
    await globalSim.runGlobalSim(player, opps, {
      runs: 60000,
      seed: 5,
      onProgress: p => seen.push(p),
    });
    assert.strictEqual(seen[0].total, 60000 * opps.length);
    assert.deepStrictEqual(seen[0].tally, { player: 0, enemy: 0, tie: 0 });
  });
});

describe('pemaksaan jumlah worker', () => {
  const C = { hp: 6, att: 5, pr: 4, wp: 4, mag: 5, mr: 4 };
  const P = [{ slot: 1, label: 'p', level: 80, coeffs: C, customStats: true, animal: null, finalStats: null }];
  const opps = [{ label: 't', teamId: 0, specs: [{ slot: 1, label: 'e', level: 60, coeffs: C, customStats: true, animal: null, finalStats: null }] }];

  it('menghormati workers eksplisit walau pertarungannya sedikit', async () => {
    for (const workers of [2, 3, 4]) {
      const r = await globalSim.runGlobalSim(P, opps, { runs: 20, seed: 7, workers });
      assert.strictEqual(r.workers, workers, `minta ${workers} worker`);
      assert.strictEqual(r.battles, 20);
    }
  });

  it('tetap satu proses untuk simulasi kecil tanpa opsi workers', async () => {
    const r = await globalSim.runGlobalSim(P, opps, { runs: 20, seed: 7 });
    assert.strictEqual(r.workers, 1);
  });

  it('simulasi besar memakai worker walau workers tidak diminta', async () => {
    const r = await globalSim.runGlobalSim(P, opps, { runs: 30000, seed: 7 });
    assert.strictEqual(r.workers, globalSim.MAX_WORKERS);
  });
});
