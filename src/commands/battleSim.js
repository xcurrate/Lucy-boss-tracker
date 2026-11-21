// Perintah simulasi battle.
//
//   dsim [lawan] [opsi]      simulasi tim aktif vs tim lain / stat manual
//   dsim -m 500              jumlah pertarungan (default 100, tanpa batas atas)
//   dsim -s 1234             seed (default acak)
//   dsim -qp 80 -qe 50       quality senjata pemain / lawan
//   dsim -lawan hp=8,att=6,pr=2,wp=3,mag=5,mr=1 level=60
const { MessageFlags } = require('discord.js');
const store = require('../utils/battleTeamStorage');
const dexStore = require('../utils/animalDexStorage');
const animalDex = require('../services/animalDex');
const sim = require('../services/battleSim');
const globalSim = require('../services/globalSim');
const data = require('../data/owoBattle');
const {
  simEmbed, simProgressEmbed, renderMatchup, usageEmbed, errorEmbed, warnEmbed,
  globalSimEmbed, globalLossesEmbed, globalLossButton, parseGlobalLossButton,
} = require('../ui/battlePanel');
const { parseOptions } = require('./battleTeam');

// Jeda minimum antar-edit pesan progres; Discord membatasi edit pesan.
const PROGRESS_EDIT_MS = 1000;

// Cooldown perintah simulasi per user. Simulasi bisa berjalan detik-an dan
// memakai CPU bot, jadi satu user tidak boleh menumpuknya.
const SIM_COOLDOWN_MS = 5000;
const SIM_COOLDOWN_ACTION = 'sim';

function usage(prefix = 'd') {
  return [
    `\`${prefix} sim\` — tim aktif vs tim lain milikmu (atau mirror)`,
    `\`${prefix} sim <id>\` — lawan tim lain milikmu menurut ID (lihat \`${prefix} tm\`)`,
    `\`${prefix} sim <nama-tim>\` — sama, tapi memakai nama tim`,
    `\`${prefix} sim hp=8,att=6,pr=2,wp=3,mag=5,mr=1 level=60\` — lawan stat manual`,
    `\`${prefix} sim <hewan> level=60\` — lawan dari hewan dex`,
    '',
    'Opsi: `-m <jumlah>` (default 100, tanpa batas atas), `-s <seed>`, `-qp <0-100>`, `-qe <0-100>`',
    '',
    'Level: `lvl100` (kedua sisi 100), `lvl100/60` (kita 100, lawan 60), `lvl/40` (kita tetap, lawan 40)',
  ].join('\n');
}

// Semua unit di satu sisi memakai level yang sama saat flag `lvl` dipakai.
function withLevel(specs, level) {
  if (level == null) return specs;
  return specs.map(spec => ({ ...spec, level }));
}

// Level untuk satu sisi: angka = pakai itu, kosong = pakai level yang sudah ada.
function levelOf(value) {
  if (value == null || value === '') return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= data.MAX_LEVEL ? n : null;
}

// `lvl100` (kedua sisi), `lvl100/60` (kita 100, lawan 60), `lvl/40`
// (kita tetap, lawan 40). Tanpa `lvl`, level tiap sisi tidak diubah.
const LEVEL_PREFIX = /^-?lvl/;
const LEVEL_PATTERN = /^-?lvl(\d*)(?:\/(\d*))?$/;

function parseLevels(arg) {
  if (!arg) return { player: undefined, enemy: undefined, invalid: false };
  const player = levelOf(arg.player);
  const enemy = levelOf(arg.enemy);
  if (player === null || enemy === null) return { invalid: true };
  // `lvl` tanpa angka sama sekali tidak mengubah apa pun, jadi dianggap salah.
  if (player === undefined && enemy === undefined) return { invalid: true };
  // Satu angka saja berarti kedua sisi memakai level itu.
  if (player !== undefined && enemy === undefined && arg.enemy === undefined) {
    return { player, enemy: player, invalid: false };
  }
  return { player, enemy, invalid: false };
}

