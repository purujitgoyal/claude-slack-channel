import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  codePreviewBlock,
  formatInputPreview,
  log,
  textResult,
} from './config.ts';
import { LockHeldError } from './lock.ts';
import {
  pendingPermissions,
  saveSession,
  setActiveThreadTs,
} from './session.ts';

// ---------------------------------------------------------------------------
// SlackBridge — injected by server.ts to avoid circular deps with slack.ts
// ---------------------------------------------------------------------------

export interface SlackBridge {
  postThreaded(opts: {
    text: string;
    blocks?: any[];
  }): Promise<string | undefined>;
  addReaction(channel: string, name: string, timestamp: string): Promise<void>;
  channelId: string;
}

let bridge: SlackBridge | null = null;

export function setSlackBridge(b: SlackBridge): void {
  bridge = b;
}

function requireBridge(): SlackBridge {
  if (!bridge)
    throw new Error('SlackBridge not set — call setSlackBridge() first');
  return bridge;
}

// ---------------------------------------------------------------------------
// Session mode: dormant → connected (owns Slack bridge) or client (IPC relay)
// ---------------------------------------------------------------------------

export type Mode = 'dormant' | 'connected' | 'client';

let mode: Mode = 'dormant';

export function getMode(): Mode {
  return mode;
}

export function setMode(m: Mode): void {
  mode = m;
}

export function isConnected(): boolean {
  return mode === 'connected';
}

export function isClient(): boolean {
  return mode === 'client';
}

// ---------------------------------------------------------------------------
// Activate function — injected by server.ts to avoid circular deps
// ---------------------------------------------------------------------------

type LifecycleFn = () => Promise<void>;

let injectedActivate: LifecycleFn | null = null;
let injectedDeactivate: LifecycleFn | null = null;

export function setActivate(fn: LifecycleFn): void {
  injectedActivate = fn;
}

export function setDeactivate(fn: LifecycleFn): void {
  injectedDeactivate = fn;
}

// ---------------------------------------------------------------------------
// MCP server — starts dormant (no tools) until channel mode is detected
// ---------------------------------------------------------------------------

const INSTRUCTIONS = `
You are connected to the user's Slack workspace via a channel bridge.

Inbound messages arrive as:
  <channel source="slack" slack_user_id="U01..." channel_id="C01..." event_ts="...">message text</channel>

TOOLS:
- connect: Call this first to activate the Slack bridge in this session. Only one session can be
  connected at a time. Other sessions remain dormant until you call connect.
- reply: Respond within the active thread. Use for replying to user messages and ongoing conversation.
- new_thread: Start a fresh thread. Use to proactively reach the user (status updates, questions, alerts),
  or after /compact or /clear. Pass text to post the first message immediately.
- react: Add an emoji reaction to a message (e.g. white_check_mark, eyes, thumbsup). Use to acknowledge
  without a full reply. Pass the event_ts from the inbound <channel> tag.
- Keep messages concise — the user reads these on mobile.

GETTING STARTED:
- When asked to "continue on Slack", "move to Slack", or similar — call connect first, then
  call new_thread with a brief summary of what you're working on. Do NOT ask the user to @mention first.
- You can always proactively call connect + new_thread to reach the user on Slack.

THREAD LIFECYCLE:
- The user @mentions the bot to start a new thread, OR you call new_thread to start one.
- Replies in the active thread are forwarded to you.
- If the user replies in an old thread, the server starts a new thread with a summary
  of the old thread's history, so you get that context automatically.
- Call the new_thread tool after a /compact or /clear to start a fresh Slack thread.
- Each new session starts a fresh thread automatically.

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
`.trim();

export const mcp = new Server(
  { name: 'slack-channel', version: '0.8.1' },
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
);

// ---------------------------------------------------------------------------
// MCP tools — empty when dormant, populated when channel is active
// ---------------------------------------------------------------------------

const CONNECT_TOOL = {
  name: 'connect',
  description:
    'Connect this session to the Slack channel. Only one session can be connected at a time. Call this before using reply/new_thread/react.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
};

const DISCONNECT_TOOL = {
  name: 'disconnect',
  description:
    'Disconnect this session from the Slack channel, releasing the lock so another session can connect.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
};

const CHANNEL_TOOLS = [
  {
    name: 'reply',
    description:
      'Send a message back to the user in the Slack channel. Messages are automatically threaded.',
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
          description:
            'Optional first message for the new thread. If omitted, the thread starts on the next reply.',
        },
      },
    },
  },
  {
    name: 'react',
    description:
      'Add an emoji reaction to a message. Use to acknowledge a message without a full reply (e.g. checkmark, eyes, thumbsup).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        emoji: {
          type: 'string',
          description:
            'Emoji name without colons (e.g. "white_check_mark", "eyes", "thumbsup", "rocket").',
        },
        event_ts: {
          type: 'string',
          description:
            'The event_ts from the inbound <channel> tag of the message to react to.',
        },
      },
      required: ['emoji', 'event_ts'],
    },
  },
];

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [CONNECT_TOOL, DISCONNECT_TOOL, ...CHANNEL_TOOLS],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'connect') {
    if (getMode() === 'connected') return textResult('Already connected.');
    if (getMode() === 'client')
      return textResult('Already connected as client.');
    if (!injectedActivate) throw new Error('activate function not set');
    try {
      await injectedActivate();
      return textResult('Connected to Slack.');
    } catch (err) {
      if (err instanceof LockHeldError) {
        setMode('client');
        return textResult(
          'Connected as client \u2014 messages and permissions relay through the active session.',
        );
      }
      throw err;
    }
  }

  if (req.params.name === 'disconnect') {
    if (getMode() === 'dormant') return textResult('Not connected.');
    if (!injectedDeactivate) throw new Error('deactivate function not set');
    await injectedDeactivate();
    return textResult(
      'Disconnected from Slack. Another session can now connect.',
    );
  }

  if (getMode() === 'dormant')
    throw new Error('slack channel is not active — call connect first');
  const b = requireBridge();

  if (req.params.name === 'reply') {
    const { text } = req.params.arguments as { text: string };
    await b.postThreaded({ text });
    return textResult('sent');
  }

  if (req.params.name === 'react') {
    const { emoji, event_ts } = req.params.arguments as {
      emoji: string;
      event_ts: string;
    };
    await b.addReaction(b.channelId, emoji, event_ts);
    return textResult('reacted');
  }

  if (req.params.name === 'new_thread') {
    setActiveThreadTs(null);
    saveSession({ threadTs: null });

    const { text } = (req.params.arguments ?? {}) as { text?: string };
    if (text) {
      await b.postThreaded({ text });
      log('new thread started with message');
      return textResult('New thread started.');
    }

    log('thread reset — next reply starts a new thread');
    return textResult('Thread reset. Next reply will start a new thread.');
  }

  throw new Error(`unknown tool: ${req.params.name}`);
});

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
});

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  const b = requireBridge();
  const { request_id, tool_name, description, input_preview } = params;
  const preview = formatInputPreview(tool_name, input_preview);

  await b.postThreaded({
    text: `Claude wants to use \`${tool_name}\` — tap Allow or Deny`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Claude wants to use \`${tool_name}\`*\n${description}`,
        },
      },
      ...codePreviewBlock(preview),
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
  });
  pendingPermissions.set(request_id, {
    tool_name,
    description,
    input_preview: preview,
  });
  log(`permission request ${request_id} (${tool_name}) sent to Slack`);
});
