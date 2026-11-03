const crypto = require('node:crypto');
const { readRewards } = require('./rewardOCR');
const store = require('../utils/bossRewardStorage');
const { getGuildSettings } = require('../utils/storage');

const LABELS = {
  weapon_shards: '💎 Weapon Shards',
  weapon_crate: '🗃️ Weapon Crate',
  fabled_lootbox: '📦 Fabled Lootbox',
  experience: '⭐ Experience'
};
const queue = [];
let running = false;
const inFlight = new Set();
const pendingEdits = new Map();
const noRewardSignatures = new Map();

function isRewardSourceChannel(message, settings) {
  return Boolean(message?.guildId && message?.channelId && settings?.channelId && message.channelId === settings.channelId);
}

function findRewardImage(message) {
  const raw = typeof message?.toJSON === 'function' ? message.toJSON() : message;
  const containers = (raw?.components || []).filter(component => Number(component?.type) === 17);
  for (const container of containers) {
    let hasRewardHeading = false;
    let imageUrl = null;
    const seen = new Set();
    function walk(value) {
      if (!value || typeof value !== 'object' || seen.has(value) || imageUrl) return;
      seen.add(value);
      if (Array.isArray(value)) {
        for (const child of value) walk(child);
        return;
      }
      const type = Number(value.type);
      const text = [value.content, value.text, value.title]
        .filter(x => typeof x === 'string').join(' ');
      if (type === 10 && /##\s*Hadiah\b/i.test(text)) hasRewardHeading = true;
      // Abaikan gambar sebelum heading Hadiah (misalnya raid.png).
      if (type === 12 && hasRewardHeading) {
        const candidate = value.items?.[0]?.media?.url || value.media?.url;
        if (typeof candidate === 'string') imageUrl = candidate;
      }
      for (const [key, child] of Object.entries(value)) {
        if (['media', 'url', 'proxy_url'].includes(key)) continue;
        walk(child);
      }
    }
    walk(container);
    if (!imageUrl) continue;
    let parsed;
    try { parsed = new URL(imageUrl); } catch { continue; }
    if (parsed.protocol === 'https:') return parsed.toString();
  }
  return null;
}

async function downloadRewardImage(url) {
  let safeHost = 'unknown';
  try { safeHost = new URL(url).host; } catch {}
  console.info('[BossRewards][download:start] host=' + safeHost);
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
    console.info('[BossRewards][download:ok] host=' + safeHost + ' contentType=' + type + ' bytes=' + bytes.length);
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
  const userIds = Object.keys(users);
  console.info('[BossRewards][personal:evaluate] guild=' + guild.id + ' configuredUsers=' + userIds.length);
  for (const [userId, saved] of Object.entries(users)) {
    const matched = rewardLines(rewards, saved);
    if (!matched.length) continue;
    console.info('[BossRewards][personal:matched] guild=' + guild.id + ' user=' + userId + ' categories=' + matched.length);
    const content = '🎉 <@' + userId + '> Target reward kamu terpenuhi!\n' + matched.join('\n');
    try {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) { console.warn('[BossRewards][personal:member-missing] guild=' + guild.id + ' user=' + userId); continue; }
      const channel = sourceChannel?.isTextBased?.() ? sourceChannel : (guild.systemChannel || guild.channels.cache.find(c => c.isTextBased?.() && c.permissionsFor(guild.members.me)?.has('SendMessages')));
      if (!channel) { console.warn('[BossRewards][personal:no-channel] guild=' + guild.id + ' user=' + userId); continue; }
      await channel.send({ content, allowedMentions: { parse: [], users: [userId] } });
      console.info('[BossRewards][personal:sent] guild=' + guild.id + ' user=' + userId + ' channel=' + channel.id);
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
  console.info('[BossRewards][server:evaluate] guild=' + guild.id + ' enabled=' + config.enabled + ' channel=' + (config.channelId || '-') + ' role=' + (config.roleId || '-') + ' targetCount=' + Object.keys(config.targets || {}).length);
  if (!config.enabled || !config.channelId || !config.roleId) return;
  const matched = rewardLines(rewards, config.targets);
  if (!matched.length) { console.info('[BossRewards][server:no-match] guild=' + guild.id); return; }
  console.info('[BossRewards][server:matched] guild=' + guild.id + ' categories=' + matched.length);
  const channel = await guild.channels.fetch(config.channelId).catch(() => null);
  const role = await guild.roles.fetch(config.roleId).catch(() => null);
  if (!channel?.isTextBased?.() || !role) {
    console.warn('[BossRewards] Config channel/role invalid for guild', guild.id);
    return;
  }
  const permissions = channel.permissionsFor(guild.members.me);
  if (!permissions?.has('SendMessages')) { console.warn('[BossRewards][server:no-send-permission] guild=' + guild.id + ' channel=' + channel.id); return; }
  if (!role.mentionable && !permissions.has('MentionEveryone')) {
    console.warn('[BossRewards] Bot cannot mention configured role in guild', guild.id);
    return;
  }
  const content = '🎉 **BOSS REWARD REMINDER**\n<@&' + role.id + '>\nReward target server telah terpenuhi!\n' + matched.join('\n');
  try {
    await channel.send({ content, allowedMentions: { parse: [], roles: [role.id] } });
    console.info('[BossRewards][server:sent] guild=' + guild.id + ' channel=' + channel.id + ' role=' + role.id);
    const next = { ...config.targets };
    for (const line of matched) {
      const key = Object.keys(LABELS).find(k => line.startsWith(LABELS[k]));
      if (key) delete next[key];
    }
    store.setServer(guild.id, { ...config, targets: next });
  } catch (error) { console.warn('[BossRewards] Server notification failed:', error.message); }
}

async function processMessage(message) {
  if (!message.guildId) return;
  if (message.author?.id !== process.env.LUCY_BOT_ID) {
    if (message.author?.bot && (message.components?.length || 0) > 0) {
      console.warn('[BossRewards][skip:not-lucy] guild=' + message.guildId + ' message=' + message.id + ' author=' + message.author.id + ' configuredLucyBotId=' + (process.env.LUCY_BOT_ID || '(empty)'));
    }
    return;
  }
  const guildSettings = getGuildSettings(message.guildId);
  if (!isRewardSourceChannel(message, guildSettings)) return;
  const raw = typeof message.toJSON === 'function' ? message.toJSON() : message;
  const topTypes = (raw?.components || []).map(component => component?.type ?? 'unknown');
  console.info('[BossRewards][message:lucy] guild=' + message.guildId + ' message=' + message.id + ' components=' + JSON.stringify(topTypes));
  const url = findRewardImage(message);
  if (!url) {
    const signature = crypto.createHash('sha256').update(JSON.stringify(raw?.components || [])).digest('hex');
    if (noRewardSignatures.get(message.id) === signature) return;
    noRewardSignatures.set(message.id, signature);
    if (noRewardSignatures.size > 1000) noRewardSignatures.delete(noRewardSignatures.keys().next().value);
    console.info('[BossRewards][skip:not-reward-message] guild=' + message.guildId + ' channel=' + message.channelId + ' message=' + message.id + ' components=' + JSON.stringify(topTypes));
    return;
  }
  noRewardSignatures.delete(message.id);
  const bytes = await downloadRewardImage(url);
  const imageHash = crypto.createHash('sha256').update(bytes).digest('hex');
  console.info('[BossRewards][image:hash] message=' + message.id + ' sha256=' + imageHash);
  if (store.isProcessed(message.guildId, imageHash)) {
    console.info('[BossRewards][dedupe:skip] message=' + message.id + ' image already processed');
    return;
  }
  console.info('[BossRewards][ocr:start] message=' + message.id + ' imageBytes=' + bytes.length);
  const rewards = await readRewards(bytes);
  console.info('[BossRewards][ocr:result] message=' + message.id + ' rewards=' + JSON.stringify(rewards));
  if (!Object.values(rewards).some(value => value !== null)) {
    console.warn('[BossRewards][ocr:empty] message=' + message.id + ' no valid numeric values; notifications skipped.');
    return;
  }
  if (!store.claimProcessed(message.guildId, imageHash)) return;
  await evaluatePersonal(message.guild, rewards, message.channel);
  await evaluateServer(message.guild, rewards);
  console.log('[BossRewards][processed] guild=' + message.guildId + ' message=' + message.id + ' image=' + imageHash);
}
async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const item = queue.shift();
      try { await processMessage(item); }
      catch (error) { console.error('[BossRewards][processing:error] guild=' + item.guildId + ' message=' + item.id + ' name=' + error.name + ' code=' + (error.code || '-') + ' message=' + error.message, error.stack || ''); }
      finally {
        const latest = pendingEdits.get(item.id);
        if (latest) { pendingEdits.delete(item.id); queue.push(latest); }
        else inFlight.delete(item.id);
      }
    }
  } finally { running = false; }
}
function enqueue(message) {
  if (!message?.id) return;
  if (inFlight.has(message.id)) { pendingEdits.set(message.id, message); return; }
  inFlight.add(message.id);
  queue.push(message);
  setImmediate(() => drain().catch(error => console.error('[BossRewards] Queue error:', error)));
}
module.exports = { enqueue, findRewardImage, downloadRewardImage, reached, isRewardSourceChannel };
