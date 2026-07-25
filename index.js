import express from "express";
import crypto from "crypto";
import AdmZip from "adm-zip";
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
  STATS_CHANNEL_NAME = "manifest-data", // private channel used to store /manifest pull counts
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
  await setupStatsChannel();
  cleanupOldRequestChannels();

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

  const botSetupCommand = {
    name: "bot-setup",
    description: "Configure bot settings",
    default_member_permissions: PermissionFlagsBits.Administrator.toString(),
    options: [
      {
        name: "manifest-channel",
        description: "Set which channel /manifest can be used in",
        type: 1, // SUB_COMMAND
        options: [
          {
            name: "channel",
            description: "The channel to restrict /manifest to",
            type: 7, // CHANNEL
            required: true,
            channel_types: [ChannelType.GuildText],
          },
        ],
      },
      {
        name: "request-cleanup",
        description: "Auto-delete request channels a set number of hours after they're created",
        type: 1, // SUB_COMMAND
        options: [
          {
            name: "hours",
            description: "Hours after creation to delete request channels (0 disables this)",
            type: 4, // INTEGER
            required: true,
            min_value: 0,
          },
        ],
      },
      {
        name: "support-role",
        description: "Set the role that can see /request-update and /request-new channels",
        type: 1, // SUB_COMMAND
        options: [
          {
            name: "role",
            description: "The support/admin role to grant access — omit to clear it",
            type: 8, // ROLE
            required: false,
          },
        ],
      },
    ],
  };

  const uploadAssetsCommand = {
    name: "upload-assets",
    description: "Upload a zip of images/info files — sorts them into the right folders automatically",
    default_member_permissions: PermissionFlagsBits.Administrator.toString(),
    options: [
      {
        name: "file",
        description: "A .zip containing images and/or .txt info files",
        type: 11, // ATTACHMENT
        required: true,
      },
    ],
  };

  const steamImportCommand = {
    name: "steam-import",
    description: "Fetch Steam game(s) header image + info and add them to the image/info folders",
    default_member_permissions: PermissionFlagsBits.Administrator.toString(),
    options: [
      {
        name: "app_id",
        description: "One or more Steam App IDs, comma-separated — e.g. 400, 620",
        type: 3, // STRING
        required: true,
      },
    ],
  };

  const commands = [
    manifestCommand,
    requestUpdateCommand,
    requestNewCommand,
    botSetupCommand,
    uploadAssetsCommand,
    steamImportCommand,
  ];

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
// Recognizes: Description, Price, Developer, Last Updated, App ID (also accepts app_id / AppID)
function parseInfoText(text) {
  const result = {};
  const regex = /^\s*(Description|Price|Developer|Last Updated|App[ _]?ID)\s*=\s*"([^"]*)"\s*$/gim;
  let match;
  while ((match = regex.exec(text)) !== null) {
    let key = match[1];
    if (/^App[ _]?ID$/i.test(key)) key = "App ID"; // normalize app_id / AppID / App ID to one key
    result[key] = match[2];
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

// --- Pull-count stats, persisted in a message in a private Discord channel ---
// (Railway's filesystem doesn't survive redeploys, so counting in-memory only
// would reset every time the bot restarts. A message edit is cheap and instant —
// no commit-history spam like writing to the repo would cause.)
let manifestStats = {}; // { "terraria": 5, ... } keyed by lowercase name-without-extension
let statsChannel = null;
let statsMessage = null;
const STATS_MARKER = "📊 Manifest pull-count data — do not delete this message";

function formatStatsMessage() {
  return `${STATS_MARKER}\n\`\`\`json\n${JSON.stringify(manifestStats, null, 2)}\n\`\`\``;
}

// --- Bot config, stored the same way (a message in the same private channel).
// Add new settings here as they come up — same pattern as manifestChannelId.
let botConfig = { manifestChannelId: null, requestCleanupHours: null, supportRoleId: null };
let configMessage = null;
const CONFIG_MARKER = "⚙️ Bot config data — do not delete this message";

function formatConfigMessage() {
  return `${CONFIG_MARKER}\n\`\`\`json\n${JSON.stringify(botConfig, null, 2)}\n\`\`\``;
}

async function setupStatsChannel() {
  try {
    let guild;
    if (GUILD_ID) {
      guild = await client.guilds.fetch(GUILD_ID);
    } else if (client.guilds.cache.size === 1) {
      guild = client.guilds.cache.first();
    } else {
      console.warn(
        "Can't tell which server to store bot data in (bot is in multiple servers) — set GUILD_ID."
      );
      return;
    }

    // Fetch live from Discord's API instead of trusting the local cache — right
    // after a redeploy the cache isn't guaranteed to be populated yet, which was
    // causing this to miss the already-existing channel, create a duplicate, and
    // wipe stats/config back to defaults on every restart. (Same pattern already
    // used in cleanupOldRequestChannels below, just applied here too.)
    const channels = await guild.channels.fetch();
    // NOTE: guild.channels.fetch() can return null entries for channels
    // Discord.js can't fully resolve (some thread/forum/stage channels, or
    // ones missing permission metadata). Without the `c &&` guard here, hitting
    // one of those null entries throws inside .find(), which was being caught
    // by the outer try/catch below and silently aborting this whole function —
    // meaning the existing stats/config messages were never loaded, and
    // manifestStats/botConfig just stayed at their in-memory defaults for that
    // run. cleanupOldRequestChannels() already guarded against this; this did not.
    let channel = channels.find(
      (c) => c && c.name === STATS_CHANNEL_NAME && c.type === ChannelType.GuildText
    );

    if (!channel) {
      channel = await guild.channels.create({
        name: STATS_CHANNEL_NAME,
        type: ChannelType.GuildText,
        topic: "Bot-only storage for pull-count stats and settings. Don't delete the messages here.",
        permissionOverwrites: [
          { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          {
            id: client.user.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
            ],
          },
        ],
      });
      console.log(`Created stats/config channel #${channel.name}`);
    }
    statsChannel = channel;

    const recent = await channel.messages.fetch({ limit: 20 });

    const existingStats = recent.find((m) => m.author.id === client.user.id && m.content.startsWith(STATS_MARKER));
    if (existingStats) {
      statsMessage = existingStats;
      // Pull whatever sits between the ```json fence markers directly, instead of
      // stripping the fences with two separate regex replaces. The old approach
      // (`.replace(STATS_MARKER, "").replace(/```json\n?|\n?```/g, "")`) had a bug:
      // right after the marker is stripped, the string starts with "\n```json\n{...".
      // At that position the regex's SECOND alternative (\n?```) matched the leading
      // "\n```" before the FIRST alternative (```json\n?) ever got a chance to — regex
      // alternation commits to whichever branch matches first, it doesn't look ahead —
      // leaving the literal word "json" stuck in front of the real JSON. JSON.parse
      // then threw on every single load, silently caught below with no logging, and
      // reset to {}. Saving was never affected (it doesn't re-parse anything), only
      // the read-back after a restart — exactly the "saves fine, resets on deploy" bug.
      const fenceMatch = existingStats.content.match(/```json\n([\s\S]*?)\n```/);
      try {
        manifestStats = JSON.parse(fenceMatch ? fenceMatch[1] : "{}");
      } catch (err) {
        console.error("Failed to parse existing stats message, resetting to empty:", err);
        manifestStats = {};
      }
      console.log(`Loaded pull stats for ${Object.keys(manifestStats).length} file(s)`);
    } else {
      manifestStats = {};
      statsMessage = await channel.send(formatStatsMessage());
      console.log("Created new stats message");
    }

    const existingConfig = recent.find((m) => m.author.id === client.user.id && m.content.startsWith(CONFIG_MARKER));
    if (existingConfig) {
      configMessage = existingConfig;
      // Same fence-extraction fix as the stats block above — this had the identical
      // bug, meaning bot-setup settings (manifest channel restriction, request-cleanup
      // hours, support role) were also silently resetting to defaults on every redeploy.
      const fenceMatch = existingConfig.content.match(/```json\n([\s\S]*?)\n```/);
      try {
        botConfig = {
          manifestChannelId: null,
          requestCleanupHours: null,
          supportRoleId: null,
          ...JSON.parse(fenceMatch ? fenceMatch[1] : "{}"),
        };
      } catch (err) {
        console.error("Failed to parse existing config message, resetting to defaults:", err);
        botConfig = { manifestChannelId: null, requestCleanupHours: null, supportRoleId: null };
      }
      console.log("Loaded bot config");
    } else {
      botConfig = { manifestChannelId: null, requestCleanupHours: null, supportRoleId: null };
      configMessage = await channel.send(formatConfigMessage());
      console.log("Created new config message");
    }
  } catch (err) {
    console.error("Error setting up stats/config channel:", err);
  }
}

async function saveManifestStats() {
  if (!statsMessage) return;
  try {
    const content = formatStatsMessage();
    if (content.length > 2000) {
      console.warn("Stats message is approaching Discord's 2000-char limit — consider trimming old entries.");
    }
    await statsMessage.edit(content.slice(0, 2000));
  } catch (err) {
    console.error("Error saving manifest stats:", err);
  }
}

async function saveBotConfig() {
  if (!configMessage) return;
  try {
    await configMessage.edit(formatConfigMessage());
  } catch (err) {
    console.error("Error saving bot config:", err);
  }
}

function recordManifestPull(nameWithoutExt) {
  const key = nameWithoutExt.toLowerCase();
  manifestStats[key] = (manifestStats[key] || 0) + 1;
  saveManifestStats(); // fire-and-forget so it doesn't slow down the reply
}

function getPullCount(nameWithoutExt) {
  return manifestStats[nameWithoutExt.toLowerCase()] || 0;
}

// Request channels are identified by the topic set when they're created (see
// createRequestChannel below) — no separate tracking needed, and channel.createdTimestamp
// (built into every Discord channel/snowflake) gives us its age for free.
async function cleanupOldRequestChannels() {
  if (!botConfig.requestCleanupHours) return; // null/0 = disabled

  try {
    let guild;
    if (GUILD_ID) {
      guild = await client.guilds.fetch(GUILD_ID);
    } else if (client.guilds.cache.size === 1) {
      guild = client.guilds.cache.first();
    } else {
      return; // ambiguous which server — setupStatsChannel already warned about this
    }

    const channels = await guild.channels.fetch();
    const cutoffMs = botConfig.requestCleanupHours * 60 * 60 * 1000;
    const now = Date.now();

    for (const channel of channels.values()) {
      if (!channel || channel.type !== ChannelType.GuildText || !channel.topic) continue;
      const isRequestChannel =
        channel.topic.startsWith("Update request from") || channel.topic.startsWith("New file request from");
      if (!isRequestChannel) continue;

      const age = now - channel.createdTimestamp;
      if (age >= cutoffMs) {
        try {
          await channel.delete("Auto-deleted: past the configured request-cleanup period");
          console.log(`Auto-deleted expired request channel #${channel.name}`);
        } catch (err) {
          console.error(`Failed to auto-delete #${channel.name}:`, err);
        }
      }
    }
  } catch (err) {
    console.error("Error running request-channel cleanup:", err);
  }
}

// Check every 15 minutes — fine-grained enough without hammering the API
setInterval(cleanupOldRequestChannels, 15 * 60 * 1000);

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

  const overwrites = [
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
  ];

  if (botConfig.supportRoleId) {
    overwrites.push({
      id: botConfig.supportRoleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    });
  }

  try {
    const channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      topic: `${kind === "update" ? "Update" : "New file"} request from ${interaction.user.tag}`,
      permissionOverwrites: overwrites,
    });

    const heading =
      kind === "update" ? "📦 **Update Request**" : "🆕 **New File Request**";
    const supportMention = botConfig.supportRoleId ? ` ${`<@&${botConfig.supportRoleId}>`}` : "";

    await channel.send(
      `${heading}\nRequested by ${interaction.user}\n\n**Details:** ${details}\n\n${supportMention ? supportMention + ", " : ""}an admin will be with you shortly. Feel free to add more info or attachments here.`
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

// Creates or updates a single file in the repo via the GitHub Contents API.
// Requires GITHUB_TOKEN to have write access to GITHUB_REPO.
async function commitFileToRepo(path, buffer) {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${encodeURI(path)}`;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${GITHUB_TOKEN}`,
  };

  // Look up the existing file's sha first — required by the API to overwrite
  // a file that's already there; omitted entirely when creating a new one.
  let sha;
  const existingRes = await fetch(`${url}?ref=${BRANCH}`, { headers });
  if (existingRes.ok) {
    const existing = await existingRes.json();
    sha = existing.sha;
  }

  const body = {
    message: `Add/update ${path} via /upload-assets`,
    content: buffer.toString("base64"),
    branch: BRANCH,
  };
  if (sha) body.sha = sha;

  const putRes = await fetch(url, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!putRes.ok) {
    const errText = await putRes.text();
    throw new Error(`GitHub API HTTP ${putRes.status}: ${errText}`);
  }
}

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"];
const MAX_ZIP_ENTRIES = 50; // keep each upload reasonably sized — one GitHub commit per file

