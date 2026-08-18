require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

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

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Registering slash commands...');
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands },
    );
    console.log('Done. Commands should show up in Discord within a few minutes.');
  } catch (err) {
    console.error(err);
  }
})();
