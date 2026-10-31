require('dotenv').config();
const { Client, GatewayIntentBits, Events, MessageFlags } = require('discord.js');
const command = require('./commands/boss');
const { handlePrefixCommand } = require('./commands/prefix');
const { BossTracker } = require('./services/bossTracker');
const { getGuildSettings } = require('./utils/storage');
const logBuffer = require('./utils/logBuffer');
const { startDashboard } = require('./dashboard/server');

logBuffer.install();
if (!process.env.DISCORD_TOKEN || !process.env.LUCY_BOT_ID) {
  console.error('Set DISCORD_TOKEN and LUCY_BOT_ID in .env');
  process.exit(1);
}
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const tracker = new BossTracker(client);

async function handleAutoThreadRep(message) {
  // Hindari log untuk setiap pesan biasa; diagnostik hanya untuk pesan yang tampak
  // mencoba menjalankan *rep atau menyebut target Auto Thread Rep.
  const content = message.content || '';
  const hasRepCommand = /\\*rep\\b/i.test(content);
  if (!hasRepCommand) return;

  const context = {
    guildId: message.guildId || 'DM',
    channelId: message.channelId,
    messageId: message.id,
    authorId: message.author?.id,
    authorBot: Boolean(message.author?.bot)
  };
  const skip = reason => console.log('[AutoThreadRep] SKIP:', reason, JSON.stringify(context));
  const fail = (stage, error) => console.error(
    '[AutoThreadRep] ERROR pada ' + stage + ':',
    error?.message || error,
    JSON.stringify({ ...context, code: error?.code, httpStatus: error?.status })
  );

  if (message.author?.bot) return skip('Pesan berasal dari bot; hanya pesan anggota yang diproses.');
  if (!message.guildId) return skip('Pesan bukan berasal dari server Discord.');

  let config;
  try {
    config = getGuildSettings(message.guildId).autoThreadRep;
  } catch (error) {
    return fail('membaca konfigurasi Auto Thread Rep', error);
  }

  if (!config.enabled) return skip('Fitur Auto Thread Rep sedang OFF di dashboard.');
  if (!config.channelId) return skip('Channel pemicu belum dipilih di dashboard.');
  if (message.channelId !== config.channelId) {
    return skip('Channel tidak cocok. Pesan harus dikirim di channel pemicu yang dipilih.');
  }

  const commandMatch = content.match(/\\*rep\\s+<@!?(\\d+)>/i);
  if (!commandMatch) {
    return skip('Format tidak cocok. Gunakan *rep lalu mention target Discord.');
  }
  if (commandMatch[1] !== String(config.targetUserId)) {
    return skip('Mention mengarah ke user ID ' + commandMatch[1] + ', bukan target konfigurasi ' + config.targetUserId + '.');
  }
  if (!message.mentions?.users?.has(String(config.targetUserId))) {
    return skip('Mention target tidak terdeteksi sebagai mention Discord yang valid.');
  }
  if (message.hasThread) {
    return skip('Pesan sudah memiliki thread; thread duplikat tidak dibuat.');
  }
  if (typeof message.startThread !== 'function') {
    return skip('Channel/pesan ini tidak mendukung pembuatan thread dari pesan.');
  }

  console.log('[AutoThreadRep] MATCH: syarat terpenuhi, mencoba membuat thread.', JSON.stringify(context));
  let thread;
  try {
    thread = await message.startThread({
      name: (config.threadNamePrefix + ' - ' + message.author.username).slice(0, 100),
      autoArchiveDuration: config.autoArchiveDuration
    });
    console.log('[AutoThreadRep] SUCCESS: thread berhasil dibuat.', JSON.stringify({
      ...context, threadId: thread.id, threadName: thread.name
    }));
  } catch (error) {
    return fail('membuat thread (periksa izin Create Public Threads dan Send Messages in Threads)', error);
  }

  try {
    await thread.send({
      content: 'lucy give ' + config.amount + ' ' + message.author.id,
      allowedMentions: { parse: [] }
    });
    console.log('[AutoThreadRep] SUCCESS: instruksi rep berhasil dikirim ke thread.', JSON.stringify({
      ...context, threadId: thread.id
    }));
  } catch (error) {
    fail('mengirim instruksi ke thread (periksa izin Send Messages in Threads)', error);
  }
}

async function handlePrefixMessage(message) {
  return handlePrefixCommand(message, tracker, {
    send: (m, payload) => m.reply({ ...payload, allowedMentions: { repliedUser: false, parse: [] } })
  });
}
client.once(Events.ClientReady, async c => {
  console.log('Logged in as ' + c.user.tag);
  await tracker.restoreSchedules();
});
client.on(Events.MessageCreate, async message => {
  tracker.handleMessage(message).catch(console.error);
  handlePrefixMessage(message).catch(e => {
    console.error('[PrefixCommand]', e);
    message.reply({ content: 'Terjadi kesalahan saat menjalankan perintah.' }).catch(() => {});
  });
  handleAutoThreadRep(message).catch(e => console.error('[AutoThreadRep]', e));
});
client.on(Events.MessageUpdate, async (_old, message) => {
  try {
    if (message.partial) message = await message.fetch();
    await tracker.handleMessage(message);
  } catch (e) { console.error('[MessageUpdate]', e.message); }
});
client.on(Events.InteractionCreate, async i => {
  try {
    if (i.isChatInputCommand() && i.commandName === 'boss') { await command.execute(i, tracker); return; }
    if (i.isButton() || i.isStringSelectMenu()) { await command.handleComponent(i, tracker); return; }
  } catch (e) {
    console.error(e);
    const data = { content: 'Terjadi kesalahan saat menjalankan perintah.', flags: MessageFlags.Ephemeral };
    if (i.replied || i.deferred) await i.followUp(data).catch(() => {}); else await i.reply(data).catch(() => {});
  }
});
client.on(Events.Error, console.error);
startDashboard(client, tracker);
client.login(process.env.DISCORD_TOKEN);
