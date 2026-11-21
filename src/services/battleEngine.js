// Mesin simulasi battle. Meniru mekanik OwO, tapi deterministik: semua
// randomness lewat RNG ber-seed supaya hasil bisa direproduksi dan diuji.
//
// Layout stat sengaja sama persis dengan OwO supaya port pasif/senjata tidak
// perlu diterjemahkan:
//   hp/wp         : [current, base, prev, bonus] → maksimum = base + bonus
//   att/mag/pr/mr : [base, bonus]                → nilai efektif = base + bonus
//
// Perbedaan yang disengaja dari OwO: `Math.random` diganti RNG ber-seed, dan
// wear/takedown/XP tidak disimulasikan karena tidak memengaruhi hasil battle.
const data = require('../data/owoBattle');
const { createRng } = require('./battleRng');
const { buildWeapon, weaponAbility } = require('./battleWeapon');
const { stackOf } = require('./battleBuffs');

const MAX_TURNS = data.limits.maxTurns;
const MAX_SLOTS = data.limits.maxSlots;

const PHYSICAL = 'p';
const MAGICAL = 'm';
const TRUE = 't';

// Batas stack pasif Adaptation (Stoneskin/Spellskin), dari deskripsi sumber.
const MAX_ADAPT_STACKS = 5;

let pidCounter = 0;

function resistanceFromDisplayedPercent(percent) {
  const value = Math.max(0, Math.min(79.999, Number(percent) || 0));
  return (value * 100) / (80 - value);
}

function maxHp(unit) { return unit.stats.hp[1] + unit.stats.hp[3]; }
function maxWp(unit) { return unit.stats.wp[1] + unit.stats.wp[3]; }
function isAlive(unit) { return unit.stats.hp[0] > 0; }
function aliveOf(team) { return team.filter(isAlive); }

// Penanda anti-rekursi, pengganti `tags.has(...)` OwO. Contoh: lifesteal yang
// memicu lifesteal lagi, atau thorns yang memantulkan damage pantulan.
function tagged(ctx, tag, unit) { return ctx.tags.has(`${tag}:${unit.pid}`); }

function withTag(ctx, tag, unit, fn) {
  const key = `${tag}:${unit.pid}`;
  if (ctx.tags.has(key)) return undefined;
  ctx.tags.add(key);
  try {
    return fn();
  } finally {
    ctx.tags.delete(key);
  }
}

// (res / (100 + res)) * 0.8 — resistensi jenuh, plafon 80%.
function resToPercent(res) {
  const total = res[0] + res[1];
  return (total / (100 + total)) * 0.8;
}

function getDamage(stat, multiplier, rng) {
  return Math.round(multiplier * (stat[0] + stat[1]) + (rng.next() * 100 - 50));
}

function getDamageFromHpWp(stat, multiplier, rng) {
  return Math.round(multiplier * (stat[1] + stat[3]) + (rng.next() * 100 - 50));
}

function getMixedDamage(statA, pctA, statB, pctB, rng) {
  return Math.round((statA[0] + statA[1]) * pctA + (statB[0] + statB[1]) * pctB + (rng.next() * 100 - 50));
}

function pickRandom(list, rng) {
  if (!list.length) return null;
  return list[Math.floor(rng.next() * list.length)];
}

function lowestHp(team, excludeBuffId) {
  let lowest = null;
  for (const unit of team) {
    if (!isAlive(unit)) continue;
    if (excludeBuffId && unit.buffs.some(b => b.id === excludeBuffId)) continue;
    if (!lowest) { lowest = unit; continue; }
    if (unit.stats.hp[0] / maxHp(unit) < lowest.stats.hp[0] / maxHp(lowest)) lowest = unit;
  }
  return lowest;
}

function lowestWp(team, excludeSelf) {
  let lowest = null;
  for (const unit of team) {
    if (!isAlive(unit) || unit === excludeSelf) continue;
    if (!lowest) { lowest = unit; continue; }
    if (unit.stats.wp[0] / maxWp(unit) < lowest.stats.wp[0] / maxWp(lowest)) lowest = unit;
  }
  return lowest;
}

