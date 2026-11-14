const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

let tempDir;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-tracker-lrem-'));
  process.chdir(tempDir);
  for (const key of Object.keys(require.cache)) {
    if (/lucyReminder|lucyActionStorage|lucyCounter|storage\.js/.test(key)) delete require.cache[key];
  }
});

let counter = 0;

function makeMessage(content, { guildId = 'guild1', channelId = 'chan1', userId = 'user1', name = 'Tester', admin = false } = {}) {
  const sent = [];
  const replies = [];
  const channel = {
    id: channelId,
    isTextBased: () => true,
    send: async payload => { sent.push(payload); return { id: 's' + (++counter) }; },
    messages: { fetch: async id => ({ id, delete: async () => {} }) }
  };
  return {
    id: 'm' + (++counter),
    guildId,
    guild: { id: guildId, ownerId: 'owner' },
    channelId,
    author: { id: userId, bot: false, username: name },
    member: { displayName: name, permissions: { has: () => admin } },
    content,
    client: { channels: { fetch: async () => channel } },
    react: async () => {},
    reply: async payload => { sent.push(payload); replies.push(payload); return { id: 'r' + (++counter) }; },
    channel,
    sent,
    replies
  };
}

describe('lucy action storage', () => {
  it('records actions and ranks per day and range', () => {
    const store = require('../src/utils/lucyActionStorage');
    store.recordAction({ guildId: 'g', userId: 'u1', name: 'Ani', day: '2026-11-05', action: 'pray' });
    store.recordAction({ guildId: 'g', userId: 'u1', name: 'Ani', day: '2026-11-05', action: 'pray' });
    store.recordAction({ guildId: 'g', userId: 'u2', name: 'Budi', day: '2026-11-04', action: 'hunt' });
    store.recordAction({ guildId: 'g', userId: 'u2', name: 'Budi', day: '2026-11-05', action: 'battle' });

    const pray = store.topByDay('g', '2026-11-05', ['pray']);
    assert.equal(pray.length, 1);
    assert.equal(pray[0].count, 2);

    // battle/hunt digabung jadi satu kategori.
    const battle = store.topByRange('g', '2026-11-04', '2026-11-05', ['battle', 'hunt']);
    assert.equal(battle[0].userId, 'u2');
    assert.equal(battle[0].count, 2);

    const allTime = store.topAllTime('g', ['pray']);
    assert.equal(allTime[0].count, 2);
  });

  it('ignores unknown actions', () => {
    const store = require('../src/utils/lucyActionStorage');
    store.recordAction({ guildId: 'g', userId: 'u1', day: '2026-11-05', action: 'hack' });
    assert.equal(store.topAllTime('g', ['pray', 'curse', 'battle', 'hunt']).length, 0);
  });

  it('stores per-user reminder preferences with defaults', () => {
    const store = require('../src/utils/lucyActionStorage');
    assert.deepEqual(store.getPref('u1', 'pray'), { enabled: true, pingMode: 'tag' });
    store.setPref('u1', 'pray', { enabled: false });
    assert.deepEqual(store.getPref('u1', 'pray'), { enabled: false, pingMode: 'tag' });
    store.setPref('u1', 'pray', { pingMode: 'none' });
    assert.deepEqual(store.getPref('u1', 'pray'), { enabled: false, pingMode: 'none' });
    assert.equal(store.getPref('u2', 'pray').enabled, true, 'orang lain tidak terpengaruh');
  });

  it('tracks cooldowns per user and action', () => {
    const store = require('../src/utils/lucyActionStorage');
    store.setCooldown('g', 'u1', 'pray', 12345);
    assert.equal(store.getCooldown('g', 'u1', 'pray'), 12345);
    assert.equal(store.getCooldown('g', 'u1', 'curse'), 0);
    assert.equal(store.getCooldown('g', 'u2', 'pray'), 0);
  });
});

