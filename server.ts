#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { App } from '@slack/bolt'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

const ENV_PATH = join(homedir(), '.claude', 'channels', 'slack', '.env')

function loadEnv(path: string): Record<string, string> {
  if (!existsSync(path)) {
    throw new Error(
      `Missing config: ${path}\nRun /slack:configure to set up tokens.`,
    )
  }
  const out: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx === -1) continue
    out[trimmed.slice(0, idx)] = trimmed.slice(idx + 1)
  }
  return out
}

const env = loadEnv(ENV_PATH)
const SLACK_BOT_TOKEN = env['SLACK_BOT_TOKEN'] ?? ''
const SLACK_APP_TOKEN = env['SLACK_APP_TOKEN'] ?? ''
const ALLOWED_USER_ID = env['ALLOWED_SLACK_USER_ID'] ?? ''

if (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN || !ALLOWED_USER_ID) {
  throw new Error(
    'SLACK_BOT_TOKEN, SLACK_APP_TOKEN, and ALLOWED_SLACK_USER_ID must all be set in ' +
    ENV_PATH,
  )
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// Tracks the most recent DM channel from the allowed user so permission
// prompts know where to send Block Kit messages.
let activeDmChannelId: string | null = null

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const INSTRUCTIONS = `
You are connected to the user's Slack workspace via a personal DM bridge.

Inbound messages arrive as:
  <channel source="slack" slack_user_id="U01..." channel_id="D01..." event_ts="...">message text</channel>

Always reply using the reply tool, passing the channel_id from the tag.
Keep replies concise — this is a mobile Slack DM, not a terminal.

When you receive a permission relay prompt (tool approval), the server handles
it automatically by sending a Block Kit message to the user's Slack DM with
Allow/Deny buttons. You do NOT need to do anything for permission relay.

This channel is primarily used in multi-repo coordination sessions — the user
may be away from the terminal and relying on Slack to monitor progress and
approve tool use.
`.trim()

const mcp = new Server(
  { name: 'slack', version: '0.1.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
      tools: {},
    },
    instructions: INSTRUCTIONS,
  },
)

// ---------------------------------------------------------------------------
// MCP tools
// ---------------------------------------------------------------------------

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Send a message back to the user in the Slack DM channel.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel_id: {
            type: 'string',
            description:
              'The Slack channel ID from the inbound <channel> tag (e.g. D01XXXXXXXX).',
          },
          text: {
            type: 'string',
            description: 'The message text. Plain text or Slack mrkdwn.',
          },
        },
        required: ['channel_id', 'text'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'reply') {
    const { channel_id, text } = req.params.arguments as {
      channel_id: string
      text: string
    }
    await bolt.client.chat.postMessage({ channel: channel_id, text })
    return { content: [{ type: 'text' as const, text: 'sent' }] }
  }
  throw new Error(`unknown tool: ${req.params.name}`)
})

// ---------------------------------------------------------------------------
// Permission relay — receive request from Claude Code, send to Slack
// ---------------------------------------------------------------------------

const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
})

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  if (!activeDmChannelId) {
    console.error(
      '[slack-channel] permission_request received but no active DM channel — skipping relay (answer in the terminal)',
    )
    return
  }

  const { request_id, tool_name, description, input_preview } = params
  const preview =
    input_preview.length > 200 ? input_preview.slice(0, 197) + '...' : input_preview

  await bolt.client.chat.postMessage({
    channel: activeDmChannelId,
    text: `Claude wants to use \`${tool_name}\` — tap Allow or Deny`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Claude wants to use \`${tool_name}\`*\n${description}`,
        },
      },
      ...(preview
        ? [
            {
              type: 'context',
              elements: [{ type: 'mrkdwn', text: `\`\`\`${preview}\`\`\`` }],
            },
          ]
        : []),
      {
        type: 'actions',
        block_id: `permission_${request_id}`,
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '✅ Allow' },
            style: 'primary',
            action_id: `allow_${request_id}`,
            value: `allow:${request_id}`,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '❌ Deny' },
            style: 'danger',
            action_id: `deny_${request_id}`,
            value: `deny:${request_id}`,
          },
        ],
      },
    ],
  })
  console.error(
    `[slack-channel] permission request ${request_id} (${tool_name}) sent to Slack`,
  )
})

// ---------------------------------------------------------------------------
// Bolt — Socket Mode
// ---------------------------------------------------------------------------

const bolt = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: 'error' as const,
})

// Inbound DM messages
bolt.message(async ({ message }) => {
  // Skip subtypes (edits, deletions, bot messages, etc.)
  if (message.subtype !== undefined) return

  const msg = message as {
    user?: string
    text?: string
    channel?: string
    ts?: string
  }

  // Sender gate
  if (msg.user !== ALLOWED_USER_ID) {
    console.error(
      `[slack-channel] dropped message from ungated user: ${msg.user}`,
    )
    return
  }

  const channelId = msg.channel ?? ''
  const eventTs = msg.ts ?? ''
  const text = msg.text ?? ''

  // Record the active DM channel for permission relay
  activeDmChannelId = channelId

  await mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: text,
      meta: {
        slack_user_id: msg.user ?? '',
        channel_id: channelId,
        event_ts: eventTs,
      },
    },
  })
  console.error(`[slack-channel] forwarded DM from ${msg.user} to Claude`)
})

// Permission relay — receive verdict from Allow/Deny button click
bolt.action(/^(allow|deny)_[a-km-z]{5}$/, async ({ action, ack, body, client }) => {
  await ack()

  // Gate: only the allowlisted user can approve/deny
  const actingUser = body.user?.id
  if (actingUser !== ALLOWED_USER_ID) {
    console.error(
      `[slack-channel] permission action from ungated user ${actingUser} — ignored`,
    )
    return
  }

  const btn = action as { value?: string }
  const value = btn.value ?? ''
  const colonIdx = value.indexOf(':')
  if (colonIdx === -1) return

  const behavior = value.slice(0, colonIdx) as 'allow' | 'deny'
  const request_id = value.slice(colonIdx + 1)

  // Send verdict to Claude Code
  await mcp.notification({
    method: 'notifications/claude/channel/permission',
    params: { request_id, behavior },
  })
  console.error(
    `[slack-channel] verdict ${behavior} for request ${request_id} sent to Claude Code`,
  )

  // Update the Slack message — replace buttons with outcome text
  const message = body.message as { ts?: string } | undefined
  const channelId =
    (body.container as { channel_id?: string } | undefined)?.channel_id ??
    activeDmChannelId ??
    ''

  if (message?.ts && channelId) {
    await client.chat.update({
      channel: channelId,
      ts: message.ts,
      text:
        behavior === 'allow'
          ? `✅ Allowed — \`${request_id}\``
          : `❌ Denied — \`${request_id}\``,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              behavior === 'allow'
                ? `✅ *Allowed* — request \`${request_id}\``
                : `❌ *Denied* — request \`${request_id}\``,
          },
        },
      ],
    })
  }
})

// ---------------------------------------------------------------------------
// Startup + graceful shutdown
// ---------------------------------------------------------------------------

process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))

// stdin close = Claude Code shut down the subprocess
process.stdin.on('close', () => {
  bolt.stop().finally(() => process.exit(0))
})

await bolt.start()
console.error('[slack-channel] Bolt Socket Mode connected')

await mcp.connect(new StdioServerTransport())
console.error('[slack-channel] MCP connected')
