const fs = require('node:fs');
const path = require('node:path');
const file = path.resolve(process.cwd(), 'data', 'boss-rewards.json');

function readAll() {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') console.error('[BossRewards] Read failed:', error.message);
    return { personal: {}, server: {}, processed: {}, notificationCooldowns: {} };
  }
}
function writeAll(data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function update(mutator) {
  const data = readAll();
  const result = mutator(data);
  writeAll(data);
  return result;
}
function getPersonal(guildId, userId) {
  return readAll().personal?.[guildId]?.[userId] || {};
}
function setPersonal(guildId, userId, targets) {
  return update(data => {
    data.personal ||= {};
    data.personal[guildId] ||= {};
    if (Object.keys(targets).length) data.personal[guildId][userId] = targets;
    else delete data.personal[guildId][userId];
    if (!Object.keys(data.personal[guildId]).length) delete data.personal[guildId];
    return data.personal[guildId]?.[userId] || {};
  });
}
function getPersonalGuild(guildId) {
  return readAll().personal?.[guildId] || {};
}
function getServer(guildId) {
  return readAll().server?.[guildId] || { enabled: false, channelId: null, roleId: null, targets: {} };
}
function setServer(guildId, config) {
  return update(data => {
    data.server ||= {};
    data.server[guildId] = {
      enabled: Boolean(config.enabled),
      channelId: config.channelId || null,
      roleId: config.roleId || null,
      targets: { ...(config.targets || {}) }
    };
    return data.server[guildId];
  });
}
function isProcessed(guildId, imageKey) {
  return readAll().processed?.[guildId]?.[imageKey] === imageKey;
}
function claimProcessed(guildId, imageKey) {
  return update(data => {
    data.processed ||= {};
    data.processed[guildId] ||= {};
    if (data.processed[guildId][imageKey] === imageKey) return false;
    data.processed[guildId][imageKey] = imageKey;
    const ids = Object.keys(data.processed[guildId]);
    if (ids.length > 500) for (const id of ids.slice(0, ids.length - 500)) delete data.processed[guildId][id];
    return true;
  });
}

const NOTIFICATION_COOLDOWN_MS = 30 * 60 * 1000;
function cooldownRemaining(sentAt, now = Date.now()) {
  const timestamp = Number(sentAt || 0);
  return Math.max(0, timestamp + NOTIFICATION_COOLDOWN_MS - now);
}
function getCooldownRemaining(guildId, key, now = Date.now()) {
  const sentAt = Number(readAll().notificationCooldowns?.[guildId]?.[key] || 0);
  return cooldownRemaining(sentAt, now);
}
function isOnCooldown(guildId, key, now = Date.now()) {
  return getCooldownRemaining(guildId, key, now) > 0;
}
function markNotified(guildId, key, sentAt = Date.now()) {
  return update(data => {
    data.notificationCooldowns ||= {};
    data.notificationCooldowns[guildId] ||= {};
    data.notificationCooldowns[guildId][key] = sentAt;
    return sentAt;
  });
}

module.exports = { getCooldownRemaining, cooldownRemaining, isOnCooldown, markNotified, NOTIFICATION_COOLDOWN_MS, getPersonal, getPersonalGuild, setPersonal, getServer, setServer, isProcessed, claimProcessed };
