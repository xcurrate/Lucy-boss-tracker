const fs = require('node:fs');
const path = require('node:path');
const dir = path.resolve(process.cwd(), 'data');
const file = path.join(dir, 'guild-settings.json');
const defaults = () => ({
  enabled: false,
  channelId: null,
  roleId: null,
  prefix: '!',
  lastBossTimestamp: null,
  lastNotifiedTimestamp: null,
  dmUsers: [],
  userModes: {},
  userWarnSeconds: {}
});
function readAll() {
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, '{}\n');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writeAll(data) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
function getGuildSettings(id) {
  const saved = readAll()[id] || {};
  return { ...defaults(), ...saved, userModes: { ...(saved.userModes || {}) }, userWarnSeconds: { ...(saved.userWarnSeconds || {}) }, dmUsers: [...(saved.dmUsers || [])] };
}
function updateGuildSettings(id, fn) {
  const all = readAll();
  const old = all[id] || {};
  all[id] = fn({
    ...defaults(),
    ...old,
    userModes: { ...(old.userModes || {}) },
    userWarnSeconds: { ...(old.userWarnSeconds || {}) },
    dmUsers: [...(old.dmUsers || [])]
  });
  writeAll(all);
  return all[id];
}
function getUserSettings(id, userId) {
  const s = getGuildSettings(id);
  const mode = s.userModes?.[userId] || ((s.dmUsers || []).includes(userId) ? 'both' : 'channel');
  return {
    mode,
    dmEnabled: mode === 'dm' || mode === 'both',
    warnSeconds: s.userWarnSeconds?.[userId] ?? 0
  };
}
function setUserMode(guildId, userId, mode) {
  updateGuildSettings(guildId, s => {
    const userModes = { ...(s.userModes || {}), [userId]: mode };
    const dmUsers = new Set(s.dmUsers || []);
    if (mode === 'dm' || mode === 'both') dmUsers.add(userId);
    else dmUsers.delete(userId);
    return { ...s, userModes, dmUsers: [...dmUsers] };
  });
}
function setUserWarnSeconds(guildId, userId, seconds) {
  updateGuildSettings(guildId, s => ({ ...s, userWarnSeconds: { ...(s.userWarnSeconds || {}), [userId]: seconds } }));
}
module.exports = { getGuildSettings, updateGuildSettings, getUserSettings, setUserMode, setUserWarnSeconds };
