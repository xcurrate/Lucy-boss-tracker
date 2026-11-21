// Parser dan import kartu tim Lucy Components V2 ke format tim Dragneel.
const battleData = require('../data/owoBattle');
const passiveData = require('../data/owoPassives');
const store = require('../utils/battleTeamStorage');
const dexStore = require('../utils/animalDexStorage');

const LUCY_BOT_ID = '1438615298012872817';
const IMPORT_REACTION = '📊';

function componentTexts(components = []) {
  const out = [];
  for (const component of components) {
    if (component.type === 10 && typeof component.content === 'string') out.push(component.content);
    if (Array.isArray(component.components)) out.push(...componentTexts(component.components));
  }
  return out;
}

function emojiNames(text) {
  return [...String(text).matchAll(/<a?:([\w]+):\d+>/g)].map(match => match[1].toLowerCase());
}

function buildEmojiIndex(items) {
  const index = new Map();
  for (const item of items) {
    for (const token of item.emojis || []) {
      const match = String(token).match(/<a?:([\w]+):\d+>/);
      if (match && !index.has(match[1].toLowerCase())) index.set(match[1].toLowerCase(), item);
    }
  }
  return index;
}

const weaponByEmoji = buildEmojiIndex(battleData.weapons());
const passiveByEmoji = buildEmojiIndex(passiveData.all());

function statAfterEmoji(name, text, suffix = '') {
  const match = String(text).match(new RegExp(`<a?:${name}:\\d+>\\s*` + '`?([\\d,]+)`?' + suffix, 'i'));
  return match ? Number(match[1].replace(/,/g, '')) : null;
}
function parseSlot(text) {
  const header = String(text).split('\n')[0];
  const slotMatch = header.match(/\*\*\[(\d+)\]/);
  if (!slotMatch) return null;
  const slot = Number(slotMatch[1]);
  // Label bisa didahului token emoji hewan (`**[1] <a:beastmeow:123> **`), jadi
  // token dibuang dulu sebelum mencari teks bold. Tanpa ini labelnya ikut
  // menyimpan `<a:...>` mentah dan tampil sebagai teks di panel.
  const labelSource = header.replace(/<a?:\w+:\d+>/g, ' ');
  const labelMatch = labelSource.match(/\*\*\[(?:\d+)\][^\n]*?\*\*\s*([^*\n]+?)\s*\*\*/);
  const label = labelMatch ? labelMatch[1].trim() : `slot${slot}`;
  // Hewan pemilik slot dikenali dari emoji pertama di header kartu
  // (`**[2] <a:ulquiorracifer:...> **for** **`), bukan dari label: label bisa
  // diganti user jadi apa saja. Tanpa ini slot tidak punya `animalKey`, panel
  // tidak bisa mengambil emoji hewan, dan semua pet tampil sebagai 🐾.
  const headerEmoji = header.match(/<a?:(\w+):\d+>/)?.[1] || null;
  const levelMatch = text.match(/Lvl\s+(\d+)/i);
  const displayedStats = {
    hp: statAfterEmoji('hp', text),
    wp: statAfterEmoji('wp', text),
    att: statAfterEmoji('att', text),
    mag: statAfterEmoji('mg', text),
    pr: statAfterEmoji('pr', text, '%'),
    mr: statAfterEmoji('mr', text, '%'),
  };
  if (Object.values(displayedStats).some(value => value == null) || !levelMatch) return null;
  const names = emojiNames(text);
  const weapon = names.map(name => weaponByEmoji.get(name)).find(Boolean) || null;
  const passives = [...new Set(names.map(name => passiveByEmoji.get(name)?.id).filter(id => id != null))];
  return {
    slot,
    label,
    headerEmoji,
    level: Number(levelMatch[1]),
    displayedStats,
    weaponId: weapon?.id || null,
    weaponQuality: weapon ? 100 : null,
    passives,
  };
}

