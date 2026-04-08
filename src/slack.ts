import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { App } from '@slack/bolt';
import { codePreviewBlock, log, stripMentions } from './config.ts';
import {
  getActiveThreadTs,
  pendingPermissions,
  resolvedPermissions,
  saveSession,
  setActiveThreadTs,
} from './session.ts';

// ---------------------------------------------------------------------------
// Module state — populated by startSlack()
// ---------------------------------------------------------------------------

let bolt: App | null = null;
let channelId = '';
let allowedUserId = '';
let cleanupMonitor: (() => void) | null = null;

// ---------------------------------------------------------------------------
// Threading helper — posts a message, starting or continuing a thread
// ---------------------------------------------------------------------------

export async function postThreaded(opts: {
  text: string;
  blocks?: any[];
}): Promise<string | undefined> {
  const activeThreadTs = getActiveThreadTs();
  const result = await bolt!.client.chat.postMessage({
    channel: channelId,
    text: opts.text,
    blocks: opts.blocks,
    thread_ts: activeThreadTs ?? undefined,
  });

  // If this is the first message (no active thread), the response ts becomes
  // the thread parent. All subsequent messages reply to it.
  if (!activeThreadTs && result.ts) {
    setActiveThreadTs(result.ts);
    saveSession({ threadTs: result.ts });
  }

  return result.ts;
}

// ---------------------------------------------------------------------------
// Old thread summary helper
// ---------------------------------------------------------------------------

async function fetchThreadSummary(threadTs: string): Promise<string> {
  try {
    const result = await bolt!.client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      limit: 50,
    });

    const messages = result.messages ?? [];
    const lines: string[] = [];
    let totalLen = 0;

    for (const msg of messages) {
      const who = msg.bot_id ? 'bot' : 'user';
      const text = stripMentions(msg.text ?? '');
      if (!text) continue;
      const line = `[${who}]: ${text}`;
      if (totalLen + line.length > 2000) {
        lines.push('... (truncated)');
        break;
      }
      lines.push(line);
      totalLen += line.length;
    }

    return lines.join('\n');
  } catch (err) {
    log(`failed to fetch thread summary: ${err}`);
    return '(could not fetch previous thread history)';
  }
}

// ---------------------------------------------------------------------------
// Bolt handlers — registered on the App instance during startSlack()
// ---------------------------------------------------------------------------

