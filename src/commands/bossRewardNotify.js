const store = require('../utils/bossRewardStorage');
const { DEFAULT_PREFIX } = require('../utils/storage');

const ALIASES = Object.freeze({
  ws: 'weapon_shards', weapon_shards: 'weapon_shards',
  wc: 'weapon_crate', weapon_crate: 'weapon_crate',
  flb: 'fabled_lootbox', flootbox: 'fabled_lootbox', fabled_lootbox: 'fabled_lootbox',
  xp: 'experience', experience: 'experience'
});
const LABELS = {
  weapon_shards: 'Weapon Shards',
  weapon_crate: 'Weapon Crate',
  fabled_lootbox: 'Fabled Lootbox',
  experience: 'Experience'
};
function parseAmount(token) {
  const match = String(token).match(/^(\d+(?:,\d{3})*|\d+)(?:\.(\d+))?([kKmM])?(\+\+)?$/);
  if (!match) return null;
  const base = Number(match[1].replace(/,/g, '') + (match[2] ? '.' + match[2] : ''));
  const multiplier = match[3]?.toLowerCase() === 'k' ? 1000 : match[3]?.toLowerCase() === 'm' ? 1000000 : 1;
  const target = base * multiplier;
  if (!Number.isSafeInteger(target) || target < 1) return null;
  return { target, operator: match[4] ? '>' : '>=' };
}
function parseTargets(tokens) {
  if (!tokens.length || tokens.length % 2 !== 0) throw new Error('Format: boss notify ws 100 xp 10k++ flb 5');
  const result = {};
  for (let i = 0; i < tokens.length; i += 2) {
    const category = ALIASES[tokens[i].toLowerCase()];
    const amount = parseAmount(tokens[i + 1]);
    if (!category || !amount) throw new Error('Kategori/nilai tidak valid: ' + tokens[i] + ' ' + tokens[i + 1]);
    result[category] = amount;
  }
  return result;
}
function display(targets) {
  const entries = Object.entries(targets || {});
  if (!entries.length) return 'Belum ada target reward personal yang aktif.';
  return entries.map(([key, value]) => '• **' + LABELS[key] + '**: ' + (value.operator === '>' ? 'lebih dari ' : 'minimal ') + value.target.toLocaleString('en-US')).join('\n');
}
async function handlePersonalCommand(message, args, prefix = DEFAULT_PREFIX) {
  if (!message.guildId || message.author?.bot) return false;
  const userId = message.author.id;
  const sub = (args[0] || '').toLowerCase();
  let targets = store.getPersonal(message.guildId, userId);
  if (!sub || sub === 'list') {
    await message.reply({ content: '🎯 **Target reward personal kamu**\n' + display(targets), allowedMentions: { parse: [] } });
    return true;
  }
  if (sub === 'clear') {
    store.setPersonal(message.guildId, userId, {});
    await message.reply({ content: '🗑️ Semua target reward personal kamu sudah dihapus.', allowedMentions: { parse: [] } });
    return true;
  }
  if (sub === 'remove') {
    const key = ALIASES[(args[1] || '').toLowerCase()];
    if (!key) { await message.reply('Kategori tidak valid. Gunakan ws, wc, flb, atau xp.'); return true; }
    delete targets[key];
    store.setPersonal(message.guildId, userId, targets);
    await message.reply({ content: '✅ Target ' + LABELS[key] + ' dihapus.', allowedMentions: { parse: [] } });
    return true;
  }
  try {
    const parsed = parseTargets(args);
    targets = { ...targets, ...parsed };
    store.setPersonal(message.guildId, userId, targets);
    await message.reply({ content: '✅ Target reward personal diperbarui.\n' + display(targets), allowedMentions: { parse: [] } });
  } catch (error) {
    await message.reply({ content: '❌ ' + error.message + '\nContoh: `' + prefix + ' boss notify ws 100 xp 10,000++ flb 5`', allowedMentions: { parse: [] } });
  }
  return true;
}
module.exports = { handlePersonalCommand, parseAmount, parseTargets, ALIASES };