describe('lucy reminder engine', () => {
  it('defines three reminder types, with battle and hunt sharing one', () => {
    const svc = require('../src/services/lucyReminder');
    assert.deepEqual(Object.keys(svc.KINDS), ['pray', 'curse', 'battle', 'lucy']);
    assert.equal(svc.KINDS.pray.waitMs, 5 * 60 * 1000);
    assert.equal(svc.KINDS.curse.waitMs, 5 * 60 * 1000);
    assert.equal(svc.KINDS.battle.waitMs, 15 * 1000);
    assert.equal(svc.KINDS.lucy.waitMs, 10 * 1000);
    assert.equal(svc.KINDS.hunt, undefined, 'hunt bukan jenis tersendiri');
    // Baik battle maupun hunt memakai jenis reminder yang sama.
    assert.equal(svc.TRIGGER_KIND_TO_REMINDER.hunt, 'battle');
    assert.equal(svc.TRIGGER_KIND_TO_REMINDER.battle, 'battle');
  });

  it('keeps reminders off by default', () => {
    const svc = require('../src/services/lucyReminder');
    assert.deepEqual(svc.DEFAULT_PREF, { enabled: false, pingMode: 'tag' });
  });

  it('does not send a reminder until the user turns it on', async () => {
    const svc = require('../src/services/lucyReminder');
    const sent = [];
    const client = { channels: { fetch: async () => ({ isTextBased: () => true, send: async p => { sent.push(p); } }) } };
    await svc.deliverReminder(client, { guildId: 'g', channelId: 'c', userId: 'u1', name: 'Ani', kind: 'battle', messageId: 'm' });
    assert.equal(sent.length, 0, 'default OFF -> tidak ada pengingat');
  });

  it('fills {count} from today\'s action counter', async () => {
    const svc = require('../src/services/lucyReminder');
    const store = require('../src/utils/lucyActionStorage');
    const day = svc.dayKey();
    store.recordAction({ guildId: 'g', userId: 'u1', name: 'Ani', day, action: 'battle' });
    store.recordAction({ guildId: 'g', userId: 'u1', name: 'Ani', day, action: 'hunt' });
    store.setPref('u1', 'battle', { enabled: true });
    const sent = [];
    const client = { channels: { fetch: async () => ({ isTextBased: () => true, send: async p => { sent.push(p); } }) } };
    await svc.deliverReminder(client, { guildId: 'g', channelId: 'c', userId: 'u1', name: 'Ani', kind: 'battle', messageId: 'm' });
    assert.equal(sent.length, 1);
    // Kategori battle mencakup hunt: 1 battle + 1 hunt = 2.
    assert.match(sent[0].content, /Ani/);
  });

  it('offers tag, reply, both and none ping modes', () => {
    const svc = require('../src/services/lucyReminder');
    assert.deepEqual(Object.keys(svc.PING_MODES).sort(), ['both', 'none', 'reply', 'tag']);
  });

  it('responds to each action with its own prefix command and schedules a reminder', async () => {
    const svc = require('../src/services/lucyReminder');
    for (const command of ['lucy pray', 'lcurse', 'lbattle', 'lhunt']) {
      const msg = makeMessage(command);
      assert.equal(await svc.handleMessage(msg), true, command);
      assert.equal(msg.replies.length, 1, command);
      assert.equal(msg.sent.length, 2, 'balasan aksi + catatan pengingat dikirim');
    }
    assert.equal(svc.scheduledCount('guild1'), 4);
    for (const t of svc.timers.values()) clearTimeout(t);
  });

  it('also accepts the `lucy pray` style trigger', async () => {
    const svc = require('../src/services/lucyReminder');
    const msg = makeMessage('lucy pray');
    assert.equal(await svc.handleMessage(msg), true);
    for (const t of svc.timers.values()) clearTimeout(t);
  });

  it('records the action in the counter', async () => {
    const svc = require('../src/services/lucyReminder');
    const store = require('../src/utils/lucyActionStorage');
    await svc.handleMessage(makeMessage('lucy pray'));
    const rows = store.topByDay('guild1', svc.dayKey(), ['pray']);
    assert.equal(rows[0].count, 1);
    for (const t of svc.timers.values()) clearTimeout(t);
  });

  it('does not treat a plain `lucy` message as an action command', async () => {
    const svc = require('../src/services/lucyReminder');
    assert.equal(await svc.handleMessage(makeMessage('lucy lucu banget')), false);
  });

  it('does not let `lucy pray` trigger two reminders at once', async () => {
    const counter = require('../src/services/lucyCounter');
    const svc = require('../src/services/lucyReminder');
    const { updateGuildSettings } = require('../src/utils/storage');
    // Aktifkan penghitung Lucy supaya pesan ini benar-benar diproses counter.
    updateGuildSettings('guild1', s => ({ ...s, lucyCounter: { ...s.lucyCounter, enabled: true } }));
    try {
      // Jalur 1: penghitung Lucy (biasanya memasang pengingat "lucy").
      await counter.handleMessage(makeMessage('lucy pray'), {
        onCounted: (m, name) => svc.onLucyCounted(m, name)
      });
      // Jalur 2: perintah aksi (memasang pengingat "pray").
      await svc.handleMessage(makeMessage('lucy pray'));
      const keys = [...svc.timers.keys()];
      assert.deepEqual(keys, ['guild1:user1:pray'], 'hanya pengingat aksi, bukan aksi + Lucy');
    } finally {
      for (const t of svc.timers.values()) clearTimeout(t);
      svc.timers.clear();
    }
  });

  it('sends a reminder with tag, reply, both or none according to preference', async () => {
    const svc = require('../src/services/lucyReminder');
    const store = require('../src/utils/lucyActionStorage');
    const sent = [];
    const client = { channels: { fetch: async () => ({ isTextBased: () => true, send: async p => { sent.push(p); } }) } };
    const base = { guildId: 'g', channelId: 'c', userId: 'u1', name: 'Ani', kind: 'pray', messageId: 'm1' };

    store.setPref('u1', 'pray', { pingMode: 'tag' });
    await svc.deliverReminder(client, { ...base });
    assert.match(sent[0].content, /^<@u1> /);
    assert.equal(sent[0].reply, undefined);

    store.setPref('u1', 'pray', { pingMode: 'reply' });
    await svc.deliverReminder(client, { ...base });
    assert.doesNotMatch(sent[1].content, /^<@u1>/);
    assert.equal(sent[1].reply.messageReference, 'm1');

    store.setPref('u1', 'pray', { pingMode: 'both' });
    await svc.deliverReminder(client, { ...base });
    assert.match(sent[2].content, /^<@u1> /);
    assert.ok(sent[2].reply);

    store.setPref('u1', 'pray', { pingMode: 'none' });
    await svc.deliverReminder(client, { ...base });
    assert.doesNotMatch(sent[3].content, /<@u1>/);
    assert.equal(sent[3].reply, undefined);
  });

  it('skips the reminder when the user turned it off', async () => {
    const svc = require('../src/services/lucyReminder');
    const store = require('../src/utils/lucyActionStorage');
    const sent = [];
    const client = { channels: { fetch: async () => ({ isTextBased: () => true, send: async p => { sent.push(p); } }) } };
    store.setPref('u1', 'pray', { enabled: false });
    await svc.deliverReminder(client, { guildId: 'g', channelId: 'c', userId: 'u1', name: 'Ani', kind: 'pray', messageId: 'm1' });
    assert.equal(sent.length, 0);
  });

  it('sends a real reminder through the timer using a short kind', async () => {
    const svc = require('../src/services/lucyReminder');
    const store = require('../src/utils/lucyActionStorage');
    store.setPref('u1', 'battle', { enabled: true });
    const sent = [];
    const client = { channels: { fetch: async () => ({ isTextBased: () => true, send: async p => { sent.push(p); } }) } };
    svc.scheduleReminder(client, { guildId: 'g', channelId: 'c', userId: 'u1', name: 'Ani', kind: 'battle', messageId: 'm1', waitMs: 20 });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(sent.length, 1, 'pengingat terkirim setelah durasi');
  });

  it('renders custom templates with placeholders', () => {
    const svc = require('../src/services/lucyReminder');
    const out = svc.renderTemplate('Halo {user} ({mention}) jenis {kind} tunggu {durasi}', {
      user: 'Ani', mention: '<@1>', kind: 'Pray', durasi: '5 menit'
    });
    assert.equal(out, 'Halo Ani (<@1>) jenis Pray tunggu 5 menit');
  });

  it('uses the default reply when the guild has no custom reply', () => {
    const svc = require('../src/services/lucyReminder');
    assert.match(svc.replyTemplate('guild-x', 'pray'), /{user}/);
  });
});