// Taunt diprioritaskan; `ignoreChoose` melewati taunt (dipakai pasif).
function chooseTarget(attacker, allies, enemies, rng, { hasBuff, excludeBuffId, ignoreChoose } = {}) {
  const alive = aliveOf(enemies);
  if (!ignoreChoose) {
    for (const unit of alive) {
      if (unit.buffs.some(b => b.id === 1)) return unit;
    }
  }
  let pool = alive;
  if (hasBuff) pool = pool.filter(u => u.buffs.some(b => !b.debuff));
  if (excludeBuffId) pool = pool.filter(u => !u.buffs.some(b => b.id === excludeBuffId));
  return pickRandom(pool, rng);
}

// Satu-satunya jalur damage. Urutan hook mengikuti inflictDamage OwO:
// attacked (penerima) → attack (penyerang) → kurangi HP → postAttacked → postAttack.
function inflictDamage(ctx, attacker, target, rawDamage, type, { bypassRes = false } = {}) {
  let amount = rawDamage;
  if (!bypassRes) {
    if (type === PHYSICAL) amount *= 1 - resToPercent(target.stats.pr);
    else if (type === MAGICAL) amount *= 1 - resToPercent(target.stats.mr);
  }
  if (amount < 0) amount = 0;
  const bucket = { amount, bonus: 0 };

  for (const buff of target.buffs) buff.attacked?.(ctx, target, attacker, bucket, type);
  if (target.weapon) for (const p of target.weapon.passives) p.attacked?.(ctx, target, attacker, bucket, type);
  for (const buff of attacker.buffs) buff.attack?.(ctx, attacker, target, bucket, type);
  if (attacker.weapon) for (const p of attacker.weapon.passives) p.attack?.(ctx, attacker, target, bucket, type);

  let total = bucket.amount + bucket.bonus;
  if (total < 0) total = 0;
  target.stats.hp[0] -= total;
  ctx.damageDealt += total;

  for (const buff of target.buffs) buff.postAttacked?.(ctx, target, attacker, total, type);
  if (target.weapon) for (const p of target.weapon.passives) p.postAttacked?.(ctx, target, attacker, total, type);
  for (const buff of attacker.buffs) buff.postAttack?.(ctx, attacker, target, total, type);
  if (attacker.weapon) for (const p of attacker.weapon.passives) p.postAttack?.(ctx, attacker, target, total, type);

  return Math.round(total);
}

// `revive` membolehkan target ber-HP 0 ikut disembuhkan. OwO memanggil heal
// setelah menyetel `hp[0] = 0`, jadi jalur revive memang lewat sini.
function heal(ctx, target, amount, from, { overheal = false, revive = false } = {}) {
  if (!target) return 0;
  if (!revive && !isAlive(target)) return 0;
  const cap = maxHp(target) * (overheal ? 1.5 : 1);
  if (target.stats.hp[0] >= cap) return 0;
  const bucket = { amount, bonus: 0 };

  for (const buff of target.buffs) buff.healed?.(ctx, target, from, bucket);
  if (target.weapon) for (const p of target.weapon.passives) p.healed?.(ctx, target, from, bucket);
  for (const buff of from.buffs) buff.heal?.(ctx, target, from, bucket);
  if (from.weapon) for (const p of from.weapon.passives) p.heal?.(ctx, target, from, bucket);

  let total = bucket.amount + bucket.bonus;
  if (total < 0) total = 0;
  const room = cap - target.stats.hp[0];
  if (total > room) total = room;

  for (const buff of target.buffs) buff.postHealed?.(ctx, target, from, total);
  if (target.weapon) for (const p of target.weapon.passives) p.postHealed?.(ctx, target, from, total);
  for (const buff of from.buffs) buff.postHeal?.(ctx, target, from, total);
  if (from.weapon) for (const p of from.weapon.passives) p.postHeal?.(ctx, target, from, total);

  target.stats.hp[0] += total;
  return Math.round(total);
}

