const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getGuildSettings, updateGuildSettings } = require('../utils/storage');
const logBuffer = require('../utils/logBuffer');

const PUBLIC_DIR = path.join(__dirname, 'public');
const sessions = new Map();
const states = new Map();
const SESSION_TTL = 8 * 60 * 60 * 1000;
const STATE_TTL = 10 * 60 * 1000;

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}
function cookieOptions() {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${process.env.DASHBOARD_COOKIE_SECURE === 'false' ? '' : '; Secure'}`;
}
function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  const item = raw.split(';').map(v => v.trim()).find(v => v.startsWith(name + '='));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : null;
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
function cleanSession(req) {
  const id = readCookie(req, 'lucy_dashboard');
  const session = id && sessions.get(id);
  if (!session || session.expiresAt < Date.now()) {
    if (id) sessions.delete(id);
    return null;
  }
  return session;
}
async function discordFetch(url, options = {}) {
  const response = await fetch('https://discord.com/api/v10' + url, options);
  if (!response.ok) throw new Error('Discord API: ' + response.status);
  return response.json();
}
function manageableGuilds(session, client) {
  return session.guilds.filter(g => {
    const permissions = BigInt(g.permissions || '0');
    return (permissions & 0x8n) === 0x8n || (permissions & 0x20n) === 0x20n;
  }).filter(g => client.guilds.cache.has(g.id)).map(g => ({
    id: g.id,
    name: g.name,
    icon: g.icon,
    botPresent: true
  }));
}
function requireGuild(session, client, guildId) {
  const allowed = manageableGuilds(session, client).some(g => g.id === guildId);
  if (!allowed) throw Object.assign(new Error('Akses Manage Server diperlukan dan bot harus ada di server.'), { status: 403 });
  return client.guilds.cache.get(guildId);
}
function publicSettings(settings) {
  return {
    enabled: settings.enabled,
    channelId: settings.channelId || '',
    roleId: settings.roleId || '',
    prefix: settings.prefix || '!',
    lastBossTimestamp: settings.lastBossTimestamp,
    autoThreadRep: { ...settings.autoThreadRep }
  };
}
function validateSettings(input) {
  if (!input || typeof input !== 'object') throw new Error('Pengaturan tidak valid.');
  if (typeof input.enabled !== 'boolean') throw new Error('Status Boss Tracker tidak valid.');
  const channelId = input.channelId || null;
  const roleId = input.roleId || null;
  if (channelId && !/^\d{17,20}$/.test(channelId)) throw new Error('ID channel tidak valid.');
  if (roleId && !/^\d{17,20}$/.test(roleId)) throw new Error('ID role tidak valid.');
  if (typeof input.prefix !== 'string' || input.prefix.length < 1 || input.prefix.length > 5 || /\s/.test(input.prefix)) {
    throw new Error('Prefix harus 1–5 karakter tanpa spasi.');
  }
  const rep = input.autoThreadRep || {};
  if (typeof rep.enabled !== 'boolean') throw new Error('Status Auto Thread Rep tidak valid.');
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
      targetUserId: String(rep.targetUserId),
      amount: rep.amount,
      threadNamePrefix: rep.threadNamePrefix.trim(),
      autoArchiveDuration: Number(rep.autoArchiveDuration)
    }
  };
}
function startDashboard(client, tracker) {
  const port = Number(process.env.DASHBOARD_PORT || 3000);
  const clientId = process.env.CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  const redirectUri = process.env.DASHBOARD_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    console.warn('[Dashboard] Nonaktif: isi CLIENT_ID, DISCORD_CLIENT_SECRET, dan DASHBOARD_REDIRECT_URI.');
    return null;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    try {
      if (req.method === 'GET' && url.pathname === '/auth/login') {
        const state = crypto.randomBytes(24).toString('hex');
        states.set(state, Date.now() + STATE_TTL);
        res.setHeader('Set-Cookie', 'lucy_oauth_state=' + state + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=600' + (process.env.DASHBOARD_COOKIE_SECURE === 'false' ? '' : '; Secure'));
        const params = new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: 'identify guilds',
          state
        });
        return redirect(res, 'https://discord.com/oauth2/authorize?' + params);
      }
      if (req.method === 'GET' && url.pathname === '/auth/callback') {
        const state = url.searchParams.get('state');
        const expiresAt = states.get(state);
        const cookieState = readCookie(req, 'lucy_oauth_state');
        states.delete(state);
        const clearStateCookie = 'lucy_oauth_state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + (process.env.DASHBOARD_COOKIE_SECURE === 'false' ? '' : '; Secure');
        if (!state || state !== cookieState || !expiresAt || expiresAt < Date.now() || !url.searchParams.get('code')) {
          return redirect(res, '/?error=oauth_state');
        }
        const tokenResponse = await fetch('https://discord.com/api/v10/oauth2/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: 'authorization_code',
            code: url.searchParams.get('code'),
            redirect_uri: redirectUri
          })
        });
        if (!tokenResponse.ok) throw new Error('OAuth token exchange gagal: ' + tokenResponse.status);
        const token = await tokenResponse.json();
        const [user, guilds] = await Promise.all([
          discordFetch('/users/@me', { headers: { Authorization: 'Bearer ' + token.access_token } }),
          discordFetch('/users/@me/guilds', { headers: { Authorization: 'Bearer ' + token.access_token } })
        ]);
        const sessionId = crypto.randomBytes(32).toString('hex');
        sessions.set(sessionId, { user: { id: user.id, username: user.username, global_name: user.global_name, avatar: user.avatar }, guilds, expiresAt: Date.now() + SESSION_TTL });
        res.setHeader('Set-Cookie', [clearStateCookie, 'lucy_dashboard=' + sessionId + '; ' + cookieOptions()]);
        return redirect(res, '/');
      }
      if (req.method === 'POST' && url.pathname === '/auth/logout') {
        const id = readCookie(req, 'lucy_dashboard');
        if (id) sessions.delete(id);
        res.setHeader('Set-Cookie', 'lucy_dashboard=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + (process.env.DASHBOARD_COOKIE_SECURE === 'false' ? '' : '; Secure'));
        return json(res, 200, { ok: true });
      }

      const session = cleanSession(req);
      if (url.pathname.startsWith('/api/')) {
        if (!session) return json(res, 401, { error: 'Silakan login dengan Discord.' });
        if (req.method === 'GET' && url.pathname === '/api/me') {
          return json(res, 200, { user: session.user, guilds: manageableGuilds(session, client) });
        }
        if (req.method === 'GET' && url.pathname === '/api/logs') {
          const after = Number(url.searchParams.get('after') || 0);
          return json(res, 200, { logs: logBuffer.read(after), latestId: logBuffer.latestId() });
        }
        if (req.method === 'GET' && url.pathname === '/api/settings') {
          const guild = requireGuild(session, client, url.searchParams.get('guildId'));
          return json(res, 200, { settings: publicSettings(getGuildSettings(guild.id)), channels: [...guild.channels.cache.values()].filter(c => c.isTextBased?.() && !c.isThread?.()).map(c => ({ id: c.id, name: c.name })), roles: [...guild.roles.cache.values()].filter(r => !r.managed && r.id !== guild.id).map(r => ({ id: r.id, name: r.name })) });
        }
        if (req.method === 'PUT' && url.pathname === '/api/settings') {
          const input = await readBody(req);
          const guild = requireGuild(session, client, input.guildId);
          const value = validateSettings(input.settings);
          if (value.enabled && (!value.channelId || !value.roleId)) throw new Error('Pilih channel dan role sebelum mengaktifkan Boss Tracker.');
          if (value.channelId) {
            const channel = await guild.channels.fetch(value.channelId);
            if (!channel || channel.guildId !== guild.id || !channel.isTextBased()) throw new Error('Channel harus berupa channel teks dari server ini.');
          }
          if (value.roleId) {
            const role = await guild.roles.fetch(value.roleId);
            if (!role || role.guild.id !== guild.id) throw new Error('Role tidak ditemukan di server ini.');
          }
          const saved = updateGuildSettings(guild.id, old => ({ ...old, ...value }));
          if (saved.enabled && saved.lastBossTimestamp) tracker.scheduleGuild(guild.id, saved.lastBossTimestamp);
          else if (!saved.enabled) tracker.stopGuild(guild.id);
          console.log('[Dashboard] Pengaturan diperbarui oleh', session.user.username, 'untuk guild', guild.id);
          return json(res, 200, { ok: true, settings: publicSettings(saved) });
        }
        return json(res, 404, { error: 'Endpoint tidak ditemukan.' });
      }

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/assets/'))) {
        const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice('/assets/'.length);
        const file = path.resolve(PUBLIC_DIR, relative);
        if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== path.join(PUBLIC_DIR, 'index.html')) return json(res, 403, { error: 'Forbidden' });
        const ext = path.extname(file);
        const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
        if (!fs.existsSync(file)) return json(res, 404, { error: 'Not found' });
        res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
        return res.end(fs.readFileSync(file));
      }
      return json(res, 404, { error: 'Not found' });
    } catch (error) {
      console.error('[Dashboard]', error.message);
      return json(res, error.status || 400, { error: error.message || 'Terjadi kesalahan.' });
    }
  });

  server.listen(port, process.env.DASHBOARD_HOST || '127.0.0.1', () => {
    console.log('[Dashboard] Listening on ' + (process.env.DASHBOARD_HOST || '127.0.0.1') + ':' + port);
  });
  return server;
}
module.exports = { startDashboard };
