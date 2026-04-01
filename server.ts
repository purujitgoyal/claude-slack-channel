#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
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

const CHANNELS_DIR = join(homedir(), '.claude', 'channels', 'slack')
const ENV_PATH = join(CHANNELS_DIR, '.env')
const SESSION_PATH = join(CHANNELS_DIR, 'session.json')
const PID_PATH = join(CHANNELS_DIR, 'server.pid')

// Kill stale server process if one exists
try {
  if (existsSync(PID_PATH)) {
    const oldPid = parseInt(readFileSync(PID_PATH, 'utf8').trim(), 10)
    if (oldPid && oldPid !== process.pid) {
      try {
        process.kill(oldPid)
        console.error(`[slack-channel] killed stale process ${oldPid}`)
      } catch {
        // process already dead — fine
      }
    }
  }
} catch {
  // ignore
}

// Write our PID
try {
  if (!existsSync(CHANNELS_DIR)) mkdirSync(CHANNELS_DIR, { recursive: true })
  writeFileSync(PID_PATH, String(process.pid), 'utf8')
} catch {
  // non-fatal
}

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
const SLACK_CHANNEL_ID = env['SLACK_CHANNEL_ID'] ?? ''

if (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN || !ALLOWED_USER_ID || !SLACK_CHANNEL_ID) {
  throw new Error(
    'SLACK_BOT_TOKEN, SLACK_APP_TOKEN, ALLOWED_SLACK_USER_ID, and SLACK_CHANNEL_ID must all be set in ' +
    ENV_PATH,
  )
}

// ---------------------------------------------------------------------------
// Session state — persisted to disk for resume support
// ---------------------------------------------------------------------------

type SessionState = {
  threadTs: string | null
}

function loadSession(): SessionState {
  try {
    if (existsSync(SESSION_PATH)) {
      const data = JSON.parse(readFileSync(SESSION_PATH, 'utf8'))
      return { threadTs: data.threadTs ?? null }
    }
  } catch {
    // corrupt file — start fresh
  }
  return { threadTs: null }
}

function saveSession(state: SessionState) {
  try {
    if (!existsSync(CHANNELS_DIR)) mkdirSync(CHANNELS_DIR, { recursive: true })
    writeFileSync(SESSION_PATH, JSON.stringify(state), 'utf8')
  } catch (err) {
    console.error('[slack-channel] failed to save session state:', err)
  }
}

let activeThreadTs: string | null = null

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const INSTRUCTIONS = `
You are connected to the user's Slack workspace via a channel bridge in #purujit-cc.

Inbound messages arrive as:
  <channel source="slack" slack_user_id="U01..." channel_id="C01..." event_ts="...">message text</channel>

TOOLS:
- reply: Respond within the active thread. Use for replying to user messages and ongoing conversation.
- new_thread: Start a fresh thread. Use to proactively reach the user (status updates, questions, alerts),
  or after /compact or /clear. Pass text to post the first message immediately.
- Keep messages concise — the user reads these on mobile.

THREAD LIFECYCLE:
- The user @mentions the bot in #purujit-cc to start a new thread.
- Replies in the active thread are forwarded to you.
- If the user replies in an old thread, the server starts a new thread with a summary
  of the old thread's history, so you get that context automatically.
- Call the new_thread tool after a /compact or /clear to start a fresh Slack thread.
- On resume, the existing thread is continued automatically.

PERMISSION RELAY:
- When Claude Code shows a tool-approval dialog, the server automatically forwards it
  to the active thread as Block Kit buttons (Allow/Deny). You do NOT need to handle this.

IMPORTANT — TOOL ROUTING:
- ALWAYS use the reply and new_thread tools from this server (slack-channel) to send messages.
- NEVER use the official Slack plugin tools (slack_send_message, slack_send_message_draft, etc.) to send messages.
- The official Slack plugin tools (slack_read_channel, slack_read_thread) are fine for READING context.

This channel is primarily used in multi-repo coordination sessions — the user
may be away from the terminal and relying on Slack to monitor progress and
approve tool use.
`.trim()

