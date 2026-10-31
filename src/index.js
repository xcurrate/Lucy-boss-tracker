require('dotenv').config();
const { Client, GatewayIntentBits, Events, MessageFlags } = require('discord.js');
const command = require('./commands/boss');
const { handlePrefixCommand } = require('./commands/prefix');
const { BossTracker } = require('./services/bossTracker');

if (!process.env.DISCORD_TOKEN || !process.env.LUCY_BOT_ID) {
  console.error('Set DISCORD_TOKEN and LUCY_BOT_ID in .env');
  process.exit(1);
}

const REP_TARGET_ID = '1515658233174294569';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});
const tracker = new BossTracker(client);

async function handleAutoThreadRep(message) {
  if (message.author?.bot) return;
  if (!message.content?.match(/\\*rep\\s+<@!?1515658233174294569>/)) return;
  // A textual lookalike is not enough: Discord must parse this as a real user mention.
  if (!message.mentions.users.has(REP_TARGET_ID)) return;
  // A message can only own one thread; avoid attempting to create it again.
  if (message.hasThread) return;

  try {
    const thread = await message.startThread({
      name: `Rep - ${message.author.username}`,
      autoArchiveDuration: 1440
    });

    // This is intentionally plain text for the user to copy; never execute it.
    await thread.send({
      content: `lucy give 50k ${message.author.id}`,
      allowedMentions: { parse: [] }
    });
  } catch (error) {
    console.error('[AutoThreadRep] Gagal membuat thread atau mengirim command teks:', error);
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
  handleAutoThreadRep(message).catch(e => {
    console.error('[AutoThreadRep]', e);
  });
});
client.on(Events.MessageUpdate, async (_old, message) => {
  try {
    if (message.partial) message = await message.fetch();
    await tracker.handleMessage(message);
  } catch (e) {
    console.error('[MessageUpdate]', e.message);
  }
});
client.on(Events.InteractionCreate, async i => {
  try {
    if (i.isChatInputCommand() && i.commandName === 'boss') {
      await command.execute(i, tracker);
      return;
    }
    if (i.isButton() || i.isStringSelectMenu()) {
      await command.handleComponent(i, tracker);
      return;
    }
  } catch (e) {
    console.error(e);
    const data = { content: 'Terjadi kesalahan saat menjalankan perintah.', flags: MessageFlags.Ephemeral };
    if (i.replied || i.deferred) await i.followUp(data).catch(() => {});
    else await i.reply(data).catch(() => {});
  }
});
client.on(Events.Error, console.error);
client.login(process.env.DISCORD_TOKEN);
