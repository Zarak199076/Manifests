# Manifests
This can be used in numerous ways, but im using it for steam manifests.
# 1. Create the Discord bot
Go to https://discord.com/developers/applications → New Application.
Bot tab → Reset Token → copy it → this is DISCORD_BOT_TOKEN.
Still on the Bot tab, no special Privileged Gateway Intents are needed (it only sends messages).
OAuth2 → URL Generator: scopes = bot and applications.commands, permissions = Send Messages (and View Channel). Open the generated URL and invite the bot to your server. (If your bot is already invited without applications.commands, redo this step and re-invite it — otherwise the /manifest slash command below won't show up.)
In Discord, enable Developer Mode (User Settings → Advanced), right-click the target channel → Copy Channel ID → this is DISCORD_CHANNEL_ID.
# 2. Deploy (railway as an example)
Push this folder to a GitHub repo (or a subfolder of one).
In Railway: New Project → Deploy from GitHub repo → pick that repo.
Railway auto-detects Node from package.json and runs npm start.
Under Variables, add:
DISCORD_BOT_TOKEN
DISCORD_CHANNEL_ID
GITHUB_WEBHOOK_SECRET (make up any long random string)
GITHUB_REPO (the repo you want to watch — can be a different repo than the one hosting this bot)
TARGET_FOLDER (the folder to watch, e.g. uploads)
BRANCH (default main)
Under Settings → Networking, click Generate Domain so Railway gives you a public URL (e.g. https://your-app.up.railway.app).
# 3. Add the GitHub webhook
On the repo you want to watch (GITHUB_REPO):
Go to Settings → Webhooks → Add webhook.
Payload URL: https://your-app.up.railway.app/webhook
Content type: application/json
Secret: the same value you set for GITHUB_WEBHOOK_SECRET.
Events: choose Just the push event.
Save. GitHub will send a ping — check the Railway logs to confirm you see pong.
# 4. You're done. Congrats
# Notes.
The "Added" date on the embed comes from the oldest of the file's last 100 commits — accurate for files that are added once and rarely touched again (which covers this use case). If a single file somehow gets updated more than 100 times, the date shown would be its 100th-most- recent change rather than its true original add date.
Only fires on push events (includes commits made via uploading files).
Renamed files aren't currently flagged — only added/modified paths.
If a push includes multiple new files in the folder, they'll all be posted (one message each).
Private repos work fine — raw.githubusercontent.com links to a private repo will require whoever clicks them to be logged into GitHub with access.
