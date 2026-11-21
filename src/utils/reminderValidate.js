// Validasi payload untuk Custom Reminder: embed JSON, tipe collectible, dan URL.
//
// Semua validator mengembalikan bentuk seragam { ok, errors, value } supaya
// pemanggil bisa menampilkan pesan kesalahan yang bisa ditindaklanjuti. Tidak ada
// eksekusi kode, tidak ada skema URL berbahaya (javascript:, data:, file:), dan
// batas Discord ditegakkan SEBELUM data disimpan atau dikirim.
const MAX_EMBED_FIELDS = 25;
const LIMITS = {
  title: 256,
  description: 4096,
  fieldName: 256,
  fieldValue: 1024,
  footerText: 2048,
  authorName: 256,
  url: 2048,
  totalEmbed: 6000,
  color: 0xFFFFFF
};
const EMBED_KEYS = ['title', 'description', 'url', 'color', 'timestamp', 'footer', 'image', 'thumbnail', 'author', 'fields'];

// Hanya http/https. https sangat disarankan; http ditolak agar embed tidak
// memuat konten tak terenkripsi.
function isSafeUrl(value) {
  if (typeof value !== 'string' || !value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:';
  } catch { return false; }
}

function fail(errors) { return { ok: false, errors, value: null }; }
function pass(value) { return { ok: true, errors: [], value }; }

function validateColor(value) {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value > LIMITS.color) return null;
    return value;
  }
  if (typeof value === 'string') {
    const hex = value.startsWith('#') ? value.slice(1) : value;
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
    return parseInt(hex, 16);
  }
  return null;
}

// Validasi embed tunggal. Mengembalikan embed yang sudah dinormalisasi
// (warna jadi integer, hanya key yang diizinkan yang diteruskan).
// Kunci yang muncul pada payload webhook/discohook. Kalau SEMUA kunci input
// adalah kunci ini, input dianggap payload webhook dan embed-nya diambil.
const WEBHOOK_KEYS = [
  'content', 'embeds', 'attachments', 'username', 'avatar_url', 'tts',
  'allowed_mentions', 'components', 'flags', 'thread_name', 'poll', 'sticker_items'
];

// Terima hasil salin-tempel dari discohook.org (atau payload webhook Discord)
// lalu ambil embed-nya. Hanya satu embed yang didukung.
function unwrapWebhookPayload(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const keys = Object.keys(input);
  if (!keys.length) return input;
  if (!keys.every(k => WEBHOOK_KEYS.includes(k))) return input;

  if (Array.isArray(input.embeds)) {
    if (input.embeds.length > 1) {
      return { __error: 'Payload berisi ' + input.embeds.length + ' embed; hanya satu embed yang didukung. Sisakan satu.' };
    }
    if (input.embeds.length === 1) {
      if (!input.embeds[0] || typeof input.embeds[0] !== 'object' || Array.isArray(input.embeds[0])) {
        return { __error: 'embeds[0] harus berupa objek embed.' };
      }
      return input.embeds[0];
    }
  }
  // Payload tanpa embed tapi ada content -> pakai content sebagai description.
  if (typeof input.content === 'string' && input.content.trim()) return { description: input.content };
  return { __error: 'Payload tidak berisi embed. Sertakan objek embed, mis. {"title":"...","description":"..."}.' };
}

// Resolusi URL media pada field embed. Halaman penyedia (mis.
// https://klipy.com/gifs/...) BUKAN URL media langsung, jadi diambil dulu URL
// medianya. URL non-penyedia dibiarkan agar validator yang memutuskan.
async function resolveEmbedMedia(embed, options = {}) {
  if (!embed || typeof embed !== 'object') return embed;
  const out = { ...embed };
  for (const key of ['image', 'thumbnail']) {
    const url = out[key]?.url;
    if (typeof url !== 'string') continue;
    let host = '';
    try { host = new URL(url.trim()).hostname.toLowerCase(); } catch { continue; }
    const isProvider = TENOR_HOSTS.includes(host) || KLIPY_HOSTS.includes(host);
    if (!isProvider) continue;
    const result = await resolveAnyMedia(url, options);
    if (result.ok) out[key] = { url: result.value };
  }
  return out;
}

