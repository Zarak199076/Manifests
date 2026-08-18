require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');

const MAX_DURATION_MS = 14 * 24 * 60 * 60 * 1000;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

const activeLoops = new Map();

const commands = [
  new SlashCommandBuilder()
    .setName('ping-test')
    .setDescription('Ping you once per second until you run /ping-stop')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('ping-stop')
    .setDescription('Stop your active ping loop')
    .toJSON(),
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const guildId = process.env.GUILD_ID;

  try {
    if (guildId) {
      // Guild-scoped: registers instantly, only visible in this one server.
      await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId),
        { body: commands },
      );
      console.log(`Slash commands registered for guild ${guildId}.`);
    } else {
      // Global: can take up to an hour to propagate, visible in every server the bot is in.
      await rest.put(
        Routes.applicationCommands(process.env.CLIENT_ID),
        { body: commands },
      );
      console.log('Slash commands registered globally (no GUILD_ID set — may take up to an hour to show up).');
    }
  } catch (err) {
    console.error('Failed to register slash commands:', err);
  }
}

function stopLoop(userId) {
  const loop = activeLoops.get(userId);
  if (!loop) return null;
  clearInterval(loop.intervalId);
  clearTimeout(loop.safetyTimeoutId);
  activeLoops.delete(userId);
  return loop;
}

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'ping-test') {
    const userId = interaction.user.id;

    if (activeLoops.has(userId)) {
      await interaction.reply({
        content: `You already have a ping loop running in <#${activeLoops.get(userId).channelId}>. Run /ping-stop first.`,
        ephemeral: true,
      });
      return;
    }

    await interaction.reply(`Starting ping loop for <@${userId}> — once per second. Run /ping-stop to end it.`);

    const channel = interaction.channel;
    const loopState = { count: 0, channelId: channel.id };

    loopState.intervalId = setInterval(async () => {
      loopState.count += 1;
      try {
        await channel.send(`<@${userId}> ping #${loopState.count}`);
      } catch (err) {
        console.error('Ping loop send failed, stopping:', err);
        stopLoop(userId);
      }
    }, 1000);

    loopState.safetyTimeoutId = setTimeout(() => {
      const stopped = stopLoop(userId);
      if (stopped) {
        channel.send(`<@${userId}> Auto-stopped after ${MAX_DURATION_MS / 60000} min (sent ${stopped.count} pings).`);
      }
    }, MAX_DURATION_MS);

    activeLoops.set(userId, loopState);
    return;
  }

  if (interaction.commandName === 'ping-stop') {
    const userId = interaction.user.id;
    const stopped = stopLoop(userId);

    if (!stopped) {
      await interaction.reply({ content: "You don't have an active ping loop.", ephemeral: true });
      return;
    }

    await interaction.reply(`Stopped. Sent ${stopped.count} pings.`);
    return;
  }
});

client.login(process.env.DISCORD_TOKEN);
