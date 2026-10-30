const { getGuildSettings, updateGuildSettings, getUserSettings } = require('../utils/storage');
const { warnLabel } = require('../ui/panel');
const TITLE = 'Guild Boss Telah Dikalahkan!';
function collect(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(v => collect(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) if (['content','description','components','embeds'].includes(k)) collect(v, out);
  }
  return out;
}
function extractNextBossTimestamp(message) {
  const raw = typeof message?.toJSON === 'function' ? message.toJSON() : message;

  const text = [
    raw.content || '',
    ...collect(raw.embeds),
    ...collect(raw.components),
  ].join('\n');

  if (!text.toLowerCase().includes(TITLE.toLowerCase())) return null;

  const line = text.split('\n').find(s => /Boss baru/i.test(s));
  const match = line && line.match(/<t:(\d{9,12})(?::[tTdDfFR])?>/);
  return match ? Number(match[1]) : null;
}
class BossTracker {
  constructor(client) {
    this.client = client;
    this.timers = new Map();
    this.warnTimers = new Map();
  }
  async handleMessage(message) {
    if (!message.guildId || message.author?.id !== process.env.LUCY_BOT_ID) return;
    if (process.env.LUCY_CHANNEL_ID && message.channelId !== process.env.LUCY_CHANNEL_ID) return;
    const ts = extractNextBossTimestamp(message);
    if (!ts) return;
    const id = message.guildId, settings = getGuildSettings(id);
    if (settings.lastBossTimestamp === ts) return;
    updateGuildSettings(id, s => ({ ...s, lastBossTimestamp: ts }));
    if (getGuildSettings(id).enabled) this.scheduleGuild(id, ts);
    console.log('[BossTracker] Timestamp detected:', ts, 'guild:', id);
  }
  async restoreSchedules() {
    for (const guild of this.client.guilds.cache.values()) {
      const s = getGuildSettings(guild.id);
      if (s.enabled && s.lastBossTimestamp) this.scheduleGuild(guild.id, s.lastBossTimestamp);
    }
  }
  scheduleGuild(id, ts) {
    this.stopGuild(id);
    const fire = () => this.notifyBoss(id, ts).catch(console.error);
    const remaining = ts * 1000 - Date.now();
    if (remaining <= 0) return fire();
    const timer = setTimeout(() => {
      if (Date.now() < ts * 1000) this.scheduleGuild(id, ts);
      else fire();
    }, Math.min(remaining, 2_147_000_000));
    this.timers.set(id, timer);
    this.refreshWarns(id, ts);
  }

  refreshWarns(id, ts) {
    const s = getGuildSettings(id);
    if (!s.enabled || !ts) return;
    this.stopWarns(id);
    const fireAt = ts * 1000 - Date.now();
    for (const [userId, seconds] of Object.entries(s.userWarnSeconds || {})) {
      if (!seconds || seconds <= 0) continue;
      if (!getUserSettings(id, userId).dmEnabled) continue;
      const key = id + ':' + userId + ':' + ts;
      const delay = fireAt - seconds * 1000;
      if (delay < 0) continue;
      this.warnTimers.set(key, setTimeout(() => {
        this.warnTimers.delete(key);
        this.sendWarn(id, userId, ts, seconds).catch(console.error);
      }, Math.min(delay, 2_147_000_000)));
    }
  }

  async sendWarn(id, userId, ts, seconds) {
    const s = getGuildSettings(id);
    if (!s.enabled) return;
    try {
      const user = await this.client.users.fetch(userId);
      await user.send({
        content: '⏰ **Boss akan muncul ' + warnLabel(seconds) + '!**\n' +
          'Waktu perkiraan: <t:' + ts + ':F>\n' +
          'Hitung mundur: <t:' + ts + ':R>'
      });
    } catch (e) {
      console.warn('[BossTracker] Warn DM failed for', userId, e.message);
    }
  }

  stopWarns(id) {
    for (const [key, timer] of [...this.warnTimers.entries()]) {
      if (key.startsWith(id + ':')) { clearTimeout(timer); this.warnTimers.delete(key); }
    }
  }
  async notifyBoss(id, ts) {
    const s = getGuildSettings(id);
    if (!s.enabled || s.lastNotifiedTimestamp === ts) return;
    const guild = this.client.guilds.cache.get(id);
    if (!guild) return;
    updateGuildSettings(id, v => ({ ...v, lastNotifiedTimestamp: ts }));
    if (s.channelId) {
      try {
        const channel = await guild.channels.fetch(s.channelId);
        if (typeof channel?.send === 'function') await channel.send({
          content: (s.roleId ? '<@&' + s.roleId + '>\n' : '') +
            '🐉 **Boss baru sudah muncul!**\n' +
            'Waktu perkiraan: <t:' + ts + ':F>\n' +
            'Hitung mundur: <t:' + ts + ':R>',
          allowedMentions: { parse: [], roles: s.roleId ? [s.roleId] : [] }
        });
      } catch (e) { console.error('[BossTracker] Channel notification failed:', e.message); }
    }
    const userIds = new Set([...(s.dmUsers || []), ...Object.entries(s.userModes || {})
      .filter(([, mode]) => mode === 'dm' || mode === 'both').map(([userId]) => userId)]);
    for (const userId of userIds) {
      const mode = s.userModes?.[userId];
      if (mode === 'channel') continue;
      try {
        await (await this.client.users.fetch(userId)).send({
          content: '🐉 **Boss baru sudah muncul!**\n' +
            'Waktu perkiraan: <t:' + ts + ':F>\n' +
            'Hitung mundur: <t:' + ts + ':R>'
        });
      }
      catch (e) { console.warn('[BossTracker] DM failed for', userId, e.message); }
    }
  }
  stopGuild(id) {
    if (this.timers.has(id)) clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.stopWarns(id);
  }
}
module.exports = { BossTracker, extractNextBossTimestamp };
  
