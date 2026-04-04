# claude-slack-channel

A Claude Code channel plugin that bridges a Slack channel to a Claude Code session.

- **Two-way**: @mention the bot, Claude replies in a thread
- **Permission relay**: tool-use approval dialogs appear as Block Kit buttons with formatted confirmations (e.g. `Allowed — `Bash` ```git status```) — no need to watch the terminal
- **Connection monitoring**: detects WebSocket drops, auto-reconnects, and shuts down after 2 minutes of dead connection so `/mcp` can restart cleanly
- **Threaded**: one session = one thread. Old thread replies auto-start a new thread with context summary
- **Lazy activation**: dormant by default — set `SLACK_CHANNEL_ACTIVATE=1` in your Claude Code `settings.json` env to enable
- **Single-instance guard**: uses `flock(2)` to ensure only one session owns the Slack channel at a time
- **Personal use**: only your Slack user ID can trigger messages or approve tool calls

Primary use case: multi-repo autonomous sessions where you want to monitor progress and approve tool use from your phone without being at the machine.

## Prerequisites

- [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`)
- A Slack workspace where you can create apps
- Claude Code v2.1.81 or later (permission relay requires 2.1.81+)

## Slack App setup

Go to [api.slack.com/apps](https://api.slack.com/apps) → Create New App → From scratch.

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
- Under "Subscribe to bot events" add:
  - `app_mention` — @mentions of the bot
  - `message.groups` — messages in private channels (for thread replies)

**Interactivity & Shortcuts** (Features → Interactivity & Shortcuts)
- Enable Interactivity (no Request URL needed — Socket Mode handles delivery)

**Install the app**
- Settings → Install App → Install to Workspace
- Copy the Bot User OAuth Token — save as `SLACK_BOT_TOKEN` (starts with `xoxb-`)

**Channel setup**
- Create a private channel (e.g. `#claude-code`)
- Invite the bot to the channel
- Get the Channel ID: right-click channel → View channel details → scroll to bottom

**Find your Slack user ID**
- In Slack: click your profile picture → View Profile → ⋯ → Copy member ID
- Format: `U01XXXXXXXX`

## Token storage

Tokens live in `~/.claude/channels/slack/.env` (never committed):

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
ALLOWED_SLACK_USER_ID=U01XXXXXXXX
SLACK_CHANNEL_ID=C01XXXXXXXX
```

```bash
mkdir -p ~/.claude/channels/slack
chmod 700 ~/.claude/channels/slack
# write the file, then:
chmod 600 ~/.claude/channels/slack/.env
```

Or use the configure skill (see below).

## Configure

If you have this plugin installed in Claude Code, run:

```
/slack:configure
```

This guides you through writing the `.env` file.

## Start

### 1. Activate the server

Add `SLACK_CHANNEL_ACTIVATE=1` to your Claude Code `settings.json` env (either `~/.claude/settings.json` for global, or `.claude/settings.local.json` for per-project):

```json
{
  "env": {
    "SLACK_CHANNEL_ACTIVATE": "1"
  }
}
```

Without this, the server stays dormant — tools are listed but inactive, no Slack connection is made.

### 2. Enable inbound messages

Start Claude Code with the `--dangerously-load-development-channels` flag to allow Slack messages to reach Claude:

```bash
# If installed as a marketplace plugin:
claude --dangerously-load-development-channels plugin:slack-channel@claude-slack-channel

# If using a project .mcp.json:
claude --dangerously-load-development-channels server:slack-channel
```

Without this flag, outbound tools (reply, new_thread, react) still work, but inbound messages from Slack are ignored.

> **Note:** This flag is required during the research preview because this plugin isn't on Anthropic's approved allowlist yet.

If another session already holds the lock, activation fails with a clear error message.

## Using it

1. Start Claude Code with the flag and env var above
2. @mention the bot in your channel (e.g. `@Claude Code Bot check on the workers`)
3. Claude receives the message and replies in a new thread
4. Reply in the thread to continue the conversation
5. When Claude needs tool approval, you'll see Allow/Deny buttons in the thread
6. If you reply in an old thread, a new thread is started with a summary of the old thread's history

### Thread lifecycle

- **New session** → always starts a fresh thread (including `--resume` / `/resume`)
- **@mention** → starts a new thread (resets the previous one)
- **Thread reply** → continues the active thread
- **Old thread reply** → auto-starts new thread with context summary
- **`/compact` or `/clear`** → Claude calls `new_thread` to start fresh

## Access control

Only the Slack user ID in `ALLOWED_SLACK_USER_ID` can:
- Send messages that reach Claude
- Approve or deny tool-use prompts via Slack buttons

Messages from any other Slack user are silently dropped. Button clicks from other users are ignored.

## Development

```bash
bun test        # 115 unit tests
bun run check   # lint + format check
bun run fix     # auto-fix lint + format issues
```

Uses [Biome](https://biomejs.dev) for linting and formatting.

## Limitations

- Personal use only (one allowed user ID)
- Single Claude Code session at a time (enforced by `flock(2)` — second session gets a clear error)
- No file attachment support yet
- Inbound messages require `--dangerously-load-development-channels` flag (research preview)
- Permission relay requires Claude Code v2.1.81+
- Set `SLACK_CHANNEL_DEBUG=1` in env to enable debug file logging to `~/.claude/channels/slack/debug.log`
