const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

let tempDir;

// Modul reminder menyimpan handle SQLite dan membaca prefix dari storage, jadi
// cache dibuang dan cwd dipindah ke temp agar tiap test berdiri sendiri.
function resetModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('reminder') || key.includes('lucyCounterStorage.js') || key.includes('storage.js')) {
      delete require.cache[key];
    }
  }
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-tracker-reminder-'));
  process.chdir(tempDir);
  delete process.env.DEVELOPER_IDS;
  resetModules();
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

let counter = 0;

function makeMessage(content, {
  guildId = 'guild1', channelId = 'chan1', userId = 'user1', name = 'Tester',
  admin = false, dev = false, guildOwner = false, guild = null, dmFails = false
} = {}) {
  const sent = [];
  const dms = [];
  const nextId = () => 'm' + (++counter);
  const channel = { id: channelId, send: async payload => { sent.push(payload); return { id: nextId() }; } };
  const resolvedGuild = guild || { id: guildId, ownerId: guildOwner ? userId : 'someone-else', name: 'Guild Satu', iconURL: () => 'https://cdn.discordapp.com/icons/1/a.png' };
  return {
    guildId,
    guild: resolvedGuild,
    channelId,
    author: { id: userId, bot: false, username: name },
    member: { displayName: name, nickname: name + '-nick', permissions: { has: () => admin } },
    content,
    client: {
      application: { owner: dev ? { id: userId } : null },
      channels: { fetch: async () => channel },
      guilds: { cache: new Map([[guildId, resolvedGuild]]) },
      users: {
        fetch: async id => ({
          id, username: 'user' + id, globalName: 'Global ' + id,
          displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/' + id + '/x.png',
          send: async payload => { if (dmFails) throw new Error('Cannot send messages to this user'); dms.push(payload); }
        })
      }
    },
    react: async () => {},
    reply: async payload => { sent.push(payload); return { id: nextId(), delete: async () => {} }; },
    channel,
    sent,
    dms
  };
}

// Gabungkan semua teks balasan, termasuk isi embed (semua balasan reminder
// dikirim sebagai embed).
function embedText(embed) {
  const data = embed?.data || embed || {};
  const parts = [data.title, data.description, data.footer?.text];
  for (const field of data.fields || []) parts.push(field.name, field.value);
  return parts.filter(Boolean).join('\n');
}

function textOf(message) {
  return message.sent
    .map(payload => {
      if (typeof payload === 'string') return payload;
      const embeds = (payload.embeds || []).map(embedText).join('\n');
      return [payload.content || '', embeds].filter(Boolean).join('\n');
    })
    .filter(Boolean)
    .join('\n');
}

// Teks dari DM (payload embed) untuk assertion.
function dmText(message) {
  return message.dms
    .map(payload => (typeof payload === 'string' ? payload : (payload.embeds || []).map(embedText).join('\n')))
    .filter(Boolean)
    .join('\n');
}

function idOf(message, prefix) {
  const match = textOf(message).match(new RegExp('`(' + prefix + '-[A-Z0-9]+)`'));
  return match ? match[1] : null;
}

const svc = () => require('../src/services/reminders');
const storage = () => require('../src/utils/reminderStorage');

// Kategori dan format wajib disebut (sesuai spesifikasi enam kombinasi).
async function makeTemplate(name = 'Template Satu', body = 'Halo {USER}', { category = 'PRAY_CURSE', format = 'NORMAL', dev = true } = {}) {
  const message = makeMessage('d r create ' + category + ' ' + format + ' ' + name + ' | ' + body, { userId: 'dev1', dev });
  await svc().handleMessage(message);
  return { templateId: idOf(message, 'T'), message };
}

async function awardAndRedeem(recipientId = '111222333444555666') {
  const { templateId } = await makeTemplate();
  const give = makeMessage('d r give <@' + recipientId + '> ' + templateId, { userId: 'dev1', dev: true });
  await svc().handleMessage(give);
  const claimId = idOf(give, 'C');
  const redeem = makeMessage('d r redeem ' + claimId, { userId: recipientId });
  await svc().handleMessage(redeem);
  return { templateId, claimId, reminderId: idOf(redeem, 'R'), give, redeem };
}

describe('custom reminder — prefix resolution', () => {
  it('works with the default prefix d', async () => {
    const { updateGuildSettings } = require('../src/utils/storage');
    updateGuildSettings('guild1', s => ({ ...s, prefix: 'd' }));
    const { templateId } = await makeTemplate();
    assert.ok(templateId, 'template dibuat dengan prefix default');
  });

  it('follows a custom prefix configured for guild A', async () => {
    const { updateGuildSettings } = require('../src/utils/storage');
    updateGuildSettings('guild1', s => ({ ...s, prefix: '!' }));
    const ok = makeMessage('! r help', { guildId: 'guild1' });
    assert.equal(await svc().handleMessage(ok), true);
    assert.match(textOf(ok), /Custom Reminder/);
    assert.equal(await svc().handleMessage(makeMessage('d r help', { guildId: 'guild1' })), false);
  });

  it('keeps guild B on a different prefix independently', async () => {
    const { updateGuildSettings } = require('../src/utils/storage');
    updateGuildSettings('guildA', s => ({ ...s, prefix: '!' }));
    updateGuildSettings('guildB', s => ({ ...s, prefix: '?' }));
    assert.equal(await svc().handleMessage(makeMessage('! r help', { guildId: 'guildA' })), true);
    assert.equal(await svc().handleMessage(makeMessage('? r help', { guildId: 'guildB' })), true);
    assert.equal(await svc().handleMessage(makeMessage('? r help', { guildId: 'guildA' })), false);
    assert.equal(await svc().handleMessage(makeMessage('! r help', { guildId: 'guildB' })), false);
  });

  it('keeps reminder commands working after the prefix changes', async () => {
    const { updateGuildSettings, getGuildSettings } = require('../src/utils/storage');
    const { templateId } = await makeTemplate();
    updateGuildSettings('guild1', s => ({ ...s, prefix: 'lucy' }));
    assert.equal(getGuildSettings('guild1').prefix, 'lucy');
    const after = makeMessage('lucy r templates', { userId: 'dev1', dev: true });
    assert.equal(await svc().handleMessage(after), true);
    assert.match(textOf(after), new RegExp(templateId));
  });

  it('ignores unrelated messages and other bots', async () => {
    assert.equal(await svc().handleMessage(makeMessage('d bos status')), false);
    const bot = makeMessage('d r help');
    bot.author.bot = true;
    assert.equal(await svc().handleMessage(bot), false);
  });
});

describe('custom reminder — developer authorization', () => {
  it('lets only the existing developer ID create templates and award reminders', async () => {
    const denied = makeMessage('d r create PRAY_CURSE NORMAL Nakal | x', { userId: 'user9' });
    await svc().handleMessage(denied);
    assert.match(textOf(denied), /Hanya developer bot/);
    assert.equal(storage().listTemplates().length, 0);

    const dev = makeMessage('d r create PRAY_CURSE NORMAL Sah | y', { userId: 'dev1', dev: true });
    await svc().handleMessage(dev);
    assert.equal(storage().listTemplates().length, 1);

    // Penerima biasa tidak bisa memberi reminder ke dirinya sendiri.
    const selfGive = makeMessage('d r give <@user9> ' + idOf(dev, 'T'), { userId: 'user9' });
    await svc().handleMessage(selfGive);
    assert.match(textOf(selfGive), /Hanya developer bot/);
    assert.equal(storage().listAwards().length, 0);
  });

  it('honours DEVELOPER_IDS and the guild owner, not server roles or names', async () => {
    process.env.DEVELOPER_IDS = 'envdev';
    assert.equal(await svc().handleMessage(makeMessage('d r create PRAY_CURSE NORMAL A | x', { userId: 'envdev' })), true);
    const admin = makeMessage('d r create PRAY_CURSE NORMAL B | y', { userId: 'user1', admin: true });
    await svc().handleMessage(admin);
    assert.match(textOf(admin), /Hanya developer bot/);
    assert.equal(await svc().handleMessage(makeMessage('d r create PRAY_CURSE NORMAL C | z', { userId: 'user1', guildOwner: true })), true);
  });

  it('rejects unknown subcommands with a helpful message', async () => {
    const message = makeMessage('d r tidakada');
    await svc().handleMessage(message);
    assert.match(textOf(message), /Perintah tidak dikenal/);
  });
});

describe('custom reminder — award and redeem flow', () => {
  it('awards a reminder once and DMs the recipient the claim ID', async () => {
    const { templateId } = await makeTemplate();
    const give = makeMessage('d r give <@111222333444555666> ' + templateId, { userId: 'dev1', dev: true });
    await svc().handleMessage(give);
    const claimId = idOf(give, 'C');
    assert.ok(claimId);
    assert.equal(give.dms.length, 1, 'DM instruksi terkirim');
    assert.match(dmText(give), new RegExp(claimId));
    assert.match(dmText(give), /r redeem/);
    const award = storage().getAward(claimId);
    assert.equal(award.recipientId, '111222333444555666');
    assert.equal(award.issuerId, 'dev1', 'developer penerbit tercatat');
    assert.equal(award.status, 'pending');
  });

  it('does not duplicate a manual award for the same template and recipient', async () => {
    const { templateId } = await makeTemplate();
    await svc().handleMessage(makeMessage('d r give <@111222333444555666> ' + templateId, { userId: 'dev1', dev: true }));
    const second = makeMessage('d r give <@111222333444555666> ' + templateId, { userId: 'dev1', dev: true });
    await svc().handleMessage(second);
    assert.match(textOf(second), /sudah ada/);
    assert.equal(storage().listAwards({ recipientId: '111222333444555666' }).length, 1);
  });

  it('awards a reminder exactly once when the same source event is replayed', async () => {
    const { templateId } = await makeTemplate();
    const args = { templateId, recipientId: '111222333444555666', source: 'giveaway', sourceRef: 'GW-1' };
    const first = svc().awardReminder(args);
    const second = svc().awardReminder(args);
    assert.equal(first.created, true);
    assert.equal(second.created, false, 'event kedua tidak membuat award baru');
    assert.equal(second.award.claimId, first.award.claimId);
    assert.equal(storage().listAwards({ recipientId: '111222333444555666' }).length, 1);
  });

  it('handles duplicate giveaway completion events through the giveaway hook', async () => {
    const { templateId } = await makeTemplate();
    const client = makeMessage('d r help').client;
    const payload = { client, guildId: 'guild1', giveawayId: 'GW-9', winnerId: '111222333444555666', templateId };
    const a = await svc().onGiveawayWinner(payload);
    const b = await svc().onGiveawayWinner(payload);
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(storage().listAwards({ recipientId: '111222333444555666' }).length, 1);
  });

  it('redeems a claim into an owned reminder and refuses duplicates', async () => {
    const { claimId, reminderId } = await awardAndRedeem();
    assert.ok(reminderId, 'reminder dibuat saat redeem');
    assert.equal(storage().getAward(claimId).status, 'redeemed');
    assert.equal(storage().getReminder(reminderId).ownerId, '111222333444555666');

    const again = makeMessage('d r redeem ' + claimId, { userId: '111222333444555666' });
    await svc().handleMessage(again);
    assert.match(textOf(again), /sudah diklaim/);
    assert.equal(storage().listRemindersByOwner('111222333444555666').length, 1);
  });

  it('only lets the assigned recipient redeem, and refuses revoked or expired awards', async () => {
    const { templateId } = await makeTemplate();
    const give = makeMessage('d r give <@111222333444555666> ' + templateId, { userId: 'dev1', dev: true });
    await svc().handleMessage(give);
    const claimId = idOf(give, 'C');

    const wrong = makeMessage('d r redeem ' + claimId, { userId: '999888777666555444' });
    await svc().handleMessage(wrong);
    assert.match(textOf(wrong), /bukan milikmu/);
    assert.equal(storage().getAward(claimId).status, 'pending');

    storage().revokeAward({ claimId, actorId: 'dev1' });
    const revoked = makeMessage('d r redeem ' + claimId, { userId: '111222333444555666' });
    await svc().handleMessage(revoked);
    assert.match(textOf(revoked), /sudah dicabut/);

    const expired = svc().awardReminder({ templateId, recipientId: '111222333444555666', source: 'giveaway', sourceRef: 'GW-X', expiresAt: Date.now() - 1000 });
    const late = makeMessage('d r redeem ' + expired.award.claimId, { userId: '111222333444555666' });
    await svc().handleMessage(late);
    assert.match(textOf(late), /kedaluwarsa/);
  });

  it('tells the developer when the DM cannot be delivered', async () => {
    const { templateId } = await makeTemplate();
    const give = makeMessage('d r give <@111222333444555666> ' + templateId, { userId: 'dev1', dev: true, dmFails: true });
    await svc().handleMessage(give);
    assert.match(textOf(give), /DM gagal/);
    assert.match(textOf(give), new RegExp(idOf(give, 'C')), 'claim ID tetap diberikan');
  });

  it('rejects malformed IDs and unknown templates', async () => {
    const badClaim = makeMessage('d r redeem NOPE');
    await svc().handleMessage(badClaim);
    assert.match(textOf(badClaim), /Format claim ID/);

    const give = makeMessage('d r give <@111222333444555666> T-XXXXXX', { userId: 'dev1', dev: true });
    await svc().handleMessage(give);
    assert.match(textOf(give), /tidak ditemukan/);
  });

  it('exposes the award list with claim statuses to developers only', async () => {
    const { claimId } = await awardAndRedeem();
    const list = makeMessage('d r awards', { userId: 'dev1', dev: true });
    await svc().handleMessage(list);
    assert.match(textOf(list), new RegExp(claimId));
    assert.match(textOf(list), /redeemed/);

    const denied = makeMessage('d r awards', { userId: 'user9' });
    await svc().handleMessage(denied);
    assert.match(textOf(denied), /Hanya developer bot/);
  });
});

