# claude-slack-channel

A Claude Code channel plugin that bridges your Slack DMs to a Claude Code session.

- **Two-way**: send Claude a message from Slack, Claude replies back
- **Permission relay**: tool-use approval dialogs appear in Slack as Block Kit messages with Allow/Deny buttons — no need to watch the terminal
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
- `chat:write` — send messages
- `reactions:write` — add emoji reactions
- `im:history` — read DM history
- `im:read` — list DM channels

**Event Subscriptions** (Features → Event Subscriptions)
- Enable Events
- Under "Subscribe to bot events" add: `message.im`

**Interactivity & Shortcuts** (Features → Interactivity & Shortcuts)
- Enable Interactivity (no Request URL needed — Socket Mode handles delivery)

**Install the app**
- Settings → Install App → Install to Workspace
- Copy the Bot User OAuth Token — save as `SLACK_BOT_TOKEN` (starts with `xoxb-`)

**Find your Slack user ID**
- In Slack: click your profile picture → View Profile → ⋯ → Copy member ID
- Format: `U01XXXXXXXX`

## Token storage

Tokens live in `~/.claude/channels/slack/.env` (never committed):

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
ALLOWED_SLACK_USER_ID=U01XXXXXXXX
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

```bash
claude --dangerously-load-development-channels server:slack
```

Claude Code reads `.mcp.json`, spawns `server.ts` as a subprocess, and connects Bolt to Slack via Socket Mode.

> **Note:** The `--dangerously-load-development-channels` flag is required during the research preview because this plugin isn't on Anthropic's approved allowlist yet.

## Using it

1. Start Claude Code with the flag above
2. Send a DM to your bot in Slack
3. Claude receives the message and can reply back via the `reply` tool
4. When Claude needs to run a tool that requires approval, you'll see a Block Kit message in your Slack DM with **Allow** and **Deny** buttons
5. Tap Allow — the local terminal dialog closes and the tool runs

The local terminal dialog stays open in parallel, so you can also approve there.

## Access control

Only the Slack user ID in `ALLOWED_SLACK_USER_ID` can:
- Send messages that reach Claude
- Approve or deny tool-use prompts via Slack buttons

Messages from any other Slack user are silently dropped. Button clicks from other users are ignored even if they somehow see the message.

## Limitations

- Personal use only (one allowed user ID)
- No pairing flow — you must set the user ID manually in `.env`
- No file attachment support yet
- Requires `--dangerously-load-development-channels` flag (research preview)
- Permission relay requires Claude Code v2.1.81+