// `overreplenish` mengizinkan WP melewati maksimum hingga 150% (OwO: Arcane Scepter).
function replenish(ctx, target, amount, from, { overreplenish = false } = {}) {
  if (!target || !isAlive(target)) return 0;
  const cap = maxWp(target) * (overreplenish ? 1.5 : 1);
  if (target.stats.wp[0] >= cap) return 0;
  const bucket = { amount, bonus: 0 };

  for (const buff of target.buffs) buff.replenished?.(ctx, target, from, bucket);
  if (target.weapon) for (const p of target.weapon.passives) p.replenished?.(ctx, target, from, bucket);
  for (const buff of from.buffs) buff.replenish?.(ctx, target, from, bucket);
  if (from.weapon) for (const p of from.weapon.passives) p.replenish?.(ctx, target, from, bucket);

  let total = bucket.amount + bucket.bonus;
  if (total < 0) total = 0;
  const room = cap - target.stats.wp[0];
  if (total > room) total = room;

  for (const buff of target.buffs) buff.postReplenished?.(ctx, target, from, total);
  if (target.weapon) for (const p of target.weapon.passives) p.postReplenished?.(ctx, target, from, total);
  for (const buff of from.buffs) buff.postReplenish?.(ctx, target, from, total);
  if (from.weapon) for (const p of from.weapon.passives) p.postReplenish?.(ctx, target, from, total);

  target.stats.wp[0] += total;
  return Math.round(total);
}

function useMana(unit, amount) {
  const used = Math.min(amount, Math.max(0, unit.stats.wp[0]));
  unit.stats.wp[0] = Math.max(0, unit.stats.wp[0] - amount);
  return Math.round(used);
}

function buildStats(base) {
  return {
    hp: [base.hp, base.hp, base.hp, 0],
    wp: [base.wp, base.wp, base.wp, 0],
    att: [base.att, 0],
    mag: [base.mag, 0],
    pr: [base.pr, 0],
    mr: [base.mr, 0],
  };
}

function buildUnit(spec, rng, quality) {
  // `coeffs` adalah stat skala kecil (0-8 untuk hewan OwO, 0-14 untuk dex Lucy).
  // Keduanya koefisien, bukan HP final — kekuatan berasal dari level.
  const base = spec.finalStats ? null : data.baseStats(spec.coeffs, spec.level);
  const unit = {
    pid: ++pidCounter,
    slot: spec.slot,
    nickname: spec.label || (spec.animal ? spec.animal.name : 'custom'),
    level: spec.level || 1,
    custom: Boolean(spec.customStats),
    animal: spec.animal || null,
    // Hanya sasaran bertanda boss yang terpengaruh pasif seperti Giant Slayer.
    isBoss: Boolean(spec.isBoss),
    buffs: [],
    weapon: null,
    team: null,
    foes: null,
    stats: spec.finalStats ? {
      hp: [spec.finalStats.hp, spec.finalStats.hp, spec.finalStats.hp, 0],
      wp: [spec.finalStats.wp, spec.finalStats.wp, spec.finalStats.wp, 0],
      att: [spec.finalStats.att, 0],
      mag: [spec.finalStats.mag, 0],
      pr: [resistanceFromDisplayedPercent(spec.finalStats.pr), 0],
      mr: [resistanceFromDisplayedPercent(spec.finalStats.mr), 0],
    } : buildStats(base),
  };
  if (spec.weapon) {
    unit.weapon = buildWeapon(spec.weapon, rng, quality);
    // Lucy mengirim stat final yang sudah termasuk equipment; jangan tambahkan
    // stat senjata untuk kedua kalinya pada slot hasil import.
    if (!spec.finalStats) unit.weapon.alterStats(unit.stats);
  }
  unit.stats.hp[0] = maxHp(unit);
  unit.stats.wp[0] = maxWp(unit);
  return unit;
}

