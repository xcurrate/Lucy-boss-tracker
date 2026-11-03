const crypto = require('node:crypto');
const { readRewards } = require('./rewardOCR');
const store = require('../utils/bossRewardStorage');

const LABELS = {
  weapon_shards: '💎 Weapon Shards',
  weapon_crate: '🗃️ Weapon Crate',
  fabled_lootbox: '📦 Fabled Lootbox',
  experience: '⭐ Experience'
};
const queue = [];
let running = false;
const inFlight = new Set();

function findRewardImage(message) {
  const raw = typeof message?.toJSON === 'function' ? message.toJSON() : message;
  const roots = raw?.components || [];
  let hasRewardHeading = false;
  let imageUrl = null;
  const seen = new Set();
  function walk(value) {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) { for (const child of value) walk(child); return; }
    const type = Number(value.type);
    const text = [value.content, value.text, value.title].filter(x => typeof x === 'string').join(' ');
    if (type === 10 && /##\s*Hadiah/i.test(text)) hasRewardHeading = true;
    if (type === 12 && !imageUrl) {
      const candidate = value.items?.[0]?.media?.url || value.media?.url;
      if (typeof candidate === 'string') imageUrl = candidate;
    }
    for (const [key, child] of Object.entries(value)) {
      if (['media', 'url', 'proxy_url'].includes(key)) continue;
      walk(child);
    }
  }
  walk(roots);
  if (!hasRewardHeading || !imageUrl) return null;
  let parsed;
  try { parsed = new URL(imageUrl); } catch { return null; }
  if (parsed.protocol !== 'https:') return null;
  return parsed.toString();
}

async function downloadRewardImage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'error', headers: { Accept: 'image/png' } });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (type !== 'image/png') throw new Error('Format reward tidak didukung: ' + (type || 'unknown') + ' (hanya PNG).');
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > 8 * 1024 * 1024) throw new Error('Gambar reward melebihi batas 8 MB.');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error('Ukuran gambar reward tidak valid.');
    return bytes;
  } finally { clearTimeout(timer); }
}
function formatNumber(n) { return Number(n).toLocaleString('en-US'); }
function reached(value, target) {
  if (value === null || !Number.isSafeInteger(value) || !target || !Number.isSafeInteger(target.target)) return false;
  return target.operator === '>' ? value > target.target : value >= target.target;
}
function rewardLines(rewards, targets) {
  return Object.entries(targets).filter(([key, target]) => reached(rewards[key], target))
    .map(([key, target]) => LABELS[key] + ': ' + formatNumber(rewards[key]) + ' / ' + formatNumber(target.target));
}

async function evaluatePersonal(guild, rewards, sourceChannel) {
  const users = store.getPersonalGuild(guild.id);
  for (const [userId, saved] of Object.entries(users)) {
    const matched = rewardLines(rewards, saved);
    if (!matched.length) continue;
    const content = '🎉 <@' + userId + '> Target reward kamu terpenuhi!\n' + matched.join('\n');
    try {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) continue;
      const channel = sourceChannel?.isTextBased?.() ? sourceChannel : (guild.systemChannel || guild.channels.cache.find(c => c.isTextBased?.() && c.permissionsFor(guild.members.me)?.has('SendMessages')));
      if (!channel) continue;
      await channel.send({ content, allowedMentions: { parse: [], users: [userId] } });
      const next = { ...saved };
      for (const line of matched) {
        const key = Object.keys(LABELS).find(k => line.startsWith(LABELS[k]));
        if (key) delete next[key];
      }
      store.setPersonal(guild.id, userId, next);
    } catch (error) { console.warn('[BossRewards] Personal notification failed:', userId, error.message); }
  }
}

async function evaluateServer(guild, rewards) {
  const config = store.getServer(guild.id);
  if (!config.enabled || !config.channelId || !config.roleId) return;
  const matched = rewardLines(rewards, config.targets);
  if (!matched.length) return;
  const channel = await guild.channels.fetch(config.channelId).catch(() => null);
  const role = await guild.roles.fetch(config.roleId).catch(() => null);
  if (!channel?.isTextBased?.() || !role) {
    console.warn('[BossRewards] Config channel/role invalid for guild', guild.id);
    return;
  }
  const permissions = channel.permissionsFor(guild.members.me);
  if (!permissions?.has('SendMessages')) return;
  if (!role.mentionable && !permissions.has('MentionEveryone')) {
    console.warn('[BossRewards] Bot cannot mention configured role in guild', guild.id);
    return;
  }
  const content = '🎉 **BOSS REWARD REMINDER**\n<@&' + role.id + '>\nReward target server telah terpenuhi!\n' + matched.join('\n');
  try {
    await channel.send({ content, allowedMentions: { parse: [], roles: [role.id] } });
    const next = { ...config.targets };
    for (const line of matched) {
      const key = Object.keys(LABELS).find(k => line.startsWith(LABELS[k]));
      if (key) delete next[key];
    }
    store.setServer(guild.id, { ...config, targets: next });
  } catch (error) { console.warn('[BossRewards] Server notification failed:', error.message); }
}

async function processMessage(message) {
  if (!message.guildId || message.author?.id !== process.env.LUCY_BOT_ID) return;
  const url = findRewardImage(message);
  if (!url) return;
  const bytes = await downloadRewardImage(url);
  const imageHash = crypto.createHash('sha256').update(bytes).digest('hex');
  if (store.isProcessed(message.guildId, imageHash)) return;
  const rewards = await readRewards(bytes);
  if (!Object.values(rewards).some(value => value !== null)) {
    console.warn('[BossRewards] OCR tidak menghasilkan angka valid; notifikasi dilewati.');
    return;
  }
  if (!store.claimProcessed(message.guildId, imageHash, imageHash)) return;
  await evaluatePersonal(message.guild, rewards, message.channel);
  await evaluateServer(message.guild, rewards);
  console.log('[BossRewards] Reward processed:', message.guildId, message.id, imageHash, rewards);
}
async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const item = queue.shift();
      try { await processMessage(item); }
      catch (error) { console.error('[BossRewards] Processing failed:', error.message); }
      finally { inFlight.delete(item.id); }
    }
  } finally { running = false; }
}
function enqueue(message) {
  if (!message?.id || inFlight.has(message.id)) return;
  inFlight.add(message.id);
  queue.push(message);
  setImmediate(() => drain().catch(error => console.error('[BossRewards] Queue error:', error)));
}
module.exports = { enqueue, findRewardImage, downloadRewardImage, reached };
