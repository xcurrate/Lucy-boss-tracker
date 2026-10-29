require('dotenv').config();
const { REST, Routes } = require('discord.js');
const command = require('./commands/boss');
if (!process.env.DISCORD_TOKEN || !process.env.CLIENT_ID) { console.error('Set DISCORD_TOKEN and CLIENT_ID in .env'); process.exit(1); }
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
const route = process.env.GUILD_ID ? Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID) : Routes.applicationCommands(process.env.CLIENT_ID);
rest.put(route, { body: [command.data.toJSON()] })
  .then(() => console.log('Slash commands registered.'))
  .catch(e => { console.error(e); process.exitCode = 1; });
