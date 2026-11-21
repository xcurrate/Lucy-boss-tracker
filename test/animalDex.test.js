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

  it('replies with a detail card for a single match and a list otherwise', async () => {
    const { captureMessage, buildDexResponse } = require('../src/services/animalDex');
    captureMessage(makeMessage(card()));

    const detail = await buildDexResponse('lawliet');
    assert.strictEqual(detail.embeds.length, 1);
    assert.strictEqual(detail.embeds[0].data.title, '🐾 lawliet');
    // Field yang diminta dihapus tidak muncul di kartu dex.
    const names = detail.embeds[0].data.fields.map(f => f.name);
    for (const removed of ['Nickname', 'Points', 'Sell', 'Sacrifice', 'Rekomendasi Weapon', 'Kelangkaan']) {
      assert.ok(!names.includes(removed), removed + ' tidak ditampilkan');
    }
    assert.deepStrictEqual(names, ['Jumlah', 'Rank', 'Alias', 'Role', 'Statistik', 'Total Stat']);
    // Total Stat = jumlah hp..mr (2+0+1+3+14+2).
    const total = detail.embeds[0].data.fields.find(f => f.name === 'Total Stat');
    assert.strictEqual(total.value, '22');

    const list = await buildDexResponse('lawliet');
    assert.match(list.embeds[0].data.title, /lawliet/);

    // Tanpa query sama sekali → panduan pemakaian, bukan daftar hewan.
    const usage = await buildDexResponse('', { prefix: '!' });
    assert.match(usage.embeds[0].data.title, /cara pakai/);
    assert.match(usage.embeds[0].data.description, /! dex lawliet/);
    assert.doesNotMatch(usage.embeds[0].data.description, /total dex/);

    const none = await buildDexResponse('zzz');
    // Tidak ada hasil → panduan, bukan pesan "tidak ditemukan".
    assert.match(none.embeds[0].data.title, /cara pakai/);
    assert.doesNotMatch(none.embeds[0].data.description, /Tidak ditemukan/);
  });

  it('shows detail cards for several names at once', async () => {
    const { captureMessage, buildDexResponse } = require('../src/services/animalDex');
    captureMessage(makeMessage(card({ name: 'lawliet' })));
    captureMessage(makeMessage(card({ name: 'buaya', emoji: 'buaya' }), { id: 'm2' }));
    captureMessage(makeMessage(card({ name: 'kudanil', emoji: 'kudanil' }), { id: 'm3' }));

    // Dipisah spasi, koma, maupun array args semuanya didukung.
    for (const input of ['lawliet buaya kudanil', 'lawliet, buaya, kudanil', ['lawliet', 'buaya', 'kudanil']]) {
      const res = await buildDexResponse(input);
      assert.strictEqual(res.embeds.length, 3);
      assert.deepStrictEqual(res.embeds.map(e => e.data.title), ['🐾 lawliet', '🐾 buaya', '🐾 kudanil']);
    }
  });

  it('renders a compact stat table with the -c flag', async () => {
    const { captureMessage, buildDexResponse } = require('../src/services/animalDex');
    captureMessage(makeMessage(card()));

    const full = await buildDexResponse('lawliet');
    const compact = await buildDexResponse('lawliet -c');
    const long = await buildDexResponse('lawliet --compact');

    assert.strictEqual(compact.embeds.length, 1);
    const [header, row] = compact.embeds[0].data.description.split('\n');
    const gap = ' \u2001';
    // Baris judul: emoji penanda + emoji statistik hp..mr (dikelompokkan 3 | 3) + total.
    assert.strictEqual(header,
      '🧬 | <:hp:1541928276165922906>' + gap + '<:att:1541928417069375498>' + gap +
      '<:pr:1541928475454079077> | <:wp:1523723591194120354>' + gap +
      '<:mg:1523723618016563210>' + gap + '<:mr:1523723644243804281> | ∑');
    // Baris data: emoji hewan + angka statistik + total stat, dipisah spasi em.
    assert.strictEqual(row,
      '<a:lawliet:1557672128059539466> | `2`' + gap + '`0`' + gap + '`1` | `3`' + gap + '`14`' + gap +
      '`2` | `22`');
    // Judul tidak memuat nama hewan maupun daftar query.
    assert.strictEqual(compact.embeds[0].data.title, '📖 Animal Dex (ringkas)');
    assert.strictEqual(long.embeds[0].data.description, compact.embeds[0].data.description);
    // Tanpa flag tetap kartu penuh (pakai field terpisah).
    assert.ok(full.embeds[0].data.fields.length > 3);
    assert.strictEqual(compact.embeds[0].data.fields, undefined);
  });

  it('renders one compact row per result and ignores -c as a name', async () => {
    const { captureMessage, buildDexResponse } = require('../src/services/animalDex');
    captureMessage(makeMessage(card({ name: 'lawliet', emoji: 'lawliet' })));
    captureMessage(makeMessage(card({ name: 'buaya', emoji: 'buaya' }), { id: 'm2' }));

    const res = await buildDexResponse('lawliet buaya -c');
    const lines = res.embeds[0].data.description.split('\n');
    assert.strictEqual(lines.length, 3); // header + 2 hewan
    assert.match(lines[1], /^<a:lawliet:\d+> \| /);
    assert.match(lines[2], /^<a:buaya:\d+> \| /);
    assert.doesNotMatch(res.embeds[0].data.title, /-c/);
  });

  it('does not throw when the query is longer than an embed title', async () => {
    const { captureMessage, buildDexResponse } = require('../src/services/animalDex');
    captureMessage(makeMessage(card()));

    const longQuery = 'x'.repeat(300);
    for (const input of [longQuery + ' -c', longQuery]) {
      const res = await buildDexResponse(input);
      assert.strictEqual(res.embeds.length, 1);
      assert.ok(res.embeds[0].data.title.length <= 256, 'title <= 256');
      assert.ok(res.embeds[0].data.description.length <= 4096, 'description <= 4096');
    }
  });

  it('splits a long compact table across pages instead of dropping rows', async () => {
    const { captureMessage, buildDexResponse } = require('../src/services/animalDex');
    // Angka stat panjang → setiap baris tabel panjang, tidak mungkin muat satu embed.
    // (Nama emoji tidak bisa dipakai lagi: Discord membatasi 32 karakter dan
    // token hewan kini dipotong sesuai batas itu.)
    const big = '12345678901234567890';
    const longStats = '## <:hp:1541928276165922906> `' + big + '` <:att:1541928417069375498> `' + big + '`' +
      ' <:pr:1541928475454079077> `' + big + '`\n## <:wp:1523723591194120354> `' + big + '`' +
      ' <:mg:1523723618016563210> `' + big + '` <:mr:1523723644243804281> `' + big + '`';
    for (let i = 0; i < 30; i++) {
      captureMessage(makeMessage(card({ name: 'animal' + i, stats: longStats }), { id: 'm' + i }));
    }
    const res = await buildDexResponse('animal -c');
    const messages = res.messages || [{ embeds: res.embeds }];
    const embeds = messages.flatMap(m => m.embeds);

    assert.ok(embeds.length > 1, 'tabel panjang dipecah ke beberapa halaman');
    for (const embed of embeds) {
      assert.ok(embed.data.description.length <= 4096, 'description <= 4096');
      // Baris tidak terpotong di tengah: setiap baris data berisi pola ` | `.
      for (const line of embed.data.description.split('\n').slice(1)) assert.match(line, / \| /);
    }
    // Tidak ada baris yang dibuang: 30 hewan semuanya tampil.
    const rows = embeds.reduce((n, e) => n + e.data.description.split('\n').length - 1, 0);
    assert.strictEqual(rows, 30, 'semua hewan tampil');
    assert.match(embeds[0].data.title, /1\/\d+/, 'halaman diberi nomor');
  });

  it('shows usage instructions when no name is given', async () => {
    const { captureMessage, buildDexResponse } = require('../src/services/animalDex');
    const { parseDexInput } = require('../src/commands/prefix');
    captureMessage(makeMessage(card({ name: 'lawliet', emoji: 'lawliet' })));
    captureMessage(makeMessage(card({ name: 'buaya', emoji: 'buaya' }), { id: 'm2' }));

    for (const input of ['', '-c', '   ']) {
      const res = await buildDexResponse(parseDexInput('!dex' + (input ? ' ' + input : ''), '!').args, { prefix: '!' });
      assert.strictEqual(res.embeds.length, 1);
      assert.match(res.embeds[0].data.title, /cara pakai/);
      // Panduan menyebut contoh perintah yang tepat, bukan isi dex.
      assert.match(res.embeds[0].data.description, /`! dex lawliet`/);
      assert.match(res.embeds[0].data.description, /`! dex lawliet -c`/);
      assert.doesNotMatch(res.embeds[0].data.description, /lawliet.*buaya.*\d/);
      assert.strictEqual(res.embeds[0].data.fields, undefined);
    }

    // 'all' bukan kata kunci: ia diperlakukan sebagai nama biasa (tidak ada),
    // dan karena tidak ada hasil, balasannya panduan — tanpa pesan "tidak ditemukan".
    const asName = await buildDexResponse('all');
    assert.match(asName.embeds[0].data.title, /cara pakai/);
    assert.doesNotMatch(asName.embeds[0].data.description, /Tidak ditemukan/);
  });

  it('mirrors Lucy stat emojis into the bot application and renders them', async () => {
    const dex = require('../src/services/animalDex');
    const { captureMessage, buildDexResponse } = dex;
    const store = require('../src/utils/animalDexStorage');
    const created = [];
    const appEmojis = new Map([
      // Emoji aplikasi bot yang namanya sama dengan milik Lucy.
      ['9001', { id: '9001', name: 'hp', animated: false }]
    ]);
    dex.setClient({
      application: {
        emojis: {
          fetch: async () => appEmojis,
          create: async ({ name, attachment }) => {
            created.push({ name, attachment });
            const emoji = { id: String(7000 + created.length), name, animated: /\.gif$/.test(attachment) };
            appEmojis.set(emoji.id, emoji);
            return emoji;
          }
        }
      }
    });
    captureMessage(makeMessage(card({ name: 'lawliet' })));

    // Token Lucy tidak boleh dirender apa adanya; harus diganti emoji bot.
    const res = await buildDexResponse('lawliet');
    const stat = res.embeds[0].data.fields.find(f => f.name === 'Statistik').value;
    assert.ok(!stat.includes('1541928276165922906'), 'emoji Lucy tidak dipakai langsung');
    assert.ok(stat.includes('<:hp:9001>'), 'hp memakai emoji bot yang sudah ada');
    assert.match(stat, /<:\w+:\d+>/, 'stat lain memakai emoji bot hasil mirror');
    assert.ok(created.length >= 1, 'emoji baru dibuat di aplikasi bot');
    assert.ok(created.every(c => /^https:\/\/cdn\.discordapp\.com\/emojis\/\d+\.(gif|png)(\?size=\d+)?$/.test(c.attachment)));

    // Pemetaan di-cache: render kedua tidak membuat emoji baru lagi.
    const before = created.length;
    const again = await buildDexResponse('lawliet');
    assert.strictEqual(created.length, before);
    assert.strictEqual(again.embeds[0].data.fields.find(f => f.name === 'Statistik').value, stat);
    assert.strictEqual(store.getEmojiToken('1541928276165922906'), '<:hp:9001>');

    // Tabel -c juga memakai emoji hasil mirror (header stat + label hewan).
    const table = await buildDexResponse('lawliet -c');
    const header = table.embeds[0].data.description.split('\n')[0];
    assert.ok(header.includes('<:hp:9001>'));
    assert.ok(!header.includes('1541928276165922906'));

    dex.setClient(null);
  });

  it('recognizes a manually uploaded app emoji by alias name', async () => {
    const dex = require('../src/services/animalDex');
    const { captureMessage, buildDexResponse } = dex;
    const created = [];
    const appEmojis = new Map([
      // Di-upload manual di portal dengan nama "mag" (kartu Lucy memakai "mg").
      ['9002', { id: '9002', name: 'mag', animated: false }]
    ]);
    dex.setClient({
      application: {
        emojis: {
          fetch: async () => appEmojis,
          create: async ({ name }) => {
            created.push(name);
            const emoji = { id: String(7100 + created.length), name, animated: false };
            appEmojis.set(emoji.id, emoji);
            return emoji;
          }
        }
      }
    });
    // ID sumber baru agar cache emoji_map tidak menutupi jalur alias.
    captureMessage(makeMessage(card({ name: 'magtest', stats: '## <:mg:999999999999999999> `7`' })));

    const res = await buildDexResponse('magtest');
    const stat = res.embeds[0].data.fields.find(f => f.name === 'Statistik').value;
    assert.ok(stat.includes('<:mag:9002>'), 'mg memakai emoji "mag" yang sudah di-upload');
    assert.ok(!created.includes('mg'), 'tidak membuat emoji mg baru');

    dex.setClient(null);
  });

  it('shrinks oversized animated emojis instead of failing to mirror them', async () => {
    const dex = require('../src/services/animalDex');
    const { captureMessage, buildDexResponse } = dex;
    const store = require('../src/utils/animalDexStorage');
    const attempts = [];
    // Simulasi Discord: berkas tanpa parameter size ditolak (400), dan baru
    // diterima setelah diperkecil ke ?size=64. Emoji blob Lucy memang >256 KiB.
    dex.setClient({
      application: {
        emojis: {
          fetch: async () => new Map(),
          create: async ({ name, attachment }) => {
            attempts.push(attachment);
            if (!/\?size=64$/.test(attachment)) throw new Error('Request entity too large (400)');
            return { id: '9100', name, animated: true };
          }
        }
      }
    });
    captureMessage(makeMessage(card({
      name: 'blob', emoji: 'blob',
      stats: '## <:hp:1541928276165922906> `5`'
    })));

    const res = await buildDexResponse('blob -c');
    const desc = res.embeds[0].data.description;
    assert.ok(desc.includes('<a:blob:9100>'), 'emoji blob hasil mirror dipakai di tabel');
    assert.ok(!desc.includes('1542593549709615195'), 'token Lucy yang tidak bisa dirender tidak dipakai');
    // Animasi dicoba dari ukuran kecil lebih dulu, dan berhasil setelah diperkecil.
    const gifAttempts = attempts.filter(a => a.includes('1557672128059539466'));
    assert.ok(gifAttempts.length >= 2, 'mencoba ulang gif dengan ukuran lebih kecil');
    assert.strictEqual(gifAttempts[0], 'https://cdn.discordapp.com/emojis/1557672128059539466.gif?size=96');
    assert.strictEqual(gifAttempts[1], 'https://cdn.discordapp.com/emojis/1557672128059539466.gif?size=64');
    assert.strictEqual(store.getEmojiToken('1557672128059539466'), '<a:blob:9100>');

    dex.setClient(null);
  });

  it('keeps the original token when an emoji cannot be mirrored at all', async () => {
    const dex = require('../src/services/animalDex');
    const { captureMessage, buildDexResponse } = dex;
    dex.setClient({
      application: {
        emojis: { fetch: async () => new Map(), create: async () => { throw new Error('boom'); } }
      }
    });
    captureMessage(makeMessage(card({ name: 'blob', emoji: 'blob' })));

    // Tidak boleh melempar; token asli dipakai apa adanya.
    const res = await buildDexResponse('blob -c');
    assert.match(res.embeds[0].data.description, /<a:blob:1557672128059539466>/);

    dex.setClient(null);
  });

  it('handles a pasted dex block with quantity markers and decorative emoji', async () => {
    const { captureMessage, buildDexResponse } = require('../src/services/animalDex');
    const { parseDexInput } = require('../src/commands/prefix');
    captureMessage(makeMessage(card({ name: 'inuyasha', emoji: 'inuyasha' })));
    captureMessage(makeMessage(card({ name: 'illyafate', emoji: 'illyafate' }), { id: 'm2' }));
    captureMessage(makeMessage(card({ name: 'columbina', emoji: 'columbina' }), { id: 'm3' }));
    captureMessage(makeMessage(card({ name: 'lawliet', emoji: 'lawliet' }), { id: 'm4' }));

    // Salinan apa adanya dari kartu dex: emoji + penanda jumlah "⁰⁰⁰⁰" + emoji
    // dekoratif <:blank:...> + flag -c. Lewat parseDexInput seperti perintah asli.
    const pasted = '!dex <:inuyasha:1554510314500919368>⁰⁰⁰⁰  <:illyafate:1553013886301503548>⁰⁰⁰⁰  ' +
      '<:blank:1522595651571941560>    <:columbina:1550725818903306341>⁰⁰⁰⁰  <a:lawliet:1557672128059539466>⁰⁰⁰⁰  -c';

    const res = await buildDexResponse(parseDexInput(pasted, '!').args);
    assert.strictEqual(res.embeds.length, 1);
    const lines = res.embeds[0].data.description.split('\n');
    // Header + 4 hewan, tanpa baris "tidak ditemukan".
    assert.strictEqual(lines.length, 5);
    assert.ok(lines[1].startsWith('<a:inuyasha:'), 'inuyasha ada di tabel');
    assert.ok(lines[4].startsWith('<a:lawliet:'), 'lawliet ada di tabel');
    assert.doesNotMatch(res.embeds[0].data.description, /⁰⁰⁰⁰/);
    assert.doesNotMatch(res.embeds[0].data.description, /blank/);
  });

  it('recovers names from a block whose emoji tokens are cut off', async () => {
    const { captureMessage, buildDexResponse, extractFlags, toQueries } = require('../src/services/animalDex');
    const { parseDexInput } = require('../src/commands/prefix');
    captureMessage(makeMessage(card({ name: 'sakurafate', emoji: 'sakurafate' })));
    captureMessage(makeMessage(card({ name: 'fiona', emoji: 'fiona' }), { id: 'm2' }));
    captureMessage(makeMessage(card({ name: 'snorlaxdoingafk', emoji: 'snorlaxdoingafk' }), { id: 'm3' }));

    // Salinan rusak apa adanya dari Discord: token terpotong (`<a:snorlaxdoingafk:`),
    // tanpa tag emoji sama sekali (`:cpatreon:`), plus penanda jumlah "⁰⁰⁰⁰".
    const pasted = '!d :cpatreon:    :sakurafate:⁰⁰⁰⁰  :fiona:⁰⁰⁰⁰  <a:snorlaxdoingafk: -c';
    const args = parseDexInput(pasted, '!').args;
    const flags = extractFlags(args);

    // Nama yang masih terbaca diambil; penanda jumlah dibuang.
    assert.strictEqual(flags.compact, true);
    assert.deepStrictEqual(toQueries(flags.rest), ['cpatreon', 'sakurafate', 'fiona', 'snorlaxdoingafk']);

    const res = await buildDexResponse(args);
    const { title, description } = res.embeds[0].data;
    // Ketiga hewan tampil (tabel ringkas memakai label emoji hewan).
    assert.match(description, /<a:sakurafate:/);
    assert.match(description, /<a:fiona:/);
    assert.match(description, /<a:snorlaxdoingafk:/);
    // Judul ringkas tidak memuat nama hewan maupun query mentah.
    assert.strictEqual(title, '📖 Animal Dex (ringkas)');
    assert.doesNotMatch(description, /⁰⁰⁰⁰/);
  });

  it('shows the surviving animals and hides not-found info for a pasted block', async () => {
    const { captureMessage, buildDexResponse } = require('../src/services/animalDex');
    const { parseDexInput } = require('../src/commands/prefix');
    captureMessage(makeMessage(card({ name: 'lawliet', emoji: 'lawliet' })));

    const res = await buildDexResponse(parseDexInput('!dex <:inuyasha:1>⁰⁰⁰⁰ <a:lawliet:1557672128059539466>⁰⁰⁰⁰ -c', '!').args);
    assert.strictEqual(res.embeds.length, 1);
    const desc = res.embeds[0].data.description;
    assert.ok(desc.includes('<a:lawliet:'), 'lawliet ditampilkan');
    // inuyasha tidak ada di dex, tapi tidak dilaporkan sebagai "tidak ditemukan".
    assert.doesNotMatch(desc, /Tidak ditemukan/);
    assert.doesNotMatch(desc, /inuyasha/);
    assert.doesNotMatch(res.embeds[0].data.title, /inuyasha/);
  });

  it('still lets a user type the word blank as a real query', async () => {
    const { toQueries, extractFlags } = require('../src/services/animalDex');
    assert.deepStrictEqual(toQueries('blank'), ['blank']);
    assert.deepStrictEqual(toQueries(extractFlags(['<:blank:1>', 'lawliet']).rest), ['lawliet']);
    assert.deepStrictEqual(toQueries(extractFlags(['<a:lawliet:1557672128059539466>', '-c']).rest), ['lawliet']);
  });

  it('accepts a pasted animal emoji as a query', async () => {
    const { captureMessage, buildDexResponse } = require('../src/services/animalDex');
    captureMessage(makeMessage(card({ name: 'lawliet', emoji: 'lawliet' })));
    const res = await buildDexResponse('<a:lawliet:1557672128059539466>');
    assert.strictEqual(res.embeds.length, 1);
    assert.strictEqual(res.embeds[0].data.title, '🐾 lawliet');
  });

  it('falls back to a combined list when a name matches several animals', async () => {
    const { captureMessage, buildDexResponse } = require('../src/services/animalDex');
    captureMessage(makeMessage(card({ name: 'lawliet' })));
    captureMessage(makeMessage(card({ name: 'lawliet2' }), { id: 'm2' }));
    const res = await buildDexResponse('lawliet lawliet2');
    assert.strictEqual(res.embeds.length, 1);
    assert.match(res.embeds[0].data.title, /Hasil Dex/);
    assert.match(res.embeds[0].data.description, /lawliet2/);
  });

  // Hewan yang gambarnya bukan emoji (mis. lampiran biasa) tidak punya token
  // hewan, sehingga label baris jatuh ke `animalEmoji()` -> null.
  it('menampilkan nama hewan, bukan "null", saat hewan tidak punya emoji', async () => {
    const { captureMessage, buildDexResponse } = require('../src/services/animalDex');
    // Kartu tanpa token emoji hewan: judulnya teks biasa, gambarnya lampiran.
    const plainCard = {
      components: [{
        type: 17,
        components: [{
          type: 9,
          components: [{ type: 10, content: '## kudanil\n*Requested by <@1>*' }],
          accessory: {
            type: 11,
            media: { url: 'https://cdn.discordapp.com/attachments/1/2/kudanil.png' },
            description: 'kudanil',
            spoiler: false
          }
        },
        { type: 10, content: '- **Informasi animal:**\n  - **Nickname:** \'-\'\n  - **Jumlah:** 0/1\n  - **Rank:** <:rare:1521986845213458482> rare\n  - **Alias:** kudanil' },
        { type: 10, content: '## <:hp:1541928276165922906> `5` <:att:1541928417069375498> `1`' }]
      }]
    };
    captureMessage(makeMessage(plainCard));

    const res = await buildDexResponse('kudanil -c');
    const desc = res.embeds[0].data.description;
    assert.match(desc, /\*\*kudanil\*\*/, 'nama hewan dipakai sebagai label');
    assert.doesNotMatch(desc, /null/);
  });
});