describe('custom reminder — ownership and permissions', () => {
  it('refuses edits by anyone other than the owner', async () => {
    const { reminderId } = await awardAndRedeem();
    const other = makeMessage('d r update ' + reminderId + ' diretas', { userId: 'user9' });
    await svc().handleMessage(other);
    assert.match(textOf(other), /hanya bisa mengubah reminder milikmu/);
    assert.equal(storage().getReminder(reminderId).message, 'Halo {USER}');
  });

  it('blocks non-owners from embed, collectible, enable and reset too', async () => {
    const { reminderId } = await awardAndRedeem();
    for (const command of [
      'd r embed ' + reminderId + ' {"title":"x"}',
      'd r setcollectible ' + reminderId + ' rare',
      'd r enable ' + reminderId,
      'd r reset ' + reminderId
    ]) {
      const message = makeMessage(command, { userId: 'user9' });
      await svc().handleMessage(message);
      assert.match(textOf(message), /bukan milikmu|hanya bisa|Hanya pemilik/, command);
    }
    assert.equal(storage().getReminder(reminderId).active, false);
    assert.equal(storage().getReminder(reminderId).collectible, null);
  });

  it('transfers ownership only after confirmation and revokes the old owner', async () => {
    const { reminderId } = await awardAndRedeem();
    const owner = '111222333444555666';
    const target = '999888777666555444';

    // Transfer hanya boleh untuk reminder yang ditandai shareable.
    const notShareable = makeMessage('d r send <@' + target + '> ' + reminderId, { userId: owner });
    await svc().handleMessage(notShareable);
    assert.match(textOf(notShareable), /belum ditandai shareable/);
    await svc().handleMessage(makeMessage('d r shareable ' + reminderId + ' on', { userId: owner }));

    const send = makeMessage('d r send <@' + target + '> ' + reminderId, { userId: owner });
    await svc().handleMessage(send);
    assert.match(textOf(send), /memindahkan kepemilikan/);
    assert.equal(storage().getReminder(reminderId).ownerId, owner, 'belum berpindah sebelum konfirmasi');

    const confirm = makeMessage('d r confirm', { userId: owner });
    await svc().handleMessage(confirm);
    assert.equal(storage().getReminder(reminderId).ownerId, target);

    const oldOwner = makeMessage('d r update ' + reminderId + ' masih bisa?', { userId: owner });
    await svc().handleMessage(oldOwner);
    assert.match(textOf(oldOwner), /hanya bisa mengubah reminder milikmu/);
    assert.equal(storage().getReminder(reminderId).message, 'Halo {USER}');
  });

  it('lets a cancelled transfer leave ownership untouched', async () => {
    const { reminderId } = await awardAndRedeem();
    const owner = '111222333444555666';
    await svc().handleMessage(makeMessage('d r send <@999888777666555444> ' + reminderId, { userId: owner }));
    await svc().handleMessage(makeMessage('d r cancel', { userId: owner }));
    assert.equal(storage().getReminder(reminderId).ownerId, owner);
  });

  it('keeps ownership and award state after a restart', async () => {
    const { reminderId, claimId } = await awardAndRedeem();
    await svc().handleMessage(makeMessage('d r enable ' + reminderId, { userId: '111222333444555666' }));
    resetModules();
    assert.equal(storage().getReminder(reminderId).ownerId, '111222333444555666');
    assert.equal(storage().getReminder(reminderId).active, true);
    assert.equal(storage().getAward(claimId).status, 'redeemed');
  });

  it('records an audit trail for awards and transfers', async () => {
    const { reminderId, claimId } = await awardAndRedeem();
    await svc().handleMessage(makeMessage('d r shareable ' + reminderId + ' on', { userId: '111222333444555666' }));
    await svc().handleMessage(makeMessage('d r send <@999888777666555444> ' + reminderId, { userId: '111222333444555666' }));
    await svc().handleMessage(makeMessage('d r confirm', { userId: '111222333444555666' }));
    const actions = storage().listAudit({ reminderId }).map(a => a.action);
    assert.ok(actions.includes('reminder_transfer'));
    const awardAudit = storage().listAudit({ claimId }).map(a => a.action);
    assert.ok(awardAudit.includes('award_create'));
    assert.ok(awardAudit.includes('award_redeem'));
  });
});

describe('custom reminder — customization commands', () => {
  it('updates the message and resets to template defaults with confirmation', async () => {
    const { reminderId } = await awardAndRedeem();
    const owner = '111222333444555666';
    await svc().handleMessage(makeMessage('d r update ' + reminderId + ' Pesan baru {USER}', { userId: owner }));
    assert.equal(storage().getReminder(reminderId).message, 'Pesan baru {USER}');

    await svc().handleMessage(makeMessage('d r setcollectible ' + reminderId + ' epic', { userId: owner }));
    assert.equal(storage().getReminder(reminderId).collectible, 'epic');

    const reset = makeMessage('d r reset ' + reminderId, { userId: owner });
    await svc().handleMessage(reset);
    assert.match(textOf(reset), /akan mengembalikan/);
    assert.equal(storage().getReminder(reminderId).message, 'Pesan baru {USER}', 'belum berubah sebelum konfirmasi');

    await svc().handleMessage(makeMessage('d r confirm', { userId: owner }));
    const reminder = storage().getReminder(reminderId);
    assert.equal(reminder.message, 'Halo {USER}', 'kembali ke bawaan template');
    assert.equal(reminder.collectible, null);
  });

  it('validates collectible values and lists supported ones', async () => {
    const { reminderId } = await awardAndRedeem();
    const owner = '111222333444555666';
    const bad = makeMessage('d r setcollectible ' + reminderId + ' tier_dewa', { userId: owner });
    await svc().handleMessage(bad);
    assert.match(textOf(bad), /tidak dikenal/);
    assert.match(textOf(bad), /legendary/, 'menyebut pilihan yang didukung');
    assert.equal(storage().getReminder(reminderId).collectible, null);
  });

  it('honours per-guild extra collectibles from configuration', async () => {
    const { updateGuildSettings } = require('../src/utils/storage');
    const { reminderId } = await awardAndRedeem();
    updateGuildSettings('guild1', s => ({ ...s, reminders: { ...s.reminders, collectibles: ['event_khusus'] } }));
    const ok = makeMessage('d r setcollectible ' + reminderId + ' event_khusus', { userId: '111222333444555666' });
    await svc().handleMessage(ok);
    assert.match(textOf(ok), /event_khusus/);
    assert.equal(storage().getReminder(reminderId).collectible, 'event_khusus');
  });

  it('enables and disables reminders and lists active ones', async () => {
    const { reminderId } = await awardAndRedeem();
    const owner = '111222333444555666';
    await svc().handleMessage(makeMessage('d r enable ' + reminderId, { userId: owner }));
    assert.equal(storage().getReminder(reminderId).active, true);
    assert.ok(storage().getReminder(reminderId).activatedAt, 'waktu aktivasi tercatat');
    const active = makeMessage('d r active', { userId: owner });
    await svc().handleMessage(active);
    assert.match(textOf(active), new RegExp(reminderId));

    await svc().handleMessage(makeMessage('d r disable ' + reminderId, { userId: owner }));
    assert.equal(storage().getReminder(reminderId).active, false);
  });

  it('shows inventory, view and info for the owner', async () => {
    const { reminderId } = await awardAndRedeem();
    const owner = '111222333444555666';
    const inventory = makeMessage('d r inventory', { userId: owner });
    await svc().handleMessage(inventory);
    const invEmbed = inventory.sent.at(-1).embeds[0].data;
    assert.match(invEmbed.description, new RegExp(reminderId));
    assert.match(invEmbed.description, /Pray\/Curse Reminder \(Normal\)/, 'kategori + format tampil');

    const view = makeMessage('d r view ' + reminderId, { userId: owner });
    await svc().handleMessage(view);
    const embed = view.sent.at(-1).embeds[0].data;
    assert.match(embed.description, /user111222333444555666/, 'variabel USER ter-render sebagai username');

    // `r info` adalah alias `r view`.
    const info = makeMessage('d r info ' + reminderId, { userId: owner });
    await svc().handleMessage(info);
    assert.match(textOf(info), new RegExp(reminderId));
    assert.match(textOf(info), /Pray\/Curse Reminder/);
  });

  it('keeps view and info away from non-owners', async () => {
    const { reminderId } = await awardAndRedeem();
    const view = makeMessage('d r view ' + reminderId, { userId: 'user9' });
    await svc().handleMessage(view);
    assert.match(textOf(view), /bukan milikmu/);
  });
});

describe('custom reminder — embed validation', () => {
  it('rejects invalid JSON with an actionable error', async () => {
    const { reminderId } = await awardAndRedeem();
    const message = makeMessage('d r embed ' + reminderId + ' {bukan json}', { userId: '111222333444555666' });
    await svc().handleMessage(message);
    assert.match(textOf(message), /JSON tidak valid/);
    assert.equal(storage().getReminder(reminderId).embed, null);
  });

  it('rejects unsafe URL schemes and unknown fields', async () => {
    const { reminderId } = await awardAndRedeem();
    const owner = '111222333444555666';
    const evil = makeMessage('d r embed ' + reminderId + ' {"title":"x","url":"javascript:alert(1)"}', { userId: owner });
    await svc().handleMessage(evil);
    assert.match(textOf(evil), /url harus URL https/);

    const unknown = makeMessage('d r embed ' + reminderId + ' {"title":"x","webhook":"https://evil.example"}', { userId: owner });
    await svc().handleMessage(unknown);
    assert.match(textOf(unknown), /Field tidak dikenal/);
    assert.equal(storage().getReminder(reminderId).embed, null);
  });

  it('accepts a valid embed and stores it normalized', async () => {
    const { reminderId } = await awardAndRedeem();
    const owner = '111222333444555666';
    const message = makeMessage('d r embed ' + reminderId + ' {"title":"Halo","color":"#ff0000","footer":{"text":"{SERVER_NAME}"}}', { userId: owner });
    await svc().handleMessage(message);
    assert.match(textOf(message), /Tersimpan/);
    const embed = storage().getReminder(reminderId).embed;
    assert.equal(embed.color, 0xff0000, 'hex dinormalkan ke integer');
  });

  it('enforces Discord embed limits', async () => {
    const { reminderId } = await awardAndRedeem();
    const owner = '111222333444555666';
    const tooLong = makeMessage('d r embed ' + reminderId + ' {"title":"' + 'x'.repeat(300) + '"}', { userId: owner });
    await svc().handleMessage(tooLong);
    assert.match(textOf(tooLong), /melebihi 256/);

    const tooMany = makeMessage('d r embed ' + reminderId + ' {"fields":' + JSON.stringify(Array.from({ length: 26 }, (_, i) => ({ name: 'n' + i, value: 'v' }))) + '}', { userId: owner });
    await svc().handleMessage(tooMany);
    assert.match(textOf(tooMany), /maksimal 25/);
    assert.equal(storage().getReminder(reminderId).embed, null);
  });
});

