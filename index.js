import express from "express";
import crypto from "crypto";
import {
  Client,
  GatewayIntentBits,
  ActivityType,
  EmbedBuilder,
  ChannelType,
  PermissionFlagsBits,
} from "discord.js";

const {
  DISCORD_BOT_TOKEN,
  DISCORD_CHANNEL_ID,
  GITHUB_WEBHOOK_SECRET,
  GITHUB_REPO,      // "owner/repo"
  TARGET_FOLDER,    // e.g. "uploads" (matches that folder and everything under it)
  BRANCH = "main",
  PORT = 3000,
  GITHUB_TOKEN, // optional, raises GitHub API rate limits for the file-count check
  GUILD_ID, // optional — set this for instant slash command registration in one server;
            // without it, global commands can take up to ~1 hour to show up everywhere
  IMAGE_FOLDER = "images", // folder to look in for a matching image (same base filename)
  TEXT_FOLDER = "info", // folder to look in for a matching .txt info file (same base filename)
  STATS_FILE_PATH = ".manifest-bot/stats.json", // where pull counts are stored in the repo
} = process.env;

const required = {
  DISCORD_BOT_TOKEN,
  DISCORD_CHANNEL_ID,
  GITHUB_WEBHOOK_SECRET,
  GITHUB_REPO,
  TARGET_FOLDER,
};
for (const [key, value] of Object.entries(required)) {
  if (!value) {
    console.error(`Missing required environment variable: ${key}. See .env.example`);
    process.exit(1);
  }
}

// Normalize so "uploads", "uploads/", "/uploads" all behave the same
const normalizedFolder = TARGET_FOLDER.replace(/^\/+|\/+$/g, "");
const normalizedImageFolder = IMAGE_FOLDER.replace(/^\/+|\/+$/g, "");
const normalizedTextFolder = TEXT_FOLDER.replace(/^\/+|\/+$/g, "");

// --- Discord setup ---
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

let discordReady = false;
client.once("ready", async () => {
  console.log(`Discord bot logged in as ${client.user.tag}`);
  discordReady = true;
  updateFileCountStatus();
  await loadManifestStats();

  const manifestCommand = {
    name: "manifest",
    description: "Get the download link for a file in the watched folder",
    options: [
      {
        name: "filename",
        description: "Full or partial file name to search for",
        type: 3, // STRING
        required: true,
        autocomplete: true,
      },
    ],
  };

  const requestOptionSchema = [
    {
      name: "details",
      description: "Briefly describe what you need",
      type: 3, // STRING
      required: false,
    },
  ];

  const requestUpdateCommand = {
    name: "request-update",
    description: "Open a private channel to request an update to an existing file",
    options: requestOptionSchema,
  };

  const requestNewCommand = {
    name: "request-new",
    description: "Open a private channel to request a new file be added",
    options: requestOptionSchema,
  };

  const commands = [manifestCommand, requestUpdateCommand, requestNewCommand];

  try {
    if (GUILD_ID) {
      // Register scoped to just this guild — instant, no ~1hr propagation delay.
      const targetGuild = await client.guilds.fetch(GUILD_ID);
      await targetGuild.commands.set(commands);
      console.log(`Registered commands in guild ${GUILD_ID}`);

      // Clear global commands so an old global registration can't linger alongside this one.
      await client.application.commands.set([]);
    } else {
      await client.application.commands.set(commands);
      console.log("Registered commands globally (may take up to an hour to appear)");
    }

    // Clear any leftover guild-specific commands in every OTHER guild the bot is in.
    // This cleans up duplicates left behind by switching GUILD_ID on/off across deploys.
    for (const [id, guild] of client.guilds.cache) {
      if (GUILD_ID && id === GUILD_ID) continue; // already handled above
      try {
        await guild.commands.set([]);
      } catch (err) {
        console.warn(`Couldn't clear guild commands in ${guild.name} (${id}):`, err.message);
      }
    }
  } catch (err) {
    console.error("Failed to register commands:", err);
  }
});
client.login(DISCORD_BOT_TOKEN);

// Safety net in case files change outside a tracked push event
setInterval(updateFileCountStatus, 15 * 60 * 1000);

// --- Web server for the GitHub webhook ---
const app = express();

// Keep the raw body around so we can verify GitHub's signature
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

function verifySignature(req) {
  const signature = req.headers["x-hub-signature-256"];
  if (!signature) return false;
  const hmac = crypto.createHmac("sha256", GITHUB_WEBHOOK_SECRET);
  const digest = "sha256=" + hmac.update(req.rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
  } catch {
    return false; // length mismatch etc.
  }
}

