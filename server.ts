#!/usr/bin/env bun
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ENV_PATH, loadEnv, log } from './src/config.ts';
import { acquireLock, releaseLock } from './src/lock.ts';
import {
  isChannelActive,
  mcp,
  setChannelActive,
  setSlackBridge,
} from './src/mcp.ts';
import {
  getLastSeenEventTs,
  saveSession,
  setActiveThreadTs,
} from './src/session.ts';
import { postThreaded, startSlack, stopSlack } from './src/slack.ts';

// ---------------------------------------------------------------------------
// Shutdown guard — prevents reentry from racing SIGTERM, SIGINT, stdin-close
// ---------------------------------------------------------------------------

let shuttingDown = false;

/** Reset the shuttingDown flag — exported for test cleanup only. */
export function resetShuttingDown(): void {
  shuttingDown = false;
}

// ---------------------------------------------------------------------------
// Lazy activation — only when client negotiates claude/channel support
// ---------------------------------------------------------------------------

async function activate(): Promise<void> {
  const env = loadEnv(ENV_PATH);
  const botToken = env.SLACK_BOT_TOKEN ?? '';
  const appToken = env.SLACK_APP_TOKEN ?? '';
  const allowedUserId = env.ALLOWED_SLACK_USER_ID ?? '';
  const channelId = env.SLACK_CHANNEL_ID ?? '';

  if (!botToken || !appToken || !allowedUserId || !channelId) {
    throw new Error(
      'SLACK_BOT_TOKEN, SLACK_APP_TOKEN, ALLOWED_SLACK_USER_ID, and SLACK_CHANNEL_ID must all be set in ' +
        ENV_PATH,
    );
  }

  acquireLock();

  setActiveThreadTs(null);
  saveSession({ threadTs: null, lastSeenEventTs: getLastSeenEventTs() });

  const app = await startSlack({
    mcp,
    botToken,
    appToken,
    channelId,
    allowedUserId,
    onDead: shutdownGracefully,
  });

  setSlackBridge({
    postThreaded,
    addReaction: (ch, name, ts) =>
      app.client.reactions
        .add({ channel: ch, name, timestamp: ts })
        .then(() => {}),
    channelId,
  });

  setChannelActive(true);
  await mcp.sendToolListChanged();
  log(`channel activated — ${channelId}`);
}

mcp.oninitialized = () => {
  const caps = mcp.getClientCapabilities();
  const hasChannel = caps?.experimental?.['claude/channel'] != null;
  const envActivate = process.env.SLACK_CHANNEL_ACTIVATE === '1';
  if (!hasChannel && !envActivate) {
    log('channel not requested — staying dormant');
    return;
  }
  log(`activating (channel=${hasChannel}, env=${envActivate})`);
  activate().catch((err) => {
    log(`activation failed: ${err}`);
  });
};

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

export function shutdownGracefully(): void {
  // Idempotent: racing SIGTERM + SIGINT + stdin-close must not double-release
  if (shuttingDown) return;
  shuttingDown = true;

  // Safety net: if stopSlack() hangs, force-exit after 3 s.
  // .unref() prevents this timer from keeping the event loop alive on its own.
  const forceExitTimer = setTimeout(() => process.exit(1), 3000);
  forceExitTimer.unref();

  if (isChannelActive())
    saveSession({ threadTs: null, lastSeenEventTs: getLastSeenEventTs() });
  releaseLock();
  stopSlack().finally(() => process.exit(0));
}

if (import.meta.main) {
  process.on('SIGINT', shutdownGracefully);
  process.on('SIGTERM', shutdownGracefully);
  process.stdin.on('close', shutdownGracefully);
}

// ---------------------------------------------------------------------------
// Connect MCP transport
// ---------------------------------------------------------------------------

if (import.meta.main) {
  await mcp.connect(new StdioServerTransport());
  log('MCP connected — waiting for channel activation');
}