describe('lucy reminder panel', () => {
  function makeButton(customId, userId = 'user1') {
    const updates = [];
    return {
      customId,
      guildId: 'guild1',
      user: { id: userId, username: 'Tester' },
      member: { displayName: 'Tester' },
      message: { embeds: [] },
      update: async payload => { updates.push(payload); },
      updates
    };
  }

  it('recognises its own buttons', () => {
    const svc = require('../src/services/lucyReminder');
    assert.equal(svc.isReminderNav('lrem:toggle:pray'), true);
    assert.equal(svc.isReminderNav('lcnav:daily'), false);
  });

  it('toggles a reminder on and off from the panel (starts OFF)', async () => {
    const svc = require('../src/services/lucyReminder');
    const store = require('../src/utils/lucyActionStorage');
    const i = makeButton('lrem:toggle:pray');
    // Default OFF -> klik pertama menyalakan.
    assert.equal(await svc.handleComponent(i), true);
    assert.equal(store.getPref('user1', 'pray').enabled, true);
    assert.equal(i.updates.length, 1);
    await svc.handleComponent(i);
    assert.equal(store.getPref('user1', 'pray').enabled, false);
  });

  it('cycles the ping mode through all four options', async () => {
    const svc = require('../src/services/lucyReminder');
    const store = require('../src/utils/lucyActionStorage');
    const seen = [];
    for (let n = 0; n < 4; n++) {
      await svc.handleComponent(makeButton('lrem:mode:battle'));
      seen.push(store.getPref('user1', 'battle').pingMode);
    }
    assert.deepEqual(seen, ['reply', 'both', 'none', 'tag']);
  });

  it('opens the panel with one row of buttons per reminder kind', async () => {
    const svc = require('../src/services/lucyReminder');
    const msg = makeMessage('d lreminder');
    assert.equal(await svc.handleMessage(msg), true);
    const payload = msg.replies[0];
    assert.equal(payload.components.length, 4, 'pray, curse, battle/hunt, lucy');
  });
});