function registerBoltHandlers(mcp: Server) {
  // Inbound channel messages — only forward active thread replies
  bolt!.message(async ({ message }) => {
    if (message.subtype !== undefined) return;

    const msg = message as {
      user?: string;
      text?: string;
      channel?: string;
      ts?: string;
      thread_ts?: string;
    };

    // Sender gate
    if (msg.user !== allowedUserId) return;

    const threadTs = msg.thread_ts;
    const text = msg.text ?? '';
    const eventTs = msg.ts ?? '';

    // Top-level message (no thread) — ignore, only @mentions start threads
    if (!threadTs) return;

    const activeThreadTs = getActiveThreadTs();

    // Active thread reply — forward directly
    if (threadTs === activeThreadTs) {
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
      });
      log('forwarded thread reply to Claude');
      return;
    }

    // Old thread reply — fetch summary, start new thread, forward with context
    log(`reply in old thread ${threadTs} — fetching summary`);
    const summary = await fetchThreadSummary(threadTs);

    // Post a note in the old thread
    await bolt!.client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: '\u2192 Continued in new thread',
    });

    // Reset active thread — next postThreaded call will create a new one
    setActiveThreadTs(null);
    saveSession({ threadTs: null });

    // Forward to Claude with old thread context
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: `[Context from previous thread]\n${summary}\n\n[New message]\n${text}`,
        meta: {
          slack_user_id: msg.user ?? '',
          channel_id: channelId,
          event_ts: eventTs,
        },
      },
    });
    log('forwarded old thread reply with summary to Claude');
  });

  // App mention — starts a new thread
  bolt!.event('app_mention', async ({ event }) => {
    if (event.user !== allowedUserId) return;

    // Strip the bot mention tag (e.g. "<@U0123ABC> hello" → "hello")
    const text = stripMentions(event.text ?? '');
    const eventTs = event.ts ?? '';

    // The @mention message becomes the thread parent
    setActiveThreadTs(eventTs);
    saveSession({ threadTs: eventTs });
    log(`app_mention — new thread rooted at ${eventTs}`);

    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: text || '(new session)',
        meta: {
          slack_user_id: event.user ?? '',
          channel_id: channelId,
          event_ts: eventTs,
        },
      },
    });
    log('forwarded app_mention to Claude');
  });

  // Permission relay — receive verdict from Allow/Deny button click
  bolt!.action(/^(allow|deny)_.+$/, async ({ action, ack, body, client }) => {
    await ack();

    const actingUser = body.user?.id;
    if (actingUser !== allowedUserId) return;

    const btn = action as { value?: string };
    const value = btn.value ?? '';
    const colonIdx = value.indexOf(':');
    if (colonIdx === -1) return;

    const behavior = value.slice(0, colonIdx) as 'allow' | 'deny';
    const request_id = value.slice(colonIdx + 1);

    if (resolvedPermissions.has(request_id)) return;
    resolvedPermissions.add(request_id);

    try {
      await mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: { request_id, behavior },
      });
    } catch (err) {
      resolvedPermissions.delete(request_id);
      log(`failed to send verdict for ${request_id}: ${err}`);
      return;
    }

    const details = pendingPermissions.get(request_id);
    pendingPermissions.delete(request_id);
    log(`verdict ${behavior} for request ${request_id}`);

    // Update the Slack message — replace buttons with outcome text
    const message = body.message as { ts?: string } | undefined;
    const msgChannelId =
      (body.container as { channel_id?: string } | undefined)?.channel_id ??
      channelId;

    const label = behavior === 'allow' ? 'Allowed' : 'Denied';
    const preview = details?.input_preview ?? '';
    const summaryText = details
      ? `*${label}* — \`${details.tool_name}\``
      : `*${label}* — request \`${request_id}\``;

    if (message?.ts && msgChannelId) {
      await client.chat.update({
        channel: msgChannelId,
        ts: message.ts,
        text: summaryText,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: summaryText,
            },
          },
          ...codePreviewBlock(preview),
        ],
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Connection monitoring — logs lifecycle events and notifies Claude on outages
// ---------------------------------------------------------------------------

export const OUTAGE_THRESHOLD = 10_000; // 10s — only notify if disconnect lasts longer than this
export const RECONNECT_DEBOUNCE = 5_000; // 5s — wait for connection to stabilize after reconnect
export const RECOVERY_THRESHOLD = 60_000; // 60s — only fetch history on reconnect if outage exceeded this

