const fs = require('node:fs');
const path = require('node:path');
const file = path.resolve(process.cwd(), 'data', 'boss-rewards.json');

function readAll() {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') console.error('[BossRewards] Read failed:', error.message);
    return { personal: {}, server: {}, processed: {} };
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
function isProcessed(guildId, imageKey) {\n  return readAll().processed?.[guildId]?.[imageKey] === imageKey;\n}\nfunction claimProcessed(guildId, messageId, imageKey) {
  return update(data => {
    data.processed ||= {};
    data.processed[guildId] ||= {};
    const old = data.processed[guildId][messageId];
    if (old === imageKey) return false;
    data.processed[guildId][messageId] = imageKey;
    const ids = Object.keys(data.processed[guildId]);
    if (ids.length > 500) for (const id of ids.slice(0, ids.length - 500)) delete data.processed[guildId][id];
    return true;
  });
}
module.exports = { getPersonal, getPersonalGuild, setPersonal, getServer, setServer, isProcessed, claimProcessed };
