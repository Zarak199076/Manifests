import express from "express";
import crypto from "crypto";
import { Client, GatewayIntentBits } from "discord.js";

const {
  DISCORD_BOT_TOKEN,
  DISCORD_CHANNEL_ID,
  GITHUB_WEBHOOK_SECRET,
  GITHUB_REPO,      // "owner/repo"
  TARGET_FOLDER,    // e.g. "uploads" (matches that folder and everything under it)
  BRANCH = "main",
  PORT = 3000,
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
client.once("ready", () => {
  console.log(`Discord bot logged in as ${client.user.tag}`);
  discordReady = true;
});
client.login(DISCORD_BOT_TOKEN);

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
    if (matching.length === 0) return;

    if (!discordReady) {
      console.warn("Discord client wasn't ready yet — skipping this batch:", matching);
      return;
    }

    const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);

    for (const filePath of matching) {
      const filename = filePath.split("/").pop();
      const rawUrl = `https://raw.githubusercontent.com/${GITHUB_REPO}/${refBranch}/${encodeURI(
        filePath
      )}`;
      await channel.send(`[${filename}](<${rawUrl}>)`);
    }
  } catch (err) {
    console.error("Error handling webhook payload:", err);
  }
});

app.listen(PORT, () => {
  console.log(`Webhook server listening on port ${PORT}`);
});