function parseLucyTeamMessage(message) {
  if (!message || message.author?.id !== LUCY_BOT_ID) return null;
  const texts = componentTexts(message.components || message.message?.components || []);
  // Judul kartu selalu heading `## ` berisi bold, tapi bentuknya bebas:
  // `## ⭐ **win solution**`, `## **free 550 xp!**`, atau `## **nnneozen's team**`.
  // Baris statistik juga heading (`## <:hp:...>`) tapi tanpa bold, jadi aman.
  const teamText = texts.find(text => /^##\s+⭐?\s*\*\*/.test(text));
  const teamMatch = teamText?.match(/^##\s+⭐?\s*\*\*([^*\n]+?)\*\*/);
  const name = teamMatch ? teamMatch[1].trim() : 'Lucy team';
  const slots = texts.filter(text => /\*\*\[\d+\]/.test(text)).map(parseSlot).filter(Boolean);
  if (!slots.length) return null;
  return {
    name,
    slots: slots.filter((slot, index, all) => all.findIndex(other => other.slot === slot.slot) === index),
    sourceMessageId: message.id || message.message?.id || null,
    sourceGuildId: message.guildId || message.message?.guildId || null,
    sourceChannelId: message.channelId || message.message?.channelId || null,
  };
}

function coefficientsFromDisplayed(stats, level) {
  return {
    hp: (stats.hp - 500) / (level * 2),
    att: (stats.att - 100) / level,
    pr: (stats.pr - 25) / (level * 2),
    wp: (stats.wp - 500) / (level * 2),
    mag: (stats.mag - 100) / level,
    mr: (stats.mr - 25) / (level * 2),
  };
}

function importLucyTeam(userId, parsed) {
  if (!parsed?.slots?.length) return { error: 'Data tim Lucy kosong.' };
  if (parsed.sourceMessageId && store.hasTeamImport(userId, parsed.sourceMessageId)) {
    return { error: 'Pesan tim Lucy ini sudah kamu impor sebelumnya.' };
  }
  const name = store.uniqueName(userId, `Lucy Import - ${parsed.name}`);
  if (!name) return { error: 'Nama tim Lucy tidak bisa dipakai. Ganti judul kartunya atau hapus tim lama.' };
  const created = store.createTeam(userId, name);
  if (created.error) return created;
  for (const slot of parsed.slots) {
    const result = store.setSlot(userId, name, slot.slot, {
      label: slot.label,
      animalKey: resolveAnimalKey(slot),
      level: slot.level,
      finalStats: slot.displayedStats,
      weaponId: slot.weaponId,
      weaponQuality: slot.weaponQuality,
      passives: slot.passives,
    });
    if (result.error) return result;
  }
  if (parsed.sourceMessageId) store.markTeamImport(userId, parsed.sourceMessageId, name);
  return { team: store.getTeam(userId, name), imported: parsed.slots.length };
}

// Emoji header kartu adalah nama hewan di dex (`ellie`, `void2`, ...). Dipakai
// sebagai `animalKey` supaya panel bisa menampilkan emoji pet, bukan 🐾. Emoji
// yang belum pernah tertangkap jatuh ke null dan slotnya tetap bisa dipakai
// lewat stat hasil import.
function resolveAnimalKey(slot) {
  const key = slot.headerEmoji || slot.label;
  const animal = dexStore.resolveAnimal(key);
  return animal ? animal.nameKey : null;
}

async function prepareLucyTeamMessage(message) {
  const parsed = parseLucyTeamMessage(message);
  if (!parsed || !message.react) return false;
  await message.react(IMPORT_REACTION);
  if (parsed.sourceMessageId) {
    store.markTeamImportMessage(parsed.sourceMessageId, parsed.sourceGuildId, parsed.sourceChannelId);
  }
  return true;
}

async function handleReaction(reaction, user) {
  if (!reaction || user?.bot || reaction.emoji?.name !== IMPORT_REACTION) return null;
  let message = reaction.message;
  if (message?.partial && message.fetch) message = await message.fetch();
  const messageId = message?.id || message?.message?.id;
  if (!messageId || !store.isTeamImportMessage(messageId)) return null;
  const parsed = parseLucyTeamMessage(message);
  if (!parsed) return null;
  return importLucyTeam(user.id, parsed);
}

module.exports = {
  LUCY_BOT_ID,
  IMPORT_REACTION,
  componentTexts,
  parseLucyTeamMessage,
  coefficientsFromDisplayed,
  importLucyTeam,
  prepareLucyTeamMessage,
  handleReaction,
};
