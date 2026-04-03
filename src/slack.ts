import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { App } from '@slack/bolt';
import { log, stripMentions } from './config.ts';
import {
  getActiveThreadTs,
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

    await mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: { request_id, behavior },
    });
    log(`verdict ${behavior} for request ${request_id}`);

    // Update the Slack message — replace buttons with outcome text
    const message = body.message as { ts?: string } | undefined;
    const msgChannelId =
      (body.container as { channel_id?: string } | undefined)?.channel_id ??
      channelId;

    if (message?.ts && msgChannelId) {
      await client.chat.update({
        channel: msgChannelId,
        ts: message.ts,
        text:
          behavior === 'allow'
            ? `Allowed \u2014 \`${request_id}\``
            : `Denied \u2014 \`${request_id}\``,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text:
                behavior === 'allow'
                  ? `*Allowed* \u2014 request \`${request_id}\``
                  : `*Denied* \u2014 request \`${request_id}\``,
            },
          },
        ],
      });
    }
  });
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

  return bolt;
}

export async function stopSlack(): Promise<void> {
  if (bolt) {
    await bolt.stop();
    bolt = null;
  }
}