describe('lucy leaderboard ranges', () => {
  it('parses day, all-time, single date and multi-day ranges', () => {
    const svc = require('../src/services/lucyReminder');
    const today = new Date('2026-11-05T03:00:00Z'); // 10:00 WIB
    assert.equal(svc.parseRange('', today).type, 'today');
    assert.equal(svc.parseRange('all', today).type, 'alltime');
    const seven = svc.parseRange('7d', today);
    assert.equal(seven.type, 'range');
    assert.equal(seven.to, '2026-11-05');
    assert.equal(seven.from, '2026-10-30');
    assert.equal(seven.days, 7);
    assert.equal(svc.parseRange('1d', today).days, 1);
    assert.equal(svc.parseRange('5 nov', today).type, 'date');
  });

  it('builds a leaderboard for a 7 day window', () => {
    const svc = require('../src/services/lucyReminder');
    const store = require('../src/utils/lucyActionStorage');
    const today = new Date();
    const day = svc.dayKey(today);
    const sixDaysAgo = svc.shiftDay(day, -6);
    store.recordAction({ guildId: 'g', userId: 'u1', name: 'Ani', day, action: 'pray' });
    store.recordAction({ guildId: 'g', userId: 'u2', name: 'Budi', day: sixDaysAgo, action: 'pray' });
    store.recordAction({ guildId: 'g', userId: 'u3', name: 'Coki', day: svc.shiftDay(day, -30), action: 'pray' });

    const view = svc.leaderboardView('g', 'pray', svc.parseRange('7d', today));
    assert.match(view.embed.data.description, /Ani/);
    assert.match(view.embed.data.description, /Budi/);
    assert.doesNotMatch(view.embed.data.description, /Coki/, 'di luar 7 hari tidak ikut');
    assert.match(view.embed.data.footer.text, /7 hari/);
  });

  it('combines battle and hunt into one category', () => {
    const svc = require('../src/services/lucyReminder');
    const store = require('../src/utils/lucyActionStorage');
    const day = svc.dayKey();
    store.recordAction({ guildId: 'g', userId: 'u1', name: 'Ani', day, action: 'battle' });
    store.recordAction({ guildId: 'g', userId: 'u1', name: 'Ani', day, action: 'hunt' });
    const view = svc.leaderboardView('g', 'battle', svc.parseRange('', new Date()));
    assert.match(view.embed.data.title, /Battle\/Hunt/);
    assert.match(view.embed.data.description, /\*\*2\*\* — Ani/);
  });

  it('reads the lucy category from the existing lucy counter', () => {
    const svc = require('../src/services/lucyReminder');
    const lucyStore = require('../src/utils/lucyCounterStorage');
    const day = svc.dayKey();
    lucyStore.recordLucy({ guildId: 'g', userId: 'u1', name: 'Ani', day, cycleKey: day, targetActive: false, goal: 0 });
    const view = svc.leaderboardView('g', 'lucy', svc.parseRange('', new Date()));
    assert.match(view.embed.data.description, /\*\*1\*\* — Ani/);
  });

  it('answers the leaderboard commands through the prefix handler', async () => {
    const svc = require('../src/services/lucyReminder');
    const store = require('../src/utils/lucyActionStorage');
    const day = svc.dayKey();
    store.recordAction({ guildId: 'guild1', userId: 'u1', name: 'Ani', day, action: 'curse' });
    const msg = makeMessage('d llb curse');
    assert.equal(await svc.handleMessage(msg), true);
    assert.match(msg.replies[0].embeds[0].data.title, /Lucy Curse/);
  });

  it('rejects an unknown range with a helpful message', async () => {
    const svc = require('../src/services/lucyReminder');
    const msg = makeMessage('d llb pray 99xyz');
    assert.equal(await svc.handleMessage(msg), true);
    assert.match(msg.replies[0], /Rentang tidak dikenali/);
  });
});

