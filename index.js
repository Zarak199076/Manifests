import express from "express";
import crypto from "crypto";
import { Client, GatewayIntentBits, ActivityType } from "discord.js";

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

// --- Discord setup ---
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

let discordReady = false;
client.once("ready", async () => {
  console.log(`Discord bot logged in as ${client.user.tag}`);
  discordReady = true;
  updateFileCountStatus();

  const command = {
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

  try {
    if (GUILD_ID) {
      const guild = await client.guilds.fetch(GUILD_ID);
      await guild.commands.set([command]);
      console.log(`Registered /manifest command in guild ${GUILD_ID}`);
    } else {
      await client.application.commands.set([command]);
      console.log("Registered /manifest command globally (may take up to an hour to appear)");
    }
  } catch (err) {
    console.error("Failed to register /manifest command:", err);
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

async function fetchFolderFiles() {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${encodeURI(
    normalizedFolder
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

    const MAX_RESULTS = 20;
    const lines = matches.slice(0, MAX_RESULTS).map((f) => {
      const nameWithoutExt = stripExtension(f.name);
      const rawUrl = `https://raw.githubusercontent.com/${GITHUB_REPO}/${BRANCH}/${encodeURI(f.path)}`;
      return `[${nameWithoutExt}](<${rawUrl}>)`;
    });

    if (matches.length > MAX_RESULTS) {
      lines.push(`…and ${matches.length - MAX_RESULTS} more. Try a more specific name.`);
    }

    await interaction.editReply(lines.join("\n"));
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
