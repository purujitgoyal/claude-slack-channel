#!/usr/bin/env bun
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ENV_PATH, loadEnv, log, SOCKET_PATH } from './src/config.ts';
import { type IPCServer, setActiveServer } from './src/ipc.ts';
import { LockHeldError, releaseLock, tryAcquireLock } from './src/lock.ts';
import {
  isConnected,
  mcp,
  setActivate,
  setDeactivate,
  setMode,
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
let ipcServer: IPCServer | null = null;

/** Reset the IPC server reference — exported for test cleanup only. */
export function resetIpcServer(): void {
  ipcServer = null;
}

/**
 * Start the parent-PID watchdog. Called inside activate() after tryAcquireLock().
 * On macOS/Linux, when a parent process dies the OS reparents the child to
 * pid 1 (init/launchd). We use ppid === 1 as the orphan signal.
 */
export function startWatchdog(): void {
  watchdogInterval = setInterval(() => {
    if (getPpid() === 1) {
      shutdownGracefully('watchdog-orphan');
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

  if (!tryAcquireLock()) {
    throw new LockHeldError();
  }
  startWatchdog();

  try {
    setActiveThreadTs(null);
    saveSession({ threadTs: null, lastSeenEventTs: getLastSeenEventTs() });

    const app = await startSlack({
      mcp,
      botToken,
      appToken,
      channelId,
      allowedUserId,
      onDead: () => shutdownGracefully('slack-dead'),
    });

    setSlackBridge({
      postThreaded,
      addReaction: (ch, name, ts) =>
        app.client.reactions
          .add({ channel: ch, name, timestamp: ts })
          .then(() => {}),
      channelId,
    });

    // Start IPC server for multi-session relay
    const { IPCServer: IPCServerClass } = await import('./src/ipc.ts');
    const server = new IPCServerClass({
      socketPath: SOCKET_PATH,
      poster: postThreaded,
      messageUpdater: (channel, ts, text, blocks) =>
        app.client.chat.update({ channel, ts, text, blocks }).then(() => {}),
      reacter: (channel, emoji, ts) =>
        app.client.reactions
          .add({ channel, name: emoji, timestamp: ts })
          .then(() => {}),
      channelId,
    });
    await server.start();
    ipcServer = server;
    setActiveServer(server);

    setMode('connected');
    log(`channel activated — ${channelId}`);
  } catch (err) {
    log(`activation failed: ${err}`);
    if (ipcServer) {
      try {
        await ipcServer.close();
      } catch {}
      ipcServer = null;
      setActiveServer(null);
    }
    if (watchdogInterval) {
      clearInterval(watchdogInterval);
      watchdogInterval = null;
    }
    releaseLock();
    await stopSlack();
    throw err;
  }
}

// Inject activate/deactivate into MCP so the connect/disconnect tools can call them.
setActivate(async () => {
  log('activating');
  await activateFn();
});

setDeactivate(async () => {
  log('deactivating');
  try {
    await postThreaded({ text: 'Session disconnected.' });
  } catch {}
  if (ipcServer) {
    try {
      await ipcServer.close();
    } catch {}
    ipcServer = null;
    setActiveServer(null);
  }
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
  }
  saveSession({ threadTs: null, lastSeenEventTs: getLastSeenEventTs() });
  releaseLock();
  await stopSlack();
  setSlackBridge(null!);
  setMode('dormant');
  log('channel deactivated');
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

export function shutdownGracefully(reason?: string): void {
  log(
    `shutdownGracefully called (reason=${reason ?? 'unknown'}, ppid=${getPpid()})`,
  );
  // Idempotent: racing SIGTERM + SIGINT + stdin-close must not double-release
  if (shuttingDown) return;
  shuttingDown = true;

  // Best-effort farewell message — fire-and-forget so it doesn't block
  // the synchronous shutdown path.
  if (isConnected()) {
    postThreaded({ text: 'Session ended unexpectedly.' }).catch(() => {});
  }

  // Best-effort IPC server teardown — fire-and-forget close (broadcasts
  // shutdown, closes sockets, unlinks socket file). Don't await or let it
  // block the synchronous shutdown path.
  if (ipcServer) {
    try {
      ipcServer.close().catch(() => {});
    } catch {}
    ipcServer = null;
    setActiveServer(null);
  }

  // Clear the watchdog interval so it stops firing during/after shutdown.
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
  }

  // Safety net: if stopSlack() hangs, force-exit after 3 s.
  // .unref() prevents this timer from keeping the event loop alive on its own.
  const forceExitTimer = setTimeout(() => process.exit(1), 3000);
  forceExitTimer.unref();

  if (isConnected())
    saveSession({ threadTs: null, lastSeenEventTs: getLastSeenEventTs() });
  releaseLock();
  stopSlack().finally(() => {
    clearTimeout(forceExitTimer);
    process.exit(0);
  });
}

if (import.meta.main) {
  process.on('SIGINT', () => shutdownGracefully('SIGINT'));
  process.on('SIGTERM', () => shutdownGracefully('SIGTERM'));
  process.stdin.on('close', () => shutdownGracefully('stdin-close'));

  // ---------------------------------------------------------------------------
  // Connect MCP transport
  // ---------------------------------------------------------------------------

  await mcp.connect(new StdioServerTransport());
  log('MCP connected — waiting for channel activation');
}