describe('lucy action triggers (alias + prefix)', () => {
  it('accepts every alias the users type', () => {
    const t = require('../src/utils/lucyTrigger');
    const expected = {
      battle: ['lucy battle', 'lbattle', 'lb', 'lucy fight', 'lfight', 'l fight', 'lucy war'],
      hunt: ['lucy hunt', 'lucy catch', 'lh', 'lhunt', 'l hunt', 'lcatch'],
      pray: ['lucy pray', 'lpray'],
      curse: ['lucy curse', 'lcurse']
    };
    for (const [kind, samples] of Object.entries(expected)) {
      for (const sample of samples) assert.equal(t.matchAction(sample), kind, sample);
    }
  });

  it('is case-insensitive and tolerant of extra spaces', () => {
    const t = require('../src/utils/lucyTrigger');
    assert.equal(t.matchAction('LUCY BATTLE'), 'battle');
    assert.equal(t.matchAction('  L  HUNT  '), 'hunt');
    assert.equal(t.matchAction('Lucy Fight'), 'battle');
  });

  it('does not fire on ordinary chat that merely starts with l', () => {
    const t = require('../src/utils/lucyTrigger');
    for (const text of ['lucy lucu', 'lbener', 'l b', 'lucy battle ya', 'halo', 'l']) {
      assert.equal(t.matchAction(text), null, text);
    }
  });

  it('keeps `lucy` always active because it is the bot default', () => {
    const t = require('../src/utils/lucyTrigger');
    // Walau server memakai `g`, `lucy battle` TETAP dikenali.
    assert.equal(t.matchAction('lucy battle', 'g'), 'battle');
    assert.equal(t.matchAction('lucy hunt', 'g'), 'hunt');
    assert.equal(t.matchAction('lucy catch', 'g'), 'hunt');
    assert.equal(t.matchAction('lucy pray', 'g'), 'pray');
    // Prefix server ikut aktif.
    assert.equal(t.matchAction('g battle', 'g'), 'battle');
    assert.equal(t.matchAction('gbattle', 'g'), 'battle');
    assert.equal(t.matchAction('gh', 'g'), 'hunt');
    assert.equal(t.matchAction('g hunt', 'g'), 'hunt');
  });

  it('can drop the extra `l` shorthand without losing `lucy`', () => {
    const t = require('../src/utils/lucyTrigger');
    assert.equal(t.matchAction('lb', 'g'), null, '`l` tidak lagi aktif');
    assert.equal(t.matchAction('lh', 'g'), null);
    assert.equal(t.matchAction('lucy battle', 'g'), 'battle', '`lucy` tetap jalan');
  });

  it('accepts several prefixes at once', () => {
    const t = require('../src/utils/lucyTrigger');
    assert.equal(t.matchAction('lucy battle', ['lucy', 'l']), 'battle');
    assert.equal(t.matchAction('lb', 'lucy l'), 'battle', 'boleh dipisah spasi');
    assert.equal(t.matchAction('g hunt', 'g, gl'), 'hunt', 'boleh dipisah koma');
  });

  it('merges configured prefixes with the always-on default', () => {
    const t = require('../src/utils/lucyTrigger');
    assert.deepEqual(t.lucyPrefixes(null), ['lucy', 'l'], 'belum diatur -> default');
    assert.deepEqual(t.lucyPrefixes(''), ['lucy', 'l']);
    assert.deepEqual(t.lucyPrefixes('g'), ['lucy', 'g']);
    assert.deepEqual(t.lucyPrefixes('l g'), ['lucy', 'l', 'g']);
    assert.deepEqual(t.lucyPrefixes([]), ['lucy'], 'diatur kosong -> hanya bawaan');
    assert.deepEqual(t.lucyPrefixes('lucy'), ['lucy'], 'duplikat dibuang');
  });

  it('validates prefix input', () => {
    const t = require('../src/utils/lucyTrigger');
    assert.equal(t.normalizePrefix('Lucy'), 'lucy');
    assert.equal(t.normalizePrefix(''), '');
    assert.equal(t.normalizePrefix('l x'), '', 'spasi tidak boleh');
    assert.equal(t.normalizePrefix('a'.repeat(17)), '', 'terlalu panjang');
    assert.equal(t.normalizePrefix('bos2'), 'bos2');
    assert.deepEqual(t.parsePrefixList('g bos gl'), ['g', 'bos', 'gl']);
    assert.deepEqual(t.parsePrefixList('g g'), ['g'], 'duplikat dibuang');
  });
});