// Opsi berbentuk flag: `-m 500`, `-s 42`, `-qp 80`, `-qe 50`, `lvl100/60`.
function parseFlags(args) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]).toLowerCase();
    if (['-m', '-n', '-runs', '-s', '-seed', '-qp', '-qe', '-total', '-t'].includes(arg)) {
      flags[arg] = args[i + 1];
      i++;
      continue;
    }
    // Token berawalan `lvl` selalu dianggap flag level, supaya bentuk yang
    // salah tidak diam-diam jadi nama lawan.
    if (LEVEL_PREFIX.test(arg)) {
      const level = LEVEL_PATTERN.exec(arg);
      flags.lvl = level ? { player: level[1], enemy: level[2] } : { malformed: arg };
      continue;
    }
    rest.push(args[i]);
  }
  return { flags, rest };
}

// Cooldown simulasi global. Lebih panjang dari `dsim` karena sekali jalan
// mengadu tim melawan SEMUA tim tersimpan, jadi jauh lebih mahal.
const GLOBAL_COOLDOWN_MS = 10000;
const GLOBAL_COOLDOWN_ACTION = 'sim-global';

// Default jauh lebih besar dari `dsim` karena tujuannya mengukur winrate yang
// stabil. Dengan 5-11 tim lawan, 10.000 run per tim berarti puluhan ribu
// pertarungan dan selesai dalam hitungan detik.
const DEFAULT_GLOBAL_RUNS = 10000;

// Batas per perintah. Diukur ~240 ribu pertarungan/detik dengan 4 worker, jadi
// 10 juta kira-kira 40 detik: masih di bawah batas waktu interaksi Discord dan
// jauh di atas kebutuhan normal.
const MAX_GLOBAL_BATTLES = 10_000_000;

// Hasil simulasi global disimpan sebentar di memori supaya tombol "lihat
// kekalahan" bisa membacanya. Kunci = userId + token; token acak per simulasi
// agar tombol dari hasil lama tidak menampilkan data yang sudah basi.
const GLOBAL_RESULT_TTL_MS = 15 * 60 * 1000;
const globalResults = new Map();

function rememberGlobalResult(userId, token, payload) {
  const now = Date.now();
  for (const [key, entry] of globalResults) {
    if (now - entry.at > GLOBAL_RESULT_TTL_MS) globalResults.delete(key);
  }
  globalResults.set(`${userId}${token}`, { at: now, ...payload });
}

function getGlobalResult(userId, token) {
  const entry = globalResults.get(`${userId}${token}`);
  if (!entry) return null;
  if (Date.now() - entry.at > GLOBAL_RESULT_TTL_MS) {
    globalResults.delete(`${userId}${token}`);
    return null;
  }
  return entry;
}