describe('emoji hewan untuk tampilan battle', () => {
  function fakeClient(overrides = {}) {
    const dex = require('../src/services/animalDex');
    const appEmojis = new Map();
    const created = [];
    // `guildEmojiIds`: emoji yang sudah bisa dirender bot (emoji guild bot sendiri).
    const guildEmojiIds = new Set(overrides.guildEmojiIds || []);
    dex.setClient({
      emojis: { cache: { has: id => guildEmojiIds.has(String(id)) } },
      application: {
        emojis: {
          // discord.js asli menyimpan emoji aplikasi di cache; `create()` dan
          // `fetch()` sama-sama mengisinya.
          cache: appEmojis,
          fetch: async () => appEmojis,
          create: async ({ name }) => {
            created.push(name);
            const emoji = { id: String(9300 + created.length), name, animated: false };
            appEmojis.set(emoji.id, emoji);
            return emoji;
          },
          ...(overrides.application || {})
        }
      }
    });
    return { dex, created };
  }

  afterEach(() => {
    require('../src/services/animalDex').setClient(null);
  });

  it('memakai nama hewan bila judul kartu tidak memuat emoji', () => {
    const { animalEmoji } = require('../src/services/animalDex');
    const token = animalEmoji({ name: 'snorlax', imageUrl: 'https://cdn.discordapp.com/emojis/111.gif' });
    assert.strictEqual(token, '<a:snorlax:111>');
  });

  it('tidak mengarang emoji untuk gambar lampiran biasa', () => {
    const { animalEmoji } = require('../src/services/animalDex');
    assert.strictEqual(animalEmoji({ name: 'bulba', imageUrl: 'https://cdn.discordapp.com/attachments/1/2/i.png' }), null);
    assert.strictEqual(animalEmoji(null), null);
  });

  it('mem-mirror emoji pet yang ditangkap setelah startup', async () => {
    const { dex, created } = fakeClient();
    const store = require('../src/utils/animalDexStorage');
    dex.captureMessage(makeMessage(card({ name: 'lawliet' })));
    // captureMessage menjalankan mirror di latar belakang.
    await new Promise(r => setImmediate(r));
    assert.ok(created.includes('lawliet'), 'emoji pet diunggah ke aplikasi bot');
    assert.ok(store.getEmojiToken('1557672128059539466'), 'id sumber terpetakan');
  });

  it('panel tim memakai emoji pet, bukan 🐾', async () => {
    const { dex } = fakeClient();
    const store = require('../src/utils/animalDexStorage');
    const panel = require('../src/ui/battlePanel');
    dex.captureMessage(makeMessage(card({ name: 'lawliet' })));
    await new Promise(r => setImmediate(r));

    const animal = store.getAnimal('lawliet');
    const team = { id: 1, name: 'T', slots: [{ slot: 1, animalKey: 'lawliet', level: 50, weaponId: null, passives: null }] };
    const json = panel.teamEmbed(team, {}).toJSON();
    assert.ok(json.fields[0].name.includes('lawliet:'), 'nama field memuat token emoji');
    assert.ok(!json.fields[0].name.includes('🐾'), 'tidak jatuh ke ikon netral');
    assert.ok(animal.imageUrl, 'fixture punya gambar emoji');
  });

  it('render PERTAMA `d team show` sudah memakai emoji pet walau cache kosong', async () => {
    const { dex } = fakeClient();
    const dexStore = require('../src/utils/animalDexStorage');
    const store = require('../src/utils/battleTeamStorage');
    // Command harus memakai instance animalDex yang sama dengan klien tiruan;
    // modul ini sudah dihapus dari cache oleh resetModules().
    delete require.cache[require.resolve('../src/commands/battleTeam')];
    const { handleTeamCommand } = require('../src/commands/battleTeam');

    // Data lama: hewan sudah ada di dex, `emoji_map` belum pernah terisi.
    dexStore.upsertAnimal({
      nameKey: 'lawliet', name: 'lawliet', alias: null, nickname: null, rank: null, quantity: null,
      points: null, sell: null, sacrifice: null, role: null, weapons: null, rarity: null,
      stats: { hp: 2, attack: 0, protection: 1, wisdom: 3, magic: 14, mr: 2 }, statTokens: {},
      imageUrl: 'https://cdn.discordapp.com/emojis/1557672128059539466.gif', emojiName: 'lawliet'
    });
    assert.strictEqual(dexStore.getEmojiToken('1557672128059539466'), null, 'cache kosong di awal');

    store.createTeam('u', 'T');
    store.setSlot('u', 'T', 1, { animalKey: 'lawliet', level: 50 });
    store.setActiveTeam('u', 'T');

    let out = null;
    await handleTeamCommand({ guildId: 'g', author: { id: 'u' } }, ['show'], 'd', {
      sendEmbed: (m, e) => { out = e.toJSON(); },
    });
    assert.ok(out.fields[0].name.includes('lawliet:'), 'emoji pet sudah terpasang di render pertama');
    assert.ok(!out.fields[0].name.includes('🐾'), 'tidak jatuh ke ikon netral');
    assert.ok(dex, 'client tiruan dipakai');
  });

  it('render PERTAMA `d sim` memakai emoji pet di ringkasan komposisi', async () => {
    fakeClient();
    const dexStore = require('../src/utils/animalDexStorage');
    const store = require('../src/utils/battleTeamStorage');
    delete require.cache[require.resolve('../src/commands/battleSim')];
    const { handleSimCommand } = require('../src/commands/battleSim');

    dexStore.upsertAnimal({
      nameKey: 'lawliet', name: 'lawliet', alias: null, nickname: null, rank: null, quantity: null,
      points: null, sell: null, sacrifice: null, role: null, weapons: null, rarity: null,
      stats: { hp: 2, attack: 0, protection: 1, wisdom: 3, magic: 14, mr: 2 }, statTokens: {},
      imageUrl: 'https://cdn.discordapp.com/emojis/1557672128059539466.gif', emojiName: 'lawliet'
    });
    store.createTeam('u', 'T');
    store.setSlot('u', 'T', 1, { animalKey: 'lawliet', level: 50 });
    store.setActiveTeam('u', 'T');

    let out = null;
    await handleSimCommand({ guildId: 'g', author: { id: 'u' } }, ['-m', '5', '-s', '1'], 'd', {
      sendEmbed: (m, e) => { out = e.toJSON(); },
    });
    const komposisi = (out.fields || []).find(f => /komposisi/i.test(f.name)).value;
    assert.ok(komposisi.includes('lawliet:'), 'emoji pet terpasang');
    assert.ok(!komposisi.includes('🐾'), 'tidak jatuh ke ikon netral');
  });

  it('slot dengan animal_key lama (nama emoji) tetap dapat emoji pet', async () => {
    fakeClient();
    const dexStore = require('../src/utils/animalDexStorage');
    const store = require('../src/utils/battleTeamStorage');
    delete require.cache[require.resolve('../src/commands/battleTeam')];
    const { handleTeamCommand } = require('../src/commands/battleTeam');

    // `d dex` menemukan hewan lewat pencarian longgar, jadi slot yang menyimpan
    // nama emoji/alias tetap tampil benar di dex — panel harus sama.
    dexStore.upsertAnimal({
      nameKey: 'pidgeotto', name: 'pidgeotto', alias: 'pidgey', nickname: null, rank: null, quantity: null,
      points: null, sell: null, sacrifice: null, role: null, weapons: null, rarity: null,
      stats: { hp: 2, attack: 13, protection: 2, wisdom: 1, magic: 1, mr: 2 }, statTokens: {},
      imageUrl: 'https://cdn.discordapp.com/emojis/1522265093155590318.gif', emojiName: 'feagle'
    });

    for (const key of ['feagle', 'PIDGEOTTO', 'pidgey']) {
      assert.ok(dexStore.resolveAnimal(key), 'kunci lama tetap ketemu: ' + key);
    }

    store.createTeam('u', 'Blitz');
    store.setSlot('u', 'Blitz', 1, { animalKey: 'feagle', level: 50 });
    store.setActiveTeam('u', 'Blitz');

    let out = null;
    await handleTeamCommand({ guildId: 'g', author: { id: 'u' } }, ['show'], 'd', {
      sendEmbed: (m, e) => { out = e.toJSON(); },
    });
    assert.ok(out.fields[0].name.includes('feagle:'), 'emoji pet terpasang dari kunci lama');
    assert.ok(!out.fields[0].name.includes('🐾'), 'tidak jatuh ke ikon netral');
  });

  it('emoji guild yang sudah bisa dirender bot tidak jatuh ke 🐾', async () => {
    // Emoji milik server bot sendiri tidak perlu di-mirror, tapi `resolve()`
    // hanya membaca `emoji_map`; tanpa catatan eksplisit hasilnya 🐾.
    fakeClient({ guildEmojiIds: ['1542593595973046322'] });
    const dexStore = require('../src/utils/animalDexStorage');
    const be = require('../src/services/battleEmoji');

    dexStore.upsertAnimal({
      nameKey: 'charmander', name: 'charmander', alias: null, nickname: null, rank: null, quantity: null,
      points: null, sell: null, sacrifice: null, role: null, weapons: null, rarity: null,
      stats: { hp: 2, attack: 1, protection: 2, wisdom: 2, magic: 13, mr: 2 }, statTokens: {},
      imageUrl: 'https://cdn.discordapp.com/emojis/1542593595973046322.gif', emojiName: 'hlizard'
    });
    const animal = dexStore.getAnimal('charmander');

    const dex = require('../src/services/animalDex');
    await dex.mirrorEmojiTokens([dex.animalEmoji(animal)]);

    assert.strictEqual(dexStore.getEmojiToken('1542593595973046322'), '<a:hlizard:1542593595973046322>',
      'token dicatat ke emoji_map meski tidak perlu di-mirror');
    assert.ok(!be.animalEmoji(animal).includes('🐾'), 'tidak jatuh ke ikon netral');
    assert.ok(be.animalEmoji(animal).includes('hlizard:'), 'memakai emoji asli');
  });

  it('mengabaikan pemetaan emoji basi saat menyiapkan emoji pet', async () => {
    // Regresi: `ensureAnimalEmoji()` memakai baris `emoji_map` apa adanya, jadi
    // pemetaan yang emojinya sudah dihapus tetap dipakai dan Discord menolak
    // seluruh pesan (10014). Pemetaan basi harus di-mirror ulang.
    const { dex, created } = fakeClient();
    const dexStore = require('../src/utils/animalDexStorage');

    dexStore.upsertAnimal({
      nameKey: 'pidgeotto', name: 'pidgeotto', alias: null, nickname: null, rank: null, quantity: null,
      points: null, sell: null, sacrifice: null, role: null, weapons: null, rarity: null,
      stats: { hp: 2, attack: 13, protection: 2, wisdom: 1, magic: 1, mr: 2 }, statTokens: {},
      imageUrl: 'https://cdn.discordapp.com/emojis/1522265093155590318.gif', emojiName: 'feagle'
    });
    dexStore.setEmojiToken('1522265093155590318', '<:feagle:9001>');
    assert.strictEqual(dex.tokenIsLive('<:feagle:9001>'), false, 'ID 9001 tidak ada di cache');

    const animal = dexStore.getAnimal('pidgeotto');
    const token = await dex.ensureAnimalEmoji(animal);
    assert.ok(created.includes('feagle'), 'emoji basi di-mirror ulang');
    assert.strictEqual(token, '<:feagle:9301>', 'memakai token hasil mirror baru');
    assert.ok(dex.tokenIsLive(token), 'token baru bisa dirender');
  });

  it('tetap memakai 🐾 bila pet tidak punya emoji sama sekali', () => {
    const be = require('../src/services/battleEmoji');
    assert.strictEqual(be.animalEmoji({ name: 'x', imageUrl: 'https://cdn.discordapp.com/attachments/1/2/i.png' }), '🐾');
  });
});
