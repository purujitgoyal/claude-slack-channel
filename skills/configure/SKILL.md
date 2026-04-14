---
name: configure
description: Guide the user through creating a Slack app and configuring the channel plugin end-to-end.
---

# /slack:configure

Walk the user through the full setup of the Slack channel plugin — from creating the Slack app to writing the config file.

Arguments: $ARGUMENTS

## Steps

### 1. Create a Slack app

If the user doesn't have a Slack app yet, guide them:

1. Go to https://api.slack.com/apps → **Create New App** → **From scratch**
2. Name it something personal (e.g. "Claude Code - yourname") — each user needs their own app
3. Choose their workspace

If they already have an app, skip to step 2.

### 2. Configure the Slack app

Walk them through each setting. Present this as a checklist they can follow in the Slack app dashboard:

**Socket Mode** (Settings → Socket Mode)
- [ ] Enable Socket Mode
- [ ] Generate an App-Level Token with scope `connections:write`
- [ ] Copy the token — starts with `xapp-`

**Bot Token Scopes** (Features → OAuth & Permissions → Scopes → Bot Token Scopes)
- [ ] `chat:write` — send messages and update them
- [ ] `reactions:write` — add emoji reactions
- [ ] `groups:history` — read messages and threads in private channels

**Event Subscriptions** (Features → Event Subscriptions)
- [ ] Enable Events
- [ ] Subscribe to bot events: `app_mention`, `message.groups`

**Interactivity & Shortcuts** (Features → Interactivity & Shortcuts)
- [ ] Enable Interactivity (no Request URL needed — Socket Mode handles it)

**Install the app** (Settings → Install App)
- [ ] Install to Workspace
- [ ] Copy the **Bot User OAuth Token** — starts with `xoxb-`

### 3. Channel and user setup

- [ ] Create a private channel (e.g. `#claude-yourname`) or pick an existing one
- [ ] Invite the bot to the channel: `/invite @Bot Name`
- [ ] Get the **Channel ID**: right-click channel → View channel details → scroll to bottom
- [ ] Get your **Slack User ID**: click your profile picture → View Profile → ⋯ → Copy member ID (format: `U01XXXXXXXX`)

### 4. Install dependencies

Check whether `node_modules` exists in the plugin directory (`~/.claude/plugins/slack-channel/` or wherever Claude Code installed it). If it does not exist, run `bun install` from that directory. If it already exists, skip this step — there is no need to reinstall on every invocation.

### 5. Write tokens

Tell the user to create the config file themselves. Show them the template and commands:

```bash
mkdir -p ~/.claude/channels/slack
chmod 700 ~/.claude/channels/slack
```

Create `~/.claude/channels/slack/.env` with:
```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
ALLOWED_SLACK_USER_ID=U...
SLACK_CHANNEL_ID=C...
```

```bash
chmod 600 ~/.claude/channels/slack/.env
```

**Do NOT ask the user to paste tokens or read the .env file.** The user is responsible for writing the file. Once they confirm they've done it, check that the file exists (without reading its contents):

```bash
test -f ~/.claude/channels/slack/.env && echo "Config file found" || echo "Config file not found"
```

### 6. Activate

Tell the user:

> Configuration saved. To load the plugin, start Claude Code with:
>
> ```bash
> claude --dangerously-load-development-channels plugin:slack-channel@claude-slack-channel
> ```
>
> The plugin starts dormant. Call the `connect` tool to activate the Slack bridge in your session.
> Then @mention the bot in your channel to start a conversation.
> Permission prompts appear as Allow/Deny buttons in the active thread.
>
> To hand off the channel to another session, call `disconnect` first — this releases the lock.