// Token pendek yang aman untuk customId (tanpa pemisah `:`).
function resultToken(seed) {
  return `${seed.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

// Simulasi besar bisa berjalan lama, jadi hasil sementara ditampilkan di satu
// pesan yang diedit berkala lalu ditimpa hasil akhir. Dipakai bersama oleh
// mode biasa dan mode global supaya perilakunya sama.
//
// `sendEmbed` mengirim embed saja, `sendPayload` mengirim payload penuh
// (embed + tombol). Keduanya dipisah karena pemanggil lama hanya menyediakan
// `sendEmbed`.
function makeProgressPublisher(message, sendEmbed, sendPayload, labels, mode) {
  let progressMessage = null;
  let progressDisabled = false;
  let lastEdit = 0;
  let editing = false;

  const publish = async progress => {
    if (progressDisabled) return;
    const embed = simProgressEmbed(progress, {
      ...labels,
      mode,
      title: mode === 'global' ? '🌍 Simulasi Global — berjalan' : null,
    });

    if (!progressMessage) {
      const sent = await sendEmbed(message, embed);
      // Pengirim tanpa objek Message (mis. tes) tidak bisa diedit: cukup satu
      // pesan, sisanya dilewati supaya channel tidak dibanjiri.
      if (!sent?.edit) { progressDisabled = true; return; }
      progressMessage = sent;
      lastEdit = Date.now();
      return;
    }

    // Discord membatasi edit pesan; satu edit per detik cukup untuk menunjukkan
    // progres tanpa kena rate limit.
    if (editing || Date.now() - lastEdit < PROGRESS_EDIT_MS) return;
    editing = true;
    try {
      await progressMessage.edit({ embeds: [embed] });
      lastEdit = Date.now();
    } catch {
      progressDisabled = true;
      progressMessage = null;
    } finally {
      editing = false;
    }
  };

  // Kirim (atau timpa) hasil akhir di pesan progres yang sama. Pemanggil yang
  // hanya menyediakan `sendEmbed` (tes, perintah lama) tetap dapat embed-nya.
  publish.finish = async payload => {
    if (progressMessage) {
      try {
        await progressMessage.edit(payload);
        return progressMessage;
      } catch {
        // Gagal mengedit (pesan dihapus / rate limit): kirim sebagai pesan baru.
      }
    }
    if (sendPayload) return sendPayload(message, payload);
    const embed = payload?.embeds?.[0];
    return embed ? sendEmbed(message, embed) : null;
  };

  return publish;
}

function globalUsage(prefix = 'd') {
  return [
    `\`${prefix} sim global\` — tim aktif melawan **seluruh tim tersimpan** (kecuali tim yang dipilih)`,
    '',
    'Hasil berisi: rata-rata streak, rata-rata kalah, dan rekap menang/seri/kalah',
    'yang dipisah antara tim lawan berlevel di bawah 35 dan 35 ke atas.',
    'Tombol **Lihat kekalahan** menampilkan tim mana saja yang mengalahkan kamu',
    '(hanya terlihat olehmu, senjata lawan disembunyikan).',
    '',
    `Opsi:`,
    `\`-m <jumlah>\` berapa kali tiap tim dilawan (default ${DEFAULT_GLOBAL_RUNS.toLocaleString('id-ID')})`,
    `\`-total <jumlah>\` total pertarungan, dibagi rata ke semua tim lawan`,
    `\`-s <seed>\` ulangi hasil yang sama`,
    '',
    `Batas: **${MAX_GLOBAL_BATTLES.toLocaleString('id-ID')}** pertarungan per perintah.`,
    'Pertarungan dibagi ke beberapa worker, jadi jutaan pertarungan selesai',
    'dalam hitungan detik sampai puluhan detik.',
    `Cooldown: **${Math.round(GLOBAL_COOLDOWN_MS / 1000)} detik** untuk selain developer.`,
  ].join('\n');
}

// Terima dua bentuk: `-m <per tim>` atau `-total <total pertarungan>`.
// Keduanya dibatasi MAX_GLOBAL_BATTLES supaya satu perintah tidak menahan bot
// terlalu lama.
function resolveRunCount(flags, opponentCount) {
  const perTeam = flags['-m'] ?? flags['-n'] ?? flags['-runs'];
  const total = flags['-total'] ?? flags['-t'];

  if (perTeam != null && total != null) {
    return { error: 'Pakai salah satu: `-m` (per tim) atau `-total` (total pertarungan), jangan keduanya.' };
  }

  if (total != null) {
    const value = Number(total);
    if (!Number.isSafeInteger(value) || value < 1) {
      return { error: 'Total pertarungan harus bilangan bulat 1 atau lebih. Contoh: `d sim global -total 1000000`.' };
    }
    if (value > MAX_GLOBAL_BATTLES) {
      return { error: `Total pertarungan terlalu besar. Maksimum **${MAX_GLOBAL_BATTLES.toLocaleString('id-ID')}**.` };
    }
    // Dibulatkan ke bawah supaya total tidak melebihi yang diminta; sisa
    // pembagian tidak dijalankan.
    return { value: Math.max(1, Math.floor(value / opponentCount)), total: value };
  }

  const runs = perTeam ?? DEFAULT_GLOBAL_RUNS;
  const value = Number(runs);
  if (!Number.isSafeInteger(value) || value < 1) {
    return { error: 'Jumlah simulasi harus bilangan bulat 1 atau lebih. Contoh: `d sim global -m 5000`.' };
  }
  if (value * opponentCount > MAX_GLOBAL_BATTLES) {
    const maxPerTeam = Math.floor(MAX_GLOBAL_BATTLES / opponentCount);
    return {
      error: `Terlalu besar: ${value.toLocaleString('id-ID')} × ${opponentCount} tim = `
        + `${(value * opponentCount).toLocaleString('id-ID')} pertarungan, batasnya `
        + `**${MAX_GLOBAL_BATTLES.toLocaleString('id-ID')}**. `
        + `Maksimum untuk ${opponentCount} tim: \`-m ${maxPerTeam.toLocaleString('id-ID')}\`.`,
    };
  }
  return { value, total: value * opponentCount };
}

