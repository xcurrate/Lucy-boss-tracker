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
  dmUsers: []
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
function getGuildSettings(id) { return { ...defaults(), ...(readAll()[id] || {}) }; }
function updateGuildSettings(id, fn) {
  const all = readAll();
  all[id] = fn({ ...defaults(), ...(all[id] || {}), dmUsers: [...((all[id] || {}).dmUsers || [])] });
  writeAll(all);
  return all[id];
}
module.exports = { getGuildSettings, updateGuildSettings };