function validateEmbed(input) {
  if (input == null) return fail(['Embed kosong.']);
  input = unwrapWebhookPayload(input);
  if (input && typeof input === 'object' && !Array.isArray(input) && input.__error) return fail([input.__error]);
  if (typeof input !== 'object' || Array.isArray(input)) return fail(['Embed harus berupa objek JSON.']);
  const errors = [];
  const out = {};
  const unknown = Object.keys(input).filter(k => !EMBED_KEYS.includes(k));
  if (unknown.length) errors.push('Field tidak dikenal: ' + unknown.join(', ') + '. Field yang didukung: ' + EMBED_KEYS.join(', ') + '.');

  for (const key of ['title', 'description']) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'string') { errors.push(key + ' harus berupa teks.'); continue; }
    if (input[key].length > LIMITS[key]) errors.push(key + ' melebihi ' + LIMITS[key] + ' karakter (sekarang ' + input[key].length + ').');
    else out[key] = input[key];
  }

  if (input.url !== undefined) {
    if (!isSafeUrl(input.url)) errors.push('url harus URL https yang valid.');
    else if (input.url.length > LIMITS.url) errors.push('url terlalu panjang.');
    else out.url = input.url;
  }

  if (input.color !== undefined) {
    const color = validateColor(input.color);
    if (color === null) errors.push('color harus integer 0–16777215 atau hex #RRGGBB.');
    else out.color = color;
  }

  if (input.timestamp !== undefined) {
    const ts = new Date(input.timestamp);
    if (Number.isNaN(ts.getTime())) errors.push('timestamp harus tanggal ISO 8601 yang valid.');
    else out.timestamp = ts.toISOString();
  }

  if (input.footer !== undefined) {
    if (!input.footer || typeof input.footer !== 'object') errors.push('footer harus objek { text, icon_url? }.');
    else {
      const footer = {};
      if (typeof input.footer.text !== 'string') errors.push('footer.text wajib berupa teks.');
      else if (input.footer.text.length > LIMITS.footerText) errors.push('footer.text melebihi ' + LIMITS.footerText + ' karakter.');
      else footer.text = input.footer.text;
      if (input.footer.icon_url !== undefined) {
        if (!isSafeUrl(input.footer.icon_url)) errors.push('footer.icon_url harus URL https.');
        else footer.icon_url = input.footer.icon_url;
      }
      if (Object.keys(footer).length) out.footer = footer;
    }
  }

  if (input.author !== undefined) {
    if (!input.author || typeof input.author !== 'object') errors.push('author harus objek { name, url?, icon_url? }.');
    else {
      const author = {};
      if (typeof input.author.name !== 'string') errors.push('author.name wajib berupa teks.');
      else if (input.author.name.length > LIMITS.authorName) errors.push('author.name melebihi ' + LIMITS.authorName + ' karakter.');
      else author.name = input.author.name;
      for (const key of ['url', 'icon_url']) {
        if (input.author[key] === undefined) continue;
        if (!isSafeUrl(input.author[key])) errors.push('author.' + key + ' harus URL https.');
        else author[key] = input.author[key];
      }
      if (Object.keys(author).length) out.author = author;
    }
  }

  for (const key of ['image', 'thumbnail']) {
    if (input[key] === undefined) continue;
    if (!input[key] || typeof input[key] !== 'object' || !isSafeUrl(input[key].url)) {
      errors.push(key + '.url harus URL https yang valid.');
    } else out[key] = { url: input[key].url };
  }

  if (input.fields !== undefined) {
    if (!Array.isArray(input.fields)) errors.push('fields harus berupa array.');
    else if (input.fields.length > MAX_EMBED_FIELDS) errors.push('fields maksimal ' + MAX_EMBED_FIELDS + ' (sekarang ' + input.fields.length + ').');
    else {
      const fields = [];
      input.fields.forEach((field, i) => {
        if (!field || typeof field !== 'object') { errors.push('fields[' + i + '] harus objek { name, value, inline? }.'); return; }
        if (typeof field.name !== 'string' || !field.name) { errors.push('fields[' + i + '].name wajib teks.'); return; }
        if (typeof field.value !== 'string' || !field.value) { errors.push('fields[' + i + '].value wajib teks.'); return; }
        if (field.name.length > LIMITS.fieldName) { errors.push('fields[' + i + '].name melebihi ' + LIMITS.fieldName + ' karakter.'); return; }
        if (field.value.length > LIMITS.fieldValue) { errors.push('fields[' + i + '].value melebihi ' + LIMITS.fieldValue + ' karakter.'); return; }
        fields.push({ name: field.name, value: field.value, inline: Boolean(field.inline) });
      });
      if (fields.length) out.fields = fields;
    }
  }

  // Batas total karakter embed (mengikuti batas Discord 6000).
  const total = (out.title?.length || 0) + (out.description?.length || 0)
    + (out.footer?.text?.length || 0) + (out.author?.name?.length || 0)
    + (out.fields || []).reduce((n, f) => n + f.name.length + f.value.length, 0);
  if (total > LIMITS.totalEmbed) errors.push('Total karakter embed melebihi ' + LIMITS.totalEmbed + ' (sekarang ' + total + ').');

  if (errors.length) return fail(errors);
  if (!Object.keys(out).length) return fail(['Embed tidak berisi field apa pun.']);
  return pass(out);
}

