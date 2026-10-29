require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');
const command = require('./commands/boss');
const { BossTracker } = require('./services/bossTracker');
if (!process.env.DISCORD_TOKEN || !process.env.LUCY_BOT_ID) {
  console.error('Set DISCORD_TOKEN and LUCY_BOT_ID in .env'); process.exit(1);
}
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const tracker = new BossTracker(client);
client.once(Events.ClientReady, async c => { console.log('Logged in as ' + c.user.tag); await tracker.restoreSchedules(); });
client.on(Events.MessageCreate, m => tracker.handleMessage(m).catch(console.error));
client.on(Events.MessageUpdate, async (_old, message) => {
  try { if (message.partial) message = await message.fetch(); await tracker.handleMessage(message); }
  catch (e) { console.error('[MessageUpdate]', e.message); }
});
client.on(Events.InteractionCreate, async i => {
  if (!i.isChatInputCommand() || i.commandName !== 'boss') return;
  try { await command.execute(i, tracker); }
  catch (e) {
    console.error(e);
    const data = { content: 'Terjadi kesalahan saat menjalankan perintah.', ephemeral: true };
    if (i.replied || i.deferred) await i.followUp(data).catch(() => {}); else await i.reply(data).catch(() => {});
  }
});
client.on(Events.Error, console.error);
client.login(process.env.DISCORD_TOKEN);
