import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { App } from '@slack/bolt';
import { codePreviewBlock, log, stripMentions } from './config.ts';
import type { InboundMessage as IpcInboundMessage } from './ipc.ts';
import { routeVerdict } from './ipc.ts';
import {
  getActiveThreadTs,
  getLastSeenEventTs,
  pendingPermissions,
  resolvedPermissions,
  saveSession,
  setActiveThreadTs,
  setLastSeenEventTs,
} from './session.ts';

// ---------------------------------------------------------------------------
// Module state — populated by startSlack()
// ---------------------------------------------------------------------------

let bolt: App | null = null;
let channelId = '';
let allowedUserId = '';
let findClientByThread: ((ts: string) => string | null) | undefined;
let evictClient: ((sessionId: string) => void) | undefined;
let forwardToClient:
  | ((sessionId: string, msg: IpcInboundMessage) => boolean)
  | undefined;
let listClientThreads:
  | (() => Array<{ sessionId: string; threadTs: string }>)
  | undefined;
let cleanupMonitor: (() => void) | null = null;
let botUserId: string | null = null;

// ---------------------------------------------------------------------------
// Bot user ID accessors
// ---------------------------------------------------------------------------

/** Returns the bot user ID captured at startup, or null if not yet known. */
export function getBotUserId(): string | null {
  return botUserId;
}

/** Resets botUserId to null — test-only, used in afterEach to prevent cross-test state leakage. */
export function resetBotUserId(): void {
  botUserId = null;
}

/** Resets IPC callback refs — test-only, used in afterEach to prevent cross-test state leakage. */
export function resetIpcCallbacks(): void {
  findClientByThread = undefined;
  evictClient = undefined;
  forwardToClient = undefined;
  listClientThreads = undefined;
}

// ---------------------------------------------------------------------------
// Threading helper — posts a message, starting or continuing a thread
// ---------------------------------------------------------------------------

export async function postThreaded(opts: {
  text: string;
  blocks?: any[];
  thread_ts?: string;
}): Promise<string | undefined> {
  // Empty string = explicitly top-level (used by IPC server to create client
  // thread headers). Non-empty = post in that thread. Omitted = use active thread.
  if (opts.thread_ts === '') {
    const result = await bolt!.client.chat.postMessage({
      channel: channelId,
      text: opts.text,
      blocks: opts.blocks,
    });
    return result.ts;
  }
  if (opts.thread_ts) {
    const result = await bolt!.client.chat.postMessage({
      channel: channelId,
      text: opts.text,
      blocks: opts.blocks,
      thread_ts: opts.thread_ts,
    });
    return result.ts;
  }

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
      limit: 20,
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
// forwardInboundMessage — shared helper for all inbound message forwarding
// ---------------------------------------------------------------------------
// Used by the three bolt handler call sites below and by the recovery
// helper (recoverMissedMessages). Handles state mutations (setActiveThreadTs,
// saveSession) appropriate to each message type so each call site stays minimal.
//
// Returns the eventTs that was forwarded — useful for cursor advancement.
// ---------------------------------------------------------------------------

type InboundMessage =
  | { type: 'thread_reply'; text: string; eventTs: string; userId: string }
  | { type: 'app_mention'; text: string; eventTs: string; userId: string }
  | {
      type: 'old_thread_reply';
      text: string;
      eventTs: string;
      userId: string;
      oldThreadTs: string;
    };

async function forwardInboundMessage(
  mcp: Server,
  msg: InboundMessage,
): Promise<string> {
  switch (msg.type) {
    case 'thread_reply': {
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: msg.text,
          meta: {
            slack_user_id: msg.userId,
            channel_id: channelId,
            event_ts: msg.eventTs,
          },
        },
      });
      log('forwarded thread reply to Claude');
      return msg.eventTs;
    }

    case 'app_mention': {
      // The @mention message becomes the thread parent
      setActiveThreadTs(msg.eventTs);
      saveSession({
        threadTs: msg.eventTs,
        lastSeenEventTs: getLastSeenEventTs(),
      });
      log(`app_mention — new thread rooted at ${msg.eventTs}`);

      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: msg.text || '(new session)',
          meta: {
            slack_user_id: msg.userId,
            channel_id: channelId,
            event_ts: msg.eventTs,
          },
        },
      });
      log('forwarded app_mention to Claude');
      return msg.eventTs;
    }

    case 'old_thread_reply': {
      log(`reply in old thread ${msg.oldThreadTs} — fetching summary`);
      const summary = await fetchThreadSummary(msg.oldThreadTs);

      // Post a note in the old thread
      await bolt!.client.chat.postMessage({
        channel: channelId,
        thread_ts: msg.oldThreadTs,
        text: '\u2192 Continued in new thread',
      });

      // Reset active thread — next postThreaded call will create a new one
      setActiveThreadTs(null);
      saveSession({ threadTs: null, lastSeenEventTs: getLastSeenEventTs() });

      // Forward to Claude with old thread context
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: `[Context from previous thread]\n${summary}\n\n[New message]\n${msg.text}`,
          meta: {
            slack_user_id: msg.userId,
            channel_id: channelId,
            event_ts: msg.eventTs,
          },
        },
      });
      log('forwarded old thread reply with summary to Claude');
      return msg.eventTs;
    }
  }
}

