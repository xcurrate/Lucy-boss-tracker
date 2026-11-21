// Senjata battle: stat dari quality, pasif, dan ability aktif.
//
// Angka berasal dari `src/data/owoBattle.json`. Perhatikan `manaRange`:
// `manaCost = stats[last]`, jadi quality 0 memakai nilai pertama dan quality 100
// nilai kedua — untuk semua senjata OwO biaya WP TURUN saat quality naik.
const data = require('../data/owoBattle');
const { createBuff } = require('./battleBuffs');
const { createPassive, rollPassives } = require('./battlePassives');

// battleEngine mengimpor modul ini, jadi import top-level akan melingkar.
// Aksesor malas ini membuat siklusnya aman sekaligus menyimpan hasilnya:
// `require` di dalam fungsi ability berarti resolusi modul terjadi pada setiap
// serangan, dan itu mendominasi waktu simulasi.
let engineRef = null;
function engine() {
  if (!engineRef) engineRef = require('./battleEngine');
  return engineRef;
}

function statAt(range, quality) {
  const q = Math.min(100, Math.max(0, Number(quality) || 0));
  const [min, max] = range;
  return Math.round((min + (max - min) * (q / 100)) * 100) / 100;
}

function weaponStats(def, quality) {
  return def.qualityList.map((range, i) => {
    const q = Array.isArray(quality) ? quality[i] : quality;
    return statAt(range, q);
  });
}

// OwO menyambung qualityList senjata dengan qualityList tiap buff di `buffList`
// (WeaponInterface: "Buff qualities are always in the middle"), lalu menaruh
// `manaRange` di paling akhir. Urutan slotnya: stat → buff → biaya WP.
function buffSlots(def) {
  return (def.buffList || []).reduce(
    (n, id) => n + (data.buffById(id)?.qualityList.length || 0),
    0
  );
}

function buffQuality(def, quality) {
  if (!Array.isArray(quality)) return quality;
  const start = def.qualityList.length;
  return quality.slice(start, start + buffSlots(def));
}

function manaQuality(def, quality) {
  if (!Array.isArray(quality)) return quality;
  return quality[def.qualityList.length + buffSlots(def)];
}

function buildWeapon(spec, rng, globalQuality) {
  const def = typeof spec === 'object' && spec.id ? data.weapons().find(w => w.id === spec.id) : data.findWeapon(spec);
  if (!def) return null;

  const explicit = typeof spec === 'object' ? spec : {};
  // Urutan: quality slot → flag global (-qp/-qe) → tier tertinggi.
  const quality = explicit.quality ?? globalQuality ?? data.DEFAULT_QUALITY;
  const stats = weaponStats(def, quality);
  // OwO menambahkan `manaRange` ke qualityList lalu memakai elemen terakhir
  // sebagai biaya WP, jadi biaya punya slot kualitas sendiri di ujung array.
  const manaCost = def.manaRange
    ? statAt(def.manaRange, manaQuality(def, quality))
    : 0;
  const weapon = {
    id: def.id,
    name: def.name,
    def,
    stats,
    manaCost,
    // Kualitas mentah (skalar atau array slot). Buff mengambil potongannya
    // lewat buffQuality(); UI memakai nilai ini untuk memilih emoji rank.
    quality,
    ability: def.ability,
    passives: [],
  };

  // Pasif memakai tier yang sama dengan senjatanya, supaya ikon rank di
  // `d team show` sesuai dengan stat yang benar-benar dipakai simulasi.
  // Bila pemanggil tidak memilih pasif, undi sebanyak `passiveCount` bawaan —
  // bukan batas atas rentang — supaya hasil simulasi tidak berubah hanya karena
  // senjata kini boleh memakai satu pasif tambahan.
  const chosen = explicit.passives;
  weapon.passives = Array.isArray(chosen) && chosen.length
    ? chosen.map(id => createPassive(id, quality, rng)).filter(Boolean)
    : rollPassives(def.passiveCount, rng, quality);

  // Stat bonus dari pasif + efek Rune of the Forgotten (persen dari stat dasar).
  // Rune memakai satu persen yang sama untuk semua stat (stats[0]); qualityList-nya
  // memang hanya satu entri, jadi `mixed` di sana bukan persen per-stat.
  weapon.alterStats = statsObj => {
    for (const passive of weapon.passives) passive.alterStats?.(statsObj);
    if (def.statBoost === 'all') {
      const pct = weapon.stats[0] / 100;
      statsObj.hp[3] += statsObj.hp[1] * pct;
      statsObj.wp[3] += statsObj.wp[1] * pct;
      statsObj.att[1] += statsObj.att[0] * pct;
      statsObj.mag[1] += statsObj.mag[0] * pct;
      statsObj.pr[1] += statsObj.pr[0] * pct;
      statsObj.mr[1] += statsObj.mr[0] * pct;
    }
  };
  // Aegis dan Vanguard's Banner memasang efeknya di awal turn, bukan sebagai
  // ability aktif (OwO: Shield.preTurn, VanguardsBanner.preTurn).
  if (def.ability?.kind === 'taunt') {
    weapon.preTurn = (ctx, unit) => ABILITIES.taunt(ctx, weapon, unit);
  }
  if (def.ability?.kind === 'attack_up_chain') {
    weapon.preTurn = (ctx, unit) => ABILITIES.attack_up_chain(ctx, weapon, unit);
  }
  if (def.ability?.kind === 'curse_all') {
    weapon.preTurn = (ctx, unit, team, foe) => ABILITIES.curse_all(ctx, weapon, unit, foe);
  }
  if (def.ability?.kind === 'anniversary') {
    weapon.preTurn = (ctx, unit) => ABILITIES.anniversary(ctx, weapon, unit);
  }
  return weapon;
}