// Parse JSON lalu validasi. Kesalahan sintaks dilaporkan terpisah agar pengguna
// tahu apakah masalahnya di JSON atau di isi embed.
function parseAndValidateEmbed(jsonText) {
  if (typeof jsonText !== 'string' || !jsonText.trim()) return fail(['Embed JSON kosong. Contoh: `{"title":"Halo","description":"{USER}"}`']);
  let parsed;
  try { parsed = JSON.parse(jsonText); }
  catch (error) { return fail(['JSON tidak valid: ' + error.message + '. Periksa tanda kutip dan koma.']); }
  return validateEmbed(parsed);
}

// ------------------------------------------------------------- collectible --
// Registry tipe collectible. Bawaan bersifat umum; server bisa menambah daftar
// sendiri lewat `reminders.collectibles` di pengaturan server. Tidak ada tier
// yang di-hardcode sebagai satu-satunya pilihan.
const DEFAULT_COLLECTIBLES = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];

function collectibleRegistry(settings) {
  const custom = Array.isArray(settings?.reminders?.collectibles) ? settings.reminders.collectibles : [];
  const list = [...DEFAULT_COLLECTIBLES, ...custom]
    .map(v => String(v || '').trim().toLowerCase())
    .filter(v => /^[a-z0-9_-]{1,32}$/.test(v));
  return [...new Set(list)];
}

function validateCollectible(value, settings) {
  const registry = collectibleRegistry(settings);
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return fail(['Tipe collectible kosong.']);
  if (!registry.includes(normalized)) {
    return fail(['Tipe collectible "' + value + '" tidak dikenal. Pilihan: ' + registry.join(', ') + '.']);
  }
  return pass(normalized);
}

// -------------------------------------------------------------------- URL ---
const TENOR_HOSTS = ['tenor.com', 'www.tenor.com', 'media.tenor.com'];
const TENOR_MEDIA_RE = /^https:\/\/media\.tenor\.com\/[A-Za-z0-9._\-/]+\.(gif|mp4|webm)$/i;
// Klipy: penyedia GIF kedua. Bentuk URL-nya menyerupai Tenor (halaman /gif/ dan
// host media terpisah), jadi alurnya sama: media langsung dipakai, halaman
// diambil HTML-nya untuk mencari URL media.
const KLIPY_HOSTS = ['klipy.com', 'www.klipy.com', 'cdn.klipy.com', 'media.klipy.com'];
const KLIPY_MEDIA_RE = /^https:\/\/(?:cdn|media)\.klipy\.com\/[A-Za-z0-9._\-/]+\.(gif|mp4|webm)$/i;
const KLIPY_MEDIA_PATTERN = /https:\/\/(?:cdn|media)\.klipy\.com\/[A-Za-z0-9._\-/]+\.(?:gif|mp4|webm)/i;

// Validasi URL umum (untuk embed/sumber): harus https.
function validateUrl(value) {
  if (!isSafeUrl(value)) return fail(['URL harus https yang valid (skema javascript:, data:, dan file: ditolak).']);
  return pass(value);
}

