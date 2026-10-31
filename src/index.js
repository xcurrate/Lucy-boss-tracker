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
  if (message.author?.bot || !message.guildId) return;
  const config = getGuildSettings(message.guildId).autoThreadRep;
  if (!config.enabled || !config.channelId || message.channelId !== config.channelId) return;
  const targetId = config.targetUserId;
    if (!targetId || !message.content?.match(new RegExp('rep\\s+<@!?' + targetId + '>'))) return;
  //if (!targetId || !message.content?.match(new RegExp('\\rep\\s+<@!?' + targetId + '>'))) return;
  if (!message.mentions.users.has(targetId) || message.hasThread) return;
  try {
    const thread = await message.startThread({
      name: (config.threadNamePrefix + ' - ' + message.author.username).slice(0, 100),
      autoArchiveDuration: config.autoArchiveDuration
    });
      
   await thread.send({
  content: `\`lucy give ${config.amount} <@${message.author.id}>\``,
  allowedMentions: { parse: [] }
});
    //await thread.send({ content: 'lucy give ' + config.amount + ' ' + message.author.id, allowedMentions: { parse: [] } });
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
  