// ---------------------------------------------------------------------------
// Bolt handlers — registered on the App instance during startSlack()
// ---------------------------------------------------------------------------

/**
 * Dedup gate — drop replayed or already-seen events.
 * Slack event_ts is zero-padded "seconds.microseconds" (e.g. "1775644620.743929"),
 * so string comparison is monotonic for timestamps in the same epoch range.
 * If Slack ever changes the format, this assumption breaks.
 */
function isDuplicate(eventTs: string): boolean {
  const lastSeen = getLastSeenEventTs();
  return lastSeen !== null && eventTs <= lastSeen;
}

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

    if (isDuplicate(eventTs)) return;

    const activeThreadTs = getActiveThreadTs();

    if (threadTs === activeThreadTs) {
      // Active thread reply — forward directly
      await forwardInboundMessage(mcp, {
        type: 'thread_reply',
        text,
        eventTs,
        userId: msg.user ?? '',
      });
    } else {
      const sessionId = findClientByThread?.(threadTs) ?? null;
      if (sessionId !== null) {
        // Client-thread reply — forward to the owning IPC client
        const envelope: IpcInboundMessage = {
          type: 'inbound_message',
          text,
          eventTs,
          userId: msg.user ?? '',
          channelId,
        };
        let delivered = false;
        try {
          delivered = forwardToClient!(sessionId, envelope);
        } catch {
          delivered = false;
        }
        if (delivered) {
          // fall through to single cursor-advancement below
        } else {
          // Client socket is dead — evict and fall back to old-thread-reply
          evictClient!(sessionId);
          await forwardInboundMessage(mcp, {
            type: 'old_thread_reply',
            text,
            eventTs,
            userId: msg.user ?? '',
            oldThreadTs: threadTs,
          });
        }
      } else {
        // Old thread reply — fetch summary, start new thread, forward with context
        await forwardInboundMessage(mcp, {
          type: 'old_thread_reply',
          text,
          eventTs,
          userId: msg.user ?? '',
          oldThreadTs: threadTs,
        });
      }
    }

    // Advance cursor only after successful forward — if forwardInboundMessage
    // throws, the cursor stays put so recovery can retry this message.
    setLastSeenEventTs(eventTs);
  });

  // App mention — starts a new thread
  bolt!.event('app_mention', async ({ event }) => {
    if (event.user !== allowedUserId) return;

    // Strip the bot mention tag (e.g. "<@U0123ABC> hello" → "hello")
    const text = stripMentions(event.text ?? '');
    const eventTs = event.ts ?? '';

    if (isDuplicate(eventTs)) return;

    await forwardInboundMessage(mcp, {
      type: 'app_mention',
      text,
      eventTs,
      userId: event.user ?? '',
    });

    // Advance cursor only after successful forward — if forwardInboundMessage
    // throws, the cursor stays put so recovery can retry this message.
    setLastSeenEventTs(eventTs);
  });

  // Permission relay — receive verdict from Allow/Deny button click
  //
  // Three-way routing:
  //   1. Client perm (in IPC routing map) → send perm_response to client socket
  //   2. Connected session's own perm (in pendingPermissions) → mcp.notification()
  //   3. Stale button (neither map) → update message with stale text
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

    // Helper to update the Slack message with outcome text
    const message = body.message as { ts?: string } | undefined;
    const msgChannelId =
      (body.container as { channel_id?: string } | undefined)?.channel_id ??
      channelId;

    const updateMessage = async (
      summaryText: string,
      preview: string,
    ): Promise<void> => {
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
    };

    // ── Path 1: Client perm (IPC routing map) ──
    const routeResult = routeVerdict(request_id, behavior);
    if (routeResult.routed) {
      const { toolName, inputPreview } = routeResult.details;
      const label = behavior === 'allow' ? 'Allowed' : 'Denied';
      const summaryText = `*${label}* — \`${toolName}\``;
      log(`verdict ${behavior} for client request ${request_id}`);
      await updateMessage(summaryText, inputPreview);
      return;
    }

    // ── Path 2: Connected session's own perm ──
    if (pendingPermissions.has(request_id)) {
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

      const label = behavior === 'allow' ? 'Allowed' : 'Denied';
      const preview = details?.input_preview ?? '';
      const summaryText = details
        ? `*${label}* — \`${details.tool_name}\``
        : `*${label}* — request \`${request_id}\``;
      await updateMessage(summaryText, preview);
      return;
    }

    // ── Path 3: Stale button (neither map) ──
    log(`stale verdict ${behavior} for unknown request ${request_id}`);
    const staleText =
      'Stale request from a previous session — ignore or approve at the terminal if still needed.';
    await updateMessage(staleText, '');
  });
}