async function handleUploadAssets(interaction) {
  if (!GITHUB_TOKEN) {
    await interaction.reply({
      content:
        "This command needs `GITHUB_TOKEN` set with write access to the repo first — see the README.",
      ephemeral: true,
    });
    return;
  }

  const attachment = interaction.options.getAttachment("file", true);
  if (!attachment.name?.toLowerCase().endsWith(".zip")) {
    await interaction.reply({ content: "Please attach a `.zip` file.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const res = await fetch(attachment.url);
    if (!res.ok) throw new Error(`Failed to download attachment (HTTP ${res.status})`);
    const buffer = Buffer.from(await res.arrayBuffer());

    let zip;
    try {
      zip = new AdmZip(buffer);
    } catch (err) {
      await interaction.editReply("Couldn't read that as a zip file — make sure it's not corrupted.");
      return;
    }

    const entries = zip.getEntries().filter((e) => !e.isDirectory);
    if (entries.length === 0) {
      await interaction.editReply("That zip is empty.");
      return;
    }
    if (entries.length > MAX_ZIP_ENTRIES) {
      await interaction.editReply(
        `That zip has ${entries.length} files — please keep uploads under ${MAX_ZIP_ENTRIES} at a time.`
      );
      return;
    }

    const uploadedImages = [];
    const uploadedInfo = [];
    const skipped = [];

    for (const entry of entries) {
      const baseName = entry.entryName.split("/").pop(); // flatten any folder structure in the zip
      const dotIndex = baseName.lastIndexOf(".");
      const ext = dotIndex >= 0 ? baseName.slice(dotIndex).toLowerCase() : "";

      let targetFolder = null;
      if (IMAGE_EXTENSIONS.includes(ext)) targetFolder = normalizedImageFolder;
      else if (ext === ".txt") targetFolder = normalizedTextFolder;

      if (!targetFolder || !baseName) {
        skipped.push(baseName || entry.entryName);
        continue;
      }

      try {
        await commitFileToRepo(`${targetFolder}/${baseName}`, entry.getData());
        if (targetFolder === normalizedImageFolder) uploadedImages.push(baseName);
        else uploadedInfo.push(baseName);
      } catch (err) {
        console.error(`Failed to commit ${baseName}:`, err);
        skipped.push(`${baseName} (upload failed)`);
      }
    }

    const lines = [];
    if (uploadedImages.length) lines.push(`**Images (${uploadedImages.length}):** ${uploadedImages.join(", ")}`);
    if (uploadedInfo.length) lines.push(`**Info files (${uploadedInfo.length}):** ${uploadedInfo.join(", ")}`);
    if (skipped.length) lines.push(`**Skipped (${skipped.length}):** ${skipped.join(", ")}`);
    if (lines.length === 0) lines.push("Nothing usable found in that zip.");

    await interaction.editReply(lines.join("\n").slice(0, 2000));
  } catch (err) {
    console.error("Error handling /upload-assets:", err);
    await interaction.editReply("Something went wrong processing that zip — try again in a bit.");
  }
}

// Uses Steam's official Store API rather than scraping SteamDB's page directly —
// SteamDB itself pulls this same header image from Steam's own CDN, so the result
// is identical either way, but the official API is public, stable, and won't get
// blocked the way scraping a third-party site's HTML tends to over time.
async function fetchSteamAppDetails(appId) {
  const url = `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=us&l=en`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Steam API HTTP ${res.status}`);
  const json = await res.json();
  const entry = json[String(appId)];
  if (!entry || !entry.success) return null;
  return entry.data;
}

// Converts a standalone Roman numeral word to its Arabic number, e.g. "III" -> "3".
// Only matches whole, ALL-CAPS words that are valid Roman numerals — this avoids
// misfiring on ordinary words that happen to be made of the letters I/V/X/L/C/D/M
// (lowercase or mixed-case words are left untouched entirely).
const ROMAN_NUMERAL_PATTERN = /^M{0,4}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/;

function romanToArabic(roman) {
  const values = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let total = 0;
  for (let i = 0; i < roman.length; i++) {
    const current = values[roman[i]];
    const next = values[roman[i + 1]];
    total += next && current < next ? -current : current;
  }
  return total;
}

function convertRomanNumeralWords(name) {
  return name
    .split(" ")
    .map((word) => {
      if (word.length > 0 && /^[IVXLCDM]+$/.test(word) && ROMAN_NUMERAL_PATTERN.test(word)) {
        const value = romanToArabic(word);
        if (value > 0) return String(value);
      }
      return word;
    })
    .join(" ");
}

// Keeps only letters, numbers, and spaces — strips everything else (trademark
// symbols, colons, apostrophes, hyphens, etc.) BEFORE checking for Roman numerals,
// so a numeral with punctuation stuck to it (e.g. "VII:") still gets recognized
// once the colon is gone — then collapses any doubled-up spaces left behind.
function sanitizeFilename(name) {
  const cleaned = name
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return convertRomanNumeralWords(cleaned);
}

// Keeps a value safe to sit inside the `Key = "value"` format the info .txt files use —
// mainly making sure a stray " in a game's description can't break the quoted field.
function sanitizeForQuotedField(text) {
  return (text || "").replace(/"/g, "'").replace(/\s+/g, " ").trim();
}

// Imports a single Steam app: fetches its details, downloads the header image, and
// commits both files. Returns a result object rather than replying directly, so the
// caller can batch several of these into one summary message.
async function importSteamApp(appId) {
  try {
    const data = await fetchSteamAppDetails(appId);
    if (!data) {
      return { success: false, reason: "not found (or not available/visible in the US store)" };
    }
    if (!data.header_image) {
      return { success: false, reason: `found "${data.name}" but it has no header image` };
    }

    const gameName = sanitizeFilename(data.name || `app-${appId}`);

    const imgRes = await fetch(data.header_image);
    if (!imgRes.ok) throw new Error(`Failed to download header image (HTTP ${imgRes.status})`);
    const imageBuffer = Buffer.from(await imgRes.arrayBuffer());

    const price = data.is_free ? "Free" : data.price_overview?.final_formatted || "N/A";
    const developer = data.developers?.length ? data.developers.join(", ") : "Unknown";
    const description = sanitizeForQuotedField(data.short_description);

    const infoText = [
      `Description = "${description}"`,
      `app_id = "${appId}"`,
      `Price = "${price}"`,
      `Developer = "${developer}"`,
    ].join("\n");

    await commitFileToRepo(`${normalizedImageFolder}/${gameName}.png`, imageBuffer);
    await commitFileToRepo(`${normalizedTextFolder}/${gameName}.txt`, Buffer.from(infoText, "utf-8"));

    return { success: true, name: data.name };
  } catch (err) {
    console.error(`Error importing Steam app ${appId}:`, err);
    return { success: false, reason: "something went wrong fetching or uploading it" };
  }
}

const MAX_STEAM_IMPORT_IDS = 10; // keep each run reasonably sized — one Steam + two GitHub calls per ID

async function handleSteamImport(interaction) {
  if (!GITHUB_TOKEN) {
    await interaction.reply({
      content:
        "This command needs `GITHUB_TOKEN` set with write access to the repo first — see the README.",
      ephemeral: true,
    });
    return;
  }

  const rawInput = interaction.options.getString("app_id", true);
  const tokens = rawInput
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  if (tokens.length === 0) {
    await interaction.reply({ content: "Please provide at least one Steam App ID.", ephemeral: true });
    return;
  }
  if (tokens.length > MAX_STEAM_IMPORT_IDS) {
    await interaction.reply({
      content: `Please limit this to ${MAX_STEAM_IMPORT_IDS} app IDs per run.`,
      ephemeral: true,
    });
    return;
  }

  const appIds = [];
  const invalidTokens = [];
  for (const token of tokens) {
    const id = Number(token);
    if (Number.isInteger(id) && id > 0) appIds.push(id);
    else invalidTokens.push(token);
  }

  if (appIds.length === 0) {
    await interaction.reply({ content: "None of those looked like valid Steam App IDs.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  // Sequential, not parallel — gentler on both Steam's and GitHub's APIs, and keeps
  // GitHub commit order predictable if two IDs happened to touch the same filename.
  const lines = [];
  for (const appId of appIds) {
    const result = await importSteamApp(appId);
    lines.push(
      result.success ? `✅ **${result.name}** (${appId})` : `❌ \`${appId}\` — ${result.reason}`
    );
  }
  for (const bad of invalidTokens) {
    lines.push(`❌ \`${bad}\` — not a valid app ID`);
  }

  await interaction.editReply(lines.join("\n").slice(0, 2000));
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

  if (interaction.commandName === "upload-assets") {
    await handleUploadAssets(interaction);
    return;
  }

  if (interaction.commandName === "steam-import") {
    await handleSteamImport(interaction);
    return;
  }

  if (interaction.commandName === "bot-setup") {
    if (!interaction.guild) {
      await interaction.reply({ content: "This command only works inside a server.", ephemeral: true });
      return;
    }
    if (interaction.options.getSubcommand() === "manifest-channel") {
      const channel = interaction.options.getChannel("channel", true);
      botConfig.manifestChannelId = channel.id;
      await saveBotConfig();
      await interaction.reply({
        content: `\`/manifest\` can now only be used in ${channel}.`,
        ephemeral: true,
      });
    } else if (interaction.options.getSubcommand() === "request-cleanup") {
      const hours = interaction.options.getInteger("hours", true);
      botConfig.requestCleanupHours = hours > 0 ? hours : null;
      await saveBotConfig();
      const message =
        hours > 0
          ? `Request channels will now be auto-deleted ${hours} hour(s) after they're created.`
          : "Auto-delete for request channels has been turned off.";
      await interaction.reply({ content: message, ephemeral: true });
    } else if (interaction.options.getSubcommand() === "support-role") {
      const role = interaction.options.getRole("role");
      botConfig.supportRoleId = role ? role.id : null;
      await saveBotConfig();
      const message = role
        ? `${role} can now see \`/request-update\` and \`/request-new\` channels.`
        : "Support role cleared — only the requester (and admins) will see new request channels.";
      await interaction.reply({ content: message, ephemeral: true });
    }
    return;
  }

  if (interaction.commandName !== "manifest") return;

  if (botConfig.manifestChannelId && interaction.channelId !== botConfig.manifestChannelId) {
    await interaction.reply({
      content: `\`/manifest\` can only be used in <#${botConfig.manifestChannelId}>.`,
      ephemeral: true,
    });
    return;
  }

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
    if (infoData?.["App ID"]) fields.push({ name: "App ID", value: infoData["App ID"], inline: true });
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
