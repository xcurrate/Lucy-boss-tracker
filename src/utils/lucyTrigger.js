// Pemicu aksi Lucy: `<prefix> <aksi>` dengan prefix yang bisa diatur admin.
//
// Bentuk yang diterima (prefix default `lucy`, bentuk pendek `l` selalu ikut):
//   lucy battle, lbattle, lb, lucy fight, lfight, l fight, lucy war
//   lucy hunt, lucy catch, lh, lhunt, l hunt
//   lucy pray, lpray, lucy curse, lcurse
//
// Modul ini sengaja tanpa dependensi supaya bisa dipakai lucyReminder maupun
// lucyCounter tanpa membuat require melingkar.
const DEFAULT_LUCY_PREFIX = 'lucy';
// Bentuk pendek yang selalu dikenali, di samping prefix yang diatur admin.
const SHORT_LUCY_PREFIX = 'l';

// Kata kunci per jenis aksi. Alias satu huruf hanya berlaku pada bentuk
// bersambung (`lb`), bukan bentuk berspasi (`l b`), supaya chat biasa tidak
// ikut terpicu.
const ACTION_ALIASES = {
  pray: ['pray', 'doa', 'p'],
  curse: ['curse', 'kutuk', 'c'],
  battle: ['battle', 'fight', 'war', 'b'],
  hunt: ['hunt', 'catch', 'h']
};

const ALIAS_TO_KIND = (() => {
  const map = {};
  for (const [kind, aliases] of Object.entries(ACTION_ALIASES)) {
    for (const alias of aliases) if (!(alias in map)) map[alias] = kind;
  }
  return map;
})();

// Prefix valid: huruf/angka, tanpa spasi, maksimal 16 karakter.
function normalizePrefix(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return /^[a-z0-9]{1,16}$/.test(text) ? text : '';
}

// Prefix yang berlaku di sebuah server: yang diatur admin (bila valid), plus
// `lucy` (kanonik) dan `l` (bentuk pendek) supaya variasi pemakaian tetap jalan.
function lucyPrefixes(configured) {
  const list = [normalizePrefix(configured), DEFAULT_LUCY_PREFIX, SHORT_LUCY_PREFIX].filter(Boolean);
  return [...new Set(list)];
}

// Mengembalikan jenis aksi ('pray'|'curse'|'battle'|'hunt') atau null.
function matchAction(content, configuredPrefix) {
  const text = String(content ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!text) return null;
  for (const prefix of lucyPrefixes(configuredPrefix)) {
    for (const [alias, kind] of Object.entries(ALIAS_TO_KIND)) {
      if (text === prefix + alias) return kind;
      if (alias.length >= 2 && text === prefix + ' ' + alias) return kind;
    }
  }
  return null;
}

function isActionCommand(content, configuredPrefix) {
  return matchAction(content, configuredPrefix) !== null;
}

module.exports = {
  matchAction, isActionCommand, lucyPrefixes, normalizePrefix,
  ACTION_ALIASES, DEFAULT_LUCY_PREFIX, SHORT_LUCY_PREFIX
};