// ---------------------------------------------------------------------------
// formatRestoredMessage — build the reconnect notification body
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

function formatRestoredMessage(
  outageMs: number,
  result: { recovered: number; error?: string },
): string {
  if (outageMs < RECOVERY_THRESHOLD) {
    return 'Slack connection restored.';
  }
  const dur = formatDuration(outageMs);
  if (result.error) {
    return `Slack connection restored after ${dur}. Recovery failed: ${result.error}. Check Slack thread manually.`;
  }
  if (result.recovered > 0) {
    return `Slack connection restored after ${dur}. Recovered ${result.recovered} missed messages — they appear above this notice.`;
  }
  return `Slack connection restored after ${dur}. No messages missed.`;
}

// ---------------------------------------------------------------------------
// Connection monitoring — logs lifecycle events and notifies Claude on outages
// ---------------------------------------------------------------------------

export const OUTAGE_THRESHOLD = 10_000; // 10s — only notify if disconnect lasts longer than this
export const RECONNECT_DEBOUNCE = 5_000; // 5s — wait for connection to stabilize after reconnect
export const RECOVERY_THRESHOLD = 60_000; // 60s — only fetch history on reconnect if outage exceeded this
export const FLAP_WINDOW = 10_000; // 10s — sliding window for detecting reconnect flapping
export const FLAP_THRESHOLD = 5; // 5 connected events within FLAP_WINDOW = stuck loop

// ---------------------------------------------------------------------------
// Recovery function seam — allows tests to stub recoverMissedMessages
// ---------------------------------------------------------------------------

type RecoveryFn = (
  mcp: Server,
  sinceTs: string | null,
) => Promise<{ recovered: number; error?: string }>;

let recoveryFn: RecoveryFn = recoverMissedMessages;

/** Override the recovery function for testing only. */
export function setRecoveryFn(fn: RecoveryFn): void {
  recoveryFn = fn;
}

