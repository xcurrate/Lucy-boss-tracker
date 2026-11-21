const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
let tempDir;
let importer;
let store;

function cardMessage(overrides = {}) {
  const slot = `**[2] <:animal:1> **for** **
Lvl 83 \`[6,602,130/47,459,321]\`
<:hp:1> \`2990\` <:wp:2> \`0666\`
<:att:3> \`0100\` <:mg:4> \`0100\`
<:pr:5> \`67%\` <:mr:6> \`67%\`
🔒 \`2PI\` <a:fabled:7> <:fshield:8> <:fthorns:9> <:fhgen:10> 100%`;
  return {
    id: 'lucy-message-1',
    author: { id: '1438615298012872817', bot: true },
    guildId: 'guild-1',
    channelId: 'channel-1',
    components: [{
      type: 17,
      components: [
        { type: 10, content: "## ⭐ **nnneozen's team**" },
        { type: 10, content: slot },
      ],
    }],
    ...overrides,
  };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucy-team-import-'));
  process.chdir(tempDir);
  delete require.cache[require.resolve('../src/utils/battleTeamStorage')];
  delete require.cache[require.resolve('../src/services/lucyTeamImport')];
  store = require('../src/utils/battleTeamStorage');
  importer = require('../src/services/lucyTeamImport');
});

