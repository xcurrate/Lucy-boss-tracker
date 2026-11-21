// Mesin interpolasi variabel untuk Custom Reminder.
//
// Prinsip:
//  - Satu registry terpusat (`VARIABLES`) berisi nama, deskripsi, dan resolver.
//  - Penggantian hanya SATU lintas: nilai hasil tidak dipindai ulang, jadi tidak
//    ada ekspansi rekursif (mis. nilai yang mengandung `{TIME}` tetap literal).
//  - Nilai acak dibuat sekali per render (`createRenderContext`), sehingga satu
//    pesan yang memakai {EMOJI} dua kali menampilkan emoji yang sama.
//  - Setiap nilai dipotong panjangnya dan total keluaran dibatasi, agar variabel
//    tidak bisa dipakai untuk membengkakkan pesan.
//  - Bila sistem sumber tidak tersedia (goal, avatar, cat/dog), dipakai fallback
//    yang jelas — bukan nilai karangan.
const { getGuildSettings } = require('./storage');
const { dayKey, targetSchedule, challengeCycleKey } = require('../services/lucyCounter');

const WIB = 'Asia/Jakarta';
const FALLBACK = '(tidak tersedia)';
const MAX_VALUE_LENGTH = 1024;
const MAX_OUTPUT_LENGTH = 6000; // batas konten pesan Discord

// Emoji acak untuk {EMOJI}. Sengaja daftar kecil dan aman (tanpa mention/format).
const EMOJIS = ['🎉', '🔥', '✨', '🌟', '🎯', '🍀', '💫', '🎁', '🏆', '⚡', '🌈', '💎', '🚀', '🍭', '🧿', '🪄'];
// Bendera acak untuk {FLAG}.
const FLAGS = ['🇮🇩', '🇯🇵', '🇰🇷', '🇸🇬', '🇲🇾', '🇺🇸', '🇬🇧', '🇩🇪', '🇫🇷', '🇧🇷', '🇦🇺', '🇨🇦', '🇮🇳', '🇹🇭', '🇻🇳', '🇵🇭'];

// 00:00 WIB untuk hari ini + offset hari, dalam detik Unix (WIB = UTC+7 tetap,
// tanpa DST). Dipakai {DAILY}/{DAILY_TOMORROW}/{DAILY_YESTERDAY} supaya cocok
// dengan reset harian yang sudah dipakai sistem target Lucy.
function wibDayStartUnix(dayOffset = 0, now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: WIB, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(now));
  const get = type => Number(parts.find(p => p.type === type).value);
  const utcMidnightWib = Date.UTC(get('year'), get('month') - 1, get('day'), -7, 0, 0);
  return Math.floor((utcMidnightWib + dayOffset * 86400000) / 1000);
}