/** Reset recovery function to the real implementation — exported for test cleanup. */
export function resetRecoveryFn(): void {
  recoveryFn = recoverMissedMessages;
}

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
  const connectedTimestamps: number[] = [];

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

    // Flap detection — if we see FLAP_THRESHOLD connected events within
    // FLAP_WINDOW, the finity state machine is stuck in a reconnect loop
    // (typically after sleep/wake). Notify Claude and kill the bridge so
    // the user can /mcp to recover cleanly.
    const now = Date.now();
    connectedTimestamps.push(now);
    // Trim events outside the window
    while (
      connectedTimestamps.length > 0 &&
      connectedTimestamps[0] < now - FLAP_WINDOW
    ) {
      connectedTimestamps.shift();
    }
    if (connectedTimestamps.length >= FLAP_THRESHOLD) {
      log(
        `reconnect flap detected (${connectedTimestamps.length} connects in ${FLAP_WINDOW / 1000}s) — killing bridge`,
      );
      mcp
        .notification({
          method: 'notifications/claude/channel',
          params: {
            content:
              '/mcp to recover — Slack stuck in reconnect loop (sleep/wake).',
            meta: { channel_id: cid, event_ts: '' },
          },
        })
        .catch(() => {});
      onDead();
      return;
    }

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
    reconnectNotifyTimer = setTimeout(async () => {
      reconnectNotifyTimer = null;

      // Compute outage duration
      const outageMs =
        disconnectedAt !== null ? Date.now() - disconnectedAt : 0;

      // Attempt recovery if outage exceeded the threshold
      let recoveryResult: { recovered: number; error?: string } = {
        recovered: 0,
      };
      if (outageMs >= RECOVERY_THRESHOLD) {
        recoveryResult = await recoveryFn(mcp, getLastSeenEventTs());
      }

      // Build notification body based on outcome
      const content = formatRestoredMessage(outageMs, recoveryResult);

      // Reset state before firing notification (recovery already ran above)
      disconnectedAt = null;
      notifiedDisconnect = false;

      mcp
        .notification({
          method: 'notifications/claude/channel',
          params: {
            content,
            meta: { channel_id: cid, event_ts: '' },
          },
        })
        .catch(() => {});
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
  findClientByThread?: (ts: string) => string | null;
  evictClient?: (sessionId: string) => void;
  forwardToClient?: (sessionId: string, msg: IpcInboundMessage) => boolean;
  listClientThreads?: () => Array<{ sessionId: string; threadTs: string }>;
}): Promise<App> {
  channelId = opts.channelId;
  allowedUserId = opts.allowedUserId;
  findClientByThread = opts.findClientByThread;
  evictClient = opts.evictClient;
  forwardToClient = opts.forwardToClient;
  listClientThreads = opts.listClientThreads;

  bolt = new App({
    token: opts.botToken,
    appToken: opts.appToken,
    socketMode: true,
    logLevel: 'warn' as const,
  });

  registerBoltHandlers(opts.mcp);
  await bolt.start();
  log('Bolt Socket Mode connected');

  // Capture bot user ID for use by recovery filtering.
  // Wrapped in try/catch so a failure here does not abort startup.
  try {
    const authResult = await bolt.client.auth.test();
    botUserId = authResult.user_id ?? null;
  } catch (err) {
    log(`failed to capture bot user ID: ${err}`);
  }

  cleanupMonitor = monitorConnection(opts.mcp, opts.channelId, opts.onDead);

  return bolt;
}

// ---------------------------------------------------------------------------
// recoverMissedMessages — fetch and forward messages missed during an outage
// ---------------------------------------------------------------------------
// Called on reconnect when outageMs >= RECOVERY_THRESHOLD. Fetches channel
// history (for @mentions) and active thread replies (if any) since the given
// cursor timestamp. Filters, dedupes, sorts ascending, and forwards each via
// forwardInboundMessage. Returns a count of successfully forwarded messages.
//
// This is best-effort: Slack API errors are caught and returned as { error }.
// Per-message forward failures do not abort the loop; the cursor is only
// advanced after a successful forward so the next recovery pass can retry.
//
// Cursor ordering note: Slack event_ts is zero-padded "seconds.microseconds"
// (e.g. "1775644620.743929"). String comparison is monotonic for these values
// in the same epoch range. If Slack ever changes the format, this breaks.
// ---------------------------------------------------------------------------

// Discriminated union: 'primary' = mention or active-thread reply (destined
// for the primary MCP session); 'client' = reply in a connected IPC client's
// thread (destined for that client via IPC).
type DispatchItem =
  | { kind: 'primary'; msg: any }
  | { kind: 'client'; msg: any; sessionId: string };

