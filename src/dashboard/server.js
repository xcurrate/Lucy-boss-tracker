const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getGuildSettings, updateGuildSettings } = require('../utils/storage');
const logBuffer = require('../utils/logBuffer');

const PUBLIC_DIR = path.join(__dirname, 'public');

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 32_768) {
        reject(new Error('Payload terlalu besar'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('JSON tidak valid')); }
    });
    req.on('error', reject);
  });
}
function getGuild(client, guildId) {
  const guild = guildId && client.guilds.cache.get(guildId);
  if (!guild) throw Object.assign(new Error('Server tidak ditemukan atau bot belum bergabung.'), { status: 404 });
  return guild;
}
function publicSettings(settings) {
  return {
    enabled: settings.enabled,
    channelId: settings.channelId || '',
    roleId: settings.roleId || '',
    prefix: settings.prefix || '!',
    lastBossTimestamp: settings.lastBossTimestamp,
    autoThreadRep: { ...settings.autoThreadRep, channelId: settings.autoThreadRep.channelId || '' }
  };
}
function validateSettings(input) {
  if (!input || typeof input !== 'object') throw new Error('Pengaturan tidak valid.');
  if (typeof input.enabled !== 'boolean') throw new Error('Status Boss Tracker tidak valid.');
  const channelId = input.channelId || null;
  const roleId = input.roleId || null;
  if (channelId && !/^\d{17,20}$/.test(channelId)) throw new Error('ID channel notifikasi tidak valid.');
  if (roleId && !/^\d{17,20}$/.test(roleId)) throw new Error('ID role tidak valid.');
  if (typeof input.prefix !== 'string' || input.prefix.length < 1 || input.prefix.length > 5 || /\s/.test(input.prefix)) {
    throw new Error('Prefix harus 1–5 karakter tanpa spasi.');
  }
  const rep = input.autoThreadRep || {};
  if (typeof rep.enabled !== 'boolean') throw new Error('Status Auto Thread Rep tidak valid.');
  const repChannelId = rep.channelId || null;
  if (repChannelId && !/^\d{17,20}$/.test(repChannelId)) throw new Error('ID channel Auto Thread Rep tidak valid.');
  if (!/^\d{17,20}$/.test(String(rep.targetUserId || ''))) throw new Error('Target user ID harus berupa Discord ID.');
  if (typeof rep.amount !== 'string' || !/^\d{1,9}(?:[kKmM])?$/.test(rep.amount)) throw new Error('Nominal rep tidak valid (contoh: 50k).');
  if (typeof rep.threadNamePrefix !== 'string' || !rep.threadNamePrefix.trim() || rep.threadNamePrefix.length > 40) {
    throw new Error('Awalan nama thread wajib diisi (maksimal 40 karakter).');
  }
  if (![60, 1440, 4320, 10080].includes(Number(rep.autoArchiveDuration))) {
    throw new Error('Durasi arsip thread tidak valid.');
  }
  return {
    enabled: input.enabled,
    channelId,
    roleId,
    prefix: input.prefix,
    autoThreadRep: {
      enabled: rep.enabled,
      channelId: repChannelId,
      targetUserId: String(rep.targetUserId),
      amount: rep.amount,
      threadNamePrefix: rep.threadNamePrefix.trim(),
      autoArchiveDuration: Number(rep.autoArchiveDuration)
    }
  };
}
function startDashboard(client, tracker) {
  const port = Number(process.env.DASHBOARD_PORT || process.env.SERVER_PORT || process.env.PORT || 4002);
  const host = process.env.DASHBOARD_HOST || '0.0.0.0';
  const token = process.env.DASHBOARD_TOKEN || '';
  if (token.length < 24) {
    console.error('[Dashboard] DASHBOARD_TOKEN wajib diisi (minimal 24 karakter). Dashboard tidak dijalankan tanpa token.');
    return null;
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    // Static dashboard files are public; every API endpoint requires the developer token.
    if (url.pathname.startsWith('/api/')) {
      const supplied = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!safeEqual(supplied, token)) return json(res, 401, { error: 'Token dashboard salah atau belum diisi.' });
    }
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin) {
        try {
          if (new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'Origin tidak diizinkan.' });
        } catch {
          return json(res, 403, { error: 'Origin tidak valid.' });
        }
      }
    }
    try {
      if (req.method === 'GET' && url.pathname === '/api/me') {
        const guilds = [...client.guilds.cache.values()].map(guild => ({ id: guild.id, name: guild.name }));
        return json(res, 200, { user: { username: 'Developer' }, guilds });
      }
      if (req.method === 'GET' && url.pathname === '/api/logs') {
        const after = Number(url.searchParams.get('after') || 0);
        return json(res, 200, { logs: logBuffer.read(after), latestId: logBuffer.latestId() });
      }
      if (req.method === 'GET' && url.pathname === '/api/settings') {
        const guild = getGuild(client, url.searchParams.get('guildId'));
        const channels = [...guild.channels.cache.values()]
          .filter(c => c.isTextBased?.() && !c.isThread?.() && typeof c.send === 'function')
          .map(c => ({ id: c.id, name: c.name }));
        const roles = [...guild.roles.cache.values()]
          .filter(r => !r.managed && r.id !== guild.id)
          .map(r => ({ id: r.id, name: r.name }));
        return json(res, 200, { settings: publicSettings(getGuildSettings(guild.id)), channels, roles });
      }
      if (req.method === 'PUT' && url.pathname === '/api/settings') {
        const input = await readBody(req);
        const guild = getGuild(client, input.guildId);
        const value = validateSettings(input.settings);
        if (value.enabled && (!value.channelId || !value.roleId)) throw new Error('Pilih channel dan role sebelum mengaktifkan Boss Tracker.');
        if (value.autoThreadRep.enabled && !value.autoThreadRep.channelId) throw new Error('Pilih channel Auto Thread Rep sebelum mengaktifkan fitur tersebut.');
        for (const [id, label] of [[value.channelId, 'Channel notifikasi'], [value.autoThreadRep.channelId, 'Channel Auto Thread Rep']]) {
          if (!id) continue;
          const channel = await guild.channels.fetch(id);
          if (!channel || channel.guildId !== guild.id || !channel.isTextBased() || channel.isThread?.()) {
            throw new Error(label + ' harus berupa channel teks dari server ini.');
          }
        }
        if (value.roleId) {
          const role = await guild.roles.fetch(value.roleId);
          if (!role || role.guild.id !== guild.id) throw new Error('Role tidak ditemukan di server ini.');
        }
        const saved = updateGuildSettings(guild.id, old => ({ ...old, ...value }));
        if (saved.enabled && saved.lastBossTimestamp) tracker.scheduleGuild(guild.id, saved.lastBossTimestamp);
        else if (!saved.enabled) tracker.stopGuild(guild.id);
        console.log('[Dashboard] Pengaturan diperbarui untuk guild', guild.id);
        return json(res, 200, { ok: true, settings: publicSettings(saved) });
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/assets/'))) {
        const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice('/assets/'.length);
        const file = path.resolve(PUBLIC_DIR, relative);
        if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== path.join(PUBLIC_DIR, 'index.html')) return json(res, 403, { error: 'Forbidden' });
        const ext = path.extname(file);
        const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
        if (!fs.existsSync(file)) return json(res, 404, { error: 'Not found' });
        res.writeHead(200, {
          'Content-Type': types[ext] || 'application/octet-stream',
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-cache',
          'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'"
        });
        return res.end(fs.readFileSync(file));
      }
      return json(res, 404, { error: 'Not found' });
    } catch (error) {
      console.error('[Dashboard]', error.message);
      return json(res, error.status || 400, { error: error.message || 'Terjadi kesalahan.' });
    }
  });
  server.listen(port, host, () => console.log('[Dashboard] Listening on http://' + host + ':' + port + ' (token protected)'));
  return server;
}
module.exports = { startDashboard };