function monitorConnection(
  mcp: Server,
  cid: string,
  onDead: () => void,
): () => void {
  // Access the underlying SocketModeClient from Bolt's receiver
  const socketClient = (bolt!.receiver as any).client;
  let disconnectNotifyTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectNotifyTimer: ReturnType<typeof setTimeout> | null = null;
  let connected = false;
  let notifiedDisconnect = false;
  let stopped = false;
  let disconnectedAt: number | null = null;
  let diagCloseListener: ((code: number, reason: Buffer) => void) | null = null;

  socketClient.on('disconnected', () => {
    if (stopped) return;
    log('Socket Mode disconnected');

    // Record the first disconnection time — don't overwrite on repeated disconnected events
    if (disconnectedAt === null) {
      disconnectedAt = Date.now();
    }

    // Cancel any pending "restored" notification — connection didn't stabilize
    if (reconnectNotifyTimer) {
      clearTimeout(reconnectNotifyTimer);
      reconnectNotifyTimer = null;
    }

    // Delay the "lost" notification — routine Slack WS rotations reconnect in <5s
    // and shouldn't be surfaced. Only notify if disconnect persists.
    if (!notifiedDisconnect && !disconnectNotifyTimer) {
      disconnectNotifyTimer = setTimeout(() => {
        disconnectNotifyTimer = null;
        notifiedDisconnect = true;
        mcp
          .notification({
            method: 'notifications/claude/channel',
            params: {
              content:
                'Slack connection lost — attempting to reconnect. Messages sent during this time may not be delivered.',
              meta: { channel_id: cid, event_ts: '' },
            },
          })
          .catch(() => {});
      }, OUTAGE_THRESHOLD);
      disconnectNotifyTimer.unref();
    }
  });

  socketClient.on('connected', () => {
    if (stopped) return;
    log('Socket Mode connected');

    // Cancel pending "lost" notification — reconnected before threshold
    if (disconnectNotifyTimer) {
      clearTimeout(disconnectNotifyTimer);
      disconnectNotifyTimer = null;
    }

    // Attach WebSocket close listener for diagnostics — logs the close code
    // and reason so we can determine what causes real-world drops.
    // Only remove our own listener; leave the library's internal handlers intact.
    const ws = socketClient.websocket;
    if (ws) {
      if (diagCloseListener) ws.off('close', diagCloseListener);
      diagCloseListener = (code: number, reason: Buffer) => {
        log(`ws closed: code=${code} reason=${reason?.toString() || '(none)'}`);
      };
      ws.on('close', diagCloseListener);
    }

    // Only notify on reconnections, not the initial connection.
    if (!connected) {
      connected = true;
      return;
    }

    // Only send "restored" if we actually notified about a disconnect
    if (!notifiedDisconnect) return;

    // Debounce — wait for connection to stabilize before notifying Claude
    if (reconnectNotifyTimer) clearTimeout(reconnectNotifyTimer);
    reconnectNotifyTimer = setTimeout(() => {
      reconnectNotifyTimer = null;
      notifiedDisconnect = false;
      mcp
        .notification({
          method: 'notifications/claude/channel',
          params: {
            content:
              'Slack connection restored. Messages during the outage may have been missed.',
            meta: { channel_id: cid, event_ts: '' },
          },
        })
        .catch(() => {});
      disconnectedAt = null;
    }, RECONNECT_DEBOUNCE);
    reconnectNotifyTimer.unref();
  });

  socketClient.on('reconnecting', () => {
    log('Socket Mode reconnecting');
  });

  socketClient.on('error', (err: Error) => {
    log(`Socket Mode error: ${err.message}`);
  });

  socketClient.on('unable_to_socket_mode_start', () => {
    log('unable_to_socket_mode_start — calling onDead');
    onDead();
  });

  return () => {
    stopped = true;
    if (disconnectNotifyTimer) {
      clearTimeout(disconnectNotifyTimer);
      disconnectNotifyTimer = null;
    }
    if (reconnectNotifyTimer) {
      clearTimeout(reconnectNotifyTimer);
      reconnectNotifyTimer = null;
    }
  };
}

// ---------------------------------------------------------------------------
// Lifecycle — start / stop
// ---------------------------------------------------------------------------

export async function startSlack(opts: {
  mcp: Server;
  botToken: string;
  appToken: string;
  channelId: string;
  allowedUserId: string;
  onDead: () => void;
}): Promise<App> {
  channelId = opts.channelId;
  allowedUserId = opts.allowedUserId;

  bolt = new App({
    token: opts.botToken,
    appToken: opts.appToken,
    socketMode: true,
    logLevel: 'warn' as const,
  });

  registerBoltHandlers(opts.mcp);
  await bolt.start();
  log('Bolt Socket Mode connected');

  cleanupMonitor = monitorConnection(opts.mcp, opts.channelId, opts.onDead);

  return bolt;
}

export async function stopSlack(): Promise<void> {
  if (bolt) {
    cleanupMonitor?.();
    cleanupMonitor = null;
    try {
      await bolt.stop();
    } catch (err: any) {
      // @slack/socket-mode state machine bug: late WebSocket close event
      // arrives after the client has already transitioned to 'disconnected',
      // throwing "Unhandled event 'websocket close' in state 'disconnected'".
      if (!err?.message?.includes('Unhandled event')) throw err;
      log(`suppressed stop() error: ${err.message}`);
    }
    bolt = null;
  }
}