type FetchedSources = {
  historyMessages: any[];
  repliesMessages: any[];
  clientRepliesTagged: Array<{ msg: any; sessionId: string }>;
  apiError: string | undefined;
};

// Fetch channel history, the active-thread replies, and per-connected-client
// thread replies (in parallel). History failure is fatal — returned as
// `{ fatal }` so the caller returns early. Replies failures log and continue:
// partial recovery beats none.
async function fetchAllSources(
  oldest: string,
  activeThreadTs: string | null,
): Promise<FetchedSources | { fatal: string }> {
  if (!bolt) return { fatal: 'bolt not initialized' };

  let historyMessages: any[] = [];
  let repliesMessages: any[] = [];
  let apiError: string | undefined;

  try {
    const result = await bolt.client.conversations.history({
      channel: channelId,
      oldest,
      limit: 100,
    });
    historyMessages = result.messages ?? [];
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    log(`recoverMissedMessages: conversations.history failed: ${msg}`);
    return { fatal: msg };
  }

  if (activeThreadTs) {
    try {
      const result = await bolt.client.conversations.replies({
        channel: channelId,
        ts: activeThreadTs,
        oldest,
        limit: 100,
      });
      repliesMessages = result.messages ?? [];
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      log(`recoverMissedMessages: conversations.replies failed: ${msg}`);
      apiError = msg;
      // Continue with whatever history we got — partial recovery beats none.
    }
  }

  // Per-client-thread replies in parallel. Wrapped as { msg, sessionId } so
  // each message carries its routing origin without mutating Slack shape.
  const clientThreadEntries = listClientThreads?.() ?? [];
  const clientRepliesTagged: Array<{ msg: any; sessionId: string }> = [];
  if (clientThreadEntries.length > 0) {
    const fetches = clientThreadEntries.map(async ({ sessionId, threadTs }) => {
      try {
        const result = await bolt!.client.conversations.replies({
          channel: channelId,
          ts: threadTs,
          oldest,
          limit: 100,
        });
        const messages = result.messages ?? [];
        // Allowed user, in this thread, exclude the parent.
        const filtered = messages.filter(
          (msg: any) =>
            msg.user === allowedUserId &&
            msg.thread_ts === threadTs &&
            msg.ts !== threadTs,
        );
        for (const m of filtered) {
          clientRepliesTagged.push({ msg: m, sessionId });
        }
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        log(
          `recoverMissedMessages: conversations.replies for client thread ${threadTs} failed: ${msg}`,
        );
        // Partial recovery — continue with remaining clients.
      }
    });
    await Promise.all(fetches);
  }

  return { historyMessages, repliesMessages, clientRepliesTagged, apiError };
}

// Filter + combine + dedupe + sort fetched sources into an ordered queue.
// Sort is ascending by ts (lexicographic is monotonic for Slack's
// zero-padded "seconds.microseconds" format).
function buildDispatchQueue(
  sources: FetchedSources,
  sinceTs: string | null,
  activeThreadTs: string | null,
): DispatchItem[] {
  const { historyMessages, repliesMessages, clientRepliesTagged } = sources;

  // History: allowed user, mentioning the bot (when we know its id).
  // Precompute the needle so it isn't rebuilt per message.
  const mentionNeedle = botUserId ? `<@${botUserId}>` : null;
  const mentionFilter = mentionNeedle
    ? (msg: any) =>
        msg.user === allowedUserId && (msg.text ?? '').includes(mentionNeedle)
    : (msg: any) => msg.user === allowedUserId;
  const mentions = historyMessages.filter(mentionFilter);

  const replies = activeThreadTs
    ? repliesMessages.filter(
        (msg: any) =>
          msg.user === allowedUserId &&
          msg.thread_ts === activeThreadTs &&
          msg.ts !== activeThreadTs,
      )
    : [];

  const all: DispatchItem[] = [
    ...mentions.map((msg: any): DispatchItem => ({ kind: 'primary', msg })),
    ...replies.map((msg: any): DispatchItem => ({ kind: 'primary', msg })),
    ...clientRepliesTagged.map(
      ({ msg, sessionId }): DispatchItem => ({
        kind: 'client',
        msg,
        sessionId,
      }),
    ),
  ];

  const unseen = sinceTs
    ? all.filter((item) => (item.msg.ts ?? '') > sinceTs)
    : all;
  unseen.sort((a, b) => {
    const ta: string = a.msg.ts ?? '';
    const tb: string = b.msg.ts ?? '';
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return 0;
  });
  return unseen;
}

