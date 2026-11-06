const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

let tempDir;

function resetModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('animalDex.js') || key.includes('animalDexStorage.js') || key.includes(path.sep + 'commands' + path.sep + 'prefix.js')) delete require.cache[key];
  }
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-tracker-dex-'));
  process.chdir(tempDir);
  resetModules();
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// Kartu "Informasi animal" contoh (disederhanakan dari capture asli Lucy).
const card = (overrides = {}) => ({
  components: [{
    type: 17,
    components: [{
      type: 9,
      components: [{ type: 10, content: '## <a:lawliet:1557672128059539466> ' + (overrides.name || 'lawliet') + '\n*Requested by <@1515658233174294569>*' }],
      accessory: {
        type: 11,
        media: { url: 'https://cdn.discordapp.com/emojis/1557672128059539466.gif' },
        description: overrides.name || 'lawliet',
        spoiler: false
      }
    }, { type: 14, spacing: 1, divider: true },
    { type: 10, content: overrides.info || "- **Informasi animal:**\n  - **Nickname:** 'DM ME'\n  - **Jumlah:** 0/1\n  - **Rank:** <a:cpatreon:1541932219772313661> cpatreon\n  - **Alias:** lawliet, lawliet\n  - **Points:** 25000\n  - **Sell:** ???\n  - **Sacrifice:** 25000 Essence | 1 killed" },
    { type: 14, spacing: 1, divider: true },
    { type: 10, content: overrides.stats || '## <:hp:1541928276165922906> `2` <:att:1541928417069375498> `0` <:pr:1541928475454079077> `1`\n## <:wp:1523723591194120354> `3` <:mg:1523723618016563210> `14` <:mr:1523723644243804281> `2`' },
    { type: 14, spacing: 1, divider: true },
    { type: 10, content: overrides.role || '- **Role**\n  * <:balanced:1551271654712152254> Hybrid — Balanced' },
    { type: 14, spacing: 1, divider: true },
    { type: 10, content: overrides.weapons || '- **Rekomendasi Weapon**\n  * <:fstithe:1550633888559145021> <:fascept:1541851395240497164> <:fbgaze:1550294886463438896> + more' },
    { type: 14, spacing: 1, divider: true },
    { type: 10, content: overrides.rarity || '-# Kelangkaan: <a:cpatreon:1541932219772313661> cpatreon • 8 total ditangkap' }]
  }]
});

function makeMessage(raw, { id = 'm1', guildId = 'g1' } = {}) {
  return { id, guildId, toJSON: () => raw };
}

describe('animal dex parser', () => {
  it('parses all fields from a Lucy animal card', () => {
    const { parseAnimalCard } = require('../src/services/animalDex');
    const a = parseAnimalCard(card());
    assert.strictEqual(a.name, 'lawliet');
    assert.strictEqual(a.nameKey, 'lawliet');
    assert.strictEqual(a.nickname, 'DM ME');
    assert.strictEqual(a.quantity, '0/1');
    assert.strictEqual(a.rank, 'cpatreon');
    assert.strictEqual(a.alias, 'lawliet');
    assert.strictEqual(a.points, '25000');
    assert.strictEqual(a.sell, '???');
    assert.strictEqual(a.sacrifice, '25000 Essence | 1 killed');
    assert.deepStrictEqual(a.stats, { hp: 2, attack: 0, protection: 1, wisdom: 3, magic: 14, mr: 2 });
    assert.strictEqual(a.role, 'Hybrid — Balanced');
    assert.ok(a.weapons.includes('fstithe'));
    assert.ok(a.weapons.includes('+ more'));
    assert.strictEqual(a.rarity, 'cpatreon');
    assert.strictEqual(a.capturedTotal, 8);
    assert.strictEqual(a.imageUrl, 'https://cdn.discordapp.com/emojis/1557672128059539466.gif');
    // Token emoji stat asli disimpan untuk dirender ulang.
    assert.strictEqual(a.statTokens.hp, '<:hp:1541928276165922906>');
    assert.strictEqual(a.statTokens.mr, '<:mr:1523723644243804281>');
  });

  it('returns null for messages that are not animal cards', () => {
    const { parseAnimalCard, isAnimalCard } = require('../src/services/animalDex');
    const other = { components: [{ type: 17, components: [{ type: 10, content: '## Guild Boss Telah Dikalahkan!' }] }] };
    assert.strictEqual(parseAnimalCard(other), null);
    assert.strictEqual(isAnimalCard(other), false);
    assert.strictEqual(isAnimalCard(card()), true);
  });

  it('normalizes names for dedupe keys', () => {
    const { normalizeName } = require('../src/services/animalDex');
    assert.strictEqual(normalizeName('Lawliet'), 'lawliet');
    assert.strictEqual(normalizeName('  Law L I E T '), 'law l i e t');
  });
});