describe('custom reminder — Tenor utility', () => {
  it('accepts direct media.tenor.com URLs', async () => {
    const { resolveTenor } = require('../src/utils/reminderValidate');
    const result = await resolveTenor('https://media.tenor.com/abc/xyz.gif');
    assert.equal(result.ok, true);
    assert.equal(result.value, 'https://media.tenor.com/abc/xyz.gif');
  });

  it('rejects unsafe schemes and non-Tenor hosts', async () => {
    const { resolveTenor } = require('../src/utils/reminderValidate');
    assert.equal((await resolveTenor('javascript:alert(1)')).ok, false);
    assert.equal((await resolveTenor('http://media.tenor.com/a.gif')).ok, false);
    assert.equal((await resolveTenor('https://evil.example/x.gif')).ok, false);
    assert.equal((await resolveTenor('https://media.tenor.com/a.txt')).ok, false);
  });

  it('resolves a Tenor view page through an injected fetch', async () => {
    const { resolveTenor } = require('../src/utils/reminderValidate');
    const fetchFn = async () => ({ ok: true, text: async () => '<meta property="og:image" content="https://media.tenor.com/ZZZ/abc.gif">' });
    const result = await resolveTenor('https://tenor.com/view/something-123', { fetchFn });
    assert.equal(result.ok, true);
    assert.equal(result.value, 'https://media.tenor.com/ZZZ/abc.gif');

    const failing = await resolveTenor('https://tenor.com/view/x', { fetchFn: async () => ({ ok: false, status: 404 }) });
    assert.equal(failing.ok, false);
  });
});

describe('custom reminder — variables', () => {
  const variables = () => require('../src/utils/reminderVariables');

  it('resolves every user variable and falls back when data is missing', () => {
    const context = variables().createRenderContext({
      user: {
        id: '123', name: 'ani', displayName: 'Ani', nickname: 'Ani N', mention: '<@123>',
        avatarUrl: 'https://cdn.discordapp.com/avatars/123/x.png',
        serverAvatarUrl: 'https://cdn.discordapp.com/guilds/1/users/123/avatars/y.png'
      },
      guild: { name: 'Guild Satu', iconUrl: 'https://cdn.discordapp.com/icons/1/a.png' }
    });
    assert.equal(variables().render('{USER}', context), 'ani', '{USER} tanpa mention');
    assert.equal(variables().render('{USER_MENTION}', context), '<@123>');
    assert.equal(variables().render('{USER_ID}', context), '123');
    assert.equal(variables().render('{USER_NAME}', context), 'ani');
    assert.equal(variables().render('{USER_DISPLAYNAME}', context), 'Ani');
    assert.equal(variables().render('{USER_NICKNAME}', context), 'Ani N');
    assert.match(variables().render('{USER_AVATAR}', context), /^https:\/\/cdn\.discordapp\.com/);
    assert.match(variables().render('{USER_SERVERAVATAR}', context), /^https:\/\/cdn\.discordapp\.com/);

    const empty = variables().createRenderContext({ user: { id: '1' } });
    assert.equal(variables().render('{USER_NICKNAME}', empty), variables().FALLBACK);
    assert.equal(variables().render('{USER_AVATAR}', empty), variables().FALLBACK);
    assert.equal(variables().render('{SERVER_ICON}', empty), variables().FALLBACK);
    assert.equal(variables().render('{SERVER_NAME}', empty), variables().FALLBACK);
  });

  it('rejects non-Discord avatar URLs', () => {
    const context = variables().createRenderContext({ user: { id: '1', avatarUrl: 'https://evil.example/x.png' } });
    assert.equal(variables().render('{USER_AVATAR}', context), variables().FALLBACK);
  });

  it('resolves random and time variables consistently within one render', () => {
    const context = variables().createRenderContext({ user: { id: '1' } });
    const out = variables().render('{EMOJI} {EMOJI} {FLAG}', context);
    const [emojiA, emojiB] = out.split(' ');
    assert.equal(emojiA, emojiB, 'emoji sama dalam satu render');

    const time = variables().render('{TIME} {DAILY} {DAILY_TOMORROW} {DAILY_YESTERDAY}', context);
    const [now, daily, tomorrow, yesterday] = time.split(' ').map(Number);
    assert.ok(Number.isFinite(now) && Number.isFinite(daily));
    assert.equal(daily - yesterday, 86400, 'selisih harian tepat 1 hari');
    assert.equal(tomorrow - daily, 86400);
    assert.match(variables().render('<t:{DAILY_TOMORROW}:R>', context), /^<t:\d+:R>$/);
  });

  it('falls back for goal variables when the target system is off', () => {
    const context = variables().createRenderContext({ guildId: 'guild1', user: { id: '1' } });
    assert.equal(context.goal.available, false);
    assert.equal(variables().render('{GOAL}', context), variables().FALLBACK);
    assert.equal(variables().render('{GOAL_PROGRESS}', context), variables().FALLBACK);
    assert.equal(variables().render('{GOAL_PROGRESS_INVERTED}', context), variables().FALLBACK);
    assert.equal(variables().render('{GOAL_END}', context), variables().FALLBACK);
  });

  it('reads goal values from the existing Lucy target system when enabled', () => {
    const { updateGuildSettings, getGuildSettings } = require('../src/utils/storage');
    updateGuildSettings('guild1', s => ({ ...s, lucyCounter: { ...s.lucyCounter, targetEnabled: true, targetGoal: 10 } }));
    const lucyStore = require('../src/utils/lucyCounterStorage');
    const { dayKey, challengeCycleKey } = require('../src/services/lucyCounter');
    const cycle = challengeCycleKey(new Date(), getGuildSettings('guild1').lucyCounter);
    lucyStore.recordLucy({ guildId: 'guild1', userId: 'user1', name: 'Ani', day: dayKey(), cycleKey: cycle, targetActive: true, goal: 10 });
    lucyStore.recordLucy({ guildId: 'guild1', userId: 'user1', name: 'Ani', day: dayKey(), cycleKey: cycle, targetActive: true, goal: 10 });

    const context = variables().createRenderContext({ guildId: 'guild1', user: { id: 'user1' } });
    assert.equal(context.goal.available, true);
    assert.equal(context.goal.progress, 2);
    assert.equal(variables().render('{GOAL}', context), '10');
    assert.equal(variables().render('{GOAL_PROGRESS}', context), '2');
    assert.equal(variables().render('{GOAL_PROGRESS_INVERTED}', context), '8');
    assert.equal(variables().render('{GOAL_END}', context), '10');
  });

  it('leaves unknown variables untouched and prevents recursive expansion', () => {
    const context = variables().createRenderContext({ user: { id: '1', name: 'ani' } });
    assert.equal(variables().render('{TIDAK_ADA}', context), '{TIDAK_ADA}');
    assert.deepEqual(variables().unknownVariables('{TIDAK_ADA} {USER}'), ['TIDAK_ADA']);
    const injected = variables().createRenderContext({ user: { id: '1', name: '{USER}' } });
    assert.equal(variables().render('{USER_NAME}', injected), '{USER}');
  });

  it('caps excessive output length', () => {
    const context = variables().createRenderContext({ user: { id: '1' } });
    const long = variables().render('{EMOJI}'.repeat(3000), context);
    assert.ok(long.length <= variables().MAX_OUTPUT_LENGTH);
  });

  it('interpolates embed text fields but not structural values', () => {
    const context = variables().createRenderContext({ user: { id: '1', name: 'ani', mention: '<@1>' }, guild: { name: 'G' } });
    const embed = variables().renderEmbed({
      title: 'Halo {USER_MENTION}', description: '{SERVER_NAME}',
      footer: { text: '{USER}' }, author: { name: '{USER}' },
      fields: [{ name: '{USER}', value: '{SERVER_NAME}' }],
      color: 0x123456, url: 'https://example.com/{USER}'
    }, context);
    assert.equal(embed.title, 'Halo <@1>', 'USER_MENTION menghasilkan mention');
    assert.equal(embed.description, 'G');
    assert.equal(embed.footer.text, 'ani', '{USER} tanpa mention');
    assert.equal(embed.author.name, 'ani');
    assert.equal(embed.fields[0].name, 'ani');
    assert.equal(embed.color, 0x123456, 'nilai non-teks tidak diubah');
    assert.equal(embed.url, 'https://example.com/{USER}', 'url tidak diinterpolasi');
  });

  it('documents every variable in the reference', () => {
    const reference = variables().variableReference();
    const names = reference.map(r => r.name.replace(/[{}]/g, ''));
    assert.deepEqual(names.sort(), variables().VARIABLE_NAMES.slice().sort());
    for (const item of reference) assert.ok(item.description && item.description.length > 3, item.name);
  });
});


describe('custom reminder — storage schema and IDs', () => {
  it('creates the schema with a version marker and validates IDs', () => {
    const store = storage();
    store.getDb();
    assert.ok(store.SCHEMA_VERSION);
    assert.equal(store.isValidTemplateId('T-ABC123'), true);
    assert.equal(store.isValidTemplateId('R-ABC123'), false);
    assert.equal(store.isValidClaimId('C-ABC123'), true);
    assert.equal(store.isValidReminderId('R-ABC123'), true);
    assert.equal(store.isValidReminderId('X-ABC123'), false);
    assert.equal(store.isValidUserId('123'), false);
    assert.equal(store.isValidUserId('111222333444555666'), true);
  });

  it('keeps template, claim and reminder IDs distinct', async () => {
    const { templateId, claimId, reminderId } = await awardAndRedeem();
    assert.match(templateId, /^T-/);
    assert.match(claimId, /^C-/);
    assert.match(reminderId, /^R-/);
    assert.notEqual(templateId, claimId);
    assert.notEqual(claimId, reminderId);
  });

  it('persists templates across a restart', async () => {
    const { templateId } = await makeTemplate('Tetap Ada', 'Isi {USER}');
    resetModules();
    const template = storage().getTemplate(templateId);
    assert.equal(template.name, 'Tetap Ada');
    assert.equal(template.message, 'Isi {USER}');
  });

  it('never lets a user gain developer power through names or arguments', async () => {
    const spoof = makeMessage('d r create PRAY_CURSE NORMAL X | y', { userId: '999888777666555444', name: 'dev1' });
    await svc().handleMessage(spoof);
    assert.match(textOf(spoof), /Hanya developer bot/);
    assert.equal(storage().listTemplates().length, 0);
  });
});

describe('custom reminder — categories, formats and six combinations', () => {
  it('creates all six category-format combinations', async () => {
    const { CATEGORY_KEYS, FORMAT_KEYS } = require('../src/utils/reminderCategories');
    let n = 0;
    for (const category of CATEGORY_KEYS) {
      for (const format of FORMAT_KEYS) {
        const { templateId } = await makeTemplate('T' + n, 'Isi ' + category + ' ' + format, { category, format });
        assert.ok(templateId, category + '/' + format);
        const template = storage().getTemplate(templateId);
        assert.equal(template.category, category);
        assert.equal(template.format, format);
        n++;
      }
    }
    assert.equal(n, 6, 'enam kombinasi');
    assert.equal(storage().listTemplates().length, 6);
  });

  it('keeps category and format as separate properties', () => {
    const cats = require('../src/utils/reminderCategories');
    assert.equal(cats.normalizeCategory('pray_curse'), 'PRAY_CURSE');
    assert.equal(cats.normalizeCategory('EMBED'), null, 'format bukan kategori');
    assert.equal(cats.normalizeFormat('embed'), 'EMBED');
    assert.equal(cats.normalizeFormat('PRAY_CURSE'), null, 'kategori bukan format');
    assert.equal(cats.displayNameFor('HUNT_BATTLE', 'EMBED'), 'Hunt/Battle Reminder (Embed)');
    assert.equal(cats.combinations().length, 6);
    // Kategori gabungan memetakan aksi engine yang sesuai.
    assert.deepEqual(cats.CATEGORIES.PRAY_CURSE.actions, ['pray', 'curse']);
    assert.deepEqual(cats.CATEGORIES.HUNT_BATTLE.actions, ['hunt', 'battle']);
    assert.deepEqual(cats.CATEGORIES.LUCY.actions, ['lucy']);
  });

  it('rejects a create command without an explicit category and format', async () => {
    const message = makeMessage('d r create Tanpa Kategori | isi', { userId: 'dev1', dev: true });
    await svc().handleMessage(message);
    assert.match(textOf(message), /Format:/);
    assert.match(textOf(message), /Kategori: PRAY_CURSE/);
    assert.equal(storage().listTemplates().length, 0);
  });

  it('does not expose a DAILY category', () => {
    const cats = require('../src/utils/reminderCategories');
    assert.equal(cats.normalizeCategory('DAILY'), null);
    assert.ok(!cats.CATEGORY_KEYS.includes('DAILY'));
  });

  it('preserves category and format through award, redeem and edit', async () => {
    const { templateId } = await makeTemplate('Hunt Embed', 'Serang!', { category: 'HUNT_BATTLE', format: 'EMBED' });
    const give = makeMessage('d r give <@111222333444555666> ' + templateId, { userId: 'dev1', dev: true });
    await svc().handleMessage(give);
    const redeem = makeMessage('d r redeem ' + idOf(give, 'C'), { userId: '111222333444555666' });
    await svc().handleMessage(redeem);
    const reminderId = idOf(redeem, 'R');
    assert.equal(storage().getReminder(reminderId).category, 'HUNT_BATTLE');
    assert.equal(storage().getReminder(reminderId).format, 'EMBED');

    // Edit pesan dan embed tidak mengubah kategori/format.
    await svc().handleMessage(makeMessage('d r update ' + reminderId + ' teks baru', { userId: '111222333444555666' }));
    await svc().handleMessage(makeMessage('d r embed ' + reminderId + ' {"title":"x"}', { userId: '111222333444555666' }));
    const after = storage().getReminder(reminderId);
    assert.equal(after.category, 'HUNT_BATTLE');
    assert.equal(after.format, 'EMBED');
    assert.equal(after.message, 'teks baru');
  });
});