describe('global reminder preferences', () => {
  it('applies one preference across every server', () => {
    const store = require('../src/utils/lucyActionStorage');
    // Diatur saat berada di guild A (tidak ada parameter guild sama sekali).
    store.setPref('u1', 'battle', { pingMode: 'none', enabled: false });
    // Dibaca kembali tanpa menyebut guild apa pun.
    assert.deepEqual(store.getPref('u1', 'battle'), { enabled: false, pingMode: 'none' });
    assert.equal(store.getPrefs('u1').battle.pingMode, 'none');
  });
});

describe('lucy prefix admin command', () => {
  it('shows the default prefixes and says `lucy` is always on', async () => {
    const svc = require('../src/services/lucyReminder');
    const show = makeMessage('d lucyprefix');
    assert.equal(await svc.handleMessage(show), true);
    assert.match(show.replies[0].content, /\*\*lucy\*\*/);
    assert.match(show.replies[0].content, /\*\*l\*\*/);
    assert.match(show.replies[0].content, /selalu aktif/);
  });

  it('requires a moderator to change it', async () => {
    const svc = require('../src/services/lucyReminder');
    const denied = makeMessage('d lucyprefix add g', { admin: false });
    await svc.handleMessage(denied);
    assert.match(denied.replies[0], /Hanya moderator/);
  });

  it('adds a server prefix while keeping `lucy` and the defaults', async () => {
    const svc = require('../src/services/lucyReminder');
    const { getGuildSettings } = require('../src/utils/storage');
    const ok = makeMessage('d lucyprefix add g', { admin: true });
    assert.equal(await svc.handleMessage(ok), true);
    assert.match(ok.replies[0], /\*\*g\*\*/);
    assert.deepEqual(getGuildSettings('guild1').lucyReminder.lucyPrefixes, ['l', 'g']);
    // Ketiganya jalan: bawaan, pendek, dan tambahan server.
    assert.equal(await svc.handleMessage(makeMessage('lucy battle')), true);
    assert.equal(await svc.handleMessage(makeMessage('lb')), true);
    assert.equal(await svc.handleMessage(makeMessage('g battle')), true);
    for (const t of svc.timers.values()) clearTimeout(t);
  });

  it('`set` replaces the extras but `lucy` keeps working', async () => {
    const svc = require('../src/services/lucyReminder');
    const { getGuildSettings } = require('../src/utils/storage');
    await svc.handleMessage(makeMessage('d lucyprefix set g', { admin: true }));
    assert.deepEqual(getGuildSettings('guild1').lucyReminder.lucyPrefixes, ['g']);
    // `lucy battle` tetap jalan; `lb` ikut hilang karena `l` tidak lagi didaftarkan.
    assert.equal(await svc.handleMessage(makeMessage('lucy battle')), true);
    assert.equal(await svc.handleMessage(makeMessage('lb')), false);
    assert.equal(await svc.handleMessage(makeMessage('gbattle')), true);
    for (const t of svc.timers.values()) clearTimeout(t);
  });

  it('remove only touches extras, never `lucy`', async () => {
    const svc = require('../src/services/lucyReminder');
    const { getGuildSettings } = require('../src/utils/storage');
    await svc.handleMessage(makeMessage('d lucyprefix set g', { admin: true }));
    await svc.handleMessage(makeMessage('d lucyprefix remove g', { admin: true }));
    assert.deepEqual(getGuildSettings('guild1').lucyReminder.lucyPrefixes, []);
    // Hanya prefix bawaan yang tersisa, dan itu tetap jalan.
    assert.equal(await svc.handleMessage(makeMessage('lucy battle')), true);
    assert.equal(await svc.handleMessage(makeMessage('gbattle')), false);

    const note = makeMessage('d lucyprefix remove lucy', { admin: true });
    await svc.handleMessage(note);
    assert.match(note.replies[0], /selalu aktif/);
    assert.equal(await svc.handleMessage(makeMessage('lucy battle')), true);
    for (const t of svc.timers.values()) clearTimeout(t);
  });

  it('reset returns to the default prefixes', async () => {
    const svc = require('../src/services/lucyReminder');
    const { getGuildSettings } = require('../src/utils/storage');
    await svc.handleMessage(makeMessage('d lucyprefix set g', { admin: true }));
    const reset = makeMessage('d lucyprefix reset', { admin: true });
    await svc.handleMessage(reset);
    assert.match(reset.replies[0], /default/);
    assert.equal(getGuildSettings('guild1').lucyReminder.lucyPrefixes, null);
    assert.equal(await svc.handleMessage(makeMessage('lb')), true);
    for (const t of svc.timers.values()) clearTimeout(t);
  });

  it('rejects an invalid prefix', async () => {
    const svc = require('../src/services/lucyReminder');
    const bad = makeMessage('d lucyprefix add ab!', { admin: true });
    await svc.handleMessage(bad);
    assert.match(bad.replies[0], /tidak valid/);
  });
});

