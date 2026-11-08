const fs = require('node:fs');
const path = require('node:path');
const dir = path.resolve(process.cwd(), 'data');
const file = path.join(dir, 'guild-settings.json');
// Prefix bawaan untuk memanggil bot (mis. `d status`, `d f100`). Server bisa
// menggantinya lewat `d prefix <baru>` (moderator) atau dashboard (developer).
const DEFAULT_PREFIX = 'd';
// Input user tidak pandang huruf besar/kecil: prefix selalu disimpan dan
// dibandingkan dalam huruf kecil, sehingga `D BOSS STATUS` == `d boss status`.
function normalizePrefix(value) { return String(value ?? '').toLowerCase(); }
function matchPrefix(content, prefix) {
  const p = normalizePrefix(prefix);
  const text = String(content ?? '');
  return text.slice(0, p.length).toLowerCase() === p ? text.slice(p.length) : null;
}
const defaults = () => ({
  enabled: false, channelId: null, roleId: null, prefix: DEFAULT_PREFIX, lastBossTimestamp: null, lastNotifiedTimestamp: null,
  dmUsers: [], userModes: {}, userWarnSeconds: {},
  lucyCounter: { enabled: false, targetEnabled: false, targetGoal: 0, targetMessage: '🎉 Target Lucy tercapai!', targetChannelId: null, targetStartTime: '12:00', targetStopTime: '10:00', blacklistedChannelIds: [], whitelistedChannelIds: [] },
  family100: { enabled: true, channelId: null, durationSeconds: 0 },
  autoThreadRep: { enabled: true, channelId: null, targetUserId: '1515658233174294569', amount: '50k', threadNamePrefix: 'Rep', autoArchiveDuration: 1440 }
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
function mergeSettings(saved = {}) {
  const base = defaults();
  return {
    ...base, ...saved,
    lucyCounter: { ...base.lucyCounter, ...(saved.lucyCounter || {}) },
    family100: { ...base.family100, ...(saved.family100 || {}) },
    autoThreadRep: { ...base.autoThreadRep, ...(saved.autoThreadRep || {}) },
    userModes: { ...(saved.userModes || {}) },
    userWarnSeconds: { ...(saved.userWarnSeconds || {}) },
    dmUsers: [...(saved.dmUsers || [])]
  };
}
// Prefix dinormalkan saat dibaca juga, agar pengaturan lama yang tersimpan
// dengan huruf besar tetap cocok dengan pencocokan case-insensitive.
function getGuildSettings(id) {
  const s = mergeSettings(readAll()[id] || {});
  if (s.prefix) s.prefix = normalizePrefix(s.prefix);
  return s;
}
function updateGuildSettings(id, fn) {
  const all = readAll();
  const next = mergeSettings(fn(mergeSettings(all[id] || {})));
  if (next.prefix) next.prefix = normalizePrefix(next.prefix);
  all[id] = next;
  writeAll(all);
  return next;
}
function getUserSettings(id, userId) {
  const s = getGuildSettings(id);
  const mode = s.userModes?.[userId] || ((s.dmUsers || []).includes(userId) ? 'both' : 'channel');
  return { mode, dmEnabled: mode === 'dm' || mode === 'both', warnSeconds: s.userWarnSeconds?.[userId] ?? 0 };
}
function setUserMode(guildId, userId, mode) {
  updateGuildSettings(guildId, s => {
    const userModes = { ...(s.userModes || {}), [userId]: mode };
    const dmUsers = new Set(s.dmUsers || []);
    if (mode === 'dm' || mode === 'both') dmUsers.add(userId); else dmUsers.delete(userId);
    return { ...s, userModes, dmUsers: [...dmUsers] };
  });
}
function setUserWarnSeconds(guildId, userId, seconds) {
  updateGuildSettings(guildId, s => ({ ...s, userWarnSeconds: { ...(s.userWarnSeconds || {}), [userId]: seconds } }));
}
module.exports = { DEFAULT_PREFIX, normalizePrefix, matchPrefix, getGuildSettings, updateGuildSettings, getUserSettings, setUserMode, setUserWarnSeconds };
