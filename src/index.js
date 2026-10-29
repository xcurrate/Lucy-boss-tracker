require('dotenv').config();
const { Client, GatewayIntentBits, Events, PermissionFlagsBits } = require('discord.js');
const command = require('./commands/boss');
const { BossTracker } = require('./services/bossTracker');
const { getGuildSettings, updateGuildSettings } = require('./utils/storage');

if (!process.env.DISCORD_TOKEN || !process.env.LUCY_BOT_ID) {
  console.error('Set DISCORD_TOKEN and LUCY_BOT_ID in .env');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});
const tracker = new BossTracker(client);

function isAdmin(message) {
  return Boolean(message.member?.permissions?.has(PermissionFlagsBits.ManageGuild));
}

function send(message, content) {
  return message.reply({ content, allowedMentions: { repliedUser: false, parse: [] } });
}

async function handlePrefixCommand(message) {
  if (!message.guildId || message.author.bot) return;
  const settings = getGuildSettings(message.guildId);
  const prefix = settings.prefix || '!';
  if (!message.content.startsWith(prefix)) return;

  const input = message.content.slice(prefix.length).trim();
  const [root, ...args] = input.split(/\s+/);
  if ((root || '').toLowerCase() !== 'boss') return;
  const sub = (args[0] || 'help').toLowerCase();
  const rest = args.slice(1);

  if (sub === 'help') {
    return send(message, [
      '**🐉 Boss Tracker — Bantuan**',
      '• `' + prefix + 'boss on` — aktifkan pengingat pribadi lewat DM',
      '• `' + prefix + 'boss off` — matikan pengingat pribadi',
      '• `' + prefix + 'boss status` — lihat status dan jadwal boss',
      '• `' + prefix + 'boss help` — tampilkan bantuan ini',
      '',
      'Pengaturan server dikelola moderator/admin.'
    ].join('\n'));
  }

  if (sub === 'on' || sub === 'off') {
    const enabled = sub === 'on';
    updateGuildSettings(message.guildId, s => {
      const users = new Set(s.dmUsers || []);
      enabled ? users.add(message.author.id) : users.delete(message.author.id);
      return { ...s, dmUsers: [...users] };
    });
    return send(message, enabled
      ? '✅ Pengingat pribadi aktif. Kamu akan menerima DM saat boss muncul.'
      : '🔕 Pengingat pribadi dimatikan.');
  }

  if (sub === 'status') {
    const s = getGuildSettings(message.guildId);
    const ts = s.lastBossTimestamp;
    return send(message, [
      '**🐉 Status Boss Tracker**',
      'Notifikasi server: ' + (s.enabled ? '✅ Aktif' : '🔕 Nonaktif'),
      'Pengingat DM kamu: ' + ((s.dmUsers || []).includes(message.author.id) ? '✅ Aktif' : '🔕 Nonaktif'),
      'Boss berikutnya: ' + (ts ? '<t:' + ts + ':F> (<t:' + ts + ':R>)' : 'Belum terdeteksi dari pesan Lucy.')
    ].join('\n'));
  }

  if (sub === 'prefix') {
    if (!isAdmin(message)) return send(message, 'Pengaturan prefix hanya bisa digunakan moderator/admin.');
    const value = rest[0];
    if (!value) return send(message, 'Prefix server saat ini: `' + prefix + '`. Ubah dengan `' + prefix + 'boss prefix <prefix-baru>`.');
    if (value.length > 5 || /\s/.test(value)) return send(message, 'Prefix harus 1–5 karakter tanpa spasi.');
    updateGuildSettings(message.guildId, s => ({ ...s, prefix: value }));
    return send(message, '✅ Prefix diubah menjadi `' + value + '`. Contoh: `' + value + 'boss help`');
  }

  if (sub === 'admin-help') {
    if (!isAdmin(message)) return send(message, 'Panduan ini khusus moderator/admin server.');
    return send(message, [
      '**⚙️ Pengaturan Moderator/Admin**',
      '• `' + prefix + 'boss setup #channel @role` — atur channel dan role tag',
      '• `' + prefix + 'boss server on` — aktifkan notifikasi server',
      '• `' + prefix + 'boss server off` — matikan notifikasi server',
      '• `' + prefix + 'boss prefix <prefix-baru>` — ubah prefix server',
      '• `' + prefix + 'boss prefix` — lihat prefix saat ini',
      'Pengaturan slash command: `/boss setup`, `/boss server-on`, `/boss server-off`, dan `/boss prefix`.'
    ].join('\n'));
  }

  if (['setup', 'server', 'server-on', 'server-off'].includes(sub) && !isAdmin(message)) {
    return send(message, 'Perintah ini hanya bisa digunakan moderator/admin dengan izin Manage Server.');
  }

  if (sub === 'setup') {
    const channelId = (rest[0] || '').match(/^<#?(\d+)>?$/)?.[1];
    const roleId = (rest[1] || '').match(/^<@&?(\d+)>?$/)?.[1];
    if (!channelId || !roleId) {
      return send(message, 'Format: `' + prefix + 'boss setup #channel @role`');
    }
    const channel = await message.guild.channels.fetch(channelId).catch(() => null);
    const role = await message.guild.roles.fetch(roleId).catch(() => null);
    if (!channel?.isTextBased() || !channel.send || !role) {
      return send(message, 'Channel teks atau role tidak ditemukan. Pastikan pilihan benar.');
    }
    updateGuildSettings(message.guildId, s => ({ ...s, channelId, roleId }));
    return send(message, '✅ Channel dan role notifikasi tersimpan. Aktifkan dengan `' + prefix + 'boss server on`.');
  }

  if (sub === 'server' || sub === 'server-on' || sub === 'server-off') {
    const action = sub === 'server-on' ? 'on' : sub === 'server-off' ? 'off' : (rest[0] || '').toLowerCase();
    if (!['on', 'off'].includes(action)) return send(message, 'Format: `' + prefix + 'boss server on` atau `' + prefix + 'boss server off`.');
    const current = getGuildSettings(message.guildId);
    if (action === 'on' && (!current.channelId || !current.roleId)) {
      return send(message, 'Atur channel dan role terlebih dahulu dengan `' + prefix + 'boss setup #channel @role`.');
    }
    const enabled = action === 'on';
    const s = updateGuildSettings(message.guildId, old => ({ ...old, enabled }));
    if (enabled && s.lastBossTimestamp) tracker.scheduleGuild(message.guildId, s.lastBossTimestamp);
    else if (!enabled) tracker.stopGuild(message.guildId);
    return send(message, enabled ? '✅ Tracker aktif untuk seluruh server.' : '🔕 Tracker server dimatikan.');
  }

  return send(message, 'Perintah tidak dikenal. Gunakan `' + prefix + 'boss help`.');
}

client.once(Events.ClientReady, async c => {
  console.log('Logged in as ' + c.user.tag);
  await tracker.restoreSchedules();
});
client.on(Events.MessageCreate, async message => {
  tracker.handleMessage(message).catch(console.error);
  handlePrefixCommand(message).catch(e => {
    console.error('[PrefixCommand]', e);
    send(message, 'Terjadi kesalahan saat menjalankan perintah.').catch(() => {});
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
  if (!i.isChatInputCommand() || i.commandName !== 'boss') return;
  try {
    await command.execute(i, tracker);
  } catch (e) {
    console.error(e);
    const data = { content: 'Terjadi kesalahan saat menjalankan perintah.', ephemeral: true };
    if (i.replied || i.deferred) await i.followUp(data).catch(() => {});
    else await i.reply(data).catch(() => {});
  }
});
client.on(Events.Error, console.error);
client.login(process.env.DISCORD_TOKEN);