async function handleGlobalSim(message, args, prefix, deps = {}) {
  const send = deps.sendEmbed || ((m, embed) => m.reply({ embeds: [embed] }));
  const sendPayload = deps.sendPayload || null;
  const isDev = deps.isDeveloper ? deps.isDeveloper(message) : false;
  const userId = message.author.id;

  const team = store.getActiveTeam(userId);
  if (!team) {
    return send(message, errorEmbed(`Belum ada tim aktif. Buat dulu: \`${prefix} team new <nama>\` lalu \`${prefix} team add 1 <hewan>\`.`));
  }
  if (!team.slots.length) {
    return send(message, errorEmbed(`Tim **${team.name}** masih kosong. Isi dengan \`${prefix} team add 1 <hewan>\`.`));
  }

  const { flags, rest } = parseFlags(args);
  if (rest.length) {
    return send(message, errorEmbed(`Argumen \`${rest.join(' ')}\` tidak dikenal di simulasi global. Lihat \`${prefix} sim global help\`.`));
  }

  const seed = flags['-s'] ?? flags['-seed'];
  if (seed != null && !Number.isFinite(Number(seed))) return send(message, errorEmbed('Seed harus angka.'));

  const player = resolveTeamSpecs(team);
  if (player.error) return send(message, errorEmbed(`❌ ${player.error}`));

  const opponents = [];
  // Simulasi global melawan semua tim tersimpan, termasuk tim lain milik user
  // sendiri. Hanya tim yang sedang dipilih yang dikecualikan, karena tim itu
  // yang bertarung. Semua yang tidak ikut diadu dicatat supaya angka `dtm`
  // bisa direkonsiliasi.
  const skipped = [];
  let excluded = 0;
  const allTeams = store.listAllTeams();
  for (const other of allTeams) {
    if (other.id === team.id) { excluded += 1; continue; }
    if (!other.slots.length) {
      skipped.push({ label: teamLabel(other), reason: 'kosong' });
      continue;
    }
    const specs = resolveTeamSpecs(other);
    if (specs.error) {
      skipped.push({ label: teamLabel(other), reason: 'stat belum lengkap' });
      continue;
    }
    opponents.push({
      teamId: other.id,
      slotId: other.slotId,
      label: teamLabel(other),
      specs: specs.specs,
    });
  }
  if (!opponents.length) {
    return send(message, warnEmbed('Belum ada tim lawan yang bisa dipakai. Simulasi global butuh tim tersimpan selain tim yang sedang dipilih.'));
  }

  // Jumlah run baru bisa dihitung setelah jumlah lawan diketahui, karena
  // `-total` dibagi rata ke semua lawan.
  const runCount = resolveRunCount(flags, opponents.length);
  if (runCount.error) return send(message, errorEmbed(runCount.error));

  // Gerbang cooldown dipasang setelah validasi supaya salah ketik tidak
  // menghabiskan jatah. Developer melewati cooldown untuk pengujian.
  if (!isDev) {
    const waiting = store.cooldownRemaining(userId, GLOBAL_COOLDOWN_ACTION);
    if (waiting > 0) {
      return send(message, warnEmbed(
        `⏳ Simulasi global baru bisa dipakai lagi dalam **${(waiting / 1000).toFixed(1)} detik**.`
      ));
    }
    store.setCooldown(userId, GLOBAL_COOLDOWN_ACTION, Date.now() + GLOBAL_COOLDOWN_MS);
  }

  const labels = { playerLabel: teamLabel(team) };
  const publishProgress = makeProgressPublisher(message, send, sendPayload, labels, 'global');

  // Embed progres dikirim sebelum simulasi dimulai supaya user langsung melihat
  // balasan, bukan menunggu potongan pertama selesai. Kalau antrean sedang
  // dipakai, statusnya jujur menyebut "menunggu antrean".
  await publishProgress({
    done: 0,
    total: runCount.total,
    tally: { player: 0, enemy: 0, tie: 0 },
    winRate: 0,
    lossRate: 0,
    tieRate: 0,
    etaMs: null,
    avgTurns: 0,
    queued: globalSim.queueInfo().active > 0,
  });

  let result;
  try {
    result = await globalSim.runGlobalSim(player.specs, opponents, {
      runs: runCount.value,
      seed: seed != null ? Number(seed) : undefined,
      onProgress: publishProgress,
    });
  } catch (error) {
    // Antrean penuh bukan kesalahan user: beri tahu dan lepas cooldown supaya
    // bisa langsung mencoba lagi.
    if (!isDev) store.clearCooldown(userId, GLOBAL_COOLDOWN_ACTION);
    return send(message, errorEmbed(`❌ ${error.message}`));
  }
  if (!isDev) store.setCooldown(userId, GLOBAL_COOLDOWN_ACTION, Date.now() + GLOBAL_COOLDOWN_MS);

  await animalDex.ensureAnimalEmojis([
    ...player.specs.map(spec => spec.animal),
    ...opponents.flatMap(o => o.specs.map(spec => spec.animal)),
  ]);

  const token = resultToken(result.seed);
  rememberGlobalResult(userId, token, { result, playerLabel: labels.playerLabel });

  const finalEmbed = globalSimEmbed(result, {
    playerLabel: labels.playerLabel,
    prefix,
    playerSpecs: player.specs,
    skipped,
    totals: { all: allTeams.length, excluded },
  });
  const payload = {
    embeds: [finalEmbed],
    // Tombol tetap ditampilkan walau belum ada kekalahan; saat dibuka akan
    // menjawab bahwa tidak ada tim yang menang.
    components: [globalLossButton(userId, token)],
  };

  return publishProgress.finish(payload);
}

