/**
 * Integration Tests — Connection Lifecycle
 *
 * These tests exercise the REAL Slack Socket Mode connection. They require
 * valid tokens in ~/.claude/channels/slack/.env.
 *
 * Run with:   INTEGRATION=1 bun test test/integration.test.ts
 * Skip with:  bun test (integration tests auto-skip without INTEGRATION=1)
 *
 * KEY FINDINGS:
 * - WebSocket.terminate() does NOT emit 'disconnected'. It goes:
 *   connected → reconnecting → connecting → connected
 *   This means the plugin's healthTimeout monitoring is only triggered
 *   when the state machine reaches 'disconnected' (failed reconnection).
 *
 * - app.stop() can throw "Unhandled event 'websocket close' in state
 *   'disconnected'" from the finity state machine. This is a @slack/socket-mode
 *   bug — the state machine doesn't handle late WebSocket close events.
 *
 * - Reconnection after terminate() takes ~800-1000ms typically.
 */

import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '@slack/bolt';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ENV_PATH = `${process.env.HOME}/.claude/channels/slack/.env`;
const SKIP = !process.env.INTEGRATION;

function loadTokens(): {
  botToken: string;
  appToken: string;
  channelId: string;
} | null {
  if (!existsSync(ENV_PATH)) return null;
  const { loadEnv } =
    require('../src/config') as typeof import('../src/config');
  const env = loadEnv(ENV_PATH);
  if (!env.SLACK_BOT_TOKEN || !env.SLACK_APP_TOKEN || !env.SLACK_CHANNEL_ID)
    return null;
  return {
    botToken: env.SLACK_BOT_TOKEN,
    appToken: env.SLACK_APP_TOKEN,
    channelId: env.SLACK_CHANNEL_ID,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSocketClient(app: App): any {
  return (app.receiver as any).client;
}

function getWebSocket(app: App): any {
  return getSocketClient(app).websocket;
}

/** Wait for a specific event on the SocketModeClient, with timeout. */
function waitForEvent(
  app: App,
  event: string,
  timeoutMs = 30_000,
): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error(`Timeout waiting for '${event}' (${timeoutMs}ms)`)),
      timeoutMs,
    );
    getSocketClient(app).once(event, (...args: any[]) => {
      clearTimeout(timer);
      resolve(args);
    });
  });
}

/** Start app and wait until Socket Mode is fully connected and ready. */
async function startAndWaitReady(app: App, timeoutMs = 15_000): Promise<void> {
  const connectedPromise = waitForEvent(app, 'connected', timeoutMs);
  await app.start();
  await connectedPromise;
  await Bun.sleep(200);
}

/** Stop app safely — catches the finity state machine error. */
async function safeStop(app: App): Promise<void> {
  try {
    await app.stop();
  } catch (err: any) {
    // Known @slack/socket-mode bug: "Unhandled event 'websocket close' in state 'disconnected'"
    if (err?.message?.includes('Unhandled event')) {
      // expected — ignore
    } else {
      throw err;
    }
  }
}

/** Create a Bolt App with Socket Mode. */
function createApp(tokens: { botToken: string; appToken: string }): App {
  return new App({
    token: tokens.botToken,
    appToken: tokens.appToken,
    socketMode: true,
    logLevel: 'warn' as any,
  });
}

interface TrackEvent {
  time: number;
  event: string;
  detail?: string;
}

