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
      components: [{ type: 10, content: '## <a:' + (overrides.emoji || 'lawliet') + ':1557672128059539466> ' + (overrides.name || 'lawliet') + '\n*Requested by <@1515658233174294569>*' }],
      accessory: {
        type: 11,
        media: { url: 'https://cdn.discordapp.com/emojis/1557672128059539466.gif' },
        description: overrides.name || 'lawliet',
        spoiler: false
      }
    }, { type: 14, spacing: 1, divider: true },
    { type: 10, content: overrides.info || "- **Informasi animal:**\n  - **Nickname:** 'DM ME'\n  - **Jumlah:** 0/1\n  - **Rank:** <a:cpatreon:1541932219772313661> cpatreon\n  - **Alias:** " + (overrides.name || 'lawliet') + ", " + (overrides.name || 'lawliet') + "\n  - **Points:** 25000\n  - **Sell:** ???\n  - **Sacrifice:** 25000 Essence | 1 killed" },
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
    // Nama emoji hewan disimpan (untuk pencarian via emoji yang disalin user).
    assert.strictEqual(a.emojiName, 'lawliet');
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
  it('upserts globally by name and merges partial updates', () => {
    const { captureMessage } = require('../src/services/animalDex');
    const store = require('../src/utils/animalDexStorage');
    captureMessage(makeMessage(card()));
    assert.strictEqual(store.countAnimals(), 1);

    // Kartu baru hanya berisi sebagian data (mis. hanya statistik) → data lama tetap ada.
    captureMessage(makeMessage(card({ stats: '## <:hp:1541928276165922906> `9`' })));
    const animal = store.getAnimal('lawliet');
    assert.strictEqual(animal.stats.hp, 9);
    assert.strictEqual(animal.nickname, 'DM ME'); // dari kartu pertama
    assert.strictEqual(store.countAnimals(), 1); // tetap satu baris
  });

  it('merges the same animal across different guilds into one global row', () => {
    const { captureMessage } = require('../src/services/animalDex');
    const store = require('../src/utils/animalDexStorage');
    captureMessage(makeMessage(card(), { guildId: 'guildA' }));
    captureMessage(makeMessage(card({ stats: '## <:hp:1541928276165922906> `5`' }), { guildId: 'guildB', id: 'm2' }));
    assert.strictEqual(store.countAnimals(), 1);
    assert.strictEqual(store.getAnimal('lawliet').stats.hp, 5);
  });

  it('migrates a legacy per-guild database to the global schema', () => {
    const { DatabaseSync } = require('node:sqlite');
    fs.mkdirSync(path.join(tempDir, 'data'), { recursive: true });
    const legacy = new DatabaseSync(path.join(tempDir, 'data', 'animal-dex.db'));
    legacy.exec(`CREATE TABLE dex_animals (
      guild_id TEXT NOT NULL, name_key TEXT NOT NULL, name TEXT NOT NULL, nickname TEXT, rank TEXT,
      quantity TEXT, alias TEXT, points INTEGER, sell TEXT, sacrifice TEXT, hp INTEGER, attack INTEGER,
      protection INTEGER, wisdom INTEGER, magic INTEGER, mr INTEGER, role TEXT, weapons TEXT, rarity TEXT,
      captured_total INTEGER, image_url TEXT, raw TEXT, source_message_id TEXT, first_seen_at INTEGER,
      updated_at INTEGER, PRIMARY KEY (guild_id, name_key));`);
    legacy.prepare(`INSERT INTO dex_animals (guild_id, name_key, name, nickname, hp, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run('guildA', 'lawliet', 'lawliet', 'Lama', 1, 100);
    legacy.prepare(`INSERT INTO dex_animals (guild_id, name_key, name, nickname, hp, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run('guildB', 'lawliet', 'lawliet', 'Baru', 9, 200);
    legacy.close();

    const store = require('../src/utils/animalDexStorage');
    assert.strictEqual(store.countAnimals(), 1); // dua guild digabung jadi satu
    const animal = store.getAnimal('lawliet');
    assert.strictEqual(animal.stats.hp, 9);       // baris terbaru menang
    assert.strictEqual(animal.nickname, 'Baru');
  });

  it('searches by name, alias, nickname, and rank', () => {
    const { captureMessage } = require('../src/services/animalDex');
    const store = require('../src/utils/animalDexStorage');
    captureMessage(makeMessage(card({ name: 'lawliet' })));
    captureMessage(makeMessage(card({ name: 'wolfie', emoji: 'wolfie', info: '- **Informasi animal:**\n  - **Nickname:** Flame\n  - **Rank:** <a:crare:1> crare' }), { id: 'm2' }));

    assert.strictEqual(store.searchAnimals('lawliet').length, 1);
    assert.strictEqual(store.searchAnimals('flame').length, 1);
    assert.strictEqual(store.searchAnimals('crare').length, 1);
    assert.strictEqual(store.searchAnimals('').length, 2);
    assert.strictEqual(store.searchAnimals('nope').length, 0);
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

    const detail = buildDexResponse('lawliet');
    assert.strictEqual(detail.embeds.length, 1);
    assert.strictEqual(detail.embeds[0].data.title, '🐾 lawliet');

    const list = buildDexResponse('');
    assert.match(list.embeds[0].data.title, /Animal Dex/);
    assert.match(list.embeds[0].data.description, /lawliet/);

    const none = buildDexResponse('zzz');
    assert.match(none.embeds[0].data.description, /Tidak ada/);
  });

  it('shows detail cards for several names at once', () => {
    const { captureMessage, buildDexResponse } = require('../src/services/animalDex');
    captureMessage(makeMessage(card({ name: 'lawliet' })));
    captureMessage(makeMessage(card({ name: 'buaya', emoji: 'buaya' }), { id: 'm2' }));
    captureMessage(makeMessage(card({ name: 'kudanil', emoji: 'kudanil' }), { id: 'm3' }));

    // Dipisah spasi, koma, maupun array args semuanya didukung.
    for (const input of ['lawliet buaya kudanil', 'lawliet, buaya, kudanil', ['lawliet', 'buaya', 'kudanil']]) {
      const res = buildDexResponse(input);
      assert.strictEqual(res.embeds.length, 3);
      assert.deepStrictEqual(res.embeds.map(e => e.data.title), ['🐾 lawliet', '🐾 buaya', '🐾 kudanil']);
    }
  });

  it('renders a compact stat table with the -c flag', () => {
    const { captureMessage, buildDexResponse } = require('../src/services/animalDex');
    captureMessage(makeMessage(card()));

    const full = buildDexResponse('lawliet');
    const compact = buildDexResponse('lawliet -c');
    const long = buildDexResponse('lawliet --compact');

    assert.strictEqual(compact.embeds.length, 1);
    const [header, row] = compact.embeds[0].data.description.split('\n');
    // Baris judul: emoji statistik hp..mr (dikelompokkan 3 | 3).
    assert.strictEqual(header,
      'Animal | <:hp:1541928276165922906> <:att:1541928417069375498> <:pr:1541928475454079077> | ' +
      '<:wp:1523723591194120354> <:mg:1523723618016563210> <:mr:1523723644243804281>');
    // Baris data: emoji hewan + angka statistik.
    assert.strictEqual(row, '<a:lawliet:1557672128059539466> | 2 0 1 | 3 14 2');
    assert.strictEqual(long.embeds[0].data.description, compact.embeds[0].data.description);
    // Tanpa flag tetap kartu penuh (pakai field terpisah).
    assert.ok(full.embeds[0].data.fields.length > 3);
    assert.strictEqual(compact.embeds[0].data.fields, undefined);
  });

  it('renders one compact row per result and ignores -c as a name', () => {
    const { captureMessage, buildDexResponse } = require('../src/services/animalDex');
    captureMessage(makeMessage(card({ name: 'lawliet', emoji: 'lawliet' })));
    captureMessage(makeMessage(card({ name: 'buaya', emoji: 'buaya' }), { id: 'm2' }));

    const res = buildDexResponse('lawliet buaya -c');
    const lines = res.embeds[0].data.description.split('\n');
    assert.strictEqual(lines.length, 3); // header + 2 hewan
    assert.match(lines[1], /^<a:lawliet:\d+> \| /);
    assert.match(lines[2], /^<a:buaya:\d+> \| /);
    assert.doesNotMatch(res.embeds[0].data.title, /-c/);
  });

  it('accepts a pasted animal emoji as a query', () => {
    const { captureMessage, buildDexResponse } = require('../src/services/animalDex');
    captureMessage(makeMessage(card({ name: 'lawliet', emoji: 'lawliet' })));
    const res = buildDexResponse('<a:lawliet:1557672128059539466>');
    assert.strictEqual(res.embeds.length, 1);
    assert.strictEqual(res.embeds[0].data.title, '🐾 lawliet');
  });

  it('falls back to a combined list when a name matches several animals', () => {
    const { captureMessage, buildDexResponse } = require('../src/services/animalDex');
    captureMessage(makeMessage(card({ name: 'lawliet' })));
    captureMessage(makeMessage(card({ name: 'lawliet2' }), { id: 'm2' }));
    const res = buildDexResponse('lawliet lawliet2');
    assert.strictEqual(res.embeds.length, 1);
    assert.match(res.embeds[0].data.title, /Hasil Dex/);
    assert.match(res.embeds[0].data.description, /lawliet2/);
  });
});