// Buff masuk lewat satu pintu supaya Stinky dan penumpukan durasi konsisten.
function bindBuff(ctx, target, buff) {
  if (!isAlive(target)) return;
  const stinky = target.buffs.find(b => b.id === 12);
  if (stinky) { stinky.preBind?.(ctx, target, buff); return; }

  // Sacred Ward menolak debuff: satu stack habis, lalu replenish MAG pemasang.
  const ward = buff.debuff && target.buffs.find(b => b.id === 13);
  if (ward) {
    target.buffs = target.buffs.filter(b => b !== ward);
    const amount = getDamage(ward.from.stats.mag, ward.stats[0] / 100, ctx.rng);
    if (amount > 0) replenish(ctx, target, amount, ward.from);
    return;
  }

  const rule = stackOf(buff);
  const same = b => b.id === buff.id && (!rule.sameFrom || b.from === buff.from);

  if (rule.kind === 'independent') { target.buffs.push(buff); return; }

  if (rule.kind === 'replace') {
    // Flame: instance lama meledak lalu dibuang. OwO menghitung ledakan dari
    // buff yang BARU menempel (`this.stats[1]`), bukan dari yang lama.
    for (const old of target.buffs.filter(same)) {
      old.explode?.(ctx, target, buff);
      target.buffs = target.buffs.filter(b => b !== old);
    }
    target.buffs.push(buff);
    return;
  }

  const existing = target.buffs.find(same);
  if (existing) { existing.duration += buff.duration; return; }
  target.buffs.push(buff);
}

function runTurn(ctx, player, enemy) {
  // Nomor giliran dipakai senjata berjadwal (Scepter of Celebrations: tiap 4 turn).
  ctx.turn = (ctx.turn || 0) + 1;
  for (const [team, foe] of [[player, enemy], [enemy, player]]) {
    for (const unit of team) {
      if (!isAlive(unit)) continue;
      unit.skippedAttack = false;
      for (const buff of unit.buffs) buff.preTurn?.(ctx, unit, team, foe);
      if (unit.weapon) {
        unit.weapon.preTurn?.(ctx, unit, team, foe);
        for (const passive of unit.weapon.passives) passive.preTurn?.(ctx, unit, team, foe);
      }
    }
  }

  // OwO selalu memberi giliran pertama ke tim pemain (`executeTurn` dipanggil
  // dengan tim pemain sebagai `team`). Simulasi mengikuti itu apa adanya: yang
  // diukur adalah peluang menang tim ini di battle sungguhan, jadi keuntungan
  // giliran pertama memang bagian dari hasil, bukan noise yang perlu dibuang.
  const playerFirst = ctx.playerFirst;
  const first = playerFirst ? player : enemy;
  const second = playerFirst ? enemy : player;
  let firstPos = 0;
  let secondPos = 0;
  for (let i = 0; i < MAX_SLOTS * 2; i++) {
    let actor, allies, foes;
    if (firstPos <= secondPos) {
      actor = first[firstPos++];
      allies = first; foes = second;
    } else {
      actor = second[secondPos++];
      allies = second; foes = first;
    }
    if (!actor || !isAlive(actor)) continue;
    // OwO Shield.attackWeapon: setelah Taunt baru dipasang di preTurn, unit
    // melewati serangan pada turn itu.
    if (actor.skippedAttack) continue;
    // OwO memanggil canAttack semua buff (tidak berhenti di yang pertama),
    // karena Freeze menurunkan durasinya sendiri di sini.
    let blocked = false;
    for (const buff of actor.buffs) {
      if (buff.canAttack?.(ctx, actor, allies, foes) === false) blocked = true;
    }
    if (blocked) continue;
    act(ctx, actor, allies, foes);
  }

  for (const [team, foe] of [[player, enemy], [enemy, player]]) {
    for (const unit of team) {
      if (!isAlive(unit)) continue;
      for (const buff of [...unit.buffs]) buff.postTurn?.(ctx, unit, team, foe);
      if (unit.weapon) {
        unit.weapon.postTurn?.(ctx, unit, team, foe);
        for (const passive of unit.weapon.passives) passive.postTurn?.(ctx, unit, team, foe);
      }
    }
  }

  for (const unit of [...player, ...enemy]) {
    unit.buffs = unit.buffs.filter(b => {
      if (b.expired) return false;
      // Freeze menurunkan durasinya sendiri di canAttack, bukan di sini.
      if (b.managesOwnDuration) return true;
      if (b.duration == null) return true;
      b.duration -= 1;
      return b.duration > 0;
    });
  }
}