// Resolusi media generik untuk Tenor dan Klipy. Menerima URL media langsung,
// atau halaman penyedia yang diambil HTML-nya untuk mencari URL media. `fetchFn`
// bisa disuntik agar bisa diuji tanpa jaringan. Hanya skema https yang diterima.
async function resolveMedia(rawUrl, { fetchFn = globalThis.fetch, timeoutMs = 5000, provider = 'tenor' } = {}) {
  const spec = provider === 'klipy'
    ? { hosts: KLIPY_HOSTS, mediaHosts: ['cdn.klipy.com', 'media.klipy.com'], mediaRe: KLIPY_MEDIA_RE, mediaPattern: KLIPY_MEDIA_PATTERN, name: 'Klipy', example: '`https://klipy.com/gif/...` atau `https://cdn.klipy.com/....gif`' }
    : { hosts: TENOR_HOSTS, mediaHosts: ['media.tenor.com'], mediaRe: TENOR_MEDIA_RE, mediaPattern: /https:\/\/media\.tenor\.com\/[A-Za-z0-9._\-/]+\.(?:gif|mp4|webm)/i, name: 'Tenor', example: '`https://tenor.com/view/...` atau `https://media.tenor.com/....gif`' };

  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return fail(['URL ' + spec.name + ' kosong.']);
  let url;
  try { url = new URL(rawUrl.trim()); }
  catch { return fail(['URL tidak valid.']); }
  if (url.protocol !== 'https:') return fail(['Hanya URL https yang diterima.']);
  if (!spec.hosts.includes(url.hostname.toLowerCase())) {
    return fail(['Bukan URL ' + spec.name + '. Contoh: ' + spec.example]);
  }
  if (spec.mediaHosts.includes(url.hostname.toLowerCase())) {
    if (spec.mediaRe.test(url.href)) return pass(url.href);
    return fail(['URL media ' + spec.name + ' harus berakhiran .gif, .mp4, atau .webm.']);
  }
  if (typeof fetchFn !== 'function') return fail(['Pengambilan ' + spec.name + ' tidak tersedia di lingkungan ini. Pakai URL media langsung.']);
  let html = '';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetchFn(url.href, { signal: controller.signal, headers: { 'user-agent': 'Dragneel-Reminder/1.0' } });
    clearTimeout(timer);
    if (!response?.ok) return fail(['Gagal mengambil halaman ' + spec.name + ' (status ' + (response?.status ?? 'tidak diketahui') + ').']);
    html = String(await response.text());
  } catch (error) {
    return fail(['Gagal mengambil halaman ' + spec.name + ': ' + (error?.message || 'kesalahan jaringan') + '.']);
  }
  const match = html.match(spec.mediaPattern);
  if (!match) return fail(['Tidak menemukan GIF di halaman ' + spec.name + ' itu. Salin URL media langsung.']);
  return pass(match[0]);
}

async function resolveTenor(rawUrl, options = {}) {
  return resolveMedia(rawUrl, { ...options, provider: 'tenor' });
}

async function resolveKlipy(rawUrl, options = {}) {
  return resolveMedia(rawUrl, { ...options, provider: 'klipy' });
}

// Deteksi penyedia dari URL, lalu resolusi dengan resolver yang tepat. Dipakai
// perintah `<prefix> r media <URL>` supaya Tenor dan Klipy punya satu pintu.
async function resolveAnyMedia(rawUrl, options = {}) {
  let host = '';
  try { host = new URL(String(rawUrl || '').trim()).hostname.toLowerCase(); } catch { return fail(['URL tidak valid.']); }
  if (KLIPY_HOSTS.includes(host)) return resolveKlipy(rawUrl, options);
  return resolveTenor(rawUrl, options);
}



// Bersihkan konten dari mention massal. Mention pengguna tunggal dibiarkan,
// tapi @everyone/@here dinetralkan supaya reminder tidak bisa dipakai spam.
function sanitizeContent(text) {
  return String(text ?? '').replace(/@(everyone|here)/gi, '@\u200b$1');
}

module.exports = {
  LIMITS, MAX_EMBED_FIELDS, EMBED_KEYS, DEFAULT_COLLECTIBLES,
  TENOR_HOSTS, KLIPY_HOSTS,
  isSafeUrl, validateUrl, validateEmbed, parseAndValidateEmbed,
  collectibleRegistry, validateCollectible,
  resolveMedia, resolveTenor, resolveKlipy, resolveAnyMedia, resolveEmbedMedia,
  unwrapWebhookPayload, WEBHOOK_KEYS, sanitizeContent
};