// Ability aktif. Mengembalikan true bila benar-benar dipakai; false berarti
// pemanggil harus jatuh ke serangan fisik (mis. tidak ada target valid).
const ABILITIES = {
  damage_all(ctx, weapon, actor) {
    const e = engine();
    const ab = weapon.ability;
    e.useMana(actor, weapon.manaCost);
    const raw = e.getDamage(actor.stats[ab.stat], weapon.stats[0] / 100, ctx.rng);
    for (const target of e.aliveOf(actor.foes)) e.inflictDamage(ctx, actor, target, raw, ab.type || e.PHYSICAL);
    return true;
  },

  damage_one(ctx, weapon, actor) {
    const e = engine();
    const ab = weapon.ability;
    const target = e.chooseTarget(actor, actor.team, actor.foes, ctx.rng);
    if (!target) return false;
    e.useMana(actor, weapon.manaCost);
    const raw = e.getDamage(actor.stats[ab.stat], weapon.stats[0] / 100, ctx.rng);
    e.inflictDamage(ctx, actor, target, raw, ab.type || e.PHYSICAL);
    return true;
  },

  damage_one_buff(ctx, weapon, actor) {
    const e = engine();
    const ab = weapon.ability;
    const buffId = weapon.def.buffList[0];
    const target = e.chooseTarget(actor, actor.team, actor.foes, ctx.rng, {
      excludeBuffId: ab.skipIfBuffed ? buffId : undefined,
    });
    if (!target) return false;
    e.useMana(actor, weapon.manaCost);
    const already = target.buffs.some(b => b.id === buffId);
    const pct = weapon.stats[0] + (already && ab.bonusIfBuffed ? weapon.stats[ab.bonusIfBuffed] : 0);
    const raw = e.getDamage(actor.stats[ab.stat], pct / 100, ctx.rng);
    e.inflictDamage(ctx, actor, target, raw, ab.type || e.PHYSICAL);
    // Glacial Axe melewati buff kalau target sudah terkena Freeze.
    if (!(ab.skipIfBuffed && already)) applyBuff(ctx, buffId, actor, target, ab.duration, buffQuality(weapon.def, weapon.quality));
    return true;
  },

  damage_all_heal_team(ctx, weapon, actor) {
    const e = engine();
    const ab = weapon.ability;
    e.useMana(actor, weapon.manaCost);
    const raw = e.getDamage(actor.stats[ab.stat], weapon.stats[0] / 100, ctx.rng);
    let dealt = 0;
    for (const target of e.aliveOf(actor.foes)) dealt += e.inflictDamage(ctx, actor, target, raw, e.MAGICAL);
    const allies = e.aliveOf(actor.team);
    for (const unit of allies) e.heal(ctx, unit, dealt / Math.max(1, allies.length), actor);
    return true;
  },

  damage_one_steal_wp(ctx, weapon, actor) {
    const e = engine();
    const ab = weapon.ability;
    const target = e.chooseTarget(actor, actor.team, actor.foes, ctx.rng);
    if (!target) return false;
    e.useMana(actor, weapon.manaCost);
    const raw = e.getDamage(actor.stats[ab.stat], weapon.stats[0] / 100, ctx.rng);
    const dealt = e.inflictDamage(ctx, actor, target, raw, e.MAGICAL);
    const stolen = Math.min((dealt * weapon.stats[1]) / 100, target.stats.wp[0]);
    target.stats.wp[0] -= stolen;
    // OwO AbsorbWand memakai getLowestWp(team), jadi pemakai sendiri ikut dihitung.
    const receiver = e.lowestWp(actor.team) || actor;
    e.replenish(ctx, receiver, stolen, actor);
    return true;
  },

  heal_lowest(ctx, weapon, actor) {
    const e = engine();
    const ab = weapon.ability;
    const target = e.lowestHp(actor.team);
    if (!target) return false;
    if (target.stats.hp[0] + 1 >= e.maxHp(target) * 1.5) return false;
    e.useMana(actor, weapon.manaCost);
    const raw = e.getDamage(actor.stats[ab.stat], weapon.stats[0] / 100, ctx.rng);
    e.heal(ctx, target, raw, actor, { overheal: true });
    return true;
  },

  heal_all_buff(ctx, weapon, actor) {
    const e = engine();
    const ab = weapon.ability;
    e.useMana(actor, weapon.manaCost);
    const raw = e.getDamage(actor.stats[ab.stat], weapon.stats[0] / 100, ctx.rng);
    for (const unit of e.aliveOf(actor.team)) {
      e.heal(ctx, unit, raw, actor);
      applyBuff(ctx, weapon.def.buffList[0], actor, unit, ab.duration, buffQuality(weapon.def, weapon.quality));
    }
    return true;
  },

  replenish_ally(ctx, weapon, actor) {
    const e = engine();
    const ab = weapon.ability;
    const target = e.lowestWp(actor.team, actor);
    if (!target) return false;
    if (target.stats.wp[0] + 1 >= e.maxWp(target) * 1.5) return false;
    e.useMana(actor, weapon.manaCost);
    const raw = e.getDamage(actor.stats[ab.stat], weapon.stats[0] / 100, ctx.rng);
    e.replenish(ctx, target, raw, actor, { overreplenish: true });
    return true;
  },

  revive(ctx, weapon, actor) {
    const e = engine();
    const ab = weapon.ability;
    // OwO WeaponInterface.getDead(): ambil rekan mati pertama (urutan slot).
    const dead = actor.team.find(u => u.stats.hp[0] <= 0);
    if (!dead) return false;
    e.useMana(actor, weapon.manaCost);
    dead.stats.hp[0] = 0;
    const raw = e.getDamage(actor.stats[ab.stat], weapon.stats[0] / 100, ctx.rng);
    // Tanpa `revive`, heal() menolak target ber-HP 0 sehingga rekan tidak
    // pernah benar-benar hidup kembali.
    e.heal(ctx, dead, raw, actor, { revive: true });
    return true;
  },

  taunt(ctx, weapon, actor) {
    const e = engine();
    // OwO Shield.preTurn: hanya menolak bila Taunt sudah menempel.
    if (actor.buffs.some(b => b.id === 1)) return false;
    // preTurn dipanggil di luar `act()`, jadi cek WP dilakukan di sini.
    if (actor.stats.wp[0] < weapon.manaCost) return false;
    e.useMana(actor, weapon.manaCost);
    applyBuff(ctx, 1, actor, actor, weapon.ability.duration, buffQuality(weapon.def, weapon.quality));
    actor.skippedAttack = true;
    return true;
  },

  // Vanguard's Banner memasang Attack Up ke SEMUA rekan di awal turn. Saat buff
  // tinggal 1 turn, pemasangan berikutnya menaikkan tier (Attack Up → + → ++).
  attack_up_chain(ctx, weapon, actor) {
    const e = engine();
    const ab = weapon.ability;
    const tiers = weapon.def.buffList;
    if (actor.stats.wp[0] < weapon.manaCost) return false;
    const current = actor.buffs.find(b => tiers.includes(b.id));
    if (current && current.duration > 1) return false;
    const nextId = current ? Math.min(current.id + 1, tiers[tiers.length - 1]) : tiers[0];
    e.useMana(actor, weapon.manaCost);
    for (const unit of e.aliveOf(actor.team)) {
      if (current) unit.buffs = unit.buffs.filter(b => !(b.id === current.id && b.from === actor));
      // Durasi +1 karena mesin menurunkan durasi di akhir turn pemasangan juga.
      // Tanpa ini buff tinggal 1 turn saat preTurn berikutnya, sehingga recast
      // dan eskalasi terjadi tiap turn dan unit tidak pernah menyerang.
      applyBuff(ctx, nextId, actor, unit, ab.duration + 1, buffQuality(weapon.def, weapon.quality));
    }
    actor.skippedAttack = true;
    return true;
  },

  // Witching Hour: kutuk SEMUA musuh di awal turn. Biaya WP dibayar tiap
  // giliran (bukan sekali), jadi unit yang kehabisan WP berhenti mengutuk.
  curse_all(ctx, weapon, actor, foes) {
    const e = engine();
    const ab = weapon.ability;
    const buffId = weapon.def.buffList[0];
    // Hanya musuh yang belum terkutuk: memasang ulang tiap turn akan
    // menggabungkan durasi dan membuat kutukan bertahan jauh lebih lama dari
    // 2 turn yang disebut sumber.
    const enemies = e.aliveOf(foes || actor.foes || []).filter(u => !u.buffs.some(b => b.id === buffId));
    if (!enemies.length) return false;
    if (actor.stats.wp[0] < weapon.manaCost) return false;
    e.useMana(actor, weapon.manaCost);
    // Tanpa +1: mesin menurunkan durasi di akhir turn pemasangan, jadi durasi 2
    // menghasilkan tepat 2 kali damage akhir turn.
    for (const target of enemies) {
      applyBuff(ctx, buffId, actor, target, ab.duration, buffQuality(weapon.def, weapon.quality));
    }
    return true;
  },

  // Scepter of Celebrations: tiap 4 giliran memasang Anniversary Blessing ke
  // seluruh tim. Penghitungnya per unit (`ctx.turn`) supaya tidak bergantung
  // pada urutan giliran.
  anniversary(ctx, weapon, actor) {
    const e = engine();
    const ab = weapon.ability;
    const every = ab.interval || 4;
    const turn = ctx.turn || 1;
    if ((turn - 1) % every !== 0) return false;
    if (actor.stats.wp[0] < weapon.manaCost) return false;
    e.useMana(actor, weapon.manaCost);
    for (const ally of e.aliveOf(actor.team)) {
      applyBuff(ctx, weapon.def.buffList[0], actor, ally, ab.duration, buffQuality(weapon.def, weapon.quality));
    }
    return true;
  },

  // Bleeding Gaze: biaya WP 0, biaya HP 20-10% Max HP. Satu musuh dipaksa
  // menyerang sekutunya dengan efektivitas senjata 30-50%; kalau musuh hanya
  // satu, damage 150-200% MAG langsung ke dia.
  bleeding_gaze(ctx, weapon, actor) {
    const e = engine();
    const ab = weapon.ability;
    const enemies = e.aliveOf(actor.foes || []);
    if (!enemies.length) return false;
    const hpCost = e.maxHp(actor) * (weapon.stats[2] / 100);
    if (actor.stats.hp[0] <= hpCost) return false;
    e.useMana(actor, weapon.manaCost);
    actor.stats.hp[0] -= hpCost;

    const target = e.pickRandom(enemies, ctx.rng);
    if (!target) return true;
    const allies = e.aliveOf(target.team).filter(u => u !== target);
    if (!allies.length) {
      const raw = e.getDamage(actor.stats[ab.stat], weapon.stats[1] / 100, ctx.rng);
      e.inflictDamage(ctx, actor, target, raw, e.MAGICAL);
      return true;
    }
    // Serangan paksa: target memakai senjatanya sendiri, tapi efektivitasnya
    // dipotong ke stats[0]. Efek debuff-nya tetap menempel seperti serangan biasa.
    const victim = e.pickRandom(allies, ctx.rng);
    const raw = e.getDamage(target.stats.att, weapon.stats[0] / 100, ctx.rng);
    e.inflictDamage(ctx, target, victim, raw, e.PHYSICAL);
    return true;
  },

  // Conduit Claw: pindahkan satu debuff dari musuh ke sekutu dengan buff
  // terbanyak, efektivitasnya dipotong, lalu beri damage MAG ke musuh itu.
  conduit(ctx, weapon, actor) {
    const e = engine();
    const ab = weapon.ability;
    const targets = e.aliveOf(actor.foes || []).filter(u => u.buffs.some(b => b.debuff));
    const target = e.pickRandom(targets, ctx.rng);
    if (!target) return false;
    const allies = e.aliveOf(actor.team);
    if (!allies.length) return false;
    // "Sekutu dengan buff terbanyak" milik tim musuh, bukan tim pemakai.
    const receiver = target.team
      .filter(u => e.isAlive(u) && u !== target)
      .sort((a, b) => b.buffs.length - a.buffs.length)[0];
    if (!receiver) return false;
    e.useMana(actor, weapon.manaCost);

    const idx = target.buffs.findIndex(b => b.debuff);
    const [moved] = target.buffs.splice(idx, 1);
    moved.effectiveness = (moved.effectiveness ?? 1) * (1 - weapon.stats[0] / 100);
    moved.from = actor; // stat caster asli tetap dipakai, hanya pemberinya berubah
    e.bindBuff(ctx, receiver, moved);

    const raw = e.getDamage(actor.stats[ab.stat], weapon.stats[1] / 100, ctx.rng);
    e.inflictDamage(ctx, actor, target, raw, e.MAGICAL);
    return true;
  },

  // Staff of Corruption: efektivitas buff musuh acak turun ke 70-50%, lalu buff
  // itu mengenai pemakai sebesar 80-120% STR.
  corrupt_buff(ctx, weapon, actor) {
    const e = engine();
    const ab = weapon.ability;
    const targets = e.aliveOf(actor.foes || []).filter(u => u.buffs.length);
    const target = e.pickRandom(targets, ctx.rng);
    if (!target) return false;
    e.useMana(actor, weapon.manaCost);

    const buff = e.pickRandom(target.buffs, ctx.rng);
    buff.effectiveness = (buff.effectiveness ?? 1) * (weapon.stats[0] / 100);
    const raw = e.getDamage(actor.stats[ab.stat], weapon.stats[1] / 100, ctx.rng);
    e.inflictDamage(ctx, actor, target, raw, e.PHYSICAL);
    return true;
  },

  celebration(ctx, weapon, actor) {
    const e = engine();
    const target = e.lowestHp(actor.team, 10);
    if (!target) return false;
    if (target.stats.hp[0] + 1 >= e.maxHp(target)) return false;
    e.useMana(actor, weapon.manaCost);
    applyBuff(ctx, 10, actor, target, weapon.ability.duration, buffQuality(weapon.def, weapon.quality));
    return true;
  },

  // Staff of Purity: buang debuff dari rekan acak, heal 50-100% MAG, lalu
  // pasang 1 stack Sacred Ward 2 turn.
  purify(ctx, weapon, actor) {
    const e = engine();
    const ab = weapon.ability;
    const debuffed = e.pickRandom(e.aliveOf(actor.team).filter(u => u.buffs.some(b => b.debuff)), ctx.rng);
    if (!debuffed) return false;
    e.useMana(actor, weapon.manaCost);
    const idx = debuffed.buffs.findIndex(b => b.debuff);
    if (idx >= 0) debuffed.buffs.splice(idx, 1);
    const raw = e.getDamage(actor.stats[ab.stat], weapon.stats[0] / 100, ctx.rng);
    e.heal(ctx, debuffed, raw, actor);
    applyBuff(ctx, 13, actor, debuffed, ab.duration, buffQuality(weapon.def, weapon.quality));
    return true;
  },

  luck_hits(ctx, weapon, actor) {
    const e = engine();
    const target = e.chooseTarget(actor, actor.team, actor.foes, ctx.rng);
    if (!target) return false;
    e.useMana(actor, weapon.manaCost);
    for (let i = 0; i < weapon.ability.hits; i++) {
      const physical = ctx.rng.next() < 0.5;
      const stat = physical ? 'att' : 'mag';
      const raw = e.getDamage(actor.stats[stat], weapon.stats[i] / 100, ctx.rng);
      e.inflictDamage(ctx, actor, target, raw, physical ? e.PHYSICAL : e.MAGICAL);
    }
    return true;
  },

};

function applyBuff(ctx, buffId, from, target, duration, quality) {
  const e = engine();
  if (!e.isAlive(target)) return;
  const buff = createBuff(buffId, { quality, from, duration, rng: ctx.rng });
  if (buff) e.bindBuff(ctx, target, buff);
}

function weaponAbility(ctx, weapon, actor) {
  const ab = weapon.ability;
  if (!ab || ab.kind === 'none') return false;
  // Dipasang di awal turn (preTurn), bukan sebagai ability aktif.
  if (ab.kind === 'taunt' || ab.kind === 'attack_up_chain' || ab.kind === 'curse_all') return false;
  if (ab.kind === 'anniversary') return false;
  const handler = ABILITIES[ab.kind];
  if (!handler) return false;
  return handler(ctx, weapon, actor) === true;
}

module.exports = { buildWeapon, weaponAbility, weaponStats, buffQuality, manaQuality, statAt, ABILITIES, applyBuff };