// Per-item outcome:
//   'delivered' — message handled; advance cursor and count it.
//   'skipped'   — intentionally ignored (e.g. bot's own echo); don't advance,
//                 don't count. Next successful non-bot message will advance
//                 past it naturally since ts is monotonic.
//   'failed'    — exception during delivery; don't advance so the next
//                 recovery pass can retry.
type DispatchResult = 'delivered' | 'skipped' | 'failed';

async function dispatchItem(
  mcp: Server,
  item: DispatchItem,
  activeThreadTs: string | null,
): Promise<DispatchResult> {
  const msg = item.msg;
  const ts: string = msg.ts ?? '';
  const text: string = msg.text ?? '';
  const userId: string = msg.user ?? '';
  const oldThreadTs: string = msg.thread_ts ?? ts;

  if (botUserId && userId === botUserId) return 'skipped';

  const sendOldThreadReply = () =>
    forwardInboundMessage(mcp, {
      type: 'old_thread_reply',
      text,
      eventTs: ts,
      userId,
      oldThreadTs,
    });

  try {
    if (item.kind === 'client') {
      const sessionId = item.sessionId;

      // Graceful degradation: if IPC callbacks aren't wired, treat the client
      // as dead and fall back to old_thread_reply on primary.
      if (!forwardToClient || !evictClient) {
        await sendOldThreadReply();
        return 'delivered';
      }

      const envelope: IpcInboundMessage = {
        type: 'inbound_message',
        text,
        eventTs: ts,
        userId,
        channelId,
      };
      let delivered = false;
      try {
        delivered = forwardToClient(sessionId, envelope);
      } catch {
        delivered = false;
      }
      if (delivered) return 'delivered';

      // Client socket is dead — evict and fall back to old_thread_reply.
      evictClient(sessionId);
      await sendOldThreadReply();
      return 'delivered';
    }

    if (activeThreadTs && msg.thread_ts === activeThreadTs) {
      await forwardInboundMessage(mcp, {
        type: 'thread_reply',
        text,
        eventTs: ts,
        userId,
      });
    } else {
      await forwardInboundMessage(mcp, {
        type: 'app_mention',
        text,
        eventTs: ts,
        userId,
      });
    }
    return 'delivered';
  } catch (err: any) {
    log(
      `recoverMissedMessages: failed to forward message ${ts}: ${err?.message ?? err}`,
    );
    return 'failed';
  }
}

export async function recoverMissedMessages(
  mcp: Server,
  sinceTs: string | null,
): Promise<{ recovered: number; error?: string }> {
  if (!bolt) return { recovered: 0 };

  // If no prior cursor, cap history lookback at 1 hour to avoid flooding.
  const oldest = sinceTs ?? String((Date.now() / 1000 - 3600).toFixed(6));
  const activeThreadTs = getActiveThreadTs();

  const sources = await fetchAllSources(oldest, activeThreadTs);
  if ('fatal' in sources) return { recovered: 0, error: sources.fatal };

  const queue = buildDispatchQueue(sources, sinceTs, activeThreadTs);

  let recoveredCount = 0;
  for (const item of queue) {
    const ts: string = item.msg.ts ?? '';
    const outcome = await dispatchItem(mcp, item, activeThreadTs);
    if (outcome === 'delivered') {
      setLastSeenEventTs(ts);
      recoveredCount++;
    }
    // 'skipped' and 'failed' deliberately leave the cursor alone.
  }

  const result: { recovered: number; error?: string } = {
    recovered: recoveredCount,
  };
  if (sources.apiError !== undefined) result.error = sources.apiError;
  return result;
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
