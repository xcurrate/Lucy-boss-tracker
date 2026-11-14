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
    replies,
    // Pesan yang benar-benar terlihat semua orang (ephemeral tidak dihitung).
    get publicSent() { return sent.filter(p => !p.flags); }
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
  it('has three reminder types, each shared by two actions', () => {
    const svc = require('../src/services/lucyReminder');
    assert.deepEqual(Object.keys(svc.KINDS), ['pray', 'battle', 'lucy']);
    assert.equal(svc.KINDS.pray.waitMs, 5 * 60 * 1000);
    assert.equal(svc.KINDS.battle.waitMs, 15 * 1000);
    assert.equal(svc.KINDS.lucy.waitMs, 10 * 1000);
    assert.equal(svc.KINDS.curse, undefined, 'curse bukan jenis tersendiri');
    assert.equal(svc.KINDS.hunt, undefined, 'hunt bukan jenis tersendiri');
    // pray+curse satu jenis; battle+hunt satu jenis.
    assert.equal(svc.TRIGGER_KIND_TO_REMINDER.pray, 'pray');
    assert.equal(svc.TRIGGER_KIND_TO_REMINDER.curse, 'pray');
    assert.equal(svc.TRIGGER_KIND_TO_REMINDER.battle, 'battle');
    assert.equal(svc.TRIGGER_KIND_TO_REMINDER.hunt, 'battle');
    // Label per aksi tetap membedakan teks pengingatnya.
    assert.equal(svc.ACTION_LABELS.pray, 'Lucy Pray');
    assert.equal(svc.ACTION_LABELS.curse, 'Lucy Curse');
    assert.equal(svc.ACTION_LABELS.hunt, 'Lucy Hunt');
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

  it('fills {count} from the triggering action, not the shared kind', async () => {
    const svc = require('../src/services/lucyReminder');
    const store = require('../src/utils/lucyActionStorage');
    const { updateGuildSettings } = require('../src/utils/storage');
    updateGuildSettings('g', s => ({ ...s, lucyReminder: { ...s.lucyReminder, premium: true, replies: { battle: '{count}', pray: '{count}' } } }));
    const day = svc.dayKey();
    store.recordAction({ guildId: 'g', userId: 'u1', name: 'Ani', day, action: 'battle' });
    store.recordAction({ guildId: 'g', userId: 'u1', name: 'Ani', day, action: 'hunt' });
    store.recordAction({ guildId: 'g', userId: 'u1', name: 'Ani', day, action: 'hunt' });
    // pingMode 'none' supaya teksnya bersih tanpa mention.
    store.setPref('u1', 'battle', { enabled: true, pingMode: 'none' });
    store.setPref('u1', 'pray', { enabled: true, pingMode: 'none' });
    const sent = [];
    const client = { channels: { fetch: async () => ({ isTextBased: () => true, send: async p => { sent.push(p); } }) } };
    const deliver = action => svc.deliverReminder(client, { guildId: 'g', channelId: 'c', userId: 'u1', name: 'Ani', kind: svc.TRIGGER_KIND_TO_REMINDER[action], action, messageId: 'm' });
    await deliver('battle');
    assert.equal(sent.at(-1).content, '1', 'lb -> hitungan battle saja');
    await deliver('hunt');
    assert.equal(sent.at(-1).content, '2', 'lh -> hitungan hunt saja');
    await deliver('pray');
    assert.equal(sent.at(-1).content, '0', 'lpray -> hitungan pray saja');
    await deliver('curse');
    assert.equal(sent.at(-1).content, '0', 'lcurse -> hitungan curse sendiri, bukan pray');
  });

  it('uses an action-level custom reply when one is set', async () => {
    const svc = require('../src/services/lucyReminder');
    const store = require('../src/utils/lucyActionStorage');
    const { updateGuildSettings } = require('../src/utils/storage');
    updateGuildSettings('g', s => ({ ...s, lucyReminder: { ...s.lucyReminder, premium: true, replies: { pray: 'DOA {user}', curse: 'KUTUK {user}' } } }));
    store.setPref('u1', 'pray', { enabled: true, pingMode: 'none' });
    const sent = [];
    const client = { channels: { fetch: async () => ({ isTextBased: () => true, send: async p => { sent.push(p); } }) } };
    await svc.deliverReminder(client, { guildId: 'g', channelId: 'c', userId: 'u1', name: 'Ani', kind: 'pray', action: 'pray', messageId: 'm' });
    assert.equal(sent.at(-1).content, 'DOA Ani', 'pray memakai template pray');
    await svc.deliverReminder(client, { guildId: 'g', channelId: 'c', userId: 'u1', name: 'Ani', kind: 'pray', action: 'curse', messageId: 'm' });
    assert.equal(sent.at(-1).content, 'KUTUK Ani', 'curse memakai template curse walau jenisnya sama');
    // Tanpa template curse, curse jatuh ke template jenis (pray).
    updateGuildSettings('g', s => ({ ...s, lucyReminder: { ...s.lucyReminder, replies: { pray: 'DOA {user}' } } }));
    await svc.deliverReminder(client, { guildId: 'g', channelId: 'c', userId: 'u1', name: 'Ani', kind: 'pray', action: 'curse', messageId: 'm' });
    assert.equal(sent.at(-1).content, 'DOA Ani', 'fallback ke template jenis');
  });

  it('offers tag, reply, both and none ping modes', () => {
    const svc = require('../src/services/lucyReminder');
    assert.deepEqual(Object.keys(svc.PING_MODES).sort(), ['both', 'none', 'reply', 'tag']);
  });

  it('schedules a reminder per kind without replying publicly', async () => {
    const svc = require('../src/services/lucyReminder');
    for (const command of ['lucy pray', 'lcurse', 'lbattle', 'lhunt']) {
      const msg = makeMessage(command);
      assert.equal(await svc.handleMessage(msg), true, command);
      assert.equal(msg.publicSent.length, 0, 'tidak ada balasan publik untuk ' + command);
    }
    // pray+curse dan battle+hunt masing-masing berbagi satu jenis, jadi 2 pengingat.
    assert.equal(svc.scheduledCount('guild1'), 2);
    for (const t of svc.timers.values()) clearTimeout(t);
  });

  it('keeps the FIRST reminder: `lh` then `lb` is counted from `lh`', async () => {
    const svc = require('../src/services/lucyReminder');
    const first = makeMessage('lh');
    await svc.handleMessage(first);
    const key = 'guild1:user1:battle';
    const afterFirst = { ...svc.reminders.get(key) };
    assert.equal(afterFirst.action, 'hunt', 'aksi pertama = hunt');
    assert.equal(svc.timers.size, 1);

    // Beri jeda kecil supaya kalau waktunya benar-benar digeser, terlihat.
    await new Promise(r => setTimeout(r, 25));
    const second = makeMessage('lb');
    await svc.handleMessage(second);

    const afterSecond = svc.reminders.get(key);
    assert.equal(svc.timers.size, 1, 'tetap satu pengingat, bukan dua');
    assert.equal(afterSecond.action, 'hunt', 'aksi pemicu tetap hunt');
    assert.equal(afterSecond.scheduledAt, afterFirst.scheduledAt, 'waktu pasang tidak digeser');
    assert.equal(afterSecond.dueAt, afterFirst.dueAt, 'jatuh tempo dihitung dari lh');
    assert.equal(afterSecond.messageId, first.id, 'pengingat menunjuk pesan lh');

    for (const t of svc.timers.values()) clearTimeout(t);
  });

  it('uses the earlier action name in the reminder text', async () => {
    const svc = require('../src/services/lucyReminder');
    const store = require('../src/utils/lucyActionStorage');
    const { updateGuildSettings } = require('../src/utils/storage');
    // Template yang memakai {kind} supaya nama aksi terlihat.
    updateGuildSettings('guild1', s => ({ ...s, lucyReminder: { ...s.lucyReminder, premium: true, replies: { battle: '{kind} untuk {user}.' } } }));
    store.setPref('user1', 'battle', { enabled: true });
    await svc.handleMessage(makeMessage('lh'));
    await svc.handleMessage(makeMessage('lb'));
    const sent = [];
    const client = { channels: { fetch: async () => ({ isTextBased: () => true, send: async p => { sent.push(p); } }) } };
    const reminder = svc.reminders.get('guild1:user1:battle');
    await svc.deliverReminder(client, reminder);
    assert.equal(sent.length, 1);
    assert.match(sent[0].content, /Lucy Hunt/, 'nama aksi yang lebih dulu (lh)');
    assert.doesNotMatch(sent[0].content, /Battle/);
    for (const t of svc.timers.values()) clearTimeout(t);
  });

  it('`lb` then `lh` is counted from `lb`', async () => {
    const svc = require('../src/services/lucyReminder');
    await svc.handleMessage(makeMessage('lb'));
    const before = { ...svc.reminders.get('guild1:user1:battle') };
    await new Promise(r => setTimeout(r, 25));
    await svc.handleMessage(makeMessage('lh'));
    const after = svc.reminders.get('guild1:user1:battle');
    assert.equal(after.action, 'battle', 'aksi pertama = battle');
    assert.equal(after.dueAt, before.dueAt, 'jatuh tempo tetap dari lb');
    for (const t of svc.timers.values()) clearTimeout(t);
  });

  it('a later kind does not disturb a different kind in progress', async () => {
    const svc = require('../src/services/lucyReminder');
    await svc.handleMessage(makeMessage('lpray'));
    await svc.handleMessage(makeMessage('lh'));
    assert.equal(svc.timers.size, 2, 'pray dan battle/hunt masing-masing satu');
    assert.equal(svc.reminders.get('guild1:user1:pray').action, 'pray');
    assert.equal(svc.reminders.get('guild1:user1:battle').action, 'hunt');
    for (const t of svc.timers.values()) clearTimeout(t);
  });

  it('pray and curse share one reminder: `lpray` then `lcurse` keeps `lpray`', async () => {
    const svc = require('../src/services/lucyReminder');
    const key = 'guild1:user1:pray';
    await svc.handleMessage(makeMessage('lpray'));
    const before = { ...svc.reminders.get(key) };
    assert.equal(before.action, 'pray');
    assert.equal(svc.timers.size, 1);

    await new Promise(r => setTimeout(r, 25));
    await svc.handleMessage(makeMessage('lcurse'));
    const after = svc.reminders.get(key);

    assert.equal(svc.timers.size, 1, 'tetap satu pengingat untuk pray/curse');
    assert.equal(after.action, 'pray', 'aksi pertama (pray) dipertahankan');
    assert.equal(after.dueAt, before.dueAt, 'jatuh tempo dari lpray');
    assert.equal(after.scheduledAt, before.scheduledAt, 'waktu pasang tidak digeser');
    for (const t of svc.timers.values()) clearTimeout(t);
  });

  it('`lcurse` then `lpray` keeps `lcurse`', async () => {
    const svc = require('../src/services/lucyReminder');
    const key = 'guild1:user1:pray';
    await svc.handleMessage(makeMessage('lcurse'));
    const before = { ...svc.reminders.get(key) };
    assert.equal(before.action, 'curse');
    await new Promise(r => setTimeout(r, 25));
    await svc.handleMessage(makeMessage('lpray'));
    const after = svc.reminders.get(key);
    assert.equal(after.action, 'curse', 'aksi pertama (curse) dipertahankan');
    assert.equal(after.dueAt, before.dueAt);
    for (const t of svc.timers.values()) clearTimeout(t);
  });

  it('applies the first-wins rule to every reminder kind', async () => {
    const svc = require('../src/services/lucyReminder');
    // Setiap jenis diuji dengan dua aksi berbeda yang memetakan ke jenis itu.
    for (const [kind, first, second] of [
      ['pray', 'lpray', 'lucy pray'],
      ['pray', 'lcurse', 'lucy curse'],
      ['battle', 'lh', 'lb'],
      ['battle', 'lb', 'lh']
    ]) {
      for (const t of svc.timers.values()) clearTimeout(t);
      svc.timers.clear();
      svc.reminders.clear();

      await svc.handleMessage(makeMessage(first));
      const key = 'guild1:user1:' + kind;
      const before = { ...svc.reminders.get(key) };
      await new Promise(r => setTimeout(r, 25));
      await svc.handleMessage(makeMessage(second));
      const after = svc.reminders.get(key);

      assert.equal(svc.timers.size, 1, `${first} lalu ${second}: satu pengingat`);
      assert.equal(after.action, before.action, `${first} lalu ${second}: aksi pertama dipertahankan`);
      assert.equal(after.dueAt, before.dueAt, `${first} lalu ${second}: jatuh tempo dari aksi pertama`);
    }
    for (const t of svc.timers.values()) clearTimeout(t);
  });

  it('keeps pray/curse separate from battle/hunt', async () => {
    const svc = require('../src/services/lucyReminder');
    await svc.handleMessage(makeMessage('lpray'));
    await svc.handleMessage(makeMessage('lh'));
    // Jenis berbeda -> masing-masing punya pengingat sendiri.
    assert.deepEqual([...svc.timers.keys()].sort(), ['guild1:user1:battle', 'guild1:user1:pray']);
    assert.equal(svc.reminders.get('guild1:user1:pray').action, 'pray');
    assert.equal(svc.reminders.get('guild1:user1:battle').action, 'hunt');
    for (const t of svc.timers.values()) clearTimeout(t);
  });

  it('does not let a second kind reset the first kind timer', async () => {
    const svc = require('../src/services/lucyReminder');
    await svc.handleMessage(makeMessage('lpray'));
    const prayBefore = { ...svc.reminders.get('guild1:user1:pray') };
    await new Promise(r => setTimeout(r, 25));
    await svc.handleMessage(makeMessage('lpray'));
    const prayAfter = svc.reminders.get('guild1:user1:pray');
    assert.equal(prayAfter.dueAt, prayBefore.dueAt, 'pray berulang tidak menggeser waktunya');
    for (const t of svc.timers.values()) clearTimeout(t);
  });

  it('counts each action separately even though the reminder is shared', async () => {
    const svc = require('../src/services/lucyReminder');
    const store = require('../src/utils/lucyActionStorage');
    await svc.handleMessage(makeMessage('lh'));
    await svc.handleMessage(makeMessage('lb'));
    const day = svc.dayKey();
    assert.equal(store.topByDay('guild1', day, ['hunt'])[0].count, 1);
    assert.equal(store.topByDay('guild1', day, ['battle'])[0].count, 1);
    for (const t of svc.timers.values()) clearTimeout(t);
  });

  it('leaves the channel clean: one action produces no message at all', async () => {
    const svc = require('../src/services/lucyReminder');
    const msg = makeMessage('lb');
    await svc.handleMessage(msg);
    assert.equal(msg.publicSent.length, 0, 'channel tidak mendapat pesan publik');
    // Pesan pemicu TIDAK dihapus, karena mode ping `reply` membalas pesan ini.
    assert.equal(msg.deleted, undefined);
    assert.equal(svc.timers.size, 1, 'pengingat tetap terjadwal');
    for (const t of svc.timers.values()) clearTimeout(t);
  });

  it('reminds once, and the reminder text is what the user sees', async () => {
    const svc = require('../src/services/lucyReminder');
    const store = require('../src/utils/lucyActionStorage');
    store.setPref('user1', 'battle', { enabled: true });
    const msg = makeMessage('lb');
    await svc.handleMessage(msg);
    // Hanya satu pengingat, dan isinya teks balasan (bukan ganda).
    const sent = [];
    const client = { channels: { fetch: async () => ({ isTextBased: () => true, send: async p => { sent.push(p); } }) } };
    const reminder = [...svc.timers.keys()];
    assert.deepEqual(reminder, ['guild1:user1:battle']);
    await svc.deliverReminder(client, { guildId: 'guild1', channelId: 'chan1', userId: 'user1', name: 'melda', kind: 'battle', messageId: msg.id });
    assert.equal(sent.length, 1, 'tepat satu pengingat');
    assert.match(sent[0].content, /melda/);
    for (const t of svc.timers.values()) clearTimeout(t);
  });

  it('also accepts the `lucy pray` style trigger', async () => {
    const svc = require('../src/services/lucyReminder');
    const msg = makeMessage('lucy pray');
    assert.equal(await svc.handleMessage(msg), true);
    for (const t of svc.timers.values()) clearTimeout(t);
  });

  it('sends nothing at all when the reminder is off, even for a newcomer', async () => {
    const svc = require('../src/services/lucyReminder');
    const msg = makeMessage('lucy battle');
    await svc.handleMessage(msg);
    // Tidak ada ajakan menyalakan pengingat, tidak ada info status apa pun.
    assert.equal(msg.sent.length, 0, 'tidak ada pesan sama sekali');
    assert.equal(svc.timers.size, 1, 'pengingat tetap terjadwal');
    for (const t of svc.timers.values()) clearTimeout(t);
  });

  it('stays silent for someone who already turned reminders on', async () => {
    const svc = require('../src/services/lucyReminder');
    const store = require('../src/utils/lucyActionStorage');
    store.setPref('user1', 'battle', { enabled: true });
    const msg = makeMessage('lucy battle');
    await svc.handleMessage(msg);
    assert.equal(msg.sent.length, 0, 'tidak ada pesan sama sekali');
    for (const t of svc.timers.values()) clearTimeout(t);
  });

  it('never mentions the reminder settings in an action reply', async () => {
    const svc = require('../src/services/lucyReminder');
    const store = require('../src/utils/lucyActionStorage');
    // Baik sudah diatur maupun belum, aksi tidak boleh membalas apa pun.
    for (const prefs of [[], [['battle', { enabled: false }]], [['battle', { enabled: true }]]]) {
      for (const t of svc.timers.values()) clearTimeout(t);
      svc.timers.clear();
      svc.reminders.clear();
      store.getDb().prepare('DELETE FROM lucy_reminder_prefs_global').run();
      for (const [kind, pref] of prefs) store.setPref('user1', kind, pref);
      const msg = makeMessage('lucy battle');
      await svc.handleMessage(msg);
      assert.equal(msg.sent.length, 0, JSON.stringify(prefs) + ' -> tanpa pesan');
    }
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
    assert.equal(payload.components.length, 3, 'pray/curse, battle/hunt, lucy');
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

  it('accepts a trailing user mention like `lpray @Lucy`', () => {
    const t = require('../src/utils/lucyTrigger');
    const id = '276801656656494602';
    // Bentuk mention biasa dan mention nickname.
    assert.equal(t.matchAction('lpray <@' + id + '>', null), 'pray');
    assert.equal(t.matchAction('lpray <@!' + id + '>', null), 'pray');
    assert.equal(t.matchAction('lb <@' + id + '>', null), 'battle');
    assert.equal(t.matchAction('l hunt <@' + id + '>', null), 'hunt');
    assert.equal(t.matchAction('lcurse <@' + id + '>', null), 'curse');
    assert.equal(t.matchAction('lucy battle <@' + id + '>', null), 'battle');
    assert.equal(t.matchAction('lucy pray <@' + id + '>', null), 'pray');
    // Beberapa mention di belakang juga boleh.
    assert.equal(t.matchAction('lh <@' + id + '> <@' + id + '>', null), 'hunt');
  });

  it('still ignores ordinary chat even with a mention', () => {
    const t = require('../src/utils/lucyTrigger');
    const id = '276801656656494602';
    assert.equal(t.matchAction('lb ya nanti', null), null);
    assert.equal(t.matchAction('lpray halo <@' + id + '>', null), null, 'teks sebelum mention tetap chat');
    assert.equal(t.matchAction('lpray <@' + id + '> extra', null), null, 'teks setelah mention tetap chat');
    assert.equal(t.matchAction('<@' + id + '>', null), null, 'mention saja bukan perintah');
    assert.equal(t.matchAction('lucy', null), null);
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

describe('`top` command', () => {
  it('defaults to the LUCY count when no category is given', async () => {
    const svc = require('../src/services/lucyReminder');
    const lucyStore = require('../src/utils/lucyCounterStorage');
    const day = svc.dayKey();
    lucyStore.recordLucy({ guildId: 'guild1', userId: 'u1', name: 'Ani', day, cycleKey: day, targetActive: false, goal: 0 });
    for (const command of ['d top', 'd t']) {
      const msg = makeMessage(command);
      assert.equal(await svc.handleMessage(msg), true, command);
      assert.match(msg.replies[0].embeds[0].data.title, /Leaderboard Lucy/, command);
      assert.match(msg.replies[0].embeds[0].data.description, /Ani/, command);
    }
  });

  it('reads the same counter as `lcount`, not a new one', async () => {
    const svc = require('../src/services/lucyReminder');
    const counter = require('../src/services/lucyCounter');
    const lucyStore = require('../src/utils/lucyCounterStorage');
    const day = svc.dayKey();
    lucyStore.recordLucy({ guildId: 'guild1', userId: 'u1', name: 'Ani', day, cycleKey: day, targetActive: false, goal: 0 });
    lucyStore.recordLucy({ guildId: 'guild1', userId: 'u1', name: 'Ani', day, cycleKey: day, targetActive: false, goal: 0 });
    const top = makeMessage('d top');
    await svc.handleMessage(top);
    const lcount = makeMessage('d lcount');
    await counter.handleMessage(lcount, { onCounted: () => {} });
    const countOf = payload => (payload.embeds[0].data.description.match(/\*\*(\d[\d.]*)\*\*/) || [])[1];
    assert.equal(countOf(top.replies[0]), countOf(lcount.replies[0]), 'angka harus sama dengan lcount');
  });

  it('accepts each category token', async () => {
    const svc = require('../src/services/lucyReminder');
    for (const [token, expect] of [
      ['lucy', /Leaderboard Lucy/],
      ['pray', /Leaderboard Lucy Pray/],
      ['curse', /Leaderboard Lucy Curse/],
      ['battle', /Leaderboard Lucy Battle\/Hunt/],
      ['hunt', /Leaderboard Lucy Battle\/Hunt/],
      ['all', /Semua Aksi/]
    ]) {
      const msg = makeMessage('d top ' + token);
      assert.equal(await svc.handleMessage(msg), true, token);
      assert.match(msg.replies[0].embeds[0].data.title, expect, token);
    }
  });

  it('still accepts ranges, pages and the global token', async () => {
    const svc = require('../src/services/lucyReminder');
    const range = makeMessage('d top 7d');
    await svc.handleMessage(range);
    assert.match(range.replies[0].embeds[0].data.title, /7 Hari Terakhir/);

    const glob = makeMessage('d top lucy all global');
    await svc.handleMessage(glob);
    assert.match(glob.replies[0].embeds[0].data.footer.text, /Global/);
    assert.match(glob.replies[0].embeds[0].data.title, /All-Time/);
  });

  it('keeps the old `llb` spelling working', async () => {
    const svc = require('../src/services/lucyReminder');
    const msg = makeMessage('d llb pray');
    assert.equal(await svc.handleMessage(msg), true);
    assert.match(msg.replies[0].embeds[0].data.title, /Lucy Pray/);
  });
});

describe('`global` command', () => {
  const seedTwoServers = () => {
    const svc = require('../src/services/lucyReminder');
    const store = require('../src/utils/lucyActionStorage');
    const day = svc.dayKey();
    // Ani: 1 di server ini + 2 di server lain = 3 secara global, 1 secara lokal.
    store.recordAction({ guildId: 'guild1', userId: 'u1', name: 'Ani', day, action: 'pray' });
    store.recordAction({ guildId: 'guild9', userId: 'u1', name: 'Ani', day, action: 'pray' });
    store.recordAction({ guildId: 'guild9', userId: 'u1', name: 'Ani', day, action: 'pray' });
    // Budi hanya ada di server lain.
    store.recordAction({ guildId: 'guild9', userId: 'u2', name: 'Budi', day, action: 'pray' });
    return day;
  };

  it('`g` and `global` both default to the LUCY board across servers', async () => {
    const svc = require('../src/services/lucyReminder');
    const lucyStore = require('../src/utils/lucyCounterStorage');
    const day = svc.dayKey();
    lucyStore.recordLucy({ guildId: 'guild1', userId: 'u1', name: 'Ani', day, cycleKey: day, targetActive: false, goal: 0 });
    lucyStore.recordLucy({ guildId: 'guild9', userId: 'u1', name: 'Ani', day, cycleKey: day, targetActive: false, goal: 0 });
    for (const command of ['d g', 'd global']) {
      const msg = makeMessage(command);
      assert.equal(await svc.handleMessage(msg), true, command);
      assert.match(msg.replies[0].embeds[0].data.title, /Leaderboard Lucy/, command);
      assert.match(msg.replies[0].embeds[0].data.description, /\*\*2\*\* — Ani/, command);
      assert.match(msg.replies[0].embeds[0].data.footer.text, /Global/, command);
    }
  });

  it('sums an action across servers while `top` stays local', async () => {
    const svc = require('../src/services/lucyReminder');
    seedTwoServers();
    const global = makeMessage('d g pray');
    await svc.handleMessage(global);
    assert.match(global.replies[0].embeds[0].data.description, /\*\*3\*\* — Ani/, 'global: 1+2');
    assert.match(global.replies[0].embeds[0].data.description, /Budi/, 'pemain server lain ikut tampil');
    assert.match(global.replies[0].embeds[0].data.footer.text, /Global/);

    const local = makeMessage('d top pray');
    await svc.handleMessage(local);
    assert.match(local.replies[0].embeds[0].data.description, /\*\*1\*\* — Ani/, 'lokal: hanya server ini');
    assert.doesNotMatch(local.replies[0].embeds[0].data.description, /Budi/);
    assert.match(local.replies[0].embeds[0].data.footer.text, /Server ini/);
  });

  it('accepts categories, ranges and the old global token', async () => {
    const svc = require('../src/services/lucyReminder');
    seedTwoServers();
    const all = makeMessage('d g all');
    await svc.handleMessage(all);
    assert.match(all.replies[0].embeds[0].data.title, /Semua Aksi/);
    assert.match(all.replies[0].embeds[0].data.footer.text, /Global/);

    const range = makeMessage('d g battle 7d');
    await svc.handleMessage(range);
    assert.match(range.replies[0].embeds[0].data.title, /7 Hari Terakhir/);
    assert.match(range.replies[0].embeds[0].data.footer.text, /Global/);

    // Bentuk lama tetap jalan.
    const legacy = makeMessage('d top pray global');
    await svc.handleMessage(legacy);
    assert.match(legacy.replies[0].embeds[0].data.footer.text, /Global/);
  });

  it('treats `semua` as the all-time range, never as the global flag', async () => {
    const svc = require('../src/services/lucyReminder');
    seedTwoServers();
    const msg = makeMessage('d top pray semua');
    await svc.handleMessage(msg);
    assert.match(msg.replies[0].embeds[0].data.title, /All-Time/);
    assert.match(msg.replies[0].embeds[0].data.footer.text, /Server ini/, 'tetap per server');
  });
});

describe('leaderboard title matches its content', () => {
  it('labels daily, range, single date and all-time differently', () => {
    const svc = require('../src/services/lucyReminder');
    const title = range => svc.leaderboardView('guild1', 'pray', range).embed.data.title;
    assert.match(title(svc.parseRange('')), /Harian/);
    assert.match(title(svc.parseRange('7d')), /7 Hari Terakhir/);
    assert.match(title(svc.parseRange('all')), /All-Time/);
    assert.match(title(svc.parseRange('5 nov')), /5 nov 2026/);
    assert.doesNotMatch(title(svc.parseRange('all')), /Harian/);
  });
});

describe('leaderboard range and page parsing', () => {
  it('reads a multi-word range like `5 nov`', async () => {
    const svc = require('../src/services/lucyReminder');
    const msg = makeMessage('d llb curse 5 nov');
    assert.equal(await svc.handleMessage(msg), true);
    assert.match(msg.replies[0].embeds[0].data.footer.text, /5 nov 2026/);
  });

  it('reads `all` as the range even when it is the second token', async () => {
    const svc = require('../src/services/lucyReminder');
    const msg = makeMessage('d llb all all');
    assert.equal(await svc.handleMessage(msg), true);
    assert.match(msg.replies[0].embeds[0].data.footer.text, /semua tanggal/);
  });

  it('treats a trailing number as the page, not the range', async () => {
    const svc = require('../src/services/lucyReminder');
    // `d llb all 2` dulu salah dibaca: `2` dianggap rentang -> pesan error.
    const msg = makeMessage('d llb all 2');
    assert.equal(await svc.handleMessage(msg), true);
    assert.ok(msg.replies[0].embeds, 'harus mengirim embed, bukan pesan error');
    assert.match(msg.replies[0].embeds[0].data.footer.text, /Halaman 1\/1/);
  });

  it('accepts several date formats', async () => {
    const svc = require('../src/services/lucyReminder');
    for (const [input, expect] of [
      ['5 nov', /5 nov 2026/],
      ['5 november', /5 nov 2026/],
      ['5/11', /5 nov 2026/],
      ['2026-11-05', /5 nov 2026/],
      ['7d', /7 hari/],
      ['all', /semua tanggal/]
    ]) {
      const msg = makeMessage('d llb pray ' + input);
      assert.equal(await svc.handleMessage(msg), true, input);
      assert.match(msg.replies[0].embeds[0].data.footer.text, expect, input);
    }
  });

  it('still reports an unknown range instead of silently showing today', async () => {
    const svc = require('../src/services/lucyReminder');
    const msg = makeMessage('d llb pray kemarin');
    await svc.handleMessage(msg);
    assert.match(msg.replies[0], /Rentang tidak dikenali/);
  });

  it('falls back to today when only a page number is given', async () => {
    const svc = require('../src/services/lucyReminder');
    const msg = makeMessage('d llb pray 2');
    assert.equal(await svc.handleMessage(msg), true);
    assert.ok(msg.replies[0].embeds, 'nomor halaman saja tetap menampilkan board');
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