// Tombol "lihat kekalahan": balasan ephemeral berisi tim yang mengalahkan
// pemain, dengan ikon senjata diganti tanda tanya.
async function handleGlobalLossButton(i) {
  const parsed = parseGlobalLossButton(i.customId);
  if (!parsed.ok) {
    return i.reply({ content: 'Tombol kedaluwarsa. Jalankan `d sim global` lagi.', flags: MessageFlags.Ephemeral });
  }
  if (parsed.userId !== i.user.id) {
    return i.reply({
      content: 'Tombol ini milik orang lain. Jalankan `d sim global` untuk hasilmu sendiri.',
      flags: MessageFlags.Ephemeral,
    });
  }
  const entry = getGlobalResult(parsed.userId, parsed.token);
  if (!entry) {
    return i.reply({
      content: 'Hasil simulasi ini sudah kedaluwarsa. Jalankan `d sim global` lagi.',
      flags: MessageFlags.Ephemeral,
    });
  }

  await animalDex.ensureAnimalEmojis(
    entry.result.losses.flatMap(loss => loss.specs.map(spec => spec.animal))
  );
  return i.reply({
    embeds: [globalLossesEmbed(entry.result, { playerLabel: entry.playerLabel })],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleSimCommand(message, args, prefix, deps = {}) {
  const send = deps.sendEmbed || ((m, embed) => m.reply({ embeds: [embed] }));
  const userId = message.author.id;

  // `help` tidak kena cooldown: perintah bantuan tidak menjalankan simulasi.
  if ((args[0] || '').toLowerCase() === 'help' || (args[0] || '').toLowerCase() === 'bantuan') {
    return send(message, usageEmbed('⚔️ Simulasi Battle', usage(prefix)));
  }

  // `d sim global` / `d sim g` — mode simulasi melawan semua tim tersimpan.
  const mode = (args[0] || '').toLowerCase();
  if (['global', 'g'].includes(mode)) {
    const rest = args.slice(1);
    if (['help', 'bantuan'].includes((rest[0] || '').toLowerCase())) {
      return send(message, usageEmbed('🌍 Simulasi Global', globalUsage(prefix)));
    }
    return handleGlobalSim(message, rest, prefix, deps);
  }

  const team = store.getActiveTeam(userId);
  if (!team) {
    return send(message, errorEmbed(`Belum ada tim aktif. Buat dulu: \`${prefix} team new <nama>\` lalu \`${prefix} team add 1 <hewan>\`.`));
  }
  if (!team.slots.length) {
    return send(message, errorEmbed(`Tim **${team.name}** masih kosong. Isi dengan \`${prefix} team add 1 <hewan>\`.`));
  }

  const { flags, rest } = parseFlags(args);
  const levels = parseLevels(flags.lvl);
  if (levels.invalid || flags.lvl?.malformed) {
    return send(message, errorEmbed(`Format level salah. Contoh: \`${prefix} sim lvl100\`, \`${prefix} sim lvl100/60\`, \`${prefix} sim lvl/40\`.`));
  }
  const runs = flags['-m'] ?? flags['-n'] ?? flags['-runs'] ?? 100;
  const runCount = Number(runs);
  if (!Number.isSafeInteger(runCount) || runCount < 1) {
    return send(message, errorEmbed('Jumlah simulasi harus bilangan bulat 1 atau lebih. Contoh: `d sim -m 500`.'));
  }
  const seed = flags['-s'] ?? flags['-seed'];
  if (seed != null && !Number.isFinite(Number(seed))) return send(message, errorEmbed('Seed harus angka.'));

  const quality = value => {
    if (value == null) return undefined;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 && n <= 100 ? n : undefined;
  };
  const playerQuality = quality(flags['-qp']);
  const enemyQuality = quality(flags['-qe']);

  const player = resolveTeamSpecs(team);
  if (player.error) return send(message, errorEmbed(`❌ ${player.error}`));

  const enemy = resolveEnemy(userId, rest, levels.enemy);
  if (enemy.error) return send(message, errorEmbed(`❌ ${enemy.error}`));

  // Flag `lvl` menimpa level tersimpan, tanpa mengubah tim di database.
  const playerSpecs = withLevel(player.specs, levels.player);
  const enemySpecs = withLevel(enemy.specs, levels.enemy);

  // Simulasi besar bisa berjalan lama. Kirim pesan progres lebih dulu, perbarui
  // berkala, lalu timpa dengan hasil akhir di pesan yang sama supaya channel
  // tidak dibanjiri pesan.
  const labels = { playerLabel: teamLabel(team), enemyLabel: enemy.label };
  const publishProgress = makeProgressPublisher(message, send, deps.sendPayload || null, labels, 'duel');

  // Gerbang cooldown dipasang setelah validasi: perintah yang salah ketik tetap
  // dapat pesan errornya sendiri, dan tidak menghabiskan jatah user. Yang mahal
  // hanya simulasi, jadi itu yang dibatasi.
  const waiting = store.cooldownRemaining(userId, SIM_COOLDOWN_ACTION);
  if (waiting > 0) {
    return send(message, warnEmbed(
      `⏳ Tunggu **${(waiting / 1000).toFixed(1)} detik** lagi sebelum simulasi berikutnya.`
    ));
  }
  // Ditandai dua kali: sebelum jalan supaya simulasi yang panjang tidak bisa
  // ditumpuk, dan sesudah selesai supaya cooldown dihitung dari akhir simulasi.
  store.setCooldown(userId, SIM_COOLDOWN_ACTION, Date.now() + SIM_COOLDOWN_MS);

  const result = await sim.simulate(playerSpecs, enemySpecs, {
    runs: runCount,
    seed: seed != null ? Number(seed) : undefined,
    playerQuality,
    enemyQuality,
    onProgress: publishProgress,
  });
  store.setCooldown(userId, SIM_COOLDOWN_ACTION, Date.now() + SIM_COOLDOWN_MS);

  // Ringkasan matchup memuat emoji hewan; siapkan dulu seperti `d dex`.
  await animalDex.ensureAnimalEmojis([
    ...playerSpecs.map(spec => spec.animal),
    ...enemySpecs.map(spec => spec.animal),
  ]);

  const finalEmbed = simEmbed(result, {
    ...labels,
    matchup: renderMatchup(playerSpecs, enemySpecs),
  });

  return publishProgress.finish({ embeds: [finalEmbed] });
}

// Tim aktif → spec engine, dengan stat diambil dari dex bila perlu.
function resolveTeamSpecs(team) {
  const slots = team.slots.map(slot => ({
    ...slot,
    dexAnimal: slot.animalKey ? dexStore.resolveAnimal(slot.animalKey) : null,
  }));
  return sim.toSpecs({ slots });
}

// Nama tim selalu ditampilkan dengan ID agar cocok dengan angka di `dtm`.
function teamLabel(team) {
  if (!team) return '-';
  return team.slotId != null ? `[${team.slotId}] ${team.name}` : team.name;
}

// Menentukan lawan: tim lain, hewan dex, atau stat manual.
function resolveEnemy(userId, args, overrideLevel) {
  const { options, rest } = parseOptions(args);
  const raw = rest.join(' ').trim();

  // Tanpa argumen: pakai tim aktif lain milik user, kalau tidak ada pakai
  // stat seimbang dari tim pemain agar simulasi tetap bermakna.
  if (!raw) {
    const others = store.listTeams(userId);
    const active = store.getActiveTeam(userId);
    const other = others.find(t => active && t.id !== active.id && t.slots.length);
    if (other) {
      const specs = resolveTeamSpecs(other);
      if (specs.error) return { error: specs.error };
      return { specs: specs.specs, label: teamLabel(other) };
    }
    const own = resolveTeamSpecs(active);
    if (own.error) return { error: own.error };
    // Cermin harus benar-benar identik (termasuk senjata), supaya hasilnya
    // jadi pembanding netral ~50%, bukan tim tanpa senjata.
    return {
      specs: own.specs.map(s => ({ ...s, label: `${s.label} (mirror)` })),
      label: 'mirror',
    };
  }

  // `d sim blitz` / `d sim 1 vs blitz` → lawan tim milik user sendiri.
  // Dicek sebelum stat manual karena nama tim bisa berupa angka ("1").
  // `d sim 3` memilih tim lewat ID; nama tim tetap diterima untuk kompatibilitas.
  const enemyName = raw.includes(' vs ') ? raw.split(/\s+vs\s+/i).pop().trim() : raw;
  const ownTeam = enemyName ? store.findTeam(userId, enemyName) : null;
  if (ownTeam) {
    if (!ownTeam.slots.length) {
      return { error: `Tim **${teamLabel(ownTeam)}** masih kosong. Isi dulu dengan \`d team add 1 <hewan>\`.` };
    }
    const specs = resolveTeamSpecs(ownTeam);
    if (specs.error) return { error: specs.error };
    return { specs: specs.specs, label: teamLabel(ownTeam) };
  }

  // `level=` eksplisit menang atas flag `lvl`, karena lebih spesifik.
  const level = options.level ? Number(options.level) : (overrideLevel ?? 60);
  const looksLikeStats = raw.includes('=') || /^[\d\s,-]+$/.test(raw);
  if (looksLikeStats) {
    const parsed = sim.parseCustomStats(raw);
    if (parsed.error) return { error: parsed.error };
    return { specs: [{ slot: 1, coeffs: parsed.custom, level, label: 'lawan' }], label: 'stat manual' };
  }

  const animal = dexStore.resolveAnimal(raw) || dexStore.searchAnimals(raw)[0];
  if (!animal) return { error: `Lawan \`${raw}\` tidak dikenal. Pakai nama tim (lihat \`d team list\`), hewan dex, atau stat manual.` };
  const coeffs = sim.dexStatsToCustom(animal);
  if (!coeffs) return { error: `Stat \`${animal.name}\` tidak lengkap di dex.` };
  return { specs: [{ slot: 1, coeffs, level, label: animal.name, animal }], label: animal.name };
}

module.exports = {
  handleSimCommand, handleGlobalSim, handleGlobalLossButton,
  parseFlags, resolveEnemy, resolveTeamSpecs, usage, globalUsage, resolveRunCount,
  GLOBAL_COOLDOWN_MS, DEFAULT_GLOBAL_RUNS, MAX_GLOBAL_BATTLES, globalResults,
};