const mcp = new Server(
  { name: 'slack', version: '0.2.0' },
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
// Threading helper — posts a message, starting or continuing a thread
// ---------------------------------------------------------------------------

async function postThreaded(opts: {
  text: string
  blocks?: any[]
}): Promise<string | undefined> {
  const result = await bolt.client.chat.postMessage({
    channel: SLACK_CHANNEL_ID,
    text: opts.text,
    blocks: opts.blocks,
    thread_ts: activeThreadTs ?? undefined,
  })

  // If this is the first message (no active thread), the response ts becomes
  // the thread parent. All subsequent messages reply to it.
  if (!activeThreadTs && result.ts) {
    activeThreadTs = result.ts
    saveSession({ threadTs: activeThreadTs })
  }

  return result.ts
}

// ---------------------------------------------------------------------------
// Old thread summary helper
// ---------------------------------------------------------------------------

async function fetchThreadSummary(threadTs: string): Promise<string> {
  try {
    const result = await bolt.client.conversations.replies({
      channel: SLACK_CHANNEL_ID,
      ts: threadTs,
      limit: 50,
    })

    const messages = result.messages ?? []
    const lines: string[] = []
    let totalLen = 0

    for (const msg of messages) {
      const who = msg.bot_id ? 'bot' : 'user'
      const text = (msg.text ?? '').replace(/<@[A-Z0-9]+>\s*/g, '').trim()
      if (!text) continue
      const line = `[${who}]: ${text}`
      if (totalLen + line.length > 2000) {
        lines.push('... (truncated)')
        break
      }
      lines.push(line)
      totalLen += line.length
    }

    return lines.join('\n')
  } catch (err) {
    console.error('[slack-channel] failed to fetch thread summary:', err)
    return '(could not fetch previous thread history)'
  }
}

// ---------------------------------------------------------------------------
// MCP tools
// ---------------------------------------------------------------------------

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Send a message back to the user in the Slack channel. Messages are automatically threaded.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          text: {
            type: 'string',
            description: 'The message text. Plain text or Slack mrkdwn.',
          },
        },
        required: ['text'],
      },
    },
    {
      name: 'new_thread',
      description:
        'Start a fresh Slack thread. Use to proactively reach the user, or after /compact or /clear. If text is provided, it becomes the first message (thread parent). Otherwise the next reply starts the thread.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          text: {
            type: 'string',
            description: 'Optional first message for the new thread. If omitted, the thread starts on the next reply.',
          },
        },
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'reply') {
    const { text } = req.params.arguments as {
      text: string
    }
    // Always post to the configured channel, ignore passed channel_id
    await postThreaded({ text })
    return { content: [{ type: 'text' as const, text: 'sent' }] }
  }

  if (req.params.name === 'new_thread') {
    activeThreadTs = null
    saveSession({ threadTs: null })

    const { text } = (req.params.arguments ?? {}) as { text?: string }
    if (text) {
      await postThreaded({ text })
      console.error('[slack-channel] new thread started with message')
      return { content: [{ type: 'text' as const, text: 'New thread started.' }] }
    }

    console.error('[slack-channel] thread reset — next reply starts a new thread')
    return {
      content: [
        { type: 'text' as const, text: 'Thread reset. Next reply will start a new thread.' },
      ],
    }
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
  const { request_id, tool_name, description, input_preview } = params
  const preview =
    input_preview.length > 200 ? input_preview.slice(0, 197) + '...' : input_preview

  await postThreaded({
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
            text: { type: 'plain_text', text: 'Allow' },
            style: 'primary',
            action_id: `allow_${request_id}`,
            value: `allow:${request_id}`,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Deny' },
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

// Inbound channel messages — only forward active thread replies
bolt.message(async ({ message }) => {
  if (message.subtype !== undefined) return

  const msg = message as {
    user?: string
    text?: string
    channel?: string
    ts?: string
    thread_ts?: string
  }

  // Sender gate
  if (msg.user !== ALLOWED_USER_ID) return

  const threadTs = msg.thread_ts
  const text = msg.text ?? ''
  const eventTs = msg.ts ?? ''

  // Top-level message (no thread) — ignore, only @mentions start threads
  if (!threadTs) return

  console.error(`[slack-channel] DEBUG thread check: msg.thread_ts=${threadTs} activeThreadTs=${activeThreadTs}`)

  // Active thread reply — forward directly
  if (threadTs === activeThreadTs) {
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: text,
        meta: {
          slack_user_id: msg.user ?? '',
          channel_id: SLACK_CHANNEL_ID,
          event_ts: eventTs,
        },
      },
    })
    console.error(`[slack-channel] forwarded thread reply to Claude`)
    return
  }

  // Old thread reply — fetch summary, start new thread, forward with context
  console.error(`[slack-channel] reply in old thread ${threadTs} — fetching summary`)
  const summary = await fetchThreadSummary(threadTs)

  // Post a note in the old thread
  await bolt.client.chat.postMessage({
    channel: SLACK_CHANNEL_ID,
    thread_ts: threadTs,
    text: '→ Continued in new thread',
  })

  // Reset active thread — next postThreaded call will create a new one
  activeThreadTs = null
  saveSession({ threadTs: null })

  // Forward to Claude with old thread context
  await mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: `[Context from previous thread]\n${summary}\n\n[New message]\n${text}`,
      meta: {
        slack_user_id: msg.user ?? '',
        channel_id: SLACK_CHANNEL_ID,
        event_ts: eventTs,
      },
    },
  })
  console.error(`[slack-channel] forwarded old thread reply with summary to Claude`)
})

