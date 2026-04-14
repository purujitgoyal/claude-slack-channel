# claude-slack-channel

A Claude Code channel plugin that bridges a Slack channel to a Claude Code session.

- **Two-way**: @mention the bot, Claude replies in a thread
- **Permission relay**: tool-use approval dialogs appear as Block Kit buttons with formatted confirmations (e.g. `Allowed — `Bash` ```git status```) — no need to watch the terminal
- **Connection monitoring**: detects WebSocket drops, auto-reconnects, and shuts down after 2 minutes of dead connection so `/mcp` can restart cleanly
- **Threaded**: one session = one thread. Reply in any old thread (even from a past session) to auto-start a new thread with context
- **Explicit activation**: call the `connect` tool to activate — you choose which session owns the channel
- **Single-instance guard**: uses `flock(2)` to ensure only one session owns the Slack channel at a time. Call `disconnect` to release the lock and hand off to another session
- **Personal use**: only your Slack user ID can trigger messages or approve tool calls

Primary use case: multi-repo autonomous sessions where you want to monitor progress and approve tool use from your phone without being at the machine.

## Prerequisites

- [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`)
- A Slack workspace where you can create apps
- Claude Code v2.1.81 or later (permission relay requires 2.1.81+)

## Setup

Each user needs their own Slack app. This takes ~5 minutes and gives you a fully isolated channel — your events, your bot, no interference with other users.

> **Team use**: If multiple people on your team want to use this plugin, each person follows the steps below to create their own Slack app in the shared workspace. There is no shared app — Slack's Socket Mode delivers events to a single connection per app, so sharing an app between users would cause messages to be randomly lost.

### 1. Create a Slack app

Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**.

Name it something personal (e.g. "Claude Code - yourname") so it's distinguishable from teammates' apps.

### 2. Configure the app

**Socket Mode** (Settings → Socket Mode)
- Enable Socket Mode
- Generate an App-Level Token with scope `connections:write`
- Save this as `SLACK_APP_TOKEN` (starts with `xapp-`)

**Bot Token Scopes** (Features → OAuth & Permissions → Scopes → Bot Token Scopes)
- `chat:write` — send messages and update them
- `reactions:write` — add emoji reactions
- `groups:history` — read messages and threads in private channels

**Event Subscriptions** (Features → Event Subscriptions)
- Enable Events
- Subscribe to bot events: `app_mention`, `message.groups`

**Interactivity & Shortcuts** (Features → Interactivity & Shortcuts)
- Enable Interactivity (no Request URL needed — Socket Mode handles delivery)

### 3. Install and collect tokens

- Settings → Install App → Install to Workspace
- Copy the **Bot User OAuth Token** → `SLACK_BOT_TOKEN` (starts with `xoxb-`)

### 4. Channel setup

- Create a private channel (e.g. `#claude-yourname`) or use an existing one
- Invite your bot to the channel (`/invite @Your Bot Name`)
- Get the **Channel ID**: right-click channel → View channel details → scroll to bottom

### 5. Find your Slack user ID

- Click your profile picture → View Profile → ⋯ → Copy member ID
- Format: `U01XXXXXXXX`

### 6. Save tokens

If you have the plugin installed, run `/slack:configure` — it guides you through writing the config file.