function isInTargetFolder(filePath) {
  return filePath === normalizedFolder || filePath.startsWith(normalizedFolder + "/");
}

function stripExtension(filename) {
  return filename.replace(/\.[^/.]+$/, "");
}

// Cache of files in the watched folder, so /manifest and its autocomplete can respond
// instantly instead of hitting the GitHub API on every keystroke. Refreshed by
// updateFileCountStatus (on startup, every 15 min, and after each relevant push).
let folderFilesCache = [];

async function fetchFolderContents(folderPath) {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${encodeURI(
    folderPath
  )}?ref=${BRANCH}`;
  const headers = { Accept: "application/vnd.github+json" };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GitHub API returned HTTP ${res.status}`);
  }

  const contents = await res.json();
  if (!Array.isArray(contents)) return [];
  return contents.filter((item) => item.type === "file");
}

async function fetchFolderFiles() {
  return fetchFolderContents(normalizedFolder);
}

// Looks in IMAGE_FOLDER for a file with the same base name (extension ignored),
// e.g. "terraria.zip" in the manifest folder matches "terraria.png" in the image folder.
async function findMatchingImage(baseName) {
  try {
    const files = await fetchFolderContents(normalizedImageFolder);
    const match = files.find(
      (f) => stripExtension(f.name).toLowerCase() === baseName.toLowerCase()
    );
    if (!match) return null;
    return `https://raw.githubusercontent.com/${GITHUB_REPO}/${BRANCH}/${encodeURI(match.path)}`;
  } catch (err) {
    console.error("Error looking up matching image:", err);
    return null;
  }
}

// Parses lines like: Description = "some text"
// Recognizes: Description, Price, Developer, Last Updated
function parseInfoText(text) {
  const result = {};
  const regex = /^\s*(Description|Price|Developer|Last Updated)\s*=\s*"([^"]*)"\s*$/gim;
  let match;
  while ((match = regex.exec(text)) !== null) {
    result[match[1]] = match[2];
  }
  return result;
}

// Looks in TEXT_FOLDER for a .txt file with the same base name (extension ignored),
// e.g. "terraria.zip" in the manifest folder matches "terraria.txt" in the info folder.
async function findMatchingInfoText(baseName) {
  try {
    const files = await fetchFolderContents(normalizedTextFolder);
    const match = files.find(
      (f) =>
        stripExtension(f.name).toLowerCase() === baseName.toLowerCase() &&
        f.name.toLowerCase().endsWith(".txt")
    );
    if (!match) return null;

    const rawUrl = `https://raw.githubusercontent.com/${GITHUB_REPO}/${BRANCH}/${encodeURI(match.path)}`;
    const res = await fetch(rawUrl);
    if (!res.ok) return null;

    const text = await res.text();
    return parseInfoText(text);
  } catch (err) {
    console.error("Error looking up matching info text:", err);
    return null;
  }
}