// Format WIB siap-teks. Dipakai variabel *_FULL/_DATE/_TIME/_IN yang aman
// ditampilkan di dalam embed.
function wibClock(unixSeconds) {
  return new Intl.DateTimeFormat('id-ID', { timeZone: WIB, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(unixSeconds * 1000));
}
function wibDate(unixSeconds) {
  return new Intl.DateTimeFormat('id-ID', { timeZone: WIB, day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(unixSeconds * 1000));
}
function wibFull(unixSeconds) {
  return new Intl.DateTimeFormat('id-ID', { timeZone: WIB, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(unixSeconds * 1000)) + ' pukul ' + wibClock(unixSeconds) + ' WIB';
}
function relativeWib(unixSeconds, now) {
  const deltaMinutes = Math.round((unixSeconds - Math.floor(now / 1000)) / 60);
  const rtf = new Intl.RelativeTimeFormat('id', { numeric: 'auto' });
  if (Math.abs(deltaMinutes) < 60) return rtf.format(deltaMinutes, 'minute');
  return rtf.format(Math.round(deltaMinutes / 60), 'hour');
}

function pick(list, random) {
  return list[Math.floor(random() * list.length) % list.length];
}

function safeAvatarUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  // Hanya https ke host Discord CDN yang diterima; mencegah URL aneh masuk embed.
  if (!/^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\//i.test(value)) return null;
  return value;
}

function safeIconUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  if (!/^https:\/\/cdn\.discordapp\.com\//i.test(value)) return null;
  return value;
}

// Kumpulkan nilai goal dari sistem target Lucy yang sudah ada. Bila target tidak
// aktif atau goal belum diatur, kembalikan null supaya fallback dipakai.
function goalContext(guildId, userId, now = Date.now()) {
  if (!guildId) return { available: false };
  const config = getGuildSettings(guildId).lucyCounter || {};
  const goal = Number(config.targetGoal) || 0;
  if (!config.targetEnabled || goal <= 0) return { available: false };
  let progress = 0;
  try {
    const store = require('./lucyCounterStorage');
    const users = store.getGuildData(guildId).users || {};
    const user = users[userId];
    if (user && user.challengeDayKey === challengeCycleKey(new Date(now), config)) {
      progress = Number(user.challengeCount) || 0;
    }
  } catch { progress = 0; }
  const schedule = targetSchedule(config);
  return {
    available: true,
    goal,
    progress,
    remaining: Math.max(0, goal - progress),
    schedule: schedule ? { startMinutes: schedule.startMinutes, stopMinutes: schedule.stopMinutes } : null
  };
}

// Registry variabel. Setiap entri: deskripsi + resolver(ctx) -> string.
// Resolver tidak boleh melempar; kesalahan ditangani pemanggil sebagai fallback.
const VARIABLES = {
  // --- USER ---
  // {USER} sengaja TIDAK memakai mention: tag bisa mengaktifkan notifikasi dan
  // masuk ke log audit. Pakai {USER_MENTION} bila memang ingin menandai.
  USER: { description: 'Username pengguna (tanpa mention)', resolve: c => c.user?.name || c.user?.displayName || FALLBACK },
  USER_ID: { description: 'ID pengguna', resolve: c => c.user?.id || FALLBACK },
  USER_MENTION: { description: 'Mention pengguna (memicu notifikasi)', resolve: c => c.user?.mention || FALLBACK },
  USER_NAME: { description: 'Username pengguna', resolve: c => c.user?.name || FALLBACK },
  USER_DISPLAYNAME: { description: 'Nama tampilan pengguna', resolve: c => c.user?.displayName || c.user?.name || FALLBACK },
  USER_NICKNAME: { description: 'Nickname pengguna di server ini', resolve: c => c.user?.nickname || c.user?.displayName || c.user?.name || FALLBACK },
  USER_AVATAR: { description: 'URL avatar pengguna', resolve: c => safeAvatarUrl(c.user?.avatarUrl) || FALLBACK },
  USER_SERVERAVATAR: { description: 'URL avatar khusus server', resolve: c => safeAvatarUrl(c.user?.serverAvatarUrl) || safeAvatarUrl(c.user?.avatarUrl) || FALLBACK },
  EMOJI: { description: 'Emoji acak', resolve: c => c.random.emoji },

  // --- GOAL (dari sistem Target Lucy) ---
  GOAL: { description: 'Target Lucy yang diformat', resolve: c => c.goal.available ? c.goal.goal.toLocaleString('id-ID') : FALLBACK },
  GOAL_PROGRESS: { description: 'Progres target pengguna', resolve: c => c.goal.available ? String(c.goal.progress) : FALLBACK },
  GOAL_PROGRESS_INVERTED: { description: 'Sisa menuju target (kebalikan progres)', resolve: c => c.goal.available ? String(c.goal.remaining) : FALLBACK },
  GOAL_END: { description: 'Nilai akhir target', resolve: c => c.goal.available ? String(c.goal.goal) : FALLBACK },

  // --- RANDOM ---
  FLAG: { description: 'Bendera acak', resolve: c => c.random.flag },
  CAT: { description: 'Gambar kucing acak dari daftar yang dikonfigurasi', resolve: c => c.random.cat },
  DOG: { description: 'Gambar anjing acak dari daftar yang dikonfigurasi', resolve: c => c.random.dog },

  // --- TIME ---
  // Bentuk `<t:...>` (DAILY/TIME) hanya dirender Discord di CONTENT pesan, TIDAK
  // di dalam embed — di embed angkanya tampil apa adanya. Karena itu bentuk
  // siap-teks WIB disediakan dan itulah yang aman dipakai di embed.
  DAILY: { description: 'Timestamp Discord 00:00 WIB hari ini (khusus content, tidak render di embed)', resolve: c => String(c.time.daily) },
  DAILY_TOMORROW: { description: 'Timestamp Discord 00:00 WIB besok (khusus content, tidak render di embed)', resolve: c => String(c.time.tomorrow) },
  DAILY_YESTERDAY: { description: 'Timestamp Discord 00:00 WIB kemarin (khusus content, tidak render di embed)', resolve: c => String(c.time.yesterday) },
  TIME: { description: 'Timestamp Discord sekarang (khusus content, tidak render di embed)', resolve: c => String(c.time.now) },
  DAILY_TIME: { description: 'Jam 00:00 WIB hari ini sebagai teks (aman di embed)', resolve: c => c.time.dailyClock },
  DAILY_DATE: { description: 'Tanggal reset WIB hari ini sebagai teks (aman di embed)', resolve: c => c.time.dailyDate },
  DAILY_FULL: { description: 'Tanggal + jam reset WIB hari ini sebagai teks (aman di embed)', resolve: c => c.time.dailyFull },
  DAILY_IN: { description: 'Hitung mundur ke reset WIB hari ini (aman di embed)', resolve: c => c.time.dailyRelative },
  TOMORROW_FULL: { description: 'Tanggal + jam reset WIB besok sebagai teks (aman di embed)', resolve: c => c.time.tomorrowFull },

  // --- SERVER ---
  SERVER_NAME: { description: 'Nama server', resolve: c => c.guild?.name || FALLBACK },
  SERVER_ICON: { description: 'URL ikon server', resolve: c => safeIconUrl(c.guild?.iconUrl) || FALLBACK }
};

const VARIABLE_NAMES = Object.keys(VARIABLES);
const VARIABLE_RE = /\{([A-Z][A-Z0-9_]*)\}/g;

function clampValue(value) {
  const text = String(value ?? '');
  return text.length > MAX_VALUE_LENGTH ? text.slice(0, MAX_VALUE_LENGTH) + '…' : text;
}

// Nilai acak dikunci sekali per render supaya konsisten dalam satu pesan.
function createRenderContext({ user = {}, guild = null, guildId = null, now = Date.now(), settings = null, random = Math.random } = {}) {
  const cats = Array.isArray(settings?.reminders?.randomImages?.cats) ? settings.reminders.randomImages.cats : [];
  const dogs = Array.isArray(settings?.reminders?.randomImages?.dogs) ? settings.reminders.randomImages.dogs : [];
  const safeList = list => list.filter(u => typeof u === 'string' && /^https:\/\//i.test(u));
  const catList = safeList(cats);
  const dogList = safeList(dogs);
  return {
    user,
    guild,
    goal: goalContext(guildId, user.id, now),
    random: {
      emoji: pick(EMOJIS, random),
      flag: pick(FLAGS, random),
      cat: catList.length ? pick(catList, random) : '(gambar kucing belum dikonfigurasi)',
      dog: dogList.length ? pick(dogList, random) : '(gambar anjing belum dikonfigurasi)'
    },
    time: (() => {
      const daily = wibDayStartUnix(0, now);
      const tomorrow = wibDayStartUnix(1, now);
      return {
        now: Math.floor(now / 1000),
        daily,
        tomorrow,
        yesterday: wibDayStartUnix(-1, now),
        dailyClock: wibClock(daily),
        dailyDate: wibDate(daily),
        dailyFull: wibFull(daily),
        dailyRelative: relativeWib(daily, now),
        tomorrowFull: wibFull(tomorrow)
      };
    })()
  };
}

// Variabel yang menghasilkan mention pengguna. Dipakai pemanggil untuk memutuskan
// apakah mention perlu diizinkan di payload Discord.
const MENTION_VARIABLES = ['USER_MENTION'];

// ID pengguna yang di-mention lewat variabel pada teks ini. Teks sudah dirender,
// jadi cukup mencocokkan pola mention Discord.
function mentions(text) {
  const found = new Set();
  for (const match of String(text ?? '').matchAll(/<@!?(\d{17,20})>/g)) found.add(match[1]);
  return [...found];
}

// Nama variabel (tanpa kurung) yang dipakai di teks, terlepas dari dikenal atau
// tidak. Dipakai untuk memberi peringatan variabel tak dikenal.
function variablesUsed(text) {
  const found = new Set();
  for (const match of String(text ?? '').matchAll(VARIABLE_RE)) found.add(match[1]);
  return [...found];
}

// Nama variabel yang dipakai di teks tapi tidak ada di registry.
function unknownVariables(text) {
  const found = new Set();
  for (const match of String(text ?? '').matchAll(VARIABLE_RE)) {
    if (!VARIABLES[match[1]]) found.add(match[1]);
  }
  return [...found];
}

// Ganti semua variabel yang dikenal. Variabel tak dikenal dibiarkan apa adanya
// (tidak dihapus) supaya pengguna bisa melihat salah ketiknya.
function render(text, context) {
  const source = String(text ?? '');
  const ctx = context || createRenderContext({});
  const out = source.replace(VARIABLE_RE, (match, name) => {
    const variable = VARIABLES[name];
    if (!variable) return match;
    try {
      return clampValue(variable.resolve(ctx));
    } catch {
      return FALLBACK;
    }
  });
  return out.length > MAX_OUTPUT_LENGTH ? out.slice(0, MAX_OUTPUT_LENGTH) : out;
}

// Terapkan interpolasi ke konten dan field embed yang diizinkan. Embed tidak
// diubah strukturnya; hanya nilai string pada field teks yang diinterpolasi.
function renderEmbed(embed, context) {
  if (!embed || typeof embed !== 'object') return embed;
  const out = { ...embed };
  // `url` sengaja tidak diinterpolasi: variabel bisa menyisipkan teks ke URL.
  for (const key of ['title', 'description']) {
    if (typeof out[key] === 'string') out[key] = render(out[key], context);
  }
  if (out.footer && typeof out.footer === 'object' && typeof out.footer.text === 'string') {
    out.footer = { ...out.footer, text: render(out.footer.text, context) };
  }
  if (out.author && typeof out.author === 'object' && typeof out.author.name === 'string') {
    out.author = { ...out.author, name: render(out.author.name, context) };
  }
  if (Array.isArray(out.fields)) {
    out.fields = out.fields.map(field => (field && typeof field === 'object' ? {
      ...field,
      name: typeof field.name === 'string' ? render(field.name, context) : field.name,
      value: typeof field.value === 'string' ? render(field.value, context) : field.value
    } : field));
  }
  return out;
}

// Referensi variabel untuk dokumentasi (`d r help`).
function variableReference() {
  return VARIABLE_NAMES.map(name => ({ name: '{' + name + '}', description: VARIABLES[name].description }));
}

module.exports = {
  VARIABLES, VARIABLE_NAMES, VARIABLE_RE, MENTION_VARIABLES, FALLBACK, MAX_OUTPUT_LENGTH, MAX_VALUE_LENGTH,
  createRenderContext, render, renderEmbed, mentions, variablesUsed, unknownVariables, variableReference,
  wibDayStartUnix, goalContext, dayKey
};