Or manually create `~/.claude/channels/slack/.env`:

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
ALLOWED_SLACK_USER_ID=U01XXXXXXXX
SLACK_CHANNEL_ID=C01XXXXXXXX
```

```bash
mkdir -p ~/.claude/channels/slack
chmod 700 ~/.claude/channels/slack
chmod 600 ~/.claude/channels/slack/.env
```

### 7. Install plugin dependencies

Run `bun install` once in the plugin directory after cloning (or after the plugin is installed by Claude Code). This is a one-time step — the server no longer auto-installs on startup.

```bash
cd /path/to/claude-slack-channel  # or ~/.claude/plugins/slack-channel
bun install
```

## Start

### Option A: Managed settings (recommended)

Add the plugin to your `allowedChannelPlugins` in Claude Code managed settings (`~/.claude/settings.json`):

```json
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [
    { "marketplace": "claude-slack-channel", "plugin": "slack-channel" }
  ]
}
```

Then start Claude Code normally — no flags needed.

### Option B: Development flag

```bash
claude --dangerously-load-development-channels plugin:slack-channel@claude-slack-channel
```

This bypasses the allowlist check and loads the specified channel plugin.

### Activating the bridge

The plugin starts dormant. Call the `connect` tool in the session you want to use — this gives you control over which session owns the channel, especially useful when running multiple sessions.

Call `disconnect` to release the lock so another session can connect without restarting.

If another session already holds the lock, `connect` fails with a clear error message.

## Using it

1. Start Claude Code (with settings or flag above)
2. Call `connect` to activate the Slack bridge in this session
3. @mention the bot in your channel (e.g. `@Claude Code Bot check on the workers`)
4. Claude receives the message and replies in a new thread
5. Reply in the thread to continue the conversation
6. When Claude needs tool approval, you'll see Allow/Deny buttons in the thread
7. If you reply in an old thread, a new thread is started with a summary of the old thread's history

### Thread lifecycle

- **New session** → always starts a fresh thread (including `--resume` / `/resume`)
- **@mention** → starts a new thread (resets the previous one)
- **Thread reply** → continues the active thread
- **Old thread reply** → auto-starts new thread with context summary (see below)
- **`/compact` or `/clear`** → Claude calls `new_thread` to start fresh

### Cross-session context from old threads

Reply in any old thread — even from a completely different session — and the plugin automatically:

1. Fetches the old thread's history (up to 20 messages, 2000 chars)
2. Posts a "→ Continued in new thread" breadcrumb in the old thread
3. Starts a fresh thread with the old context + your new message

Claude sees the conversation formatted as:

```
[Context from previous thread]
[user]: what's the status on the auth migration?
[bot]: The auth middleware has been replaced. Tests pass...

[New message]
actually, can you also update the session token format?
```

This works across sessions because it reads from Slack's API, not local state — so you can `--resume` a session, `/compact`, or start a completely new session, then reply in any historical thread to carry forward context. Useful for picking up where you left off without re-explaining what happened.

## Access control

Only the Slack user ID in `ALLOWED_SLACK_USER_ID` can:
- Send messages that reach Claude
- Approve or deny tool-use prompts via Slack buttons

Messages from any other Slack user are silently dropped. Button clicks from other users are ignored.

## Development

```bash
bun test        # 150+ unit tests
bun run check   # lint + format check
bun run fix     # auto-fix lint + format issues
```

Uses [Biome](https://biomejs.dev) for linting and formatting.

## Limitations

- One Slack app per user — Slack's Socket Mode doesn't support sharing an app across users (events are round-robined, not duplicated)
- Single Claude Code session per user at a time (enforced by `flock(2)` — second session gets a clear error)
- No file attachment support yet
- Inbound messages require either `allowedChannelPlugins` in managed settings or the `--dangerously-load-development-channels` flag
- Permission relay requires Claude Code v2.1.81+

### Sleep/wake and the Slack connection

When your machine sleeps (lid close, idle sleep), the Slack WebSocket connection drops and Claude Code kills its stdio child processes — including this plugin. On wake, CC spawns a fresh plugin process, but it often hits a rapid reconnect loop as the network recovers. The plugin detects this flap (5+ reconnects in 10 seconds), kills the bridge, and notifies Claude.

**How to recover:**

1. Open `/mcp` in Claude Code and **reconnect** the slack-channel server — this is usually enough
2. If reconnecting doesn't work, wait a few seconds for the network to stabilize and try again
3. If the session is stale (overnight sleep, prolonged idle), start a new Claude Code session

Messages sent to your Slack channel during the outage are recovered automatically if the outage was longer than 60 seconds.

**Why this can't be fixed in the plugin:** This is an inherent limitation of channel plugins that need persistent connections. CC plugins run as stdio child processes that are killed on sleep. Most MCP servers (MongoDB, Linear, etc.) are unaffected because they make stateless HTTP calls — they don't need to maintain a connection. Channel plugins are fundamentally different: they need a persistent connection both to the chat platform (Slack's WebSocket) and to CC (stdio or SSE) to push inbound messages in real time. There's no transport option that avoids this — even running as a standalone HTTP server would require SSE or polling for push delivery, reintroducing the same problem.

## Debugging

Set `SLACK_CHANNEL_DEBUG=1` in env to enable debug file logging to `~/.claude/channels/slack/debug.log`.
