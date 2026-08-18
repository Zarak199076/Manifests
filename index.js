require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');

const MAX_DURATION_MS = 10 * 60 * 1000; // safety ceiling: 10 minutes

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

// userId -> loop state
const activeLoops = new Map();

function stopLoop(userId) {
  const loop = activeLoops.get(userId);
  if (!loop) return null;
  clearInterval(loop.intervalId);
  clearTimeout(loop.safetyTimeoutId);
  activeLoops.delete(userId);
  return loop;
}

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
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
        channel.send(`<@${userId}> Auto-stopped after ${MAX_DURATION_MS / 60000000000000} min (sent ${stopped.count} pings).`);
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