describe('animal dex storage', () => {
  it('upserts by guild and name, and merges partial updates', () => {
    const { captureMessage } = require('../src/services/animalDex');
    const store = require('../src/utils/animalDexStorage');
    captureMessage(makeMessage(card()));
    assert.strictEqual(store.countAnimals('g1'), 1);

    // Kartu baru hanya berisi sebagian data (mis. hanya statistik) → data lama tetap ada.
    captureMessage(makeMessage(card({ stats: '## <:hp:1541928276165922906> `9`' })));
    const animal = store.getAnimal('g1', 'lawliet');
    assert.strictEqual(animal.stats.hp, 9);
    assert.strictEqual(animal.nickname, 'DM ME'); // dari kartu pertama
    assert.strictEqual(store.countAnimals('g1'), 1); // tetap satu baris
  });

  it('searches by name, alias, nickname, and rank', () => {
    const { captureMessage } = require('../src/services/animalDex');
    const store = require('../src/utils/animalDexStorage');
    captureMessage(makeMessage(card({ name: 'lawliet' })));
    captureMessage(makeMessage(card({ name: 'wolfie', info: '- **Informasi animal:**\n  - **Nickname:** Flame\n  - **Rank:** <a:crare:1> crare' }), { id: 'm2' }));

    assert.strictEqual(store.searchAnimals('g1', 'lawliet').length, 1);
    assert.strictEqual(store.searchAnimals('g1', 'flame').length, 1);
    assert.strictEqual(store.searchAnimals('g1', 'crare').length, 1);
    assert.strictEqual(store.searchAnimals('g1', '').length, 2);
    assert.strictEqual(store.searchAnimals('g1', 'nope').length, 0);
  });
});

describe('dex prefix command', () => {
  it('parses dex and d with optional query', () => {
    const { parseDexInput } = require('../src/commands/prefix');
    assert.deepStrictEqual(parseDexInput('!dex', '!').args, []);
    assert.deepStrictEqual(parseDexInput('!dex lawliet', '!').args, ['lawliet']);
    assert.deepStrictEqual(parseDexInput('!d hybrid role', '!').args, ['hybrid', 'role']);
    assert.strictEqual(parseDexInput('!boss help', '!'), null);
    assert.strictEqual(parseDexInput('!ping', '!'), null);
  });

  it('replies with a detail card for a single match and a list otherwise', () => {
    const { captureMessage, buildDexResponse } = require('../src/services/animalDex');
    captureMessage(makeMessage(card()));

    const detail = buildDexResponse('g1', 'lawliet');
    assert.strictEqual(detail.embeds.length, 1);
    assert.strictEqual(detail.embeds[0].data.title, '🐾 lawliet');

    const list = buildDexResponse('g1', '');
    assert.match(list.embeds[0].data.title, /Animal Dex/);
    assert.match(list.embeds[0].data.description, /lawliet/);

    const none = buildDexResponse('g1', 'zzz');
    assert.match(none.embeds[0].data.description, /Tidak ada/);
  });
});