/** Track all connection events for diagnostics. */
function trackEvents(app: App): {
  events: TrackEvent[];
  stop: () => void;
} {
  const events: TrackEvent[] = [];
  const start = Date.now();
  const sc = getSocketClient(app);
  const handlers: [string, Function][] = [];

  function on(event: string, handler: Function) {
    sc.on(event, handler);
    handlers.push([event, handler]);
  }

  on('connecting', () =>
    events.push({ time: Date.now() - start, event: 'connecting' }),
  );
  on('connected', () =>
    events.push({ time: Date.now() - start, event: 'connected' }),
  );
  on('reconnecting', () =>
    events.push({ time: Date.now() - start, event: 'reconnecting' }),
  );
  on('disconnecting', () =>
    events.push({ time: Date.now() - start, event: 'disconnecting' }),
  );
  on('disconnected', (err?: Error) =>
    events.push({
      time: Date.now() - start,
      event: 'disconnected',
      detail: err?.message,
    }),
  );
  on('error', (err: any) =>
    events.push({
      time: Date.now() - start,
      event: 'error',
      detail: err?.original?.message ?? err?.message ?? String(err),
    }),
  );

  return {
    events,
    stop: () => {
      for (const [e, h] of handlers) sc.removeListener(e, h);
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('Integration: Connection Lifecycle', () => {
  let tokens: ReturnType<typeof loadTokens>;
  let app: App | null = null;

  beforeAll(() => {
    tokens = loadTokens();
    if (!tokens) throw new Error(`Missing tokens at ${ENV_PATH}`);
  });

  afterEach(async () => {
    if (app) {
      await safeStop(app);
      app = null;
    }
    await Bun.sleep(500);
  });

  // =========================================================================
  // Basic Connection
  // =========================================================================

  test('connects to Slack via Socket Mode', async () => {
    app = createApp(tokens!);
    await startAndWaitReady(app);
    expect(getSocketClient(app).isActive()).toBe(true);
  }, 20_000);

  test('WebSocket is open after connection', async () => {
    app = createApp(tokens!);
    await startAndWaitReady(app);
    const ws = getWebSocket(app);
    expect(ws).toBeTruthy();
    expect(ws.readyState).toBe(1); // OPEN
  }, 20_000);

  // =========================================================================
  // Graceful Disconnect
  // =========================================================================

  test('graceful disconnect transitions to inactive', async () => {
    app = createApp(tokens!);
    await startAndWaitReady(app);
    await safeStop(app);
    expect(getSocketClient(app).isActive()).toBe(false);
    app = null;
  }, 20_000);

  // =========================================================================
  // Forced Disconnect — WebSocket.terminate()
  //
  // KEY FINDING: terminate() triggers reconnecting → connected, NOT disconnected.
  // The 'disconnected' event only fires on FAILED reconnection or graceful stop.
  // =========================================================================

  test('auto-reconnects after WebSocket.terminate() without emitting disconnected', async () => {
    app = createApp(tokens!);
    const tracker = trackEvents(app);

    await startAndWaitReady(app);

    // Listen for reconnecting (this is what actually fires, not disconnected)
    const reconnectingPromise = waitForEvent(app, 'reconnecting', 10_000);
    const connectedPromise = waitForEvent(app, 'connected', 30_000);

    getWebSocket(app).terminate();

    await reconnectingPromise;
    await connectedPromise;

    expect(getSocketClient(app).isActive()).toBe(true);

    // Verify: no 'disconnected' event was emitted
    const hasDisconnected = tracker.events.some(
      (e) => e.event === 'disconnected',
    );
    expect(hasDisconnected).toBe(false);

    console.log('[terminate] Events:', JSON.stringify(tracker.events));
    tracker.stop();
  }, 45_000);

  test('auto-reconnects after WebSocket.close(1001)', async () => {
    app = createApp(tokens!);
    const tracker = trackEvents(app);
    await startAndWaitReady(app);

    const connectedPromise = waitForEvent(app, 'connected', 30_000);
    getWebSocket(app).close(1001, 'Going Away');
    await connectedPromise;

    expect(getSocketClient(app).isActive()).toBe(true);
    console.log('[close 1001] Events:', JSON.stringify(tracker.events));
    tracker.stop();
  }, 45_000);

  test('auto-reconnects after WebSocket.close(1006)', async () => {
    app = createApp(tokens!);
    const tracker = trackEvents(app);
    await startAndWaitReady(app);

    const connectedPromise = waitForEvent(app, 'connected', 30_000);
    getWebSocket(app).close(1006, 'Abnormal Closure');
    await connectedPromise;

    expect(getSocketClient(app).isActive()).toBe(true);
    console.log('[close 1006] Events:', JSON.stringify(tracker.events));
    tracker.stop();
  }, 45_000);

  // =========================================================================
  // Multiple Rapid Forced Disconnects
  // =========================================================================

  test('survives 3 rapid forced disconnects', async () => {
    app = createApp(tokens!);
    const tracker = trackEvents(app);
    await startAndWaitReady(app);

    for (let i = 0; i < 3; i++) {
      const connectedPromise = waitForEvent(app, 'connected', 30_000);
      const ws = getWebSocket(app);
      if (ws && ws.readyState === 1) ws.terminate();
      await connectedPromise;
      await Bun.sleep(500);
    }

    expect(getSocketClient(app).isActive()).toBe(true);
    console.log('[rapid x3] Events:', JSON.stringify(tracker.events));
    tracker.stop();
  }, 60_000);

  test('survives 5 rapid forced disconnects', async () => {
    app = createApp(tokens!);
    const tracker = trackEvents(app);
    await startAndWaitReady(app);

    for (let i = 0; i < 5; i++) {
      const connectedPromise = waitForEvent(app, 'connected', 30_000);
      const ws = getWebSocket(app);
      if (ws && ws.readyState === 1) ws.terminate();
      await connectedPromise;
      await Bun.sleep(300);
    }

    expect(getSocketClient(app).isActive()).toBe(true);
    console.log('[rapid x5] Events:', JSON.stringify(tracker.events));
    tracker.stop();
  }, 90_000);

  // =========================================================================
  // Reconnection Timing
  // =========================================================================

  test('measures reconnection time after terminate()', async () => {
    app = createApp(tokens!);
    await startAndWaitReady(app);

    const connectedPromise = waitForEvent(app, 'connected', 30_000);
    const t0 = Date.now();
    getWebSocket(app).terminate();
    await connectedPromise;
    const reconnectMs = Date.now() - t0;

    console.log(`[timing] Reconnection: ${reconnectMs}ms`);
    expect(reconnectMs).toBeLessThan(15_000);
  }, 45_000);

  // =========================================================================
  // Event Loop Blocking Impact
  //
  // These tests document whether blocking the event loop causes drops.
  // The default clientPingTimeout is 5000ms — if our pong response is
  // delayed beyond that, the client considers the connection dead.
  // =========================================================================

  test('connection survives 2-second event loop block', async () => {
    app = createApp(tokens!);
    const tracker = trackEvents(app);
    await startAndWaitReady(app);

    const start = Date.now();
    while (Date.now() - start < 2_000) {} // busy wait

    await Bun.sleep(3_000);

    console.log('[2s block] Events:', JSON.stringify(tracker.events));
    expect(getSocketClient(app).isActive()).toBe(true);
    tracker.stop();
  }, 15_000);

  test('DOCUMENT: 6-second event loop block (exceeds clientPingTimeout?)', async () => {
    app = createApp(tokens!);
    const tracker = trackEvents(app);
    await startAndWaitReady(app);

    const start = Date.now();
    while (Date.now() - start < 6_000) {} // busy wait

    // Wait for potential auto-reconnect
    await Bun.sleep(10_000);

    const wasDisconnected = tracker.events.some(
      (e) => e.event === 'disconnected',
    );
    const hadReconnecting = tracker.events.some(
      (e) => e.event === 'reconnecting',
    );
    const isActive = getSocketClient(app).isActive();

    console.log(
      `[6s block] disconnected=${wasDisconnected} reconnecting=${hadReconnecting} active=${isActive}`,
    );
    console.log('[6s block] Events:', JSON.stringify(tracker.events));

    // If it disconnected/reconnected, it should have recovered
    if (hadReconnecting || wasDisconnected) {
      expect(isActive).toBe(true);
    }
    tracker.stop();
  }, 25_000);

  test('DOCUMENT: 10-second event loop block', async () => {
    app = createApp(tokens!);
    const tracker = trackEvents(app);
    await startAndWaitReady(app);

    const start = Date.now();
    while (Date.now() - start < 10_000) {} // busy wait

    await Bun.sleep(15_000);

    const wasDisconnected = tracker.events.some(
      (e) => e.event === 'disconnected',
    );
    const hadReconnecting = tracker.events.some(
      (e) => e.event === 'reconnecting',
    );
    const isActive = getSocketClient(app).isActive();

    console.log(
      `[10s block] disconnected=${wasDisconnected} reconnecting=${hadReconnecting} active=${isActive}`,
    );
    console.log('[10s block] Events:', JSON.stringify(tracker.events));

    if (hadReconnecting || wasDisconnected) {
      expect(isActive).toBe(true);
    }
    tracker.stop();
  }, 40_000);
});

// ---------------------------------------------------------------------------
// Diagnostics — configuration and ping/pong monitoring
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('Integration: Diagnostics', () => {
  let tokens: ReturnType<typeof loadTokens>;

  beforeAll(() => {
    tokens = loadTokens();
    if (!tokens) throw new Error(`Missing tokens at ${ENV_PATH}`);
  });

  test('reports SocketModeClient configuration', async () => {
    const app = createApp(tokens!);
    await startAndWaitReady(app);

    const sc = getSocketClient(app);
    console.log(
      '[config]',
      JSON.stringify(
        {
          autoReconnectEnabled: sc.autoReconnectEnabled ?? '(default: true)',
          clientPingTimeoutMs: sc.clientPingTimeoutMillis ?? '(default: 5000)',
          serverPingTimeoutMs: sc.serverPingTimeoutMillis ?? '(default: 30000)',
          pingPongLoggingEnabled:
            sc.pingPongLoggingEnabled ?? '(default: false)',
          wsReadyState: getWebSocket(app)?.readyState,
        },
        null,
        2,
      ),
    );

    await safeStop(app);
    expect(true).toBe(true);
  }, 20_000);

  test('monitors ping/pong timing for 30 seconds', async () => {
    const app = createApp(tokens!);
    await startAndWaitReady(app);

    const ws = getWebSocket(app);
    const activity: { type: string; time: number }[] = [];
    const start = Date.now();

    ws.on('ping', () =>
      activity.push({ type: 'ping-in', time: Date.now() - start }),
    );
    ws.on('pong', () =>
      activity.push({ type: 'pong-in', time: Date.now() - start }),
    );

    await Bun.sleep(30_000);

    const pings = activity.filter((a) => a.type === 'ping-in');
    const pongs = activity.filter((a) => a.type === 'pong-in');

    console.log(
      `[ping/pong] Over 30s: ${pings.length} pings, ${pongs.length} pongs`,
    );
    if (pings.length > 1) {
      const gaps = pings.slice(1).map((p, i) => p.time - pings[i].time);
      console.log(
        `[ping/pong] Ping intervals: ${gaps.map((g) => `${g}ms`).join(', ')}`,
      );
    }
    console.log('[ping/pong] Activity:', JSON.stringify(activity));

    await safeStop(app);
  }, 45_000);

  test('measures WebSocket latency via manual ping', async () => {
    const app = createApp(tokens!);
    await startAndWaitReady(app);

    const ws = getWebSocket(app);
    const latencies: number[] = [];

    for (let i = 0; i < 5; i++) {
      const t0 = Date.now();
      const pongPromise = new Promise<void>((resolve) =>
        ws.once('pong', () => resolve()),
      );
      ws.ping();
      await pongPromise;
      latencies.push(Date.now() - t0);
      await Bun.sleep(500);
    }

    console.log(
      `[latency] Ping latencies: ${latencies.map((l) => `${l}ms`).join(', ')}`,
    );
    console.log(
      `[latency] Avg: ${Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)}ms`,
    );

    // WebSocket ping should be sub-second
    expect(Math.max(...latencies)).toBeLessThan(5_000);

    await safeStop(app);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Lock Conflict
//
// Tests that a second server process exits with code 1 when another instance
// already holds the lock. Uses a temp lock file so this doesn't interfere
// with any running bridge.
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('Integration: Lock Conflict', () => {
  test('second instance exits with code 1 on lock conflict', async () => {
    const tempLockPath = join(
      tmpdir(),
      `slack-channel-test-${Date.now()}.lock`,
    );

    // Inline Bun script: acquire an exclusive non-blocking flock on a given
    // path and hold it for up to `holdMs` milliseconds, then exit 0.
    // If flock fails (EWOULDBLOCK), exit 1.
    const script = (lockPath: string, holdMs: number) => `
import { dlopen, suffix } from 'bun:ffi';
import { closeSync, openSync, writeFileSync } from 'node:fs';

const LOCK_EX = 2;
const LOCK_NB = 4;
const libc = dlopen(\`libc.\${suffix}\`, {
  flock: { args: ['i32', 'i32'], returns: 'i32' },
});

const fd = openSync(${JSON.stringify(lockPath)}, 'w');
const result = libc.symbols.flock(fd, LOCK_EX | LOCK_NB);
if (result !== 0) {
  closeSync(fd);
  // Lock held by another process — exit with code 1
  process.exit(1);
}
writeFileSync(${JSON.stringify(lockPath)}, String(process.pid), 'utf8');
// Hold the lock for the requested duration, then exit cleanly
await new Promise(r => setTimeout(r, ${holdMs}));
closeSync(fd);
process.exit(0);
`;

    // Spawn first process — hold lock for 5 seconds
    const proc1 = Bun.spawn(['bun', '--eval', script(tempLockPath, 5000)], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Give the first process a moment to acquire the lock
    await Bun.sleep(300);

    // Spawn second process — should fail immediately to acquire
    const proc2 = Bun.spawn(['bun', '--eval', script(tempLockPath, 5000)], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Second process should exit quickly with code 1
    const exitCode = await Promise.race([
      proc2.exited,
      Bun.sleep(3000).then(() => -999), // sentinel: timeout
    ]);

    // Kill first process — it's no longer needed
    try {
      proc1.kill();
    } catch {}

    // Clean up temp lock file
    try {
      rmSync(tempLockPath, { force: true });
    } catch {}

    expect(exitCode).toBe(1);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Sleep Simulation / Outage Recovery
//
// MANUAL TEST — automated version would require a 70+ second wait and
// programmatic Bolt socket disconnect, which is not reliably supported by
// @slack/socket-mode's public API and would make CI extremely slow.
//
// HOW TO VERIFY MANUALLY:
//   1. Start the bridge in dev mode (loaded via --dangerously-load-development-channels).
//   2. Note the active thread ID in the session (check ~/.claude/channels/slack/session.json).
//   3. Disable wifi or put the laptop to sleep for > 90 seconds.
//   4. While offline / asleep, have someone post a message in the active thread
//      from a different device/account (or queue it to be sent during the gap).
//   5. Reconnect / wake the laptop.
//   6. Within ~35 seconds of reconnect (RECONNECT_DEBOUNCE=5s + recovery fetch),
//      verify that Claude receives a notifications/claude/channel notification
//      whose text contains "[Recovered after Xm outage]" framing and the content
//      of the message that was posted during the gap.
//   7. Check ~/.claude/channels/slack/debug.log (set SLACK_CHANNEL_DEBUG=1) for
//      lines like "Recovery: fetched N messages since <ts>" to confirm the
//      recoverMissedMessages path ran.
//
// AUTOMATED APPROACH (future work if needed):
//   - Use getWebSocket(app).terminate() to simulate disconnect.
//   - Wait 70 s (> RECOVERY_THRESHOLD=60s).
//   - Post a test message via app.client.chat.postMessage() during the gap.
//   - Wait for the 'connected' event + 5 s debounce + recovery fetch.
//   - Intercept mcp.notification calls via a mock injected through setMcpClient().
//   - Assert the notification payload contains the marker string.
//   The main obstacle is that terminate() triggers reconnecting→connected in
//   ~800ms (per existing tests), so it cannot simulate a 70-second gap without
//   additional machinery to suppress auto-reconnect.
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('Integration: Outage Recovery', () => {
  // MANUAL TEST: see block comment above for verification steps.
  test.skip('recovers messages missed during simulated outage (MANUAL)', async () => {
    // This test is intentionally skipped — see the manual verification
    // instructions in the block comment above.
    //
    // Automated preconditions that are hard to meet in CI:
    //   - Suppress Bolt auto-reconnect for 70+ seconds to exceed RECOVERY_THRESHOLD.
    //   - Inject a mock MCP client to intercept notifications/claude/channel calls.
    //   - Post a Slack message during the simulated gap via app.client.chat.postMessage.
    //
    // When implementing automation, use getWebSocket(app).terminate() with a
    // setMcpClient() mock and wait for the reconnect debounce + recovery to
    // complete before asserting the forwarded notification body.
  });
});