// App mention — starts a new thread
bolt.event('app_mention', async ({ event }) => {
  if (event.user !== ALLOWED_USER_ID) return

  // Strip the bot mention tag (e.g. "<@U0123ABC> hello" → "hello")
  const text = (event.text ?? '').replace(/<@[A-Z0-9]+>\s*/g, '').trim()
  const eventTs = event.ts ?? ''

  // The @mention message becomes the thread parent
  activeThreadTs = eventTs
  saveSession({ threadTs: activeThreadTs })
  console.error(`[slack-channel] app_mention — new thread rooted at ${eventTs}`)

  await mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: text || '(new session)',
      meta: {
        slack_user_id: event.user ?? '',
        channel_id: SLACK_CHANNEL_ID,
        event_ts: eventTs,
      },
    },
  })
  console.error(`[slack-channel] forwarded app_mention to Claude`)
})

// Permission relay — receive verdict from Allow/Deny button click
bolt.action(/^(allow|deny)_[a-km-z]{5}$/, async ({ action, ack, body, client }) => {
  await ack()

  const actingUser = body.user?.id
  if (actingUser !== ALLOWED_USER_ID) return

  const btn = action as { value?: string }
  const value = btn.value ?? ''
  const colonIdx = value.indexOf(':')
  if (colonIdx === -1) return

  const behavior = value.slice(0, colonIdx) as 'allow' | 'deny'
  const request_id = value.slice(colonIdx + 1)

  await mcp.notification({
    method: 'notifications/claude/channel/permission',
    params: { request_id, behavior },
  })
  console.error(
    `[slack-channel] verdict ${behavior} for request ${request_id}`,
  )

  // Update the Slack message — replace buttons with outcome text
  const message = body.message as { ts?: string } | undefined
  const channelId =
    (body.container as { channel_id?: string } | undefined)?.channel_id ?? SLACK_CHANNEL_ID

  if (message?.ts && channelId) {
    await client.chat.update({
      channel: channelId,
      ts: message.ts,
      text:
        behavior === 'allow'
          ? `Allowed — \`${request_id}\``
          : `Denied — \`${request_id}\``,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              behavior === 'allow'
                ? '*Allowed* — request `' + request_id + '`'
                : '*Denied* — request `' + request_id + '`',
          },
        },
      ],
    })
  }
})

// ---------------------------------------------------------------------------
// Startup + graceful shutdown
// ---------------------------------------------------------------------------

function cleanup() {
  saveSession({ threadTs: null })
  try { unlinkSync(PID_PATH) } catch {}
}

process.on('SIGINT', () => { cleanup(); process.exit(0) })
process.on('SIGTERM', () => { cleanup(); process.exit(0) })

process.stdin.on('close', () => {
  cleanup()
  bolt.stop().finally(() => process.exit(0))
})

await bolt.start()
console.error('[slack-channel] Bolt Socket Mode connected')

await mcp.connect(new StdioServerTransport())
console.error('[slack-channel] MCP connected — channel: ' + SLACK_CHANNEL_ID)