describe('custom reminder — server default settings via s namespace', () => {
  function adminMessage(content, { userId = 'admin1', admin = true, guildOwner = false, dev = false } = {}) {
    return makeMessage(content, { userId, admin, guildOwner, dev });
  }

  it('lets a server admin set and reset a server default', async () => {
    const set = adminMessage('d s pray set text {mention} jangan lupa doa!');
    await require('../src/commands/prefix').handlePrefixCommand(set, null, { send: (m, payload) => m.reply(payload) });
    assert.match(textOf(set), /disimpan/);
    const stored = storage().getGuildReminderSetting('guild1', 'pray');
    assert.equal(stored.message, '{mention} jangan lupa doa!');
    assert.equal(stored.format, 'NORMAL');

    const reset = adminMessage('d s pray reset');
    await require('../src/commands/prefix').handlePrefixCommand(reset, null, { send: (m, payload) => m.reply(payload) });
    assert.match(textOf(reset), /dikembalikan ke bawaan/);
    assert.equal(storage().getGuildReminderSetting('guild1', 'pray'), null);
  });

  it('refuses members without server admin permission', async () => {
    const message = adminMessage('d s pray set text nakal', { userId: 'user9', admin: false });
    await require('../src/commands/prefix').handlePrefixCommand(message, null, { send: (m, payload) => m.reply(payload) });
    assert.match(textOf(message), /Only server admins & owners can change this setting/);
    assert.equal(storage().getGuildReminderSetting('guild1', 'pray'), null);
  });

  it('does not let a developer ID alone change server defaults', async () => {
    // dev=true (application owner) tapi bukan admin server dan bukan pemilik guild.
    const message = adminMessage('d s pray set text dev coba', { userId: 'dev1', admin: false, dev: true });
    await require('../src/commands/prefix').handlePrefixCommand(message, null, { send: (m, payload) => m.reply(payload) });
    assert.match(textOf(message), /Only server admins & owners/);
    assert.equal(storage().getGuildReminderSetting('guild1', 'pray'), null);
  });

  it('lets the guild owner change settings', async () => {
    const message = adminMessage('d s hunt set text serang!', { userId: 'owner1', admin: false, guildOwner: true });
    await require('../src/commands/prefix').handlePrefixCommand(message, null, { send: (m, payload) => m.reply(payload) });
    assert.match(textOf(message), /disimpan/);
    assert.equal(storage().getGuildReminderSetting('guild1', 'hunt').message, 'serang!');
    assert.equal(storage().getGuildReminderSetting('guild1', 'battle').message, 'serang!', 'hunt dan battle satu baris');
  });

  it('isolates settings per guild', async () => {
    const setA = makeMessage('d s pray set text guild A', { guildId: 'guildA', userId: 'a1', admin: true });
    await require('../src/commands/prefix').handlePrefixCommand(setA, null, { send: (m, payload) => m.reply(payload) });
    const setB = makeMessage('d s pray set text guild B', { guildId: 'guildB', userId: 'b1', admin: true });
    await require('../src/commands/prefix').handlePrefixCommand(setB, null, { send: (m, payload) => m.reply(payload) });

    assert.equal(storage().getGuildReminderSetting('guildA', 'pray').message, 'guild A');
    assert.equal(storage().getGuildReminderSetting('guildB', 'pray').message, 'guild B');
    // Kategori lain di guild yang sama tetap kosong.
    assert.equal(storage().getGuildReminderSetting('guildA', 'battle'), null);
    assert.equal(storage().getGuildReminderSetting('guildA', 'lucy'), null);
  });

  it('s pray dan s curse menulis pengaturan kategori yang sama', async () => {
    // `pray` adalah aksi kasar (mewakili kategori PRAY_CURSE), jadi keduanya
    // harus mengarah ke satu baris dan tidak lagi terpisah.
    const setPray = makeMessage('d s pray set text teks pray', { userId: 'admin1', admin: true });
    await require('../src/commands/prefix').handlePrefixCommand(setPray, null, { send: (m, payload) => m.reply(payload) });
    assert.equal(storage().getGuildReminderSetting('guild1', 'curse').message, 'teks pray', 's pray ikut berlaku untuk curse');

    const setCurse = makeMessage('d s curse set text teks curse', { userId: 'admin1', admin: true });
    await require('../src/commands/prefix').handlePrefixCommand(setCurse, null, { send: (m, payload) => m.reply(payload) });
    assert.equal(storage().getGuildReminderSetting('guild1', 'pray').message, 'teks curse', 's curse menimpa baris yang sama');
    assert.equal(storage().listGuildReminderSettings('guild1').length, 1, 'hanya satu baris untuk satu kategori');
  });

  it('reports that server-default embeds are not supported but owned embeds are', async () => {
    const message = makeMessage('d s pray set embed {"title":"x"}', { userId: 'admin1', admin: true });
    await require('../src/commands/prefix').handlePrefixCommand(message, null, { send: (m, payload) => m.reply(payload) });
    assert.match(textOf(message), /hanya mendukung teks/);
  });
});

describe('custom reminder — resolution precedence and fallback', () => {
  const resolve = () => require('../src/utils/reminderResolve');

  it('uses builtin when there is no guild setting and no owned reminder', () => {
    const result = resolve().resolveForAction({ guildId: 'guild1', userId: 'user1', action: 'pray' });
    assert.equal(result.source, 'builtin');
    assert.equal(result.message, null);
  });

  it('falls back to the guild setting when there is no active owned reminder', async () => {
    storage().setGuildReminderSetting({ guildId: 'guild1', action: 'pray', message: 'server pray', updatedBy: 'a1' });
    const result = resolve().resolveForAction({ guildId: 'guild1', userId: 'user1', action: 'pray' });
    assert.equal(result.source, 'guild');
    assert.equal(result.message, 'server pray');
  });

  it('prefers an active owned reminder over the guild setting', async () => {
    const { reminderId } = await awardAndRedeem();
    storage().setGuildReminderSetting({ guildId: 'guild1', action: 'pray', message: 'server pray', updatedBy: 'a1' });
    await svc().handleMessage(makeMessage('d r enable ' + reminderId, { userId: '111222333444555666' }));

    const owned = resolve().resolveForAction({ guildId: 'guild1', userId: '111222333444555666', action: 'pray' });
    assert.equal(owned.source, 'owned');
    assert.equal(owned.reminder.reminderId, reminderId);
    // User lain tetap memakai default server.
    const other = resolve().resolveForAction({ guildId: 'guild1', userId: 'other1', action: 'pray' });
    assert.equal(other.source, 'guild');
  });

  it('falls back to the server default when the owned reminder is disabled', async () => {
    const { reminderId } = await awardAndRedeem();
    storage().setGuildReminderSetting({ guildId: 'guild1', action: 'pray', message: 'server pray', updatedBy: 'a1' });
    await svc().handleMessage(makeMessage('d r enable ' + reminderId, { userId: '111222333444555666' }));
    await svc().handleMessage(makeMessage('d r disable ' + reminderId, { userId: '111222333444555666' }));

    const result = resolve().resolveForAction({ guildId: 'guild1', userId: '111222333444555666', action: 'pray' });
    assert.equal(result.source, 'guild', 'disable otomatis kembali ke default server');
    assert.equal(result.message, 'server pray');
  });

  it('falls all the way back to builtin when the server default is reset', async () => {
    storage().setGuildReminderSetting({ guildId: 'guild1', action: 'pray', message: 'server pray' });
    storage().deleteGuildReminderSetting('guild1', 'pray');
    assert.equal(resolve().resolveForAction({ guildId: 'guild1', userId: 'user1', action: 'pray' }).source, 'builtin');
  });

  it('resolves per action so one category cannot override another', async () => {
    const { templateId } = await makeTemplate('Doa', 'doa {mention}', { category: 'PRAY_CURSE' });
    const give = makeMessage('d r give <@111222333444555666> ' + templateId, { userId: 'dev1', dev: true });
    await svc().handleMessage(give);
    const redeem = makeMessage('d r redeem ' + idOf(give, 'C'), { userId: '111222333444555666' });
    await svc().handleMessage(redeem);
    await svc().handleMessage(makeMessage('d r enable ' + idOf(redeem, 'R'), { userId: '111222333444555666' }));

    assert.equal(resolve().resolveForAction({ guildId: 'guild1', userId: '111222333444555666', action: 'pray' }).source, 'owned');
    // Kategori lain tidak terpengaruh.
    assert.equal(resolve().resolveForAction({ guildId: 'guild1', userId: '111222333444555666', action: 'hunt' }).source, 'builtin');
    assert.equal(resolve().resolveForAction({ guildId: 'guild1', userId: '111222333444555666', action: 'lucy' }).source, 'builtin');
  });

  it('picks deterministically when several reminders of one category are active', async () => {
    const first = await awardAndRedeem();
    const second = await makeTemplate('Kedua', 'pesan kedua', { category: 'PRAY_CURSE' });
    const give = makeMessage('d r give <@111222333444555666> ' + second.templateId, { userId: 'dev1', dev: true });
    await svc().handleMessage(give);
    const redeem = makeMessage('d r redeem ' + idOf(give, 'C'), { userId: '111222333444555666' });
    await svc().handleMessage(redeem);
    const secondId = idOf(redeem, 'R');

    await svc().handleMessage(makeMessage('d r enable ' + first.reminderId, { userId: '111222333444555666' }));
    await svc().handleMessage(makeMessage('d r enable ' + secondId, { userId: '111222333444555666' }));

    // Keduanya tetap ada di inventory (tidak dibuang/digabung).
    assert.equal(storage().listRemindersByOwner('111222333444555666').length, 2);
    const picked = resolve().pickActiveOwned('guild1', '111222333444555666', 'PRAY_CURSE');
    // Yang paling awal dibuat yang dipakai, dan hasilnya stabil.
    assert.equal(picked.reminderId, first.reminderId);
    assert.equal(resolve().pickActiveOwned('guild1', '111222333444555666', 'PRAY_CURSE').reminderId, first.reminderId);
  });

  it('renders owned and guild messages with legacy and new variables', () => {
    const rendered = resolve().resolveRendered({
      guildId: 'guild1', userId: 'u1', action: 'pray',
      legacyVars: { mention: '<@u1>', count: '3' },
      context: require('../src/utils/reminderVariables').createRenderContext({ user: { id: 'u1', mention: '<@u1>' } })
    });
    assert.equal(rendered.source, 'builtin');
  });

  it('does not mutate server defaults when a user edits an owned reminder', async () => {
    storage().setGuildReminderSetting({ guildId: 'guild1', action: 'pray', message: 'server pray' });
    const { reminderId } = await awardAndRedeem();
    await svc().handleMessage(makeMessage('d r update ' + reminderId + ' pesan user', { userId: '111222333444555666' }));
    assert.equal(storage().getGuildReminderSetting('guild1', 'pray').message, 'server pray');
  });

  it('does not mutate the template when a user edits an owned reminder', async () => {
    const { templateId, reminderId } = await awardAndRedeem();
    await svc().handleMessage(makeMessage('d r update ' + reminderId + ' diubah user', { userId: '111222333444555666' }));
    assert.equal(storage().getTemplate(templateId).message, 'Halo {USER}');
  });

  it('does not overwrite owned reminders when an admin resets server defaults', async () => {
    const { reminderId } = await awardAndRedeem();
    await svc().handleMessage(makeMessage('d r enable ' + reminderId, { userId: '111222333444555666' }));
    storage().setGuildReminderSetting({ guildId: 'guild1', action: 'pray', message: 'server pray' });
    storage().deleteGuildReminderSetting('guild1', 'pray');
    const reminder = storage().getReminder(reminderId);
    assert.equal(reminder.message, 'Halo {USER}', 'reminder milik user tetap utuh');
    assert.equal(reminder.active, true);
  });
});

