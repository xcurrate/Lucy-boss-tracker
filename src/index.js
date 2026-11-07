require('dotenv').config();
const { Client, GatewayIntentBits, Events, MessageFlags } = require('discord.js');
const command = require('./commands/boss');
const { handlePrefixCommand } = require('./commands/prefix');
const { BossTracker } = require('./services/bossTracker');
const { getGuildSettings } = require('./utils/storage');
const logBuffer = require('./utils/logBuffer');
const { startDashboard } = require('./dashboard/server');
const lucyCounter = require('./services/lucyCounter');
const family100 = require('./services/family100');
const bossRewards = require('./services/bossRewardNotifications');
const animalDex = require('./services/animalDex');

logBuffer.install();
if (!process.env.DISCORD_TOKEN || !process.env.LUCY_BOT_ID) {
  console.error('Set DISCORD_TOKEN and LUCY_BOT_ID in .env');
  process.exit(1);
}
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const tracker = new BossTracker(client);
animalDex.setClient(client);

// Emoji statistik milik Lucy perlu di-mirror ke aplikasi bot agar bisa dirender;
// jalankan sekali saat start supaya dex langsung tampil lengkap.
async function syncAnimalDexEmojis() {
  try { await animalDex.mirrorEmojiTokens(animalDex.allEmojiTokens()); }
  catch (e) { console.error('[AnimalDex] mirror emoji:', e.message); }
}

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

// Tangkap kartu "Informasi animal" dari bot Lucy (raw JSON Components V2) ke dex.
function captureAnimalDex(message) {
  if (message.author?.id !== process.env.LUCY_BOT_ID) return;
  try { animalDex.captureMessage(message); }
  catch (e) { console.error('[AnimalDex]', e); }
}

async function handlePrefixMessage(message) {
  return handlePrefixCommand(message, tracker, {
    send: (m, payload) => m.reply({ ...payload, allowedMentions: { repliedUser: false, parse: [] } })
  });
}
client.once(Events.ClientReady, async c => {
  console.log('Logged in as ' + c.user.tag);
  await tracker.restoreSchedules();
  syncAnimalDexEmojis();
});
client.on(Events.MessageCreate, async message => {
  lucyCounter.handleMessage(message).catch(e => console.error('[LucyCounter]', e));
  family100.handleMessage(message).catch(e => console.error('[Family100]', e));
  tracker.handleMessage(message).catch(console.error);
  bossRewards.enqueue(message);
  captureAnimalDex(message);
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
    bossRewards.enqueue(message);
    captureAnimalDex(message);
  } catch (e) { console.error('[MessageUpdate]', e.message); }
});
client.on(Events.InteractionCreate, async i => {
  try {
    if (i.isChatInputCommand() && i.commandName === 'boss') { await command.execute(i, tracker); return; }
    if (i.isButton() && lucyCounter.isLucyNav(i.customId)) { await lucyCounter.handleNavigation(i); return; }
    if (i.isButton() && family100.isF100Nav(i.customId)) { await family100.handleNavigation(i); return; }
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
  