describe('global leaderboard', () => {
  it('sums a player across servers when global is requested', () => {
    const svc = require('../src/services/lucyReminder');
    const store = require('../src/utils/lucyActionStorage');
    const day = svc.dayKey();
    store.recordAction({ guildId: 'serverA', userId: 'u1', name: 'Ani', day, action: 'pray' });
    store.recordAction({ guildId: 'serverB', userId: 'u1', name: 'Ani', day, action: 'pray' });
    store.recordAction({ guildId: 'serverA', userId: 'u2', name: 'Budi', day, action: 'pray' });

    const local = svc.leaderboardView('serverA', 'pray', svc.parseRange('', new Date()));
    assert.match(local.embed.data.description, /\*\*1\*\* — Ani/, 'lokal: hanya server A');
    assert.match(local.embed.data.footer.text, /Server ini/);

    const global = svc.leaderboardView('serverA', 'pray', svc.parseRange('', new Date()), 1, { global: true });
    assert.match(global.embed.data.description, /\*\*2\*\* — Ani/, 'global: digabung dua server');
    assert.match(global.embed.data.footer.text, /Global/);
  });

  it('accepts the `global` token on the prefix command', async () => {
    const svc = require('../src/services/lucyReminder');
    const store = require('../src/utils/lucyActionStorage');
    const day = svc.dayKey();
    store.recordAction({ guildId: 'guild1', userId: 'u1', name: 'Ani', day, action: 'curse' });
    store.recordAction({ guildId: 'lain', userId: 'u1', name: 'Ani', day, action: 'curse' });
    const msg = makeMessage('d llb curse global');
    assert.equal(await svc.handleMessage(msg), true);
    assert.match(msg.replies[0].embeds[0].data.description, /\*\*2\*\* — Ani/);
    assert.match(msg.replies[0].embeds[0].data.footer.text, /Global/);
  });

  it('reads the lucy category globally from the lucy counter', () => {
    const svc = require('../src/services/lucyReminder');
    const lucyStore = require('../src/utils/lucyCounterStorage');
    const day = svc.dayKey();
    lucyStore.recordLucy({ guildId: 'serverA', userId: 'u1', name: 'Ani', day, cycleKey: day, targetActive: false, goal: 0 });
    lucyStore.recordLucy({ guildId: 'serverB', userId: 'u1', name: 'Ani', day, cycleKey: day, targetActive: false, goal: 0 });
    const view = svc.leaderboardView('serverA', 'lucy', svc.parseRange('', new Date()), 1, { global: true });
    assert.match(view.embed.data.description, /\*\*2\*\* — Ani/);
  });
});