// Finds the earliest commit that touched this file, i.e. when it was added.
// Falls back to null if it can't be determined.
async function getFileAddedDate(filePath) {
  try {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/commits?path=${encodeURI(
      filePath
    )}&sha=${BRANCH}&per_page=100`;
    const headers = { Accept: "application/vnd.github+json" };
    if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;

    const res = await fetch(url, { headers });
    if (!res.ok) return null;

    const commits = await res.json();
    if (!Array.isArray(commits) || commits.length === 0) return null;

    // Commits come back newest-first; the last entry is the oldest we fetched.
    const oldest = commits[commits.length - 1];
    const dateStr = oldest.commit?.author?.date || oldest.commit?.committer?.date;
    return dateStr ? new Date(dateStr) : null;
  } catch (err) {
    console.error("Error fetching file added date:", err);
    return null;
  }
}

function formatFileSize(bytes) {
  const kb = bytes / 1024;
  if (kb >= 1024) {
    return `${(kb / 1024).toFixed(2)} MB`;
  }
  return `${kb.toFixed(2)} KB`;
}

function formatDate(date) {
  return date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

// --- Pull-count stats, persisted as a JSON file committed into the watched repo ---
// (Railway's filesystem doesn't survive redeploys, so counting in-memory only
// would reset every time the bot restarts.)
let manifestStats = {}; // { "terraria": 5, ... } keyed by lowercase name-without-extension
let statsSha = null; // current file SHA, needed to update it via the GitHub API
let statsDirty = false;

async function loadManifestStats() {
  try {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${encodeURI(
      STATS_FILE_PATH
    )}?ref=${BRANCH}`;
    const headers = { Accept: "application/vnd.github+json" };
    if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;

    const res = await fetch(url, { headers });
    if (res.status === 404) {
      manifestStats = {};
      statsSha = null;
      console.log("No existing pull-stats file yet — starting fresh");
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    statsSha = data.sha;
    manifestStats = JSON.parse(Buffer.from(data.content, "base64").toString("utf-8"));
    console.log(`Loaded pull stats for ${Object.keys(manifestStats).length} file(s)`);
  } catch (err) {
    console.error("Error loading manifest stats:", err);
    manifestStats = {};
  }
}

async function saveManifestStats() {
  if (!GITHUB_TOKEN) {
    console.warn("GITHUB_TOKEN not set — pull counts will reset on next deploy");
    return;
  }
  try {
    const body = {
      message: "Update manifest pull stats",
      content: Buffer.from(JSON.stringify(manifestStats, null, 2)).toString("base64"),
      branch: BRANCH,
    };
    if (statsSha) body.sha = statsSha;

    const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${encodeURI(STATS_FILE_PATH)}`;
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      // Likely a stale SHA (someone/something else wrote in the meantime) — reload and retry once.
      if (res.status === 409 || res.status === 422) {
        await loadManifestStats();
        return;
      }
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();
    statsSha = data.content?.sha ?? statsSha;
    statsDirty = false;
  } catch (err) {
    console.error("Error saving manifest stats:", err);
  }
}

function recordManifestPull(nameWithoutExt) {
  const key = nameWithoutExt.toLowerCase();
  manifestStats[key] = (manifestStats[key] || 0) + 1;
  statsDirty = true;
}

function getPullCount(nameWithoutExt) {
  return manifestStats[nameWithoutExt.toLowerCase()] || 0;
}

// Batches writes instead of committing to GitHub on every single /manifest call
setInterval(() => {
  if (statsDirty) saveManifestStats();
}, 2 * 60 * 1000);

async function updateFileCountStatus() {
  try {
    const files = await fetchFolderFiles();
    folderFilesCache = files;
    if (discordReady) {
      client.user.setActivity(`${files.length} Manifests`, { type: ActivityType.Watching });
      console.log(`Status updated: ${files.length} Manifests`);
    }
  } catch (err) {
    console.error("Error updating file count status:", err);
  }
}

// Creates a private text channel visible only to the requester (and anyone with
// server-wide Administrator permission, who can see every channel regardless).
async function createRequestChannel(interaction, kind) {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: "This command only works inside a server.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const details = interaction.options.getString("details") || "No additional details provided.";
  const label = kind === "update" ? "update" : "new-file";
  const safeUsername = interaction.user.username
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 20);
  const uniqueSuffix = Date.now().toString().slice(-4);
  const channelName = `${label}-${safeUsername}-${uniqueSuffix}`;

  try {
    const channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      topic: `${kind === "update" ? "Update" : "New file"} request from ${interaction.user.tag}`,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel],
        },
        {
          id: interaction.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
          ],
        },
        {
          id: client.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ManageChannels,
          ],
        },
      ],
    });

    const heading =
      kind === "update" ? "📦 **Update Request**" : "🆕 **New File Request**";

    await channel.send(
      `${heading}\nRequested by ${interaction.user}\n\n**Details:** ${details}\n\nAn admin will be with you shortly. Feel free to add more info or attachments here.`
    );

    await interaction.editReply({ content: `Created your private channel: ${channel}` });
  } catch (err) {
    console.error(`Error creating ${kind} request channel:`, err);
    await interaction.editReply({
      content:
        "Couldn't create the channel — make sure the bot's role has the **Manage Channels** permission in this server.",
    });
  }
}

client.on("interactionCreate", async (interaction) => {
  if (interaction.isAutocomplete()) {
    if (interaction.commandName !== "manifest") return;
    const focused = interaction.options.getFocused().toLowerCase();

    const choices = folderFilesCache
      .filter((f) => stripExtension(f.name).toLowerCase().includes(focused))
      .slice(0, 25) // Discord's max
      .map((f) => {
        const nameWithoutExt = stripExtension(f.name);
        return { name: nameWithoutExt, value: nameWithoutExt };
      });

    try {
      await interaction.respond(choices);
    } catch (err) {
      console.error("Error responding to autocomplete:", err);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "request-update") {
    await createRequestChannel(interaction, "update");
    return;
  }
  if (interaction.commandName === "request-new") {
    await createRequestChannel(interaction, "new");
    return;
  }

  if (interaction.commandName !== "manifest") return;

  const query = interaction.options.getString("filename", true).trim().toLowerCase();
  await interaction.deferReply();

  try {
    // Prefer an exact filename match (e.g. picked from the autocomplete list),
    // fall back to a partial/substring match otherwise.
    const exact = folderFilesCache.filter((f) => stripExtension(f.name).toLowerCase() === query);
    const matches = exact.length > 0
      ? exact
      : folderFilesCache.filter((f) => stripExtension(f.name).toLowerCase().includes(query));

    if (matches.length === 0) {
      await interaction.editReply(`No files matching **${query}** found in \`${normalizedFolder}\`.`);
      return;
    }

    if (matches.length > 1) {
      const MAX_LISTED = 20;
      const names = matches.slice(0, MAX_LISTED).map((f) => `• ${stripExtension(f.name)}`);
      if (matches.length > MAX_LISTED) {
        names.push(`…and ${matches.length - MAX_LISTED} more.`);
      }
      await interaction.editReply(
        `Found ${matches.length} matches — be more specific:\n${names.join("\n")}`
      );
      return;
    }

    const file = matches[0];
    const nameWithoutExt = stripExtension(file.name);
    const rawUrl = `https://raw.githubusercontent.com/${GITHUB_REPO}/${BRANCH}/${encodeURI(file.path)}`;

    recordManifestPull(nameWithoutExt);

    const [imageUrl, addedDate, infoData] = await Promise.all([
      findMatchingImage(nameWithoutExt),
      getFileAddedDate(file.path),
      findMatchingInfoText(nameWithoutExt),
    ]);

    const fields = [
      { name: "File Size", value: formatFileSize(file.size), inline: true },
      { name: "Added", value: addedDate ? formatDate(addedDate) : "Unknown", inline: true },
      { name: "Pulled", value: `${getPullCount(nameWithoutExt)} times`, inline: true },
    ];
    if (infoData?.Price) fields.push({ name: "Price", value: infoData.Price, inline: true });
    if (infoData?.Developer) fields.push({ name: "Developer", value: infoData.Developer, inline: true });
    if (infoData?.["Last Updated"]) {
      fields.push({ name: "Last Updated", value: infoData["Last Updated"], inline: true });
    }

    const embed = new EmbedBuilder()
      .setTitle(nameWithoutExt)
      .setURL(rawUrl)
      .setColor(0x5865f2)
      .addFields(fields)
      .setFooter({
        text: `Requested by ${interaction.user.username} • Manifest bot by Zarak_Plays`,
        iconURL: interaction.user.displayAvatarURL(),
      })
      .setTimestamp();

    if (infoData?.Description) {
      embed.setDescription(infoData.Description);
    }

    if (imageUrl) {
      embed.setImage(imageUrl);
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error("Error handling /manifest command:", err);
    await interaction.editReply("Something went wrong looking that up — try again in a bit.");
  }
});