describe('custom reminder — shareable and transfer rules', () => {
  it('keeps active and shareable independent', async () => {
    const { reminderId } = await awardAndRedeem();
    const owner = '111222333444555666';
    await svc().handleMessage(makeMessage('d r enable ' + reminderId, { userId: owner }));
    let reminder = storage().getReminder(reminderId);
    assert.equal(reminder.active, true);
    assert.equal(reminder.shareable, false, 'aktif belum tentu shareable');

    await svc().handleMessage(makeMessage('d r shareable ' + reminderId + ' on', { userId: owner }));
    reminder = storage().getReminder(reminderId);
    assert.equal(reminder.active, true);
    assert.equal(reminder.shareable, true);

    await svc().handleMessage(makeMessage('d r disable ' + reminderId, { userId: owner }));
    reminder = storage().getReminder(reminderId);
    assert.equal(reminder.active, false);
    assert.equal(reminder.shareable, true, 'shareable tetap walau nonaktif');
  });

  it('refuses to transfer a reminder that is not shareable', async () => {
    const { reminderId } = await awardAndRedeem();
    const send = makeMessage('d r send <@999888777666555444> ' + reminderId, { userId: '111222333444555666' });
    await svc().handleMessage(send);
    assert.match(textOf(send), /belum ditandai shareable/);
    assert.equal(storage().getReminder(reminderId).ownerId, '111222333444555666');
  });

  it('keeps inactive reminders editable', async () => {
    const { reminderId } = await awardAndRedeem();
    const owner = '111222333444555666';
    await svc().handleMessage(makeMessage('d r disable ' + reminderId, { userId: owner }));
    await svc().handleMessage(makeMessage('d r update ' + reminderId + ' tetap bisa diubah', { userId: owner }));
    assert.equal(storage().getReminder(reminderId).message, 'tetap bisa diubah');
  });

  it('shows an empty inventory response', async () => {
    const message = makeMessage('d r inventory', { userId: 'user9' });
    await svc().handleMessage(message);
    const embed = message.sent.at(-1).embeds[0].data;
    assert.match(embed.description, /belum punya reminder/);
    assert.match(embed.title, /Custom Reminders/);
  });

  it('lists owned reminder IDs, not template or claim IDs', async () => {
    const { templateId, claimId, reminderId } = await awardAndRedeem();
    const inventory = makeMessage('d r inventory', { userId: '111222333444555666' });
    await svc().handleMessage(inventory);
    const text = JSON.stringify(inventory.sent.at(-1).embeds[0].data);
    assert.match(text, new RegExp(reminderId));
    assert.ok(!text.includes(templateId), 'template ID tidak muncul di inventory');
    assert.ok(!text.includes(claimId), 'claim ID tidak muncul di inventory');
  });
});

describe('custom reminder — media providers', () => {
  it('supports Tenor and Klipy through the media command', async () => {
    const tenor = makeMessage('d r media https://media.tenor.com/a/b.gif');
    await svc().handleMessage(tenor);
    assert.match(textOf(tenor), /media\.tenor\.com/);

    const klipy = makeMessage('d r media https://cdn.klipy.com/a/b.gif');
    await svc().handleMessage(klipy);
    assert.match(textOf(klipy), /klipy\.com/);

    // Perintah khusus penyedia tetap ada.
    const tenorOnly = makeMessage('d r tenor https://media.tenor.com/a/b.gif');
    await svc().handleMessage(tenorOnly);
    assert.match(textOf(tenorOnly), /URL Media/);

    const klipyOnly = makeMessage('d r klipy https://cdn.klipy.com/a/b.gif');
    await svc().handleMessage(klipyOnly);
    assert.match(textOf(klipyOnly), /klipy\.com/);
  });

  it('rejects invalid or unsupported media URLs', async () => {
    for (const url of ['javascript:alert(1)', 'http://cdn.klipy.com/a.gif', 'https://evil.example/a.gif']) {
      const message = makeMessage('d r media ' + url);
      await svc().handleMessage(message);
      assert.match(textOf(message), /❌/, url);
    }
  });

  it('resolves a Klipy page through an injected fetch', async () => {
    const { resolveKlipy } = require('../src/utils/reminderValidate');
    const result = await resolveKlipy('https://klipy.com/gif/abc', {
      fetchFn: async () => ({ ok: true, text: async () => '<meta property="og:image" content="https://cdn.klipy.com/XYZ/abc.gif">' })
    });
    assert.equal(result.ok, true);
    assert.equal(result.value, 'https://cdn.klipy.com/XYZ/abc.gif');
    const missing = await resolveKlipy('https://klipy.com/gif/abc', { fetchFn: async () => ({ ok: true, text: async () => '<html></html>' }) });
    assert.equal(missing.ok, false);
  });

  it('accepts Klipy media URLs inside embed image and thumbnail', () => {
    const { validateEmbed } = require('../src/utils/reminderValidate');
    const result = validateEmbed({ image: { url: 'https://cdn.klipy.com/a/b.gif' }, thumbnail: { url: 'https://media.tenor.com/c/d.gif' } });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(validateEmbed({ image: { url: 'http://cdn.klipy.com/a.gif' } }).ok, false);
  });
});

describe('custom reminder — engine integration (no second scheduler)', () => {
  it('delivers an owned reminder through the existing engine delivery path', async () => {
    const engine = require('../src/services/lucyReminder');
    const { reminderId } = await awardAndRedeem();
    const owner = '111222333444555666';
    await svc().handleMessage(makeMessage('d r enable ' + reminderId, { userId: owner }));

    // Preferensi engine harus aktif agar pengingat benar-benar dikirim.
    require('../src/utils/lucyActionStorage').setPref(owner, 'pray', { enabled: true, pingMode: 'tag' });

    const sent = [];
    const client = {
      channels: { fetch: async () => ({ isTextBased: () => true, send: async payload => { sent.push(payload); } }) },
      users: { fetch: async id => ({ id, username: 'user' + id, displayAvatarURL: () => null }) },
      guilds: { cache: new Map([['guild1', { name: 'Guild Satu', iconURL: () => null, members: { fetch: async () => null } }]]) }
    };
    await engine.deliverReminder(client, {
      guildId: 'guild1', channelId: 'chan1', userId: owner, kind: 'pray', action: 'pray', name: 'Ani', messageId: 'm1'
    });
    assert.equal(sent.length, 1);
    assert.match(sent[0].content, /<@111222333444555666>/, 'override pribadi dipakai');
  });

  it('delivers an EMBED-format reminder as an embed', async () => {
    const engine = require('../src/services/lucyReminder');
    const { templateId } = await makeTemplate('Embed Lucy', 'Pesan lucy', { category: 'LUCY', format: 'EMBED' });
    const give = makeMessage('d r give <@111222333444555666> ' + templateId, { userId: 'dev1', dev: true });
    await svc().handleMessage(give);
    const redeem = makeMessage('d r redeem ' + idOf(give, 'C'), { userId: '111222333444555666' });
    await svc().handleMessage(redeem);
    const reminderId = idOf(redeem, 'R');
    await svc().handleMessage(makeMessage('d r enable ' + reminderId, { userId: '111222333444555666' }));
    require('../src/utils/lucyActionStorage').setPref('111222333444555666', 'lucy', { enabled: true, pingMode: 'none' });

    const sent = [];
    const client = {
      channels: { fetch: async () => ({ isTextBased: () => true, send: async payload => { sent.push(payload); } }) },
      users: { fetch: async id => ({ id, username: 'u' + id, displayAvatarURL: () => null }) },
      guilds: { cache: new Map([['guild1', { name: 'G', iconURL: () => null, members: { fetch: async () => null } }]]) }
    };
    await engine.deliverReminder(client, {
      guildId: 'guild1', channelId: 'chan1', userId: '111222333444555666', kind: 'lucy', action: 'lucy', name: 'Ani', messageId: 'm2'
    });
    assert.equal(sent.length, 1);
    assert.ok(Array.isArray(sent[0].embeds) && sent[0].embeds.length === 1, 'dikirim sebagai embed');
    assert.match(sent[0].embeds[0].data.description, /Pesan lucy/);
  });

  it('uses the server default when the user has no active reminder', async () => {
    const engine = require('../src/services/lucyReminder');
    // Pengaturan server per KATEGORI: `s hunt` dan `s battle` menulis baris yang sama.
    storage().setGuildReminderSetting({ guildId: 'guild1', action: 'hunt', message: 'server battle {count}', updatedBy: 'a1' });
    require('../src/utils/lucyActionStorage').setPref('userX', 'battle', { enabled: true, pingMode: 'none' });

    const sent = [];
    const client = {
      channels: { fetch: async () => ({ isTextBased: () => true, send: async payload => { sent.push(payload); } }) },
      users: { fetch: async id => ({ id, username: 'u', displayAvatarURL: () => null }) },
      guilds: { cache: new Map([['guild1', { name: 'G', iconURL: () => null, members: { fetch: async () => null } }]]) }
    };
    await engine.deliverReminder(client, {
      guildId: 'guild1', channelId: 'chan1', userId: 'userX', kind: 'battle', action: 'hunt', name: 'X', messageId: 'm3'
    });
    assert.equal(sent.length, 1);
    assert.match(sent[0].content, /server battle/, 'default server dipakai');
    assert.match(sent[0].content, /server battle \d+/, 'token {count} lama tetap dirender');
  });

  it('keeps the built-in reply when nothing overrides it', async () => {
    const engine = require('../src/services/lucyReminder');
    require('../src/utils/lucyActionStorage').setPref('userY', 'pray', { enabled: true, pingMode: 'none' });
    const sent = [];
    const client = {
      channels: { fetch: async () => ({ isTextBased: () => true, send: async payload => { sent.push(payload); } }) },
      users: { fetch: async id => ({ id, username: 'u', displayAvatarURL: () => null }) },
      guilds: { cache: new Map([['guild1', { name: 'G', iconURL: () => null, members: { fetch: async () => null } }]]) }
    };
    await engine.deliverReminder(client, {
      guildId: 'guild1', channelId: 'chan1', userId: 'userY', kind: 'pray', action: 'pray', name: 'Y', messageId: 'm4'
    });
    assert.match(sent[0].content, /memanjatkan doa/, 'teks bawaan Dragneel dipertahankan');
  });
});

