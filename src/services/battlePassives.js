// Pasif senjata. Port 1:1 dari OwO `battle/passives/`, memakai layout stat yang
// sama sehingga rumusnya tidak berubah.
//
// Hook yang dipakai mesin: alterStats, attack, postAttack, attacked,
// postAttacked, healed, postHealed, postReplenished, postTurn.
const passiveData = require('../data/owoPassives.json');

// battleEngine mengimpor modul ini, jadi import top-level akan melingkar.
// Aksesor malas ini membuat siklusnya aman dan tetap satu pintu.
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

function statsFor(def, quality) {
  return def.qualityList.map(range => statAt(range, quality));
}

// Setiap pasif adalah factory: (stats, rng) → objek dengan hook.
const PASSIVES = {
  1: (stats) => ({ id: 1, name: 'Strength', stats, alterStats(s) { s.att[1] += s.att[0] * (stats[0] / 100); } }),
  2: (stats) => ({ id: 2, name: 'Magic', stats, alterStats(s) { s.mag[1] += s.mag[0] * (stats[0] / 100); } }),
  3: (stats) => ({ id: 3, name: 'Health Point', stats, alterStats(s) { s.hp[3] += s.hp[1] * (stats[0] / 100); } }),
  4: (stats) => ({ id: 4, name: 'Weapon Point', stats, alterStats(s) { s.wp[3] += s.wp[1] * (stats[0] / 100); } }),
  5: (stats) => ({ id: 5, name: 'Physical Resistance', stats, alterStats(s) { s.pr[1] += s.pr[0] * (stats[0] / 100); } }),
  6: (stats) => ({ id: 6, name: 'Magical Resistance', stats, alterStats(s) { s.mr[1] += s.mr[0] * (stats[0] / 100); } }),

  7: (stats) => ({
    id: 7, name: 'Lifesteal', stats,
    postAttack(ctx, unit, target, total) {
      const { heal, tagged, withTag } = engine();
      if (tagged(ctx, 'lifesteal', unit) || tagged(ctx, 'kamikaze', unit)) return;
      if (unit.stats.hp[0] <= 0) return;
      withTag(ctx, 'lifesteal', unit, () => heal(ctx, unit, (total * stats[0]) / 100, unit));
    },
  }),

  8: (stats) => ({
    id: 8, name: 'Thorns', stats,
    postAttacked(ctx, unit, attacker, total) {
      const { inflictDamage, tagged, withTag, TRUE } = engine();
      if (tagged(ctx, 'thorns', unit) || unit.stats.hp[0] <= 0) return;
      const damage = (total * stats[0]) / 100;
      if (damage < 1) return;
      withTag(ctx, 'thorns', unit, () => inflictDamage(ctx, unit, attacker, damage, TRUE));
    },
  }),

  9: (stats) => ({
    id: 9, name: 'Mana Tap', stats,
    postAttack(ctx, unit, target, total) {
      const { replenish } = engine();
      replenish(ctx, unit, (total * stats[0]) / 100, unit);
    },
  }),

  10: (stats) => ({
    id: 10, name: 'Absolve', stats,
    postHealed(ctx, unit, healer, total) {
      const { inflictDamage, chooseTarget, tagged, withTag, MAGICAL } = engine();
      if (tagged(ctx, 'absolve', unit)) return;
      const damage = (total * stats[0]) / 100;
      if (damage < 1) return;
      const target = chooseTarget(unit, unit.team, unit.foes, ctx.rng, { ignoreChoose: true });
      if (!target) return;
      withTag(ctx, 'absolve', unit, () => inflictDamage(ctx, unit, target, damage, MAGICAL));
    },
  }),

  // Adaptation: tiap kali menerima damage, dapat stack resistensi terhadap tipe
  // damage terakhir. Stack dihitung terpisah untuk PHYSICAL dan MAGICAL karena
  // sumber menyebut dua ikon berbeda (Stoneskin / Spellskin).
  // Adaptation: resistensi terhadap tipe damage TERAKHIR. Physical memberi
  // Stoneskin, Magical memberi Spellskin; menerima tipe lain menghapus semua
  // stack. Satu pool stack saja (bukan dua), maksimal 5.
  // Giant Slayer: +10-25% damage hanya bila sasaran bertanda boss. Battle biasa
  // (PvP, mirror) tidak punya boss, jadi pasif ini tidak berefek di sana.
  22: (stats) => ({
    id: 22, name: 'Giant Slayer', stats,
    attack(ctx, unit, target, bucket) {
      if (!target?.isBoss) return;
      bucket.bonus += (bucket.amount + bucket.bonus) * (stats[0] / 100);
    },
  }),

  27: (stats) => ({
    id: 27, name: 'Adaptation', stats,
    stackType: null, // 'p' (Stoneskin) | 'm' (Spellskin) | null
    stacks: 0,
    attacked(ctx, unit, attacker, bucket, type) {
      const { PHYSICAL, MAGICAL: MAGICAL_KEY, MAX_ADAPT_STACKS } = engine();
      if (unit.stats.hp[0] <= 0) return;
      // Damage TRUE tidak termasuk Physical maupun Magical: sumber hanya
      // menyebut dua tipe itu, jadi TRUE menghapus stack tanpa memberi stack.
      const key = type === PHYSICAL ? 'p' : type === MAGICAL_KEY ? 'm' : null;
      if (!key) {
        this.stackType = null;
        this.stacks = 0;
        return;
      }
      if (this.stackType !== key) {
        // Tipe lain: buang semua stack. Hit ini belum memakai stack baru.
        this.stackType = key;
        this.stacks = 0;
      } else if (this.stacks > 0) {
        // Stack yang sudah ada berlaku untuk hit ini, baru setelah itu bertambah.
        bucket.bonus -= (bucket.amount + bucket.bonus) * ((stats[0] * this.stacks) / 100);
      }
      if (this.stacks < MAX_ADAPT_STACKS) this.stacks += 1;
    },
  }),

  11: (stats) => ({
    id: 11, name: 'Safeguard', stats,
    attacked(ctx, unit, attacker, bucket) {
      const { useMana, tagged, withTag } = engine();
      if (tagged(ctx, 'safeguard', unit)) return;
      let negate = (bucket.amount * stats[0]) / 100;
      if (unit.stats.wp[0] < negate) negate = unit.stats.wp[0];
      if (negate <= 0) return;
      withTag(ctx, 'safeguard', unit, () => {
        bucket.bonus -= useMana(unit, negate);
      });
    },
  }),

  12: (stats) => ({
    id: 12, name: 'Critical', stats,
    attack(ctx, unit, target, bucket) {
      if (ctx.rng.next() * 100 > stats[0]) return;
      bucket.bonus += (bucket.amount * stats[1]) / 100;
    },
    heal(ctx, unit, target, bucket) {
      if (ctx.rng.next() * 100 > stats[0]) return;
      bucket.bonus += (bucket.amount * stats[1]) / 100;
    },
  }),

  13: (stats) => ({
    id: 13, name: 'Discharge', stats,
    postReplenished(ctx, unit, from, total) {
      const { inflictDamage, chooseTarget, tagged, withTag, MAGICAL } = engine();
      if (tagged(ctx, 'discharge', unit)) return;
      const damage = (total * stats[0]) / 100;
      if (damage < 1) return;
      const target = chooseTarget(unit, unit.team, unit.foes, ctx.rng, { ignoreChoose: true });
      if (!target) return;
      withTag(ctx, 'discharge', unit, () => inflictDamage(ctx, unit, target, damage, MAGICAL));
    },
  }),

  14: (stats) => ({
    id: 14, name: 'Kamikaze', stats,
    postAttacked(ctx, unit, attacker, _total, _type) {
      const { inflictDamage, getDamageFromHpWp, tagged, withTag, MAGICAL } = engine();
      if (tagged(ctx, 'kamikaze', unit) || unit.stats.hp[0] > 0) return;
      const damage = getDamageFromHpWp(unit.stats.hp, stats[0] / 100, ctx.rng);
      withTag(ctx, 'kamikaze', unit, () => inflictDamage(ctx, unit, attacker, damage, MAGICAL));
    },
  }),

  15: (stats) => ({
    id: 15, name: 'Regeneration', stats,
    postTurn(ctx, unit) {
      const { heal } = engine();
      if (unit.stats.hp[0] <= 0) return;
      const amount = (unit.stats.hp[1] + unit.stats.hp[3]) * (stats[0] / 100);
      heal(ctx, unit, amount, unit);
    },
  }),

  16: (stats) => ({
    id: 16, name: 'Energize', stats,
    postTurn(ctx, unit) {
      const { replenish, maxWp } = engine();
      if (unit.stats.hp[0] <= 0) return;
      if (unit.stats.wp[0] >= maxWp(unit)) return;
      replenish(ctx, unit, stats[0], unit);
    },
  }),

  17: (stats) => ({
    id: 17, name: 'Sprout', stats,
    healed(ctx, unit, healer, bucket) {
      bucket.bonus += (bucket.amount * stats[0]) / 100;
    },
  }),

  18: (stats) => ({
    id: 18, name: 'Enrage', stats,
    attack(ctx, unit, target, bucket) {
      const max = unit.stats.hp[1] + unit.stats.hp[3];
      const current = unit.stats.hp[0];
      if (current >= max) return;
      const missing = (1 - current / max) * 10;
      const extra = bucket.amount * (stats[0] / 100) * missing;
      if (Math.floor(extra) <= 0) return;
      bucket.bonus += extra;
    },
  }),

  19: (stats) => ({
    id: 19, name: 'Sacrifice', stats,
    postAttacked(ctx, unit, attacker, _total, _type) {
      const { heal, replenish, getDamageFromHpWp, aliveOf, tagged, withTag } = engine();
      if (tagged(ctx, 'sacrifice', unit) || unit.stats.hp[0] > 0) return;
      withTag(ctx, 'sacrifice', unit, () => {
        const targets = aliveOf(unit.team);
        const healAmount = getDamageFromHpWp(unit.stats.hp, stats[0] / 100, ctx.rng);
        const wpAmount = getDamageFromHpWp(unit.stats.wp, stats[1] / 100, ctx.rng);
        for (const ally of targets) {
          heal(ctx, ally, healAmount, unit);
          replenish(ctx, ally, wpAmount, unit);
        }
      });
    },
  }),

  20: (stats) => ({
    id: 20, name: 'Snail', stats,
    postAttack(ctx, unit, target, total, type) {
      const { inflictDamage, chooseTarget, tagged, withTag } = engine();
      if (tagged(ctx, 'snail', unit)) return;
      const damage = (total * stats[0]) / 100;
      const victim = chooseTarget(unit, unit.team, unit.foes, ctx.rng, { ignoreChoose: true });
      if (!victim) return;
      // Damage sudah melewati resistensi, jadi jangan dihitung ulang.
      withTag(ctx, 'snail', unit, () => inflictDamage(ctx, unit, victim, damage, type, { bypassRes: true }));
    },
  }),

  21: () => ({ id: 21, name: 'Knowledge', stats: [], }), // tidak berpengaruh di battle
};

// Membangun instance pasif. `quality` 0-100; tanpa itu di-roll dari RNG.
function createPassive(id, quality, rng) {
  const def = passiveData.passives.find(p => p.id === Number(id));
  const factory = PASSIVES[Number(id)];
  if (!def || !factory) return null;
  const q = quality == null ? Math.floor((rng ? rng.next() : Math.random()) * 101) : quality;
  const passive = factory(statsFor(def, q), rng);
  passive.quality = q;
  return passive;
}

function rollPassives(count, rng, quality) {
  const pool = Object.keys(PASSIVES).map(Number).filter(id => id !== 21);
  const picked = [];
  for (let i = 0; i < count; i++) {
    const id = pool[Math.floor((rng ? rng.next() : Math.random()) * pool.length)];
    picked.push(createPassive(id, quality ?? null, rng));
  }
  return picked.filter(Boolean);
}

module.exports = { PASSIVES, createPassive, rollPassives, statsFor, statAt };