describe('premium custom replies', () => {
  it('blocks custom replies until premium is enabled', async () => {
    const svc = require('../src/services/lucyReminder');
    const msg = makeMessage('d lreminder reply pray halo {user}', { admin: true });
    assert.equal(await svc.handleMessage(msg), true);
    assert.match(msg.replies[0], /premium/);
  });

  it('saves a custom reply when premium is on and uses it for reminders', async () => {
    const svc = require('../src/services/lucyReminder');
    const { updateGuildSettings } = require('../src/utils/storage');
    updateGuildSettings('guild1', s => ({ ...s, lucyReminder: { ...s.lucyReminder, premium: true } }));

    const save = makeMessage('d lreminder reply pray Doa {user} dikabulkan!', { admin: true });
    assert.equal(await svc.handleMessage(save), true);
    assert.match(save.replies[0], /disimpan/);
    assert.equal(svc.replyTemplate('guild1', 'pray'), 'Doa {user} dikabulkan!');

    const sent = [];
    const client = { channels: { fetch: async () => ({ isTextBased: () => true, send: async p => { sent.push(p); } }) } };
    require('../src/utils/lucyActionStorage').setPref('u1', 'pray', { enabled: true });
    await svc.deliverReminder(client, { guildId: 'guild1', channelId: 'c', userId: 'u1', name: 'Ani', kind: 'pray', messageId: 'm' });
    assert.match(sent[0].content, /Doa Ani dikabulkan!/);
  });
});
