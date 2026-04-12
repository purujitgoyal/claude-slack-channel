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
// Parent-PID watchdog — detects orphaned bridge processes
//
// Testability seam: tests reassign getPpid to return 1 (orphaned).
// ---------------------------------------------------------------------------

/**
 * Returns the current parent process ID. Reassignable in tests via
 * `serverModule.getPpid = () => 1` (Bun allows live-binding writes on namespace).
 */
export let getPpid: () => number = () => process.ppid;

/** Override getPpid for testing — exported for test cleanup only. */
export function setGetPpid(fn: () => number): void {
  getPpid = fn;
}

/** Reset the watchdog interval handle — exported for test cleanup only. */
export function resetWatchdog(): void {
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
  }
  getPpid = () => process.ppid;
}

let watchdogInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start the parent-PID watchdog. Called inside activate() after acquireLock().
 * On macOS/Linux, when a parent process dies the OS reparents the child to
 * pid 1 (init/launchd). We use ppid === 1 as the orphan signal.
 */
export function startWatchdog(): void {
  watchdogInterval = setInterval(() => {
    if (getPpid() === 1) {
      shutdownGracefully();
    }
  }, 5000);
  watchdogInterval.unref();
}

// ---------------------------------------------------------------------------
// Lazy activation — only when client negotiates claude/channel support
// ---------------------------------------------------------------------------

/**
 * The activate implementation. Exported as a let so tests can replace it via
 * setActivateFn() — mirrors the getPpid / setGetPpid testability seam.
 */
export let activateFn: () => Promise<void> = activate;

/** Override the activate function for testing only. */
export function setActivateFn(fn: () => Promise<void>): void {
  activateFn = fn;
}

/** Reset activateFn to the real implementation — exported for test cleanup. */
export function resetActivateFn(): void {
  activateFn = activate;
}

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
  startWatchdog();

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

/**
 * Exported so tests can invoke the oninitialized logic directly without going
 * through the MCP transport. The body is extracted here and assigned to
 * mcp.oninitialized below — this is the smallest refactor that enables
 * unit-testing the activation gate and exit-on-failure behaviour.
 */
export function handleInitialized(): void {
  log('activating');
  activateFn().catch((err) => {
    log(`activation failed: ${err}`);
    process.exit(1);
  });
}

mcp.oninitialized = handleInitialized;

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

export function shutdownGracefully(): void {
  // Idempotent: racing SIGTERM + SIGINT + stdin-close must not double-release
  if (shuttingDown) return;
  shuttingDown = true;

  // Clear the watchdog interval so it stops firing during/after shutdown.
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
  }

  // Safety net: if stopSlack() hangs, force-exit after 3 s.
  // .unref() prevents this timer from keeping the event loop alive on its own.
  const forceExitTimer = setTimeout(() => process.exit(1), 3000);
  forceExitTimer.unref();

  if (isChannelActive())
    saveSession({ threadTs: null, lastSeenEventTs: getLastSeenEventTs() });
  releaseLock();
  stopSlack().finally(() => {
    clearTimeout(forceExitTimer);
    process.exit(0);
  });
}

if (import.meta.main) {
  process.on('SIGINT', shutdownGracefully);
  process.on('SIGTERM', shutdownGracefully);
  process.stdin.on('close', shutdownGracefully);

  // ---------------------------------------------------------------------------
  // Connect MCP transport
  // ---------------------------------------------------------------------------

  await mcp.connect(new StdioServerTransport());
  log('MCP connected — waiting for channel activation');
}
