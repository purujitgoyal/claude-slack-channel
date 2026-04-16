import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  buildPermissionBlocks,
  formatInputPreview,
  getSessionLabel,
  log,
  SOCKET_PATH,
  textResult,
} from './config.ts';
import { IPCClient } from './ipc.ts';
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
// IPC client — used in client mode to relay through the active session
// ---------------------------------------------------------------------------

let ipcClient: IPCClient | null = null;

export function getIpcClient(): IPCClient | null {
  return ipcClient;
}

export function setIpcClient(c: IPCClient | null): void {
  ipcClient = c;
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
- connect: Call this first. If no other session is active, you become the connected session.
  If another session is already connected, you enter client mode (relay through it).
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

MODES (after calling connect):
- Connected: "Connected to Slack." — full two-way messaging + permission relay.
- Client: "Connected as client..." — outbound only, own thread, no inbound messages.
  Note: \`react\` is limited in client mode — you can only react to messages in your own thread
  (using \`ts\` values from \`send_ack\` responses), not to inbound messages you don't receive.
- Dormant: tools error, call connect first.

Always call connect. The response tells you which mode you're in.
`.trim();

export const mcp = new Server(
  { name: 'slack-channel', version: '0.9.0' },
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
    'Connect this session to the Slack channel. If another session is already connected, enters client mode with relay. Call this before using reply/new_thread/react.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
};

const DISCONNECT_TOOL = {
  name: 'disconnect',
  description:
    'Disconnect this session from the Slack channel. In connected mode, releases the lock. In client mode, disconnects from relay.',
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
        try {
          const client = new IPCClient({
            socketPath: SOCKET_PATH,
            sessionId: crypto.randomUUID(),
            label: getSessionLabel(),
            onPermResponse: (requestId, behavior) => {
              mcp.notification({
                method: 'notifications/claude/channel/permission',
                params: { request_id: requestId, behavior },
              });
            },
            onDisconnect: ({ graceful }) => {
              ipcClient = null;
              setMode('dormant');
              const reason = graceful
                ? 'Connected session disconnected — degraded to dormant'
                : 'IPC connection lost unexpectedly — degraded to dormant';
              log(reason);
              mcp
                .notification({
                  method: 'notifications/claude/channel',
                  params: {
                    content: `${reason}. Call connect to become the main session.`,
                  },
                })
                .catch(() => {});
            },
          });
          await client.connect();
          ipcClient = client;
          setMode('client');
          return textResult(
            'Connected as client \u2014 messages and permissions relay through the active session. You have your own thread.',
          );
        } catch (ipcErr) {
          log(`IPC connect failed: ${ipcErr}`);
          setMode('dormant');
          return textResult(
            'No active session found \u2014 call connect in another session first.',
          );
        }
      }
      throw err;
    }
  }

  if (req.params.name === 'disconnect') {
    if (getMode() === 'dormant') return textResult('Not connected.');
    if (getMode() === 'client') {
      if (ipcClient) {
        ipcClient.close();
        ipcClient = null;
      }
      setMode('dormant');
      return textResult('Disconnected from relay.');
    }
    if (!injectedDeactivate) throw new Error('deactivate function not set');
    await injectedDeactivate();
    return textResult(
      'Disconnected from Slack. Another session can now connect.',
    );
  }

  if (getMode() === 'dormant')
    throw new Error(
      'Slack channel is not active — call connect first. If you were in client mode, the connected session may have disconnected.',
    );

  // ── Client mode: forward tool calls over IPC ──
  if (getMode() === 'client') {
    if (!ipcClient)
      throw new Error('Slack relay lost — call connect to reconnect.');

    if (req.params.name === 'reply') {
      const { text } = req.params.arguments as { text: string };
      await ipcClient.sendMessage(text);
      return textResult('sent');
    }

    if (req.params.name === 'react') {
      const { emoji, event_ts } = req.params.arguments as {
        emoji: string;
        event_ts: string;
      };
      await ipcClient.addReaction(emoji, event_ts);
      return textResult('reacted');
    }

    if (req.params.name === 'new_thread') {
      const { text } = (req.params.arguments ?? {}) as { text?: string };
      await ipcClient.newThread(text);
      return textResult('New thread started.');
    }

    throw new Error(`unknown tool: ${req.params.name}`);
  }

  // ── Connected mode: use the local Slack bridge directly ──
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
    const label = getSessionLabel();
    const header = `\u{1F4E1} ${label}`;
    const fullText = text ? `${header}\n${text}` : header;
    await b.postThreaded({ text: fullText });
    log('new thread started with message');
    return textResult('New thread started.');
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
  const { request_id, tool_name, description, input_preview } = params;

  // ── Dormant mode: silently ignore — CC falls back to terminal ──
  if (getMode() === 'dormant') return;

  // ── Client mode: forward over IPC to the connected session ──
  if (getMode() === 'client') {
    if (!ipcClient) return; // relay lost — CC falls back to terminal
    ipcClient.sendPermRequest(
      request_id,
      tool_name,
      description,
      input_preview,
    );
    return;
  }

  // ── Connected mode: post buttons to Slack directly ──
  const b = requireBridge();
  const preview = formatInputPreview(tool_name, input_preview);

  await b.postThreaded({
    text: `Claude wants to use \`${tool_name}\` — tap Allow or Deny`,
    blocks: buildPermissionBlocks(request_id, tool_name, description, preview),
  });
  pendingPermissions.set(request_id, {
    tool_name,
    description,
    input_preview: preview,
  });
  log(`permission request ${request_id} (${tool_name}) sent to Slack`);
});