function act(ctx, actor, allies, foes) {
  const weapon = actor.weapon;
  // `manaCost` bisa 0 (Bleeding Gaze), jadi yang diperiksa keberadaan ability,
  // bukan truthiness biayanya — kalau tidak, senjata berbiaya WP 0 tidak pernah
  // memakai ability-nya.
  const hasAbility = weapon && weapon.ability && weapon.ability.kind !== 'none';
  if (hasAbility && actor.stats.wp[0] >= (weapon.manaCost || 0)) {
    if (weaponAbility(ctx, weapon, actor, allies, foes)) return;
  }
  basicAttack(ctx, actor, allies, foes);
}

function basicAttack(ctx, actor, allies, foes) {
  const target = chooseTarget(actor, allies, foes, ctx.rng);
  if (!target) return;
  // Sebagian senjata mengganti serangan dasarnya, bukan menambah ability aktif
  // (OwO: override attackPhysical). Bentuknya `basicAttack` di data.
  const weapon = actor.weapon;
  const override = weapon && weapon.def && weapon.def.basicAttack;
  if (override && override.kind === 'mixed_true') {
    const [pAtt, pMag] = override.mixed;
    const mixed = getMixedDamage(actor.stats.att, pAtt, actor.stats.mag, pMag, ctx.rng);
    inflictDamage(ctx, actor, target, mixed, TRUE);
    return;
  }
  const damage = getDamage(actor.stats.att, 1, ctx.rng);
  inflictDamage(ctx, actor, target, damage, PHYSICAL);
}

function isTeamDead(team) { return team.every(u => !isAlive(u)); }

// Satu pertarungan. Mengembalikan { winner, turns, timeout }.
// winner: 'player' | 'enemy' | 'tie'
function runBattle(playerSpecs, enemySpecs, options = {}) {
  const rng = options.rng || createRng(options.seed ?? 1);
  const player = playerSpecs.map(s => buildUnit(s, rng, options.playerQuality));
  const enemy = enemySpecs.map(s => buildUnit(s, rng, options.enemyQuality));
  for (const unit of player) { unit.team = player; unit.foes = enemy; }
  for (const unit of enemy) { unit.team = enemy; unit.foes = player; }
  const ctx = {
    rng,
    tags: new Set(),
    damageDealt: 0,
    playerFirst: options.playerFirst ?? true,
  };

  let turns = 0;
  let winner = 'tie';
  let timeout = false;
  while (turns < MAX_TURNS) {
    turns++;
    runTurn(ctx, player, enemy);
    const playerDead = isTeamDead(player);
    const enemyDead = isTeamDead(enemy);
    if (playerDead || enemyDead) {
      winner = playerDead && enemyDead ? 'tie' : enemyDead ? 'player' : 'enemy';
      break;
    }
    if (turns >= MAX_TURNS) { timeout = true; winner = 'tie'; }
  }

  return { winner, turns, timeout };
}

module.exports = {
  runBattle,
  buildUnit,
  buildStats,
  inflictDamage,
  heal,
  replenish,
  useMana,
  bindBuff,
  getDamage,
  getDamageFromHpWp,
  getMixedDamage,
  resToPercent,
  chooseTarget,
  lowestHp,
  lowestWp,
  pickRandom,
  aliveOf,
  isAlive,
  maxHp,
  maxWp,
  resistanceFromDisplayedPercent,
  tagged,
  withTag,
  PHYSICAL,
  MAGICAL,
  TRUE,
  MAX_ADAPT_STACKS,
  MAX_TURNS,
  MAX_SLOTS,
  runTurn,
};