app.get("/", (_req, res) => {
  res.send("GitHub → Discord bot is running.");
});

app.post("/webhook", async (req, res) => {
  if (!verifySignature(req)) {
    return res.status(401).send("Invalid signature");
  }

  const event = req.headers["x-github-event"];

  if (event === "ping") {
    return res.status(200).send("pong");
  }
  if (event !== "push") {
    return res.status(200).send("Ignored (not a push event)");
  }

  // Ack immediately so GitHub doesn't retry; do the Discord work after.
  res.status(200).send("OK");

  try {
    const payload = req.body;

    if (payload.repository?.full_name !== GITHUB_REPO) return;

    const refBranch = payload.ref?.replace("refs/heads/", "");
    if (BRANCH && refBranch !== BRANCH) return;

    // Collect every added/modified file across all commits in this push
    const changedFiles = new Set();
    for (const commit of payload.commits || []) {
      for (const f of commit.added || []) changedFiles.add(f);
      for (const f of commit.modified || []) changedFiles.add(f);
    }

    const matching = [...changedFiles].filter(isInTargetFolder);

    if (matching.length > 0) {
      if (!discordReady) {
        console.warn("Discord client wasn't ready yet — skipping this batch:", matching);
      } else {
        const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
        for (const filePath of matching) {
          const filename = filePath.split("/").pop();
          const nameWithoutExt = stripExtension(filename);
          const rawUrl = `https://raw.githubusercontent.com/${GITHUB_REPO}/${refBranch}/${encodeURI(
            filePath
          )}`;
          await channel.send(`[${nameWithoutExt}](<${rawUrl}>)`);
        }
      }
    }

    // Recount regardless — a push could also remove files from the folder
    await updateFileCountStatus();
  } catch (err) {
    console.error("Error handling webhook payload:", err);
  }
});

app.listen(PORT, () => {
  console.log(`Webhook server listening on port ${PORT}`);
});