describe('custom reminder — revisi: counter off, discohook, panel, create ringkas', () => {
  it('tetap memasang pengingat walau counter Lucy OFF', async () => {
    const engine = require('../src/services/lucyReminder');
    const storageUtils = require('../src/utils/storage');
    storageUtils.updateGuildSettings('guild1', s => ({ ...s, lucyCounter: { ...s.lucyCounter, enabled: false } }));
    engine.timers.clear();

    const message = makeMessage('lpray');
    assert.equal(await engine.handleMessage(message), true);
    assert.equal(engine.timers.size, 1, 'pengingat dipasang walau counter off');
    assert.equal(message.sent.length, 0, 'tetap tanpa balasan');
    engine.timers.clear();
  });

  it('mengirim hook Say Lucy walau counter OFF', async () => {
    const counter = require('../src/services/lucyCounter');
    const storageUtils = require('../src/utils/storage');
    storageUtils.updateGuildSettings('guild1', s => ({ ...s, lucyCounter: { ...s.lucyCounter, enabled: false } }));
    const seen = [];
    await counter.handleMessage(makeMessage('halo lucy apa kabar'), { onCounted: (m, name) => seen.push(name) });
    assert.equal(seen.length, 1, 'onCounted tetap dipanggil saat counter off');
  });

  it('menerima payload gaya discohook', async () => {
    const { reminderId } = await awardAndRedeem();
    const owner = '111222333444555666';
    const payload = JSON.stringify({
      content: null,
      embeds: [{
        title: 'Battle Reminder', description: 'tes', color: 16059404,
        fields: [{ name: 'ok tes', value: 'tes masuk', inline: true }],
        author: { name: 'neon' }, footer: { text: 'embed reminder tes' },
        image: { url: 'https://media.tenor.com/a/b.gif' },
        thumbnail: { url: 'https://media.tenor.com/a/b.gif' }
      }],
      attachments: []
    });
    const message = makeMessage('d r embed ' + reminderId + ' ' + payload, { userId: owner });
    await svc().handleMessage(message);
    assert.match(textOf(message), /Tersimpan/);
    const embed = storage().getReminder(reminderId).embed;
    assert.equal(embed.title, 'Battle Reminder');
    assert.equal(embed.color, 16059404);
    assert.equal(embed.author.name, 'neon');
    assert.equal(embed.image.url, 'https://media.tenor.com/a/b.gif');
  });

  it('menolak payload dengan lebih dari satu embed', async () => {
    const { reminderId } = await awardAndRedeem();
    const owner = '111222333444555666';
    const message = makeMessage('d r embed ' + reminderId + ' {"embeds":[{"title":"a"},{"title":"b"}]}', { userId: owner });
    await svc().handleMessage(message);
    assert.match(textOf(message), /hanya satu embed/i);
  });

  it('menolak field asing pada embed biasa', async () => {
    const { reminderId } = await awardAndRedeem();
    const owner = '111222333444555666';
    const message = makeMessage('d r embed ' + reminderId + ' {"title":"x","bogus":1}', { userId: owner });
    await svc().handleMessage(message);
    assert.match(textOf(message), /tidak dikenal/);
  });

  it('menampilkan inventory sebagai embed dengan nama dan avatar pengguna', async () => {
    const { reminderId } = await awardAndRedeem();
    const owner = '111222333444555666';
    const message = makeMessage('d r inventory', { userId: owner, name: 'Ani' });
    await svc().handleMessage(message);
    const embed = message.sent.at(-1).embeds[0].data;
    assert.match(embed.title, /Custom Reminders/);
    assert.match(embed.title, /Ani/, 'judul memuat nama pengguna');
    assert.match(embed.thumbnail.url, /avatars\/111222333444555666/, 'avatar sebagai thumbnail');
    assert.match(embed.description, new RegExp(reminderId));
    assert.ok(embed.fields.some(f => /Legenda/.test(f.name)), 'ada legenda');
  });

  it('menyertakan tombol "Cara menggunakan" dan "Variabel" pada panel', async () => {
    const message = makeMessage('d r', { userId: '111222333444555666' });
    await svc().handleMessage(message);
    const components = message.sent.at(-1).components;
    const labels = components[0].components.map(c => c.data.label);
    assert.deepEqual(labels, ['Cara menggunakan', 'Variabel']);
    assert.equal(svc().isPanelNav(components[0].components[0].data.custom_id), true);
  });

  it('menampilkan bantuan dan variabel lewat tombol, lalu kembali ke inventory', async () => {
    const svcMod = svc();
    const owner = '111222333444555666';
    const makeInteraction = customId => {
      const updates = [];
      return {
        customId,
        user: { id: owner, username: 'user' + owner, globalName: 'Global', displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/' + owner + '/x.png' },
        member: { displayName: 'Ani' },
        client: { users: { fetch: async id => ({ id, displayAvatarURL: () => null }) } },
        updates,
        update: async payload => { updates.push(payload); }
      };
    };

    const help = makeInteraction('rempanel:help');
    assert.equal(await svcMod.handleComponent(help), true);
    const helpText = help.updates[0].embeds[0].data.description;
    for (const cmd of ['redeem', 'view', 'send', 'update', 'embed', 'media', 'enable', 'disable']) {
      assert.match(helpText, new RegExp(cmd), 'bantuan memuat ' + cmd);
    }
    assert.ok(help.updates[0].components[0].components[0].data.custom_id.endsWith(':back'), 'ada tombol kembali');

    const vars = makeInteraction('rempanel:vars');
    assert.equal(await svcMod.handleComponent(vars), true);
    assert.match(vars.updates[0].embeds[0].data.description, /\{USER\}/);
    assert.match(vars.updates[0].embeds[0].data.description, /\{DAILY_TOMORROW\}/);

    const back = makeInteraction('rempanel:back');
    assert.equal(await svcMod.handleComponent(back), true);
    assert.match(back.updates[0].embeds[0].data.title, /Custom Reminders/);
    assert.ok(back.updates[0].components[0].components[0].data.custom_id.endsWith(':help'), 'tombol panel kembali');

    assert.equal(await svcMod.handleComponent({ customId: 'lain:1' }), false, 'abaikan tombol asing');
  });

  it('membuat template tanpa nama/isi: `r create battle embed`', async () => {
    const message = makeMessage('d r create battle embed', { userId: 'dev1', dev: true });
    await svc().handleMessage(message);
    const text = textOf(message);
    assert.match(text, /Template Dibuat/);
    const code = (text.match(/`(T-[A-Z0-9]+)`/) || [])[1];
    assert.ok(code, 'bot membalas kode template');
    const template = storage().getTemplate(code);
    assert.equal(template.category, 'HUNT_BATTLE', 'battle dipetakan ke HUNT_BATTLE');
    assert.equal(template.format, 'EMBED');
    assert.equal(template.message, '', 'tanpa isi default');
    assert.match(template.name, /Hunt\/Battle Reminder/);
  });

  it('menerima nama aksi sebagai kategori pada create', async () => {
    for (const [input, expected] of [['pray', 'PRAY_CURSE'], ['lucy', 'LUCY'], ['hunt', 'HUNT_BATTLE']]) {
      const message = makeMessage('d r create ' + input + ' normal', { userId: 'dev1', dev: true });
      await svc().handleMessage(message);
      const code = (textOf(message).match(/`(T-[A-Z0-9]+)`/) || [])[1];
      assert.ok(code, input + ' dibuat');
      assert.equal(storage().getTemplate(code).category, expected, input + ' -> ' + expected);
    }
  });

  it('menampilkan format baru pada error create tanpa kategori', async () => {
    const message = makeMessage('d r create', { userId: 'dev1', dev: true });
    await svc().handleMessage(message);
    assert.match(textOf(message), /KATEGORI/);
    assert.match(textOf(message), /battle embed/, 'contoh yang diminta user ada');
  });

  it('semua balasan reminder dikirim sebagai embed', async () => {
    const cases = [
      ['d r', { userId: 'u1' }],
      ['d r view R-AAAAA', { userId: 'u1' }],
      ['d r enable R-AAAAA', { userId: 'u1' }],
      ['d r media https://media.tenor.com/a/b.gif', { userId: 'u1' }],
      ['d r tidakada', { userId: 'u1' }],
      ['d r redeem C-AAAAA', { userId: 'u1' }]
    ];
    for (const [content, opts] of cases) {
      const message = makeMessage(content, opts);
      await svc().handleMessage(message);
      const last = message.sent.at(-1);
      assert.ok(last && Array.isArray(last.embeds) && last.embeds.length === 1, content + ' harus berupa embed');
    }
  });
});

describe('custom reminder — tag, duplikat, dan jam harian WIB', () => {
  const variables = () => require('../src/utils/reminderVariables');

  it('hanya engine lucyReminder yang mengirim (tidak ada pengirim kedua)', () => {
    const svcMod = svc();
    assert.equal(typeof svcMod.deliverForActivity, 'undefined', 'pengirim kedua sudah dihapus');
    assert.equal(typeof svcMod.handleMessage, 'function');
  });

  it('{USER} tidak memicu tag, {USER_MENTION} memicunya', () => {
    const id = '111222333444555666';
    const context = variables().createRenderContext({ user: { id, name: 'ani', mention: '<@' + id + '>' } });
    assert.equal(variables().render('{USER}', context), 'ani');
    assert.equal(variables().render('{USER_MENTION}', context), '<@' + id + '>');
    assert.deepEqual(variables().mentions('{USER}'), []);
    assert.deepEqual(variables().mentions(variables().render('{USER_MENTION}', context)), [id]);
  });

  it('tidak menandai saat pingMode bukan tag (kasus `{mention} jangan lupa battle!`)', async () => {
    const owner = '111222333444555666';
    const { templateId } = await makeTemplate('Battle', 'x', { category: 'HUNT_BATTLE', format: 'EMBED' });
    const give = makeMessage('d r give <@' + owner + '> ' + templateId, { userId: 'dev1', dev: true });
    await svc().handleMessage(give);
    const redeem = makeMessage('d r redeem ' + idOf(give, 'C'), { userId: owner });
    await svc().handleMessage(redeem);
    const reminderId = idOf(redeem, 'R');

    await svc().handleMessage(makeMessage('d r update ' + reminderId + ' {mention} jangan lupa battle!', { userId: owner }));
    await svc().handleMessage(makeMessage('d r embed ' + reminderId + ' {"title":"Battle Reminder","description":"{mention} jangan lupa battle!"}', { userId: owner }));
    await svc().handleMessage(makeMessage('d r enable ' + reminderId, { userId: owner }));

    const engine = require('../src/services/lucyReminder');
    const prefStore = require('../src/utils/lucyActionStorage');
    const sent = [];
    const client = { channels: { fetch: async () => ({ isTextBased: () => true, send: async p => { sent.push(p); } }) } };
    const base = { guildId: 'guild1', channelId: 'chan1', userId: owner, name: 'Ani', kind: 'battle', action: 'battle', messageId: 'm1' };

    // Mode `none`: teks DAN embed harus bersih dari mention.
    prefStore.setPref(owner, 'battle', { enabled: true, pingMode: 'none' });
    await engine.deliverReminder(client, { ...base });
    const none = sent.at(-1);
    assert.doesNotMatch(none.content, /<@/, 'teks tanpa tag saat mode none');
    assert.doesNotMatch(JSON.stringify(none.embeds[0].data), /<@/, 'embed tanpa tag saat mode none');
    assert.deepEqual(none.allowedMentions, { parse: [], users: [] }, 'tidak ada user yang diizinkan');
    assert.equal(none.reply, undefined, 'tidak me-reply');

    // Mode `reply`: me-reply, tetap tanpa tag.
    prefStore.setPref(owner, 'battle', { enabled: true, pingMode: 'reply' });
    await engine.deliverReminder(client, { ...base });
    const reply = sent.at(-1);
    assert.equal(reply.reply.messageReference, 'm1');
    assert.doesNotMatch(reply.content, /<@/, 'mode reply tidak menandai');

    // Mode `tag`: boleh menandai, dan diizinkan.
    prefStore.setPref(owner, 'battle', { enabled: true, pingMode: 'tag' });
    await engine.deliverReminder(client, { ...base });
    const tag = sent.at(-1);
    assert.match(tag.content, new RegExp('<@' + owner + '>'));
    assert.deepEqual(tag.allowedMentions, { parse: [], users: [owner] });
    assert.equal(tag.reply, undefined, 'mode tag tidak me-reply');
  });

  it('satu aksi hanya memicu satu pengingat', async () => {
    const owner = '111222333444555666';
    const { templateId } = await makeTemplate('Battle', 'x', { category: 'HUNT_BATTLE', format: 'NORMAL' });
    const give = makeMessage('d r give <@' + owner + '> ' + templateId, { userId: 'dev1', dev: true });
    await svc().handleMessage(give);
    const redeem = makeMessage('d r redeem ' + idOf(give, 'C'), { userId: owner });
    await svc().handleMessage(redeem);
    await svc().handleMessage(makeMessage('d r enable ' + idOf(redeem, 'R'), { userId: owner }));

    const engine = require('../src/services/lucyReminder');
    const prefStore = require('../src/utils/lucyActionStorage');
    prefStore.setPref(owner, 'battle', { enabled: true, pingMode: 'none' });
    engine.timers.clear();

    const message = makeMessage('lucy battle', { userId: owner });
    await engine.handleMessage(message);
    assert.equal(engine.timers.size, 1, 'aksi menjadwalkan tepat satu pengingat');
    engine.timers.clear();
  });

  it('{DAILY} tepat 00:00 WIB, dan berganti hari saat lewat tengah malam WIB', () => {
    // 15 Jan 2026 05:30 WIB = 14 Jan 22:30 UTC.
    const morning = Date.UTC(2026, 0, 14, 22, 30, 0);
    const daily = variables().wibDayStartUnix(0, morning);
    assert.equal(new Date(daily * 1000).toLocaleString('en-GB', { timeZone: 'Asia/Jakarta' }), '15/01/2026, 00:00:00');
    assert.equal(variables().wibDayStartUnix(1, morning), daily + 86400, 'besok tepat +24 jam');

    // 15 Jan 2026 23:59 WIB masih hari yang sama...
    const beforeMidnight = Date.UTC(2026, 0, 15, 16, 59, 0);
    assert.equal(variables().wibDayStartUnix(0, beforeMidnight), daily);
    // ...dan 16 Jan 2026 00:01 WIB sudah masuk hari berikutnya.
    const afterMidnight = Date.UTC(2026, 0, 15, 17, 1, 0);
    assert.equal(variables().wibDayStartUnix(0, afterMidnight), daily + 86400);
    assert.equal(variables().dayKey(new Date(afterMidnight)), '2026-01-16');
    assert.equal(variables().dayKey(new Date(beforeMidnight)), '2026-01-15');
  });

  it('menjelaskan variabel waktu sebagai 00:00 WIB', () => {
    const reference = Object.fromEntries(variables().variableReference().map(v => [v.name, v.description]));
    assert.match(reference['{DAILY}'], /00:00 WIB/);
    assert.match(reference['{DAILY_TOMORROW}'], /00:00 WIB/);
  });
});

describe('custom reminder — tag tunggal dan token {mention} di embed', () => {
  async function setupBattleReminder(owner = '111222333444555666') {
    const { templateId } = await makeTemplate('Battle', 'x', { category: 'HUNT_BATTLE', format: 'EMBED' });
    const give = makeMessage('d r give <@' + owner + '> ' + templateId, { userId: 'dev1', dev: true });
    await svc().handleMessage(give);
    const redeem = makeMessage('d r redeem ' + idOf(give, 'C'), { userId: owner });
    await svc().handleMessage(redeem);
    const reminderId = idOf(redeem, 'R');
    await svc().handleMessage(makeMessage('d r update ' + reminderId + ' {mention} jangan lupa battle!', { userId: owner }));
    await svc().handleMessage(makeMessage('d r embed ' + reminderId + ' {"title":"Battle Reminder","description":"{mention} jangan lupa battle!"}', { userId: owner }));
    await svc().handleMessage(makeMessage('d r enable ' + reminderId, { userId: owner }));
    return reminderId;
  }

  function deliver(client, sent, owner, pingMode) {
    const engine = require('../src/services/lucyReminder');
    const prefs = require('../src/utils/lucyActionStorage');
    prefs.setPref(owner, 'battle', { enabled: true, pingMode });
    return engine.deliverReminder(client, {
      guildId: 'guild1', channelId: 'chan1', userId: owner, name: 'Ani', kind: 'battle', action: 'battle', messageId: 'm1'
    }).then(() => sent.at(-1));
  }

  function clientOf(sent) {
    return { channels: { fetch: async () => ({ isTextBased: () => true, send: async p => { sent.push(p); } }) } };
  }

  it('merender {mention} di dalam embed (bukan literal)', async () => {
    const owner = '111222333444555666';
    await setupBattleReminder(owner);
    const sent = [];
    const payload = await deliver(clientOf(sent), sent, owner, 'tag');
    assert.doesNotMatch(payload.embeds[0].data.description, /\{mention\}/, 'token lama dirender di embed');
    assert.match(payload.embeds[0].data.description, new RegExp('<@' + owner + '>'));
  });

  it('hanya menandai sekali walau teks diawali {mention}', async () => {
    const owner = '111222333444555666';
    await setupBattleReminder(owner);
    const sent = [];
    const payload = await deliver(clientOf(sent), sent, owner, 'tag');
    const tags = payload.content.match(/<@!?\d+>/g) || [];
    assert.equal(tags.length, 1, 'tepat satu tag, tidak dobel');
    assert.equal(payload.reply, undefined, 'mode tag tidak me-reply');
  });

  it('mode none mengganti mention dengan nama, tanpa tag dan tanpa reply', async () => {
    const owner = '111222333444555666';
    await setupBattleReminder(owner);
    const sent = [];
    const payload = await deliver(clientOf(sent), sent, owner, 'none');
    assert.doesNotMatch(payload.content, /<@/, 'tanpa tag');
    assert.match(payload.content, /Ani jangan lupa battle!/, 'mention diganti nama');
    assert.deepEqual(payload.allowedMentions, { parse: [], users: [] });
    assert.equal(payload.reply, undefined);
  });

  it('mode both menandai sekali sekaligus me-reply', async () => {
    const owner = '111222333444555666';
    await setupBattleReminder(owner);
    const sent = [];
    const payload = await deliver(clientOf(sent), sent, owner, 'both');
    assert.equal((payload.content.match(/<@!?\d+>/g) || []).length, 1);
    assert.equal(payload.reply.messageReference, 'm1');
  });
});

describe('custom reminder — variabel waktu aman untuk embed', () => {
  const variables = () => require('../src/utils/reminderVariables');

  it('menyediakan bentuk teks 00:00 WIB yang benar-benar dirender di embed', () => {
    const now = Date.UTC(2026, 0, 14, 22, 30, 0); // 15 Jan 2026 05:30 WIB
    const context = variables().createRenderContext({ user: { id: '1', name: 'ani' }, now });
    assert.equal(variables().render('{DAILY_TIME}', context), '00.00');
    assert.equal(variables().render('{DAILY_DATE}', context), '15 Januari 2026');
    assert.equal(variables().render('{DAILY_FULL}', context), 'Kamis, 15 Januari 2026 pukul 00.00 WIB');
    assert.match(variables().render('{DAILY_IN}', context), /(lalu|dalam)/);
    assert.match(variables().render('{TOMORROW_FULL}', context), /16 Januari 2026 pukul 00\.00 WIB/);
  });

  it('menandai {DAILY} sebagai khusus content, bukan untuk embed', () => {
    const reference = Object.fromEntries(variables().variableReference().map(v => [v.name, v.description]));
    assert.match(reference['{DAILY}'], /tidak render di embed/i);
    assert.match(reference['{DAILY_FULL}'], /aman di embed/i);
  });

  it('embed dengan {DAILY_FULL} berisi teks waktu, bukan angka mentah', () => {
    const now = Date.UTC(2026, 0, 14, 22, 30, 0);
    const context = variables().createRenderContext({ user: { id: '1', name: 'ani' }, now });
    const embed = variables().renderEmbed({ title: 'Reset', description: 'Reset {DAILY_FULL}' }, context);
    assert.equal(embed.description, 'Reset Kamis, 15 Januari 2026 pukul 00.00 WIB');
    assert.doesNotMatch(embed.description, /<t:\d+/);
  });
});

describe('custom reminder — menghapus reminder (khusus developer)', () => {
  const OWNER = '111222333444555666';
  const STRANGER = '999888777666555444';

  it('developer meminta konfirmasi dulu, lalu menghapus saat dikonfirmasi', async () => {
    const { reminderId } = await awardAndRedeem(OWNER);
    const store = require('../src/utils/reminderStorage');
    assert.ok(store.getReminder(reminderId), 'reminder ada sebelum dihapus');

    const ask = makeMessage('d r delete ' + reminderId, { userId: 'dev1', dev: true });
    await svc().handleMessage(ask);
    assert.match(textOf(ask), /permanen/i, 'minta konfirmasi');
    assert.match(textOf(ask), new RegExp(OWNER), 'menyebut pemiliknya');
    assert.ok(store.getReminder(reminderId), 'belum dihapus sebelum konfirmasi');

    const confirm = makeMessage('d r confirm', { userId: 'dev1', dev: true });
    await svc().handleMessage(confirm);
    assert.match(textOf(confirm), /Dihapus/i);
    assert.equal(store.getReminder(reminderId), null, 'reminder sudah hilang dari penyimpanan');
  });

  it('membatalkan lewat `d r cancel` tanpa menghapus', async () => {
    const { reminderId } = await awardAndRedeem(OWNER);
    const store = require('../src/utils/reminderStorage');
    await svc().handleMessage(makeMessage('d r hapus ' + reminderId, { userId: 'dev1', dev: true }));
    const cancel = makeMessage('d r cancel', { userId: 'dev1', dev: true });
    await svc().handleMessage(cancel);
    assert.match(textOf(cancel), /dibatalkan/i);
    assert.ok(store.getReminder(reminderId), 'reminder tetap ada');
  });

  it('pemilik reminder sendiri TIDAK bisa menghapus', async () => {
    const { reminderId } = await awardAndRedeem(OWNER);
    const store = require('../src/utils/reminderStorage');
    const owner = makeMessage('d r hapus ' + reminderId, { userId: OWNER });
    await svc().handleMessage(owner);
    assert.match(textOf(owner), /Hanya developer/i);
    assert.ok(store.getReminder(reminderId), 'reminder tidak terhapus oleh pemilik');
  });

  it('admin server pun tidak bisa menghapus', async () => {
    const { reminderId } = await awardAndRedeem(OWNER);
    const store = require('../src/utils/reminderStorage');
    const admin = makeMessage('d r hapus ' + reminderId, { userId: STRANGER, admin: true });
    await svc().handleMessage(admin);
    assert.match(textOf(admin), /Hanya developer/i);
    assert.ok(store.getReminder(reminderId), 'reminder tidak terhapus oleh admin');
  });

  it('menolak pengguna lain tanpa hak apa pun', async () => {
    const { reminderId } = await awardAndRedeem(OWNER);
    const store = require('../src/utils/reminderStorage');
    const stranger = makeMessage('d r hapus ' + reminderId, { userId: STRANGER });
    await svc().handleMessage(stranger);
    assert.match(textOf(stranger), /Hanya developer/i);
    assert.ok(store.getReminder(reminderId), 'reminder tidak terhapus');
  });

  it('developer bisa menghapus reminder milik orang lain lewat alias apa pun', async () => {
    const store = require('../src/utils/reminderStorage');
    for (const alias of ['delete', 'hapus', 'buang']) {
      const { reminderId } = await awardAndRedeem(OWNER);
      await svc().handleMessage(makeMessage('d r ' + alias + ' ' + reminderId, { userId: 'dev1', dev: true }));
      await svc().handleMessage(makeMessage('d r confirm', { userId: 'dev1', dev: true }));
      assert.equal(store.getReminder(reminderId), null, 'alias ' + alias + ' menghapus reminder');
    }
  });

  it('konfirmasi terikat pada pengguna yang meminta, jadi orang lain tidak bisa menghapus', async () => {
    const { reminderId } = await awardAndRedeem(OWNER);
    const store = require('../src/utils/reminderStorage');
    // Prompt dibuat oleh developer...
    await svc().handleMessage(makeMessage('d r hapus ' + reminderId, { userId: 'dev1', dev: true }));
    // ...lalu orang lain mencoba mengonfirmasi di channel yang sama.
    const confirm = makeMessage('d r confirm', { userId: STRANGER });
    await svc().handleMessage(confirm);
    assert.match(textOf(confirm), /Tidak ada tindakan/i);
    assert.ok(store.getReminder(reminderId), 'reminder tetap ada');
  });

  it('menolak format tanpa ID yang valid', async () => {
    const message = makeMessage('d r hapus', { userId: 'dev1', dev: true });
    await svc().handleMessage(message);
    assert.match(textOf(message), /Format/i);
  });

  it('mencatat audit penghapusan', async () => {
    const { reminderId } = await awardAndRedeem(OWNER);
    const store = require('../src/utils/reminderStorage');
    await svc().handleMessage(makeMessage('d r delete ' + reminderId, { userId: 'dev1', dev: true }));
    await svc().handleMessage(makeMessage('d r confirm', { userId: 'dev1', dev: true }));
    const audit = store.listAudit({ reminderId });
    assert.ok(audit.some(entry => entry.action === 'reminder_delete'), 'audit reminder_delete tercatat');
  });
});

describe('custom reminder — aturan berbagi per format', () => {
  const OWNER = '111222333444555666';
  const TARGET = '999888777666555444';

  it('reminder Normal bisa dibagikan ke user lain', async () => {
    const { reminderId } = await awardAndRedeem(OWNER); // template NORMAL
    const reminder = storage().getReminder(reminderId);
    assert.equal(reminder.format, 'NORMAL');

    // Tanpa shareable: ditolak, tapi alasannya "belum ditandai", bukan soal format.
    const early = makeMessage('d r send <@' + TARGET + '> ' + reminderId, { userId: OWNER });
    await svc().handleMessage(early);
    assert.match(textOf(early), /belum ditandai shareable/);

    // Nyalakan shareable -> berhasil setelah konfirmasi.
    const on = makeMessage('d r shareable ' + reminderId + ' on', { userId: OWNER });
    await svc().handleMessage(on);
    assert.doesNotMatch(textOf(on), /tidak bisa dibagikan/);
    assert.equal(storage().getReminder(reminderId).shareable, true);

    await svc().handleMessage(makeMessage('d r send <@' + TARGET + '> ' + reminderId, { userId: OWNER }));
    await svc().handleMessage(makeMessage('d r confirm', { userId: OWNER }));
    assert.equal(storage().getReminder(reminderId).ownerId, TARGET, 'kepemilikan berpindah ke target');
  });

  it('reminder Embed tidak bisa di-share', async () => {
    const { templateId } = await makeTemplate('Embed Satu', 'x', { category: 'HUNT_BATTLE', format: 'EMBED' });
    const give = makeMessage('d r give <@' + OWNER + '> ' + templateId, { userId: 'dev1', dev: true });
    await svc().handleMessage(give);
    const redeem = makeMessage('d r redeem ' + idOf(give, 'C'), { userId: OWNER });
    await svc().handleMessage(redeem);
    const reminderId = idOf(redeem, 'R');
    assert.equal(storage().getReminder(reminderId).format, 'EMBED');

    // Menyalakan shareable ditolak.
    const on = makeMessage('d r shareable ' + reminderId + ' on', { userId: OWNER });
    await svc().handleMessage(on);
    assert.match(textOf(on), /Embed.*tidak bisa dibagikan/i);
    assert.equal(storage().getReminder(reminderId).shareable, false, 'shareable tetap false');

    // `r send` pun ditolak, dengan alasan format.
    const send = makeMessage('d r send <@' + TARGET + '> ' + reminderId, { userId: OWNER });
    await svc().handleMessage(send);
    assert.match(textOf(send), /Embed.*tidak bisa dibagikan/i);
    assert.equal(storage().getReminder(reminderId).ownerId, OWNER, 'kepemilikan tidak berubah');
  });

  it('menolak transfer Embed walau kolom shareable sempat true', async () => {
    // Kasus batas: data lama/kolom diubah langsung. Aturan format harus tetap menang.
    const { templateId } = await makeTemplate('Embed Dua', 'x', { category: 'HUNT_BATTLE', format: 'EMBED' });
    const give = makeMessage('d r give <@' + OWNER + '> ' + templateId, { userId: 'dev1', dev: true });
    await svc().handleMessage(give);
    const redeem = makeMessage('d r redeem ' + idOf(give, 'C'), { userId: OWNER });
    await svc().handleMessage(redeem);
    const reminderId = idOf(redeem, 'R');

    storage().updateReminder(reminderId, { shareable: true });
    const send = makeMessage('d r send <@' + TARGET + '> ' + reminderId, { userId: OWNER });
    await svc().handleMessage(send);
    assert.match(textOf(send), /Embed.*tidak bisa dibagikan/i);
    assert.equal(storage().getReminder(reminderId).ownerId, OWNER);
  });

  it('inventory menandai reminder Embed sebagai tidak shareable', async () => {
    const { templateId } = await makeTemplate('Embed Tiga', 'x', { category: 'HUNT_BATTLE', format: 'EMBED' });
    const give = makeMessage('d r give <@' + OWNER + '> ' + templateId, { userId: 'dev1', dev: true });
    await svc().handleMessage(give);
    await svc().handleMessage(makeMessage('d r redeem ' + idOf(give, 'C'), { userId: OWNER }));
    const inventory = makeMessage('d r inventory', { userId: OWNER });
    await svc().handleMessage(inventory);
    const text = JSON.stringify(inventory.sent.at(-1).embeds[0].data);
    assert.match(text, /Tidak shareable/, 'legend menjelaskan tidak shareable');
    assert.match(text, /🔒/, 'baris reminder Embed ditandai gembok');
  });
});

describe('custom reminder — kode redeem sekali pakai & hanya penerima', () => {
  const OWNER = '111222333444555666';
  const OTHER = '999888777666555444';

  it('kode hanya bisa di-redeem satu kali walau dicoba berkali-kali', async () => {
    const { claimId } = await awardAndRedeem(OWNER);
    assert.equal(storage().getAward(claimId).status, 'redeemed');
    assert.equal(storage().listRemindersByOwner(OWNER).length, 1);

    for (let i = 0; i < 3; i++) {
      const again = makeMessage('d r redeem ' + claimId, { userId: OWNER });
      await svc().handleMessage(again);
      assert.match(textOf(again), /sudah diklaim/);
    }
    assert.equal(storage().listRemindersByOwner(OWNER).length, 1, 'tetap satu reminder');
  });

  it('kode tidak bisa di-redeem selain oleh penerimanya', async () => {
    const { templateId } = await makeTemplate();
    const give = makeMessage('d r give <@' + OWNER + '> ' + templateId, { userId: 'dev1', dev: true });
    await svc().handleMessage(give);
    const claimId = idOf(give, 'C');

    const wrong = makeMessage('d r redeem ' + claimId, { userId: OTHER });
    await svc().handleMessage(wrong);
    assert.match(textOf(wrong), /bukan milikmu/);
    assert.equal(storage().getAward(claimId).status, 'pending', 'kode tetap bisa dipakai penerima');
    assert.equal(storage().listRemindersByOwner(OTHER).length, 0, 'orang lain tidak dapat reminder');

    // Penerima yang sah tetap bisa memakainya.
    const right = makeMessage('d r redeem ' + claimId, { userId: OWNER });
    await svc().handleMessage(right);
    assert.match(textOf(right), /Diklaim/);
    assert.equal(storage().getAward(claimId).status, 'redeemed');
  });

  it('balapan klaim dibalas dengan pesan jelas dan tidak meninggalkan reminder', async () => {
    // Kasus ini hanya bisa terjadi saat dua klaim berbarengan. Untuk mengujinya,
    // `markAwardRedeemed` dibuat gagal sekali — meniru award yang baru saja
    // diklaim proses lain setelah pemeriksaan awal lolos.
    const store = require('../src/utils/reminderStorage');
    const { templateId } = await makeTemplate();
    const award = store.createAward({ templateId, recipientId: OWNER, issuerId: 'dev1' }).award;

    const real = store.markAwardRedeemed;
    store.markAwardRedeemed = () => false;
    let result;
    try {
      result = svc().redeemAward({ claimId: award.claimId, userId: OWNER });
    } finally {
      store.markAwardRedeemed = real;
    }

    assert.equal(result.ok, false, 'dilaporkan gagal, bukan exception');
    assert.match(result.errors.join(' '), /sekali/);
    assert.equal(store.listRemindersByOwner(OWNER).length, 0, 'reminder dari transaksi batal tidak tertinggal');
    assert.equal(store.getAward(award.claimId).status, 'pending', 'award tidak berubah status');
  });
});

describe('custom reminder — pengaturan server per kategori (hunt/battle)', () => {
  function adminMessage(content, opts = {}) {
    return makeMessage(content, { userId: 'admin1', admin: true, ...opts });
  }

  it('s battle set text langsung berlaku untuk hunt maupun battle', async () => {
    const set = adminMessage('d s battle set text ayo {mention} battle!');
    await require('../src/commands/prefix').handlePrefixCommand(set, null, { send: (m, payload) => m.reply(payload) });
    assert.match(textOf(set), /disimpan/);

    const rows = storage().listGuildReminderSettings('guild1');
    assert.equal(rows.length, 1, 'hanya satu baris untuk kategori HUNT_BATTLE');
    assert.equal(rows[0].action, 'battle', 'kunci baris memakai aksi kasar');

    const resolve = require('../src/utils/reminderResolve');
    for (const action of ['battle', 'hunt']) {
      const resolved = resolve.resolveRendered({ guildId: 'guild1', userId: 'u1', action });
      assert.equal(resolved.source, 'guild', action + ' memakai pengaturan server');
      assert.match(resolved.content, /ayo/, action + ' memakai teks yang sama');
    }
  });

  it('s hunt set text menimpa baris yang sama, bukan menambah baris baru', async () => {
    await require('../src/commands/prefix').handlePrefixCommand(
      adminMessage('d s battle set text teks battle'), null, { send: (m, payload) => m.reply(payload) });
    await require('../src/commands/prefix').handlePrefixCommand(
      adminMessage('d s hunt set text teks hunt'), null, { send: (m, payload) => m.reply(payload) });

    assert.equal(storage().listGuildReminderSettings('guild1').length, 1);
    assert.equal(storage().getGuildReminderSetting('guild1', 'battle').message, 'teks hunt');
    assert.equal(storage().getGuildReminderSetting('guild1', 'hunt').message, 'teks hunt');
  });

  it('s battle reset mengembalikan battle dan hunt sekaligus', async () => {
    await require('../src/commands/prefix').handlePrefixCommand(
      adminMessage('d s battle set text sementara'), null, { send: (m, payload) => m.reply(payload) });
    const reset = adminMessage('d s battle reset');
    await require('../src/commands/prefix').handlePrefixCommand(reset, null, { send: (m, payload) => m.reply(payload) });
    assert.match(textOf(reset), /dikembalikan ke bawaan/);

    const resolve = require('../src/utils/reminderResolve');
    for (const action of ['battle', 'hunt']) {
      assert.equal(resolve.resolveRendered({ guildId: 'guild1', userId: 'u1', action }).source, 'builtin', action + ' kembali ke bawaan');
    }
  });

  it('mengingatkan dengan teks server yang sama untuk battle dan hunt lewat engine', async () => {
    const engine = require('../src/services/lucyReminder');
    storage().setGuildReminderSetting({ guildId: 'guild1', action: 'battle', message: 'server {count} kali', updatedBy: 'a1' });
    require('../src/utils/lucyActionStorage').setPref('userX', 'battle', { enabled: true, pingMode: 'none' });

    const sent = [];
    const client = {
      channels: { fetch: async () => ({ isTextBased: () => true, send: async payload => { sent.push(payload); } }) },
      users: { fetch: async id => ({ id, username: 'u', displayAvatarURL: () => null }) },
      guilds: { cache: new Map([['guild1', { name: 'G', iconURL: () => null, members: { fetch: async () => null } }]]) }
    };
    for (const action of ['battle', 'hunt']) {
      await engine.deliverReminder(client, {
        guildId: 'guild1', channelId: 'chan1', userId: 'userX', kind: 'battle', action, name: 'X', messageId: 'm-' + action
      });
    }
    assert.equal(sent.length, 2);
    for (const payload of sent) assert.match(payload.content, /server \d+ kali/, 'teks server yang sama');
  });
});

describe('custom reminder — migrasi pengaturan server skema lama', () => {
  it('menggabungkan baris per aksi menjadi per kategori tanpa kehilangan data terbaru', () => {
    const { DatabaseSync } = require('node:sqlite');
    // Bangun database gaya skema v2 (baris per aksi) sebelum modul dimuat.
    fs.mkdirSync(path.join(tempDir, 'data'), { recursive: true });
    const raw = new DatabaseSync(path.join(tempDir, 'data', 'reminders.db'));
    raw.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE guild_reminder_settings (
        guild_id TEXT NOT NULL, action TEXT NOT NULL, format TEXT NOT NULL DEFAULT 'NORMAL',
        message TEXT, embed_json TEXT, updated_by TEXT, updated_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, action));`);
    raw.prepare('INSERT INTO schema_meta VALUES (?, ?)').run('schema_version', '2');
    const insert = raw.prepare('INSERT INTO guild_reminder_settings (guild_id, action, format, message, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
    insert.run('guild1', 'hunt', 'NORMAL', 'hunt lama', 'a1', 1000);
    insert.run('guild1', 'battle', 'NORMAL', 'battle baru', 'a1', 2000);
    insert.run('guild1', 'pray', 'NORMAL', 'pray saja', 'a1', 1500);
    raw.close();

    resetModules();
    const store = require('../src/utils/reminderStorage');
    assert.equal(store.SCHEMA_VERSION, '3');

    const rows = store.listGuildReminderSettings('guild1');
    assert.equal(rows.length, 2, 'hunt+battle digabung, pray dibiarkan');
    assert.equal(store.getGuildReminderSetting('guild1', 'battle').message, 'battle baru', 'baris terbaru menang');
    assert.equal(store.getGuildReminderSetting('guild1', 'hunt').message, 'battle baru', 'hunt ikut memakai baris gabungan');
    assert.equal(store.getGuildReminderSetting('guild1', 'pray').message, 'pray saja', 'kategori satu baris tidak berubah');
    assert.equal(store.getGuildReminderSetting('guild1', 'curse').message, 'pray saja');
  });

  it('tidak menjalankan migrasi dua kali', () => {
    const store = require('../src/utils/reminderStorage');
    store.setGuildReminderSetting({ guildId: 'guild1', action: 'hunt', message: 'teks', updatedBy: 'a1' });
    resetModules();
    const reloaded = require('../src/utils/reminderStorage');
    assert.equal(reloaded.listGuildReminderSettings('guild1').length, 1, 'tetap satu baris setelah muat ulang');
    assert.equal(reloaded.getGuildReminderSetting('guild1', 'battle').message, 'teks');
  });
});
