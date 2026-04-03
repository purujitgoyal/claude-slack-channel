---
name: configure
description: Set up Slack channel tokens. Writes SLACK_BOT_TOKEN, SLACK_APP_TOKEN, ALLOWED_SLACK_USER_ID, and SLACK_CHANNEL_ID to ~/.claude/channels/slack/.env.
---

# /slack:configure

Guide the user through configuring the Slack channel plugin.

Arguments: $ARGUMENTS

## Steps

### 1. Check for existing config

Check if `~/.claude/channels/slack/.env` exists. If it does, read and display
the variable names with masked values (show first 10 chars + `...`). Ask if the
user wants to overwrite.

### 2. Collect the four values

Ask for each value if not already provided in $ARGUMENTS:

**`SLACK_BOT_TOKEN`**
- Starts with `xoxb-`
- Found at: Slack App dashboard → OAuth & Permissions → Bot User OAuth Token
- The app needs these bot token scopes: `chat:write`, `reactions:write`, `groups:history`

**`SLACK_APP_TOKEN`**
- Starts with `xapp-`
- Found at: Slack App dashboard → Basic Information → App-Level Tokens
- Must have the `connections:write` scope
- Required for Socket Mode (enable Socket Mode under Settings → Socket Mode)

**`ALLOWED_SLACK_USER_ID`**
- Format: `U01XXXXXXXX`
- Found in Slack: click your profile picture → View Profile → three-dot menu (⋯) → Copy member ID

**`SLACK_CHANNEL_ID`**
- Format: `C01XXXXXXXX`
- The ID of the private channel where the bot operates
- Found in Slack: right-click the channel → View channel details → scroll to bottom → Channel ID
- The bot must be invited to this channel after app installation

Also remind the user:
- **Event Subscriptions** must include: `app_mention`, `message.groups`
- **Interactivity & Shortcuts** must be enabled (no Request URL needed — Socket Mode handles it)

### 3. Write the config file

Create the directory and write the file:

```bash
mkdir -p ~/.claude/channels/slack
chmod 700 ~/.claude/channels/slack
```

Write `~/.claude/channels/slack/.env`:
```
SLACK_BOT_TOKEN=<value>
SLACK_APP_TOKEN=<value>
ALLOWED_SLACK_USER_ID=<value>
SLACK_CHANNEL_ID=<value>
```

Then lock permissions:
```bash
chmod 600 ~/.claude/channels/slack/.env
```

### 4. Confirm

Re-read the file and display each variable name with its value masked
(first 10 chars + `...`). Confirm the file was written successfully.

### 5. Next step

Tell the user:

> Configuration saved. To activate the channel, add the env var `SLACK_CHANNEL_ACTIVATE=1`
> to the server's entry in your project's `.mcp.json`:
>
> ```json
> {
>   "mcpServers": {
>     "slack-channel": {
>       "command": "bun",
>       "args": ["run", "--cwd", "/path/to/claude-slack-channel", "--shell=bun", "--silent", "start"],
>       "env": { "SLACK_CHANNEL_ACTIVATE": "1" }
>     }
>   }
> }
> ```
>
> Then start with: `claude --dangerously-load-development-channels server:slack-channel`
>
> @mention the bot in your channel to start a conversation.
> Permission prompts appear as Allow/Deny buttons in the active thread.
