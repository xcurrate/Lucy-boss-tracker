// Pemicu aksi Lucy: mendeteksi pesan user yang memakai bot Lucy.
//
// PENTING: ini BUKAN prefix bot kita. Prefix bot kita (mis. `d`) hanya untuk
// perintah kita sendiri (`d lreminder`, `d llb`). Prefix di sini adalah prefix
// yang dipakai bot Lucy di sebuah server — bisa `lucy`, `l`, `g`, dan
// seterusnya — sehingga bot kita tahu pesan mana yang perlu dipantau.
//
// Karena itu daftar prefix dikelola admin per server. Default `lucy` dengan
// bentuk pendek `l`. Bila admin menggantinya (mis. `g`), maka hanya prefix itu
// yang dipantau; `lucy battle` di server tersebut kembali dianggap chat biasa.
//
// Bentuk yang dikenali untuk tiap prefix P:
//   P + alias      -> `lb`, `lh`, `lfight`, `lcurse`
//   P + ' ' + alias-> `l fight`, `l hunt`, `l battle` (hanya alias >= 2 huruf)
// Alias satu huruf (`b`, `h`) HANYA berlaku pada bentuk bersambung, supaya
// `l b` — yang bisa saja chat biasa — tidak memicu pengingat palsu.
//
// Modul ini sengaja tanpa dependensi supaya bisa dipakai lucyReminder maupun
// lucyCounter tanpa membuat require melingkar.
const DEFAULT_LUCY_PREFIXES = ['lucy', 'l'];

const ACTION_ALIASES = {
  pray: ['pray', 'doa'],
  curse: ['curse', 'kutuk'],
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

// Terima string ("lucy l"), array, atau kosong. Hanya mengembalikan yang valid.
function parsePrefixList(value) {
  if (value == null) return [];
  const raw = Array.isArray(value) ? value : String(value).split(/[\s,]+/);
  const out = [];
  for (const item of raw) {
    const prefix = normalizePrefix(item);
    if (prefix && !out.includes(prefix)) out.push(prefix);
  }
  return out;
}

// Prefix yang berlaku di sebuah server. Kosong -> default. Daftar yang diatur
// admin menggantikan default sepenuhnya (bukan ditambahkan), supaya server yang
// memakai `g` tidak ikut memantau `lucy battle` yang cuma chat biasa.
function lucyPrefixes(configured) {
  const list = parsePrefixList(configured);
  return list.length ? list : [...DEFAULT_LUCY_PREFIXES];
}

// Mengembalikan jenis aksi ('pray'|'curse'|'battle'|'hunt') atau null.
function matchAction(content, configuredPrefixes) {
  const text = String(content ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!text) return null;
  for (const prefix of lucyPrefixes(configuredPrefixes)) {
    for (const [alias, kind] of Object.entries(ALIAS_TO_KIND)) {
      if (text === prefix + alias) return kind;
      if (alias.length >= 2 && text === prefix + ' ' + alias) return kind;
    }
  }
  return null;
}

function isActionCommand(content, configuredPrefixes) {
  return matchAction(content, configuredPrefixes) !== null;
}

module.exports = {
  matchAction, isActionCommand, lucyPrefixes, parsePrefixList, normalizePrefix,
  ACTION_ALIASES, DEFAULT_LUCY_PREFIXES
};