afterEach(() => {
  process.chdir(ROOT);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('Lucy team import', () => {
  it('membaca Components V2, stat, fabled weapon, dan passive', () => {
    const parsed = importer.parseLucyTeamMessage(cardMessage());
    assert.equal(parsed.name, "nnneozen's team");
    assert.equal(parsed.slots.length, 1);
    assert.deepEqual(parsed.slots[0], {
      slot: 2,
      label: 'for',
      headerEmoji: 'animal',
      level: 83,
      displayedStats: { hp: 2990, wp: 666, att: 100, mag: 100, pr: 67, mr: 67 },
      weaponId: 5,
      weaponQuality: 100,
      passives: [8, 15],
    });
  });

  it('mengabaikan pesan non-Lucy dan metadata 2PI/1F1C', () => {
    assert.equal(importer.parseLucyTeamMessage(cardMessage({ author: { id: 'other-bot' } })), null);
    const parsed = importer.parseLucyTeamMessage(cardMessage());
    assert.equal(parsed.slots[0].passives.includes('2PI'), false);
  });

  // Kartu asli Lucy memakai judul bebas tanpa awalan `⭐` dan tanpa akhiran
  // `'s team` (`## **free 550 xp!**`, `## **Dm me**`). Dulu deteksi judul
  // mensyaratkan `⭐`/`team**`, sehingga semua tim hasil impor bernama
  // "Lucy Import - Lucy team".
  it('memakai nama tim apa adanya, bukan fallback "Lucy team"', () => {
    for (const [title, expected] of [
      ['## ⭐ **win solution**', 'win solution'],
      ['## **free 550 xp!**', 'free 550 xp!'],
      ['## **Dm me**', 'Dm me'],
      ["## ⭐ **nnneozen's team**", "nnneozen's team"],
      ["## **nnneozen's team**", "nnneozen's team"],
      ['## ⭐ **My Team**', 'My Team'],
      ['## <:hp:1> `100`', 'Lucy team'],
    ]) {
      const parsed = importer.parseLucyTeamMessage(cardMessage({ components: [
        { type: 17, components: [{ type: 10, content: title }] },
        ...cardMessage().components[0].components.slice(1)
      ] }));
      assert.equal(parsed.name, expected, title);
    }
  });

  // Bug: slot hasil import tidak punya `animalKey`, jadi `battlePanel` tidak bisa
  // mengambil emoji hewan dan semua pet tampil sebagai 🐾 (`:feet:`). Hewan
  // dikenali dari emoji header kartu, bukan dari label yang bisa diganti user.
  it('menyimpan animalKey dari emoji header agar emoji hewan bisa dirender', () => {
    const dexStore = require('../src/utils/animalDexStorage');
    const dex = require('../src/services/animalDex');
    dexStore.upsertAnimal({
      nameKey: 'animal', name: 'animal', alias: null, nickname: null, rank: null, quantity: null,
      points: null, sell: null, sacrifice: null, role: null, weapons: null, rarity: null,
      stats: { hp: 1, attack: 1, protection: 1, wisdom: 1, magic: 1, mr: 1 }, statTokens: {},
      imageUrl: 'https://cdn.discordapp.com/emojis/1557672128059539466.gif', emojiName: 'animal',
    });

    const parsed = importer.parseLucyTeamMessage(cardMessage());
    assert.equal(parsed.slots[0].headerEmoji, 'animal');
    assert.equal(parsed.slots[0].label, 'for');

    const result = importer.importLucyTeam('user-1', parsed);
    const slot = result.team.slots[0];
    assert.equal(slot.animalKey, 'animal');
    // Stat kartu tetap dipakai apa adanya, tidak dihitung ulang dari dex.
    assert.deepEqual(slot.finalStats, { hp: 2990, att: 100, pr: 67, wp: 666, mag: 100, mr: 67 });

    // Tanpa `animalKey` rantai ini berhenti di null dan panel memakai 🐾.
    const animal = dexStore.resolveAnimal(slot.animalKey);
    assert.equal(animal.name, 'animal');
    assert.equal(dex.animalEmoji(animal), '<a:animal:1557672128059539466>');
  });

  // Emoji header yang belum pernah tertangkap tidak boleh menggagalkan import:
  // slotnya tetap masuk dengan stat dari kartu, hanya `animalKey` yang kosong.
  it('tetap mengimpor slot saat hewannya belum ada di dex', () => {
    const parsed = importer.parseLucyTeamMessage(cardMessage());
    const result = importer.importLucyTeam('user-1', parsed);
    assert.equal(result.imported, 1);
    assert.equal(result.team.slots[0].animalKey, null);
    assert.equal(result.team.slots[0].finalStats.hp, 2990);
  });

  it('mengimpor final stats tanpa menambahkan stat senjata dua kali', () => {
    const parsed = importer.parseLucyTeamMessage(cardMessage());
    const result = importer.importLucyTeam('user-1', parsed);
    assert.equal(result.imported, 1);
    const slot = result.team.slots[0];
    assert.deepEqual(slot.finalStats, { hp: 2990, att: 100, pr: 67, wp: 666, mag: 100, mr: 67 });
    assert.equal(slot.weaponQuality, 100);
    assert.deepEqual(slot.passives, [8, 15]);
    const sim = require('../src/services/battleSim');
    const specs = sim.toSpecs(result.team);
    assert.equal(specs.specs[0].finalStats.hp, 2990);
    assert.equal(specs.specs[0].finalStats.pr, 67);

    const duplicate = importer.importLucyTeam('user-1', parsed);
    assert.match(duplicate.error, /sudah kamu impor/);
  });

  it('memberi reaksi hanya pada kartu Lucy yang valid', async () => {
    const calls = [];
    const message = cardMessage({ react: async emoji => calls.push(emoji) });
    assert.equal(await importer.prepareLucyTeamMessage(message), true);
    assert.deepEqual(calls, ['📊']);
    assert.equal(await importer.prepareLucyTeamMessage({ author: { id: 'other' } }), false);
  });

  it('mengimpor saat user menekan reaksi 📊 dan mengabaikan bot', async () => {
    const message = cardMessage({ react: async () => {} });
    await importer.prepareLucyTeamMessage(message);
    const reaction = { emoji: { name: '📊' }, message };
    const result = await importer.handleReaction(reaction, { id: 'user-2', bot: false });
    assert.equal(result.imported, 1);
    assert.equal(await importer.handleReaction(reaction, { id: 'bot', bot: true }), null);
    assert.equal(await importer.handleReaction({ emoji: { name: '👍' }, message }, { id: 'user-3' }), null);
  });

  // Judul yang panjang terpotong 32 karakter oleh `normalizeName`. Kalau sufiks
  // ditambahkan setelah pemotongan, hasilnya identik dengan nama lama dan
  // pencarian nama bebas tidak pernah selesai (bot hang di event loop).
  it('memberi nama unik saat judul kartu sudah mentok 32 karakter', () => {
    const title = '## ⭐ **Sekian, Terimakasih**';
    const names = [];
    for (let i = 0; i < 4; i++) {
      const message = cardMessage({
        id: `lucy-long-${i}`,
        components: [{ type: 17, components: [
          { type: 10, content: title },
          { type: 10, content: '**[1] <:animal:1> **for** **\nLvl 83\n<:hp:1> `2990` <:wp:2> `666`\n<:att:3> `100` <:mg:4> `100`\n<:pr:5> `67%` <:mr:6> `67%`' },
        ] }],
      });
      const result = importer.importLucyTeam(`user-${i}`, importer.parseLucyTeamMessage(message));
      names.push(result.team.name);
    }
    // Semua di user yang sama supaya bentrok namanya benar-benar terjadi.
    const parsed = importer.parseLucyTeamMessage(cardMessage({
      id: 'lucy-same-user',
      components: [{ type: 17, components: [
        { type: 10, content: title },
        { type: 10, content: '**[1] <:animal:1> **for** **\nLvl 83\n<:hp:1> `2990` <:wp:2> `666`\n<:att:3> `100` <:mg:4> `100`\n<:pr:5> `67%` <:mr:6> `67%`' },
      ] }],
    }));
    const first = importer.importLucyTeam('same-user', parsed);
    const second = importer.importLucyTeam('same-user', { ...parsed, sourceMessageId: 'other-id' });
    const third = importer.importLucyTeam('same-user', { ...parsed, sourceMessageId: 'third-id' });

    assert.equal(first.imported, 1);
    assert.equal(second.imported, 1);
    assert.equal(third.imported, 1);
    const uniq = new Set([first.team.name, second.team.name, third.team.name]);
    assert.equal(uniq.size, 3, `nama harus unik, dapat: ${[...uniq].join(' | ')}`);
    for (const name of uniq) assert.ok(name.length <= 32, `nama "${name}" melebihi 32 karakter`);
  });

  // Label di kartu bisa didahului token emoji hewan. Token itu tidak boleh ikut
  // tersimpan sebagai label karena akan tampil sebagai teks `<a:...>` di panel.
  // Bentuk aslinya: `**[1]** <a:beastmeow:...> **`.
  it('tidak menyimpan token emoji mentah sebagai label slot', () => {
    const message = cardMessage({
      id: 'lucy-emoji-label',
      components: [{ type: 17, components: [
        { type: 10, content: '## ⭐ **emoji label**' },
        { type: 10, content: '**[1]** <a:beastmeow:1568773919501189281> **\nLvl 82 `[1/2]`\n<:hp:1> `1320` <:wp:2> `666`\n<:att:3> `100` <:mg:4> `100`\n<:pr:5> `67%` <:mr:6> `67%`' },
      ] }],
    });
    const parsed = importer.parseLucyTeamMessage(message);
    assert.equal(parsed.slots[0].headerEmoji, 'beastmeow');
    assert.ok(!/<a?:\w+:\d+>/.test(parsed.slots[0].label), `label masih berisi token: ${parsed.slots[0].label}`);
  });

  // Kartu yang timnya sudah dihapus harus bisa diimpor lagi.
  it('boleh mengimpor ulang kartu setelah timnya dihapus', () => {
    const parsed = importer.parseLucyTeamMessage(cardMessage());
    const first = importer.importLucyTeam('user-1', parsed);
    assert.equal(first.imported, 1);

    store.deleteTeam('user-1', first.team.name);

    const again = importer.importLucyTeam('user-1', parsed);
    assert.equal(again.imported, 1, `gagal impor ulang: ${again.error}`);
  });

  it('mengisi animalKey slot lama dari label yang berupa nama hewan', () => {
    const dexStore = require('../src/utils/animalDexStorage');
    dexStore.upsertAnimal({
      nameKey: 'igris', name: 'igris', alias: null, nickname: null, rank: null, quantity: null,
      points: null, sell: null, sacrifice: null, role: null, weapons: null, rarity: null,
      stats: { hp: 1, attack: 1, protection: 1, wisdom: 1, magic: 1, mr: 1 }, statTokens: {},
      imageUrl: 'https://cdn.discordapp.com/emojis/1557672128059539466.gif', emojiName: 'igris',
    });

    store.createTeam('u', 'lama');
    // Slot gaya lama: hanya label, tanpa animalKey.
    store.getDb().prepare('INSERT INTO team_slots (team_id, slot, label, level) VALUES (?, ?, ?, ?)')
      .run(store.getTeam('u', 'lama').id, 1, 'igris', 50);
    store.getDb().prepare('INSERT INTO team_slots (team_id, slot, label, level) VALUES (?, ?, ?, ?)')
      .run(store.getTeam('u', 'lama').id, 2, 'nama panggilan', 50);

    assert.equal(store.getTeam('u', 'lama').slots[0].animalKey, null);

    // Backfill berjalan saat koneksi dibuka ulang.
    store.getDb().close();
    delete require.cache[require.resolve('../src/utils/battleTeamStorage')];
    const reopened = require('../src/utils/battleTeamStorage');
    const slots = reopened.getTeam('u', 'lama').slots;
    assert.equal(slots[0].animalKey, 'igris');
    assert.equal(slots[1].animalKey, null, 'label non-hewan tidak boleh diisi');
  });

  // Import versi lama menyimpan token emoji mentah sebagai label. Backfill harus
  // membersihkannya supaya panel tidak menampilkan `<a:...>` sebagai teks.
  it('membersihkan label token emoji mentah pada slot lama', () => {
    const dexStore = require('../src/utils/animalDexStorage');
    dexStore.upsertAnimal({
      nameKey: 'beastmeow', name: 'beastmeow', alias: null, nickname: null, rank: null, quantity: null,
      points: null, sell: null, sacrifice: null, role: null, weapons: null, rarity: null,
      stats: { hp: 1, attack: 1, protection: 1, wisdom: 1, magic: 1, mr: 1 }, statTokens: {},
      imageUrl: 'https://cdn.discordapp.com/emojis/1557672128059539466.gif', emojiName: 'beastmeow',
    });

    store.createTeam('u', 'token');
    const teamId = store.getTeam('u', 'token').id;
    store.getDb().prepare('INSERT INTO team_slots (team_id, slot, label, level) VALUES (?, ?, ?, ?)')
      .run(teamId, 1, '<a:beastmeow:1568773919501189281>', 82);
    store.getDb().prepare('INSERT INTO team_slots (team_id, slot, label, level) VALUES (?, ?, ?, ?)')
      .run(teamId, 2, '<a:lowcortisol:1568228969038348418>', 80);

    store.getDb().close();
    delete require.cache[require.resolve('../src/utils/battleTeamStorage')];
    const reopened = require('../src/utils/battleTeamStorage');
    const slots = reopened.getTeam('u', 'token').slots;

    assert.equal(slots[0].label, 'beastmeow');
    assert.equal(slots[0].animalKey, 'beastmeow');
    // Hewan yang tidak ada di dex tetap dibersihkan labelnya, tanpa animalKey.
    assert.equal(slots[1].label, 'lowcortisol');
    assert.equal(slots[1].animalKey, null);
  });
});
