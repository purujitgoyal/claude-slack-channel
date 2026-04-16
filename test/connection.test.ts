/**
 * Connection Monitoring Tests
 *
 * Tests the Socket Mode connection lifecycle — disconnect detection,
 * reconnection, and graceful shutdown. This is the most critical
 * test file because connection instability is the primary reliability issue.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  FakeTimers,
  FLAP_THRESHOLD,
  OUTAGE_THRESHOLD,
  RECONNECT_DEBOUNCE,
  TEST_ALLOWED_USER,
  TEST_APP_TOKEN,
  TEST_BOT_TOKEN,
  TEST_CHANNEL_ID,
} from './helpers';

// ---------------------------------------------------------------------------
// Mock ../src/lock — must be before any import that loads it (bun:ffi/dlopen)
// ---------------------------------------------------------------------------

const releaseLockMock = mock(() => {});
const acquireLockMock = mock(() => {});
const tryAcquireLockMock = mock(() => true);

class MockLockHeldError extends Error {
  constructor(message?: string) {
    super(message ?? 'Lock is held by another instance');
    this.name = 'LockHeldError';
  }
}

mock.module('../src/lock', () => ({
  acquireLock: acquireLockMock,
  releaseLock: releaseLockMock,
  tryAcquireLock: tryAcquireLockMock,
  LockHeldError: MockLockHeldError,
}));

// ---------------------------------------------------------------------------
// Mock @slack/bolt — must be before any import that transitively loads it
// ---------------------------------------------------------------------------

const apps: any[] = [];

mock.module('@slack/bolt', () => {
  const { EventEmitter } = require('node:events');
  return {
    App: class MockApp {
      socketClient = new EventEmitter();
      receiver: any;
      client = {
        chat: {
          postMessage: mock(async () => ({ ok: true, ts: '1000.0001' })),
          update: mock(async () => ({ ok: true })),
        },
        conversations: {
          replies: mock(async () => ({ ok: true, messages: [] })),
        },
        auth: {
          test: mock(async () => ({ ok: true, user_id: 'U_TEST_MOCK' })),
        },
        reactions: { add: mock(async () => ({ ok: true })) },
      };
      _messageHandlers: any[] = [];
      _eventHandlers = new Map<string, any[]>();
      _actionHandlers: any[] = [];

      constructor() {
        this.receiver = { client: this.socketClient };
        apps.push(this);
      }
      message(h: any) {
        this._messageHandlers.push(h);
      }
      event(n: string, h: any) {
        if (!this._eventHandlers.has(n)) this._eventHandlers.set(n, []);
        this._eventHandlers.get(n)!.push(h);
      }
      action(p: any, h: any) {
        this._actionHandlers.push([p, h]);
      }
      start = mock(async () => {});
      stop = mock(async () => {});
    },
  };
});

// ---------------------------------------------------------------------------
// Import modules under test (uses mocked @slack/bolt)
// ---------------------------------------------------------------------------

const { startSlack, stopSlack, setRecoveryFn, resetRecoveryFn } = await import(
  '../src/slack'
);
const {
  shutdownGracefully,
  resetShuttingDown,
  startWatchdog,
  setGetPpid,
  resetWatchdog,
} = await import('../server');
const { mcp, setMode, getMode, setActivate } = await import('../src/mcp');
const { LockHeldError } = await import('../src/lock');
const { setLastSeenEventTs } = await import('../src/session');

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Connection Monitoring', () => {
  let app: any;
  let mcpMock: { notification: ReturnType<typeof mock> };
  let onDead: ReturnType<typeof mock>;
  const timers = new FakeTimers();

  beforeEach(async () => {
    apps.length = 0;
    timers.install();

    mcpMock = { notification: mock(async () => {}) };
    onDead = mock(() => {});

    await startSlack({
      mcp: mcpMock as any,
      botToken: TEST_BOT_TOKEN,
      appToken: TEST_APP_TOKEN,
      channelId: TEST_CHANNEL_ID,
      allowedUserId: TEST_ALLOWED_USER,
      onDead,
    });

    app = apps[apps.length - 1];

    // Simulate the initial connection that Bolt triggers on start().
    // This flips the internal `connected` flag so subsequent connected
    // events (reconnections) send notifications as expected.
    app.socketClient.emit('connected');

    mcpMock.notification.mockClear();
  });

  afterEach(async () => {
    timers.uninstall();
    await stopSlack();
  });

  // =========================================================================
  // Event Listener Registration
  // =========================================================================

  describe('event listener registration', () => {
    test('attaches listeners for all 5 lifecycle events', () => {
      const sc = app.socketClient;
      expect(sc.listenerCount('disconnected')).toBe(1);
      expect(sc.listenerCount('connected')).toBe(1);
      expect(sc.listenerCount('reconnecting')).toBe(1);
      expect(sc.listenerCount('error')).toBe(1);
      expect(sc.listenerCount('unable_to_socket_mode_start')).toBe(1);
    });
  });

  // =========================================================================
  // Disconnected Event
  // =========================================================================

  describe('disconnected event', () => {
    test('sends disconnect notification after OUTAGE_THRESHOLD', async () => {
      app.socketClient.emit('disconnected');
      // Not sent immediately — delayed by OUTAGE_THRESHOLD
      expect(mcpMock.notification).not.toHaveBeenCalled();

      await timers.tick(OUTAGE_THRESHOLD);
      expect(mcpMock.notification).toHaveBeenCalled();
      const call = mcpMock.notification.mock.calls[0][0];
      expect(call.method).toBe('notifications/claude/channel');
      expect(call.params.content).toContain('connection lost');
    });

    test('includes channel_id in notification metadata', async () => {
      app.socketClient.emit('disconnected');
      await timers.tick(OUTAGE_THRESHOLD);
      const meta = mcpMock.notification.mock.calls[0][0].params.meta;
      expect(meta.channel_id).toBe(TEST_CHANNEL_ID);
    });

    test('does NOT call onDead immediately', () => {
      app.socketClient.emit('disconnected');
      expect(onDead).not.toHaveBeenCalled();
    });

    test('swallows MCP notification errors', async () => {
      mcpMock.notification.mockRejectedValue(new Error('transport dead'));
      app.socketClient.emit('disconnected');
      await timers.tick(OUTAGE_THRESHOLD);
      expect(onDead).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Connected Event
  // =========================================================================

  describe('connected event', () => {
    test('clears disconnect notify timer on reconnect', () => {
      app.socketClient.emit('disconnected');
      expect(timers.pending).toBe(1);
      app.socketClient.emit('connected');
      expect(timers.pending).toBe(0);
    });

    test('sends reconnect notification only after notified disconnect + debounce', async () => {
      // Disconnect and wait for the outage notification to fire
      app.socketClient.emit('disconnected');
      await timers.tick(OUTAGE_THRESHOLD);
      expect(mcpMock.notification).toHaveBeenCalledTimes(1); // disconnect notification
      mcpMock.notification.mockClear();

      // Reconnect — notification is debounced
      app.socketClient.emit('connected');
      expect(mcpMock.notification).not.toHaveBeenCalled();

      await timers.tick(RECONNECT_DEBOUNCE);
      expect(mcpMock.notification).toHaveBeenCalledTimes(1);
      const call = mcpMock.notification.mock.calls[0][0];
      expect(call.method).toBe('notifications/claude/channel');
      expect(call.params.content).toContain('restored');
    });

    test('does not send reconnect notification if disconnect was brief', () => {
      // Quick disconnect + reconnect within OUTAGE_THRESHOLD — no notifications at all
      app.socketClient.emit('disconnected');
      app.socketClient.emit('connected');
      expect(mcpMock.notification).not.toHaveBeenCalled();
    });

    test('is safe without prior disconnect (no timeout to clear)', () => {
      expect(() => app.socketClient.emit('connected')).not.toThrow();
      expect(timers.pending).toBe(0);
    });

    test('multiple connected events below FLAP_THRESHOLD are harmless', () => {
      // 3 events is below FLAP_THRESHOLD (5) — no flap detection
      app.socketClient.emit('connected');
      app.socketClient.emit('connected');
      app.socketClient.emit('connected');
      expect(timers.pending).toBe(0);
      expect(onDead).not.toHaveBeenCalled();
    });

    test('FLAP_THRESHOLD connected events within window calls onDead', () => {
      // beforeEach already emitted 1 connected event (initial connection),
      // so we need FLAP_THRESHOLD - 1 more to trigger the flap detector
      for (let i = 0; i < FLAP_THRESHOLD - 1; i++) {
        app.socketClient.emit('connected');
      }
      expect(onDead).toHaveBeenCalledTimes(1);
      // Notification sent before onDead
      expect(mcpMock.notification).toHaveBeenCalledTimes(1);
      const call = mcpMock.notification.mock.calls[0][0];
      expect(call.params.content).toContain('/mcp to recover');
    });

    test('flap detection does not fire when events are spread across windows', () => {
      const origDateNow = Date.now;
      let now = Date.now() + 60_000; // well after any prior events
      Date.now = () => now;

      // Emit FLAP_THRESHOLD - 2 events (+ 1 from beforeEach = FLAP_THRESHOLD - 1, just under)
      for (let i = 0; i < FLAP_THRESHOLD - 2; i++) {
        app.socketClient.emit('connected');
        now += 500;
      }
      expect(onDead).not.toHaveBeenCalled();

      // Advance time past the flap window so old events expire
      now += 15_000;

      // Emit again — should not trigger because old events fell out of window
      app.socketClient.emit('connected');
      expect(onDead).not.toHaveBeenCalled();

      Date.now = origDateNow;
    });

    test('flap notification error does not prevent onDead', () => {
      mcpMock.notification.mockRejectedValue(new Error('transport dead'));
      for (let i = 0; i < FLAP_THRESHOLD - 1; i++) {
        app.socketClient.emit('connected');
      }
      // onDead still called even though notification failed
      expect(onDead).toHaveBeenCalledTimes(1);
    });

    test('swallows MCP notification errors', async () => {
      // Need a notified disconnect first for reconnect to attempt notification
      app.socketClient.emit('disconnected');
      await timers.tick(OUTAGE_THRESHOLD);
      mcpMock.notification.mockRejectedValue(new Error('transport dead'));
      expect(() => app.socketClient.emit('connected')).not.toThrow();
    });
  });

  // =========================================================================
  // Reconnecting Event
  // =========================================================================

  describe('reconnecting event', () => {
    test('does not affect pending timers', () => {
      app.socketClient.emit('disconnected');
      expect(timers.pending).toBe(1);
      app.socketClient.emit('reconnecting');
      expect(timers.pending).toBe(1);
    });

    test('does not call onDead', () => {
      app.socketClient.emit('reconnecting');
      expect(onDead).not.toHaveBeenCalled();
    });

    test('does not send MCP notification', () => {
      app.socketClient.emit('reconnecting');
      expect(mcpMock.notification).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Error Event
  // =========================================================================

  describe('error event', () => {
    test('does NOT call onDead', () => {
      app.socketClient.emit('error', new Error('socket error'));
      expect(onDead).not.toHaveBeenCalled();
    });

    test('does not affect pending timers', () => {
      app.socketClient.emit('disconnected');
      expect(timers.pending).toBe(1);
      app.socketClient.emit('error', new Error('transient'));
      expect(timers.pending).toBe(1);
    });

    test('does not send MCP notification', () => {
      app.socketClient.emit('error', new Error('test'));
      expect(mcpMock.notification).not.toHaveBeenCalled();
    });

    test('does not throw', () => {
      expect(() =>
        app.socketClient.emit('error', new Error('kaboom')),
      ).not.toThrow();
    });
  });

  // =========================================================================
  // unable_to_socket_mode_start
  // =========================================================================

  describe('unable_to_socket_mode_start event', () => {
    test('calls onDead immediately', () => {
      app.socketClient.emit('unable_to_socket_mode_start');
      expect(onDead).toHaveBeenCalledTimes(1);
    });

    test('does not set any new timeout', () => {
      app.socketClient.emit('unable_to_socket_mode_start');
      expect(timers.pending).toBe(0);
    });
  });

  // =========================================================================
  // Disconnect → Reconnect Cycle (Happy Path)
  // =========================================================================

  describe('disconnect → reconnect cycle', () => {
    test('sends both notifications in correct order when disconnect exceeds threshold', async () => {
      app.socketClient.emit('disconnected');
      // Wait for disconnect notification to fire
      await timers.tick(OUTAGE_THRESHOLD);
      expect(mcpMock.notification).toHaveBeenCalledTimes(1);
      expect(mcpMock.notification.mock.calls[0][0].params.content).toContain(
        'connection lost',
      );

      app.socketClient.emit('connected');
      // Wait for reconnect debounce
      await timers.tick(RECONNECT_DEBOUNCE);
      expect(mcpMock.notification).toHaveBeenCalledTimes(2);
      expect(mcpMock.notification.mock.calls[1][0].params.content).toContain(
        'restored',
      );
    });

    test('brief disconnect-reconnect sends no notifications', () => {
      // Reconnect within OUTAGE_THRESHOLD — no notification sent
      app.socketClient.emit('disconnected');
      app.socketClient.emit('connected');
      expect(mcpMock.notification).not.toHaveBeenCalled();
    });

    test('repeated clean cycles do not accumulate timers', async () => {
      for (let i = 0; i < 5; i++) {
        app.socketClient.emit('disconnected');
        await timers.tick(OUTAGE_THRESHOLD + 1); // let disconnect notification fire
        app.socketClient.emit('connected');
        await timers.tick(RECONNECT_DEBOUNCE); // let reconnect notification fire
      }
      expect(timers.pending).toBe(0);
    });
  });

  // =========================================================================
  // Graceful Shutdown — stopSlack clears pending timers
  // =========================================================================

  describe('graceful shutdown', () => {
    test('stopSlack clears all pending timers', async () => {
      app.socketClient.emit('disconnected');
      expect(timers.pending).toBe(1); // disconnectNotifyTimer

      await stopSlack();

      expect(timers.pending).toBe(0);
      expect(onDead).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Rapid Disconnects — No Leaked Timers
  // =========================================================================

  describe('rapid disconnects — no leaked timers', () => {
    /*
     * Rapid disconnect events must not leak timers because the handler
     * clears the disconnectNotifyTimer before creating a new one.
     */

    test('second disconnect keeps only one pending timer', () => {
      app.socketClient.emit('disconnected');
      expect(timers.pending).toBe(1); // disconnectNotifyTimer
      app.socketClient.emit('disconnected');
      expect(timers.pending).toBe(1); // same single timer
    });

    test('reconnect after rapid disconnects clears all timers', async () => {
      app.socketClient.emit('disconnected');
      app.socketClient.emit('disconnected');
      app.socketClient.emit('connected');

      expect(timers.pending).toBe(0);
      expect(onDead).not.toHaveBeenCalled();
    });

    test('rapid disconnect flurry still results in only one timer', () => {
      app.socketClient.emit('disconnected');
      app.socketClient.emit('disconnected');
      app.socketClient.emit('disconnected');

      expect(timers.pending).toBe(1); // disconnectNotifyTimer only
    });

    test('reconnect after flurry clears all timers', async () => {
      app.socketClient.emit('disconnected');
      app.socketClient.emit('disconnected');
      app.socketClient.emit('disconnected');
      app.socketClient.emit('connected');

      expect(timers.pending).toBe(0);
      expect(onDead).not.toHaveBeenCalled();
    });

    test('disconnect burst → reconnect → disconnect still tracks timer correctly', async () => {
      app.socketClient.emit('disconnected');
      app.socketClient.emit('disconnected');
      app.socketClient.emit('connected');
      expect(timers.pending).toBe(0);

      app.socketClient.emit('disconnected');
      expect(timers.pending).toBe(1); // disconnectNotifyTimer
    });
  });

  // =========================================================================
  // Complex / Edge-Case Scenarios (existing)
  // =========================================================================

  describe('complex scenarios', () => {
    test('error during disconnect phase does not interfere with timers', () => {
      app.socketClient.emit('disconnected');
      app.socketClient.emit('error', new Error('transient'));
      expect(timers.pending).toBe(1); // disconnectNotifyTimer only
    });

    test('reconnecting event does NOT clear timers', () => {
      app.socketClient.emit('disconnected');
      app.socketClient.emit('reconnecting');
      expect(timers.pending).toBe(1); // disconnectNotifyTimer only
    });

    test('disconnect → reconnect → disconnect resets timer correctly', async () => {
      app.socketClient.emit('disconnected');
      app.socketClient.emit('connected');
      expect(timers.pending).toBe(0);

      app.socketClient.emit('disconnected');
      expect(timers.pending).toBe(1); // new disconnectNotifyTimer
    });

    test('unable_to_socket_mode_start during active disconnect timer', () => {
      app.socketClient.emit('disconnected');
      expect(timers.pending).toBe(1); // disconnectNotifyTimer
      app.socketClient.emit('unable_to_socket_mode_start');
      // onDead called immediately by unable_to_socket_mode_start
      expect(onDead).toHaveBeenCalledTimes(1);
      // Note: timers are NOT cleared — they would fire later too
      // This is a secondary concern (process exits on first onDead anyway)
      expect(timers.pending).toBe(1);
    });

    test('connected after unable_to_socket_mode_start', () => {
      app.socketClient.emit('unable_to_socket_mode_start');
      expect(onDead).toHaveBeenCalledTimes(1);
      // Hypothetical late connected event — should be harmless
      app.socketClient.emit('connected');
      expect(onDead).toHaveBeenCalledTimes(1); // no additional call
    });

    test('alternating disconnect/error/reconnect sequence clears all timers', () => {
      app.socketClient.emit('disconnected');
      app.socketClient.emit('error', new Error('e1'));
      app.socketClient.emit('reconnecting');
      app.socketClient.emit('error', new Error('e2'));
      app.socketClient.emit('connected');

      expect(timers.pending).toBe(0);
      expect(onDead).not.toHaveBeenCalled();
    });

    test('notifications include correct channel_id throughout', () => {
      app.socketClient.emit('disconnected');
      app.socketClient.emit('connected');

      for (const call of mcpMock.notification.mock.calls) {
        expect(call[0].params.meta.channel_id).toBe(TEST_CHANNEL_ID);
      }
    });
  });

  // =========================================================================
  // Reconnect Recovery — outage recovery integration
  // =========================================================================

  describe('reconnect recovery', () => {
    let origDateNow: () => number;

    beforeEach(() => {
      origDateNow = Date.now;
      resetRecoveryFn();
    });

    afterEach(() => {
      Date.now = origDateNow;
      resetRecoveryFn();
    });

    test('outage < RECOVERY_THRESHOLD does not call recoverMissedMessages', async () => {
      const recoverySpy = mock(async () => ({ recovered: 0 }));
      setRecoveryFn(recoverySpy);

      // T0: disconnect
      let now = 1_000_000;
      Date.now = () => now;
      app.socketClient.emit('disconnected');

      // Advance OUTAGE_THRESHOLD to fire the "lost" notification
      now += OUTAGE_THRESHOLD;
      await timers.tick(OUTAGE_THRESHOLD);
      mcpMock.notification.mockClear();

      // T0+30s: reconnect (below RECOVERY_THRESHOLD of 60s)
      now += 30_000;
      app.socketClient.emit('connected');

      // Advance through the 5s reconnect debounce
      now += RECONNECT_DEBOUNCE;
      await timers.tick(RECONNECT_DEBOUNCE);

      expect(recoverySpy).not.toHaveBeenCalled();
    });

    test('outage ≥ RECOVERY_THRESHOLD calls recoverMissedMessages with current cursor', async () => {
      const recoverySpy = mock(async () => ({ recovered: 0 }));
      setRecoveryFn(recoverySpy);

      // Set a known cursor
      setLastSeenEventTs('1775644620.000001');

      // T0: disconnect
      let now = 1_000_000;
      Date.now = () => now;
      app.socketClient.emit('disconnected');

      // Fire the "lost" notification
      now += OUTAGE_THRESHOLD;
      await timers.tick(OUTAGE_THRESHOLD);
      mcpMock.notification.mockClear();

      // T0+90s: reconnect (above RECOVERY_THRESHOLD of 60s)
      now += 90_000;
      app.socketClient.emit('connected');

      // Advance through the debounce
      now += RECONNECT_DEBOUNCE;
      await timers.tick(RECONNECT_DEBOUNCE);

      expect(recoverySpy).toHaveBeenCalledTimes(1);
      expect(recoverySpy.mock.calls[0][1]).toBe('1775644620.000001');
    });

    test('restored notification: short outage, only terse message', async () => {
      setRecoveryFn(mock(async () => ({ recovered: 0 })));

      // Short outage: fire the "lost" notification, then reconnect before RECOVERY_THRESHOLD
      let now = 1_000_000;
      Date.now = () => now;
      app.socketClient.emit('disconnected');

      now += OUTAGE_THRESHOLD;
      await timers.tick(OUTAGE_THRESHOLD); // "lost" notification fires, notifiedDisconnect = true
      mcpMock.notification.mockClear();

      // Reconnect 30s after disconnect (10s + 20s since disconnect started)
      now += 20_000; // total 30s from T0
      app.socketClient.emit('connected');

      now += RECONNECT_DEBOUNCE;
      await timers.tick(RECONNECT_DEBOUNCE);

      expect(mcpMock.notification).toHaveBeenCalledTimes(1);
      const content = mcpMock.notification.mock.calls[0][0].params.content;
      expect(content).toBe('Slack connection restored.');
    });

    test('restored notification: long outage, no missed messages', async () => {
      setRecoveryFn(mock(async () => ({ recovered: 0 })));

      let now = 1_000_000;
      Date.now = () => now;
      app.socketClient.emit('disconnected');

      now += OUTAGE_THRESHOLD;
      await timers.tick(OUTAGE_THRESHOLD);
      mcpMock.notification.mockClear();

      // Reconnect 90s after disconnect
      now += 80_000; // total 90s from T0
      app.socketClient.emit('connected');

      now += RECONNECT_DEBOUNCE;
      await timers.tick(RECONNECT_DEBOUNCE);

      expect(mcpMock.notification).toHaveBeenCalledTimes(1);
      const content = mcpMock.notification.mock.calls[0][0].params.content;
      expect(content).toContain('Slack connection restored after');
      expect(content).toContain('m');
      expect(content).toContain('No messages missed.');
    });

    test('restored notification: long outage, N recovered', async () => {
      setRecoveryFn(mock(async () => ({ recovered: 3 })));

      let now = 1_000_000;
      Date.now = () => now;
      app.socketClient.emit('disconnected');

      now += OUTAGE_THRESHOLD;
      await timers.tick(OUTAGE_THRESHOLD);
      mcpMock.notification.mockClear();

      now += 80_000; // total 90s
      app.socketClient.emit('connected');

      now += RECONNECT_DEBOUNCE;
      await timers.tick(RECONNECT_DEBOUNCE);

      expect(mcpMock.notification).toHaveBeenCalledTimes(1);
      const content = mcpMock.notification.mock.calls[0][0].params.content;
      expect(content).toContain('Recovered 3 missed messages');
    });

    test('restored notification: recovery failed', async () => {
      setRecoveryFn(
        mock(async () => ({ recovered: 0, error: 'rate_limited' })),
      );

      let now = 1_000_000;
      Date.now = () => now;
      app.socketClient.emit('disconnected');

      now += OUTAGE_THRESHOLD;
      await timers.tick(OUTAGE_THRESHOLD);
      mcpMock.notification.mockClear();

      now += 80_000; // total 90s
      app.socketClient.emit('connected');

      now += RECONNECT_DEBOUNCE;
      await timers.tick(RECONNECT_DEBOUNCE);

      expect(mcpMock.notification).toHaveBeenCalledTimes(1);
      const content = mcpMock.notification.mock.calls[0][0].params.content;
      expect(content).toContain('Recovery failed: rate_limited');
    });
  });
});

// ---------------------------------------------------------------------------
// shutdownGracefully — idempotency and force-exit safety net
// ---------------------------------------------------------------------------

describe('shutdownGracefully', () => {
  let origExit: typeof process.exit;
  const exitMock = mock((_code?: number) => {});
  const timers = new FakeTimers();

  beforeEach(async () => {
    // Reset the module-level shuttingDown guard before each test
    resetShuttingDown();
    // Stub process.exit so tests do not actually exit the runner
    origExit = process.exit;
    (process as any).exit = exitMock;
    exitMock.mockClear();
    releaseLockMock.mockClear();
    // Install fake timers so we can control setTimeout
    timers.install();
    // Ensure a bolt instance exists so stopSlack() has something to call
    apps.length = 0;
    await startSlack({
      mcp: { notification: mock(async () => {}) } as any,
      botToken: TEST_BOT_TOKEN,
      appToken: TEST_APP_TOKEN,
      channelId: TEST_CHANNEL_ID,
      allowedUserId: TEST_ALLOWED_USER,
      onDead: mock(() => {}),
    });
  });

  afterEach(async () => {
    timers.uninstall();
    (process as any).exit = origExit;
    // Reset bolt.stop to a fast mock so stopSlack() can complete during cleanup
    // (some tests leave bolt.stop mocked to hang — undo that here)
    const currentApp = apps[apps.length - 1];
    if (currentApp) {
      currentApp.stop.mockImplementation(async () => {});
    }
    // Tear down bolt state. stopSlack may already have been called, so we
    // catch and ignore errors here.
    try {
      await stopSlack();
    } catch {
      // ignore — bolt may already be stopped
    }
  });

  test('shutdownGracefully is idempotent', async () => {
    // Make bolt.stop resolve immediately so stopSlack settles
    const currentApp = apps[apps.length - 1];
    currentApp.stop.mockImplementation(async () => {});

    // Call twice synchronously — second call must be a no-op
    shutdownGracefully();
    shutdownGracefully();

    // Let any immediately-queued microtasks settle
    await Promise.resolve();

    // releaseLock must be called exactly once despite two shutdownGracefully calls
    expect(releaseLockMock).toHaveBeenCalledTimes(1);
    // bolt.stop called exactly once (via stopSlack)
    expect(currentApp.stop).toHaveBeenCalledTimes(1);
  });

  test('force-exit timer fires when stopSlack hangs', async () => {
    // Make bolt.stop return a forever-pending promise to simulate a hung stop
    const currentApp = apps[apps.length - 1];
    currentApp.stop.mockImplementation(() => new Promise<void>(() => {}));

    shutdownGracefully();

    // Before 3 s — process.exit must not have been called yet
    await timers.tick(2900);
    expect(exitMock).not.toHaveBeenCalled();

    // After 3 s — force-exit timer must have fired with exit code 1
    await timers.tick(200); // total 3100ms > 3000ms
    expect(exitMock).toHaveBeenCalledWith(1);
  });

  test("force-exit timer is unref'd", () => {
    // Wrap the fake setTimeout to spy on .unref() of the returned handle.
    // FakeTimers installs its own fake, so we wrap that here.
    const fakeST = globalThis.setTimeout;
    let capturedHandle: any = null;
    (globalThis as any).setTimeout = (
      cb: (...a: unknown[]) => unknown,
      delay: number,
      ...args: unknown[]
    ) => {
      const handle = (fakeST as any)(cb, delay, ...args);
      // Spy on unref for the very first setTimeout call — the force-exit timer
      if (capturedHandle === null) {
        handle.unref = mock(() => {});
        capturedHandle = handle;
      }
      return handle;
    };

    shutdownGracefully();

    // Restore our wrapper (FakeTimers uninstall restores the original)
    (globalThis as any).setTimeout = fakeST;

    expect(capturedHandle).not.toBeNull();
    expect(capturedHandle.unref).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Parent-PID watchdog
// ---------------------------------------------------------------------------

describe('watchdog', () => {
  let origExit: typeof process.exit;
  const exitMock = mock((_code?: number) => {});
  const timers = new FakeTimers();
  // setInterval/clearInterval originals — we replace them per test
  let origSetInterval: typeof globalThis.setInterval;
  let origClearInterval: typeof globalThis.clearInterval;

  beforeEach(async () => {
    resetShuttingDown();
    resetWatchdog();
    origExit = process.exit;
    (process as any).exit = exitMock;
    exitMock.mockClear();
    releaseLockMock.mockClear();
    acquireLockMock.mockClear();
    timers.install();
    origSetInterval = globalThis.setInterval;
    origClearInterval = globalThis.clearInterval;
    // Ensure a bolt instance exists so stopSlack() has something to call
    apps.length = 0;
    await startSlack({
      mcp: { notification: mock(async () => {}) } as any,
      botToken: TEST_BOT_TOKEN,
      appToken: TEST_APP_TOKEN,
      channelId: TEST_CHANNEL_ID,
      allowedUserId: TEST_ALLOWED_USER,
      onDead: mock(() => {}),
    });
  });

  afterEach(async () => {
    // Restore setInterval/clearInterval in case a test replaced them
    globalThis.setInterval = origSetInterval;
    globalThis.clearInterval = origClearInterval;
    timers.uninstall();
    (process as any).exit = origExit;
    resetWatchdog();
    resetShuttingDown();
    const currentApp = apps[apps.length - 1];
    if (currentApp) {
      currentApp.stop.mockImplementation(async () => {});
    }
    try {
      await stopSlack();
    } catch {
      // ignore — bolt may already be stopped
    }
  });

  test('watchdog triggers shutdown when orphaned', () => {
    // Capture the interval callback so we can fire it manually
    let capturedCallback: (() => void) | null = null;
    (globalThis as any).setInterval = (cb: () => void, _delay: number) => {
      capturedCallback = cb;
      return { unref() {} };
    };

    // Stub getPpid to return 1 (orphaned — OS reparented to init/launchd)
    setGetPpid(() => 1);

    startWatchdog();

    expect(capturedCallback).not.toBeNull();
    expect(releaseLockMock).not.toHaveBeenCalled();

    // Fire the interval callback — should trigger shutdownGracefully
    capturedCallback!();

    // shutdownGracefully must have run: releaseLock is called exactly once
    expect(releaseLockMock).toHaveBeenCalledTimes(1);
  });

  test("watchdog interval is unref'd", () => {
    // Capture the interval handle to spy on .unref()
    let capturedHandle: any = null;
    (globalThis as any).setInterval = (_cb: () => void, _delay: number) => {
      const handle = { unref: mock(() => {}) };
      if (capturedHandle === null) capturedHandle = handle;
      return handle;
    };

    startWatchdog();

    expect(capturedHandle).not.toBeNull();
    expect(capturedHandle.unref).toHaveBeenCalledTimes(1);
  });

  test('watchdog is cleared on shutdown', () => {
    // Capture handle and spy on clearInterval
    let capturedHandle: any = null;
    let clearedHandle: any = null;

    (globalThis as any).setInterval = (_cb: () => void, _delay: number) => {
      capturedHandle = { unref() {} };
      return capturedHandle;
    };
    (globalThis as any).clearInterval = (handle: any) => {
      clearedHandle = handle;
    };

    startWatchdog();
    expect(capturedHandle).not.toBeNull();

    shutdownGracefully();

    // clearInterval must have been called with the watchdog handle
    expect(clearedHandle).toBe(capturedHandle);
  });
});

// ---------------------------------------------------------------------------
// tryAcquireLock — non-throwing lock acquisition
// ---------------------------------------------------------------------------

describe('tryAcquireLock', () => {
  beforeEach(() => {
    tryAcquireLockMock.mockReset();
    tryAcquireLockMock.mockReturnValue(true);
    releaseLockMock.mockClear();
  });

  test('returns true when lock is free', () => {
    tryAcquireLockMock.mockReturnValue(true);
    const result = tryAcquireLockMock();
    expect(result).toBe(true);
  });

  test('returns false when lock is held', () => {
    // First call succeeds
    tryAcquireLockMock.mockReturnValueOnce(true);
    expect(tryAcquireLockMock()).toBe(true);

    // Second call fails (lock is held)
    tryAcquireLockMock.mockReturnValueOnce(false);
    expect(tryAcquireLockMock()).toBe(false);
  });

  test('releaseLock is safe to call when no lock is held', () => {
    // releaseLock should not throw even when nothing is locked
    expect(() => releaseLockMock()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Connect tool — tool list changes based on activation state
// ---------------------------------------------------------------------------

describe('connect tool', () => {
  const listTools = (mcp as any)._requestHandlers?.get('tools/list');
  const callTool = (mcp as any)._requestHandlers?.get('tools/call');

  test('always lists all tools including connect', async () => {
    setMode('dormant');
    const result = await listTools({ method: 'tools/list', params: {} });
    const names = result.tools.map((t: any) => t.name);
    expect(names).toContain('connect');
    expect(names).toContain('reply');
    expect(names).toContain('new_thread');
    expect(names).toContain('react');
  });

  // =========================================================================
  // Connect handler — mode branching
  // =========================================================================

  describe('connect handler mode branching', () => {
    afterEach(() => {
      setMode('dormant');
    });

    test('returns "Already connected." when mode is connected', async () => {
      setMode('connected');
      const result = await callTool({
        method: 'tools/call',
        params: { name: 'connect', arguments: {} },
      });
      expect(result.content[0].text).toBe('Already connected.');
    });

    test('returns "Already connected as client." when mode is client', async () => {
      setMode('client');
      const result = await callTool({
        method: 'tools/call',
        params: { name: 'connect', arguments: {} },
      });
      expect(result.content[0].text).toBe('Already connected as client.');
    });

    test('calls activate and returns "Connected to Slack." on success', async () => {
      setMode('dormant');
      const activateMock = mock(async () => {});
      setActivate(activateMock);

      const result = await callTool({
        method: 'tools/call',
        params: { name: 'connect', arguments: {} },
      });
      expect(activateMock).toHaveBeenCalledTimes(1);
      expect(result.content[0].text).toBe('Connected to Slack.');
    });

    test('catches LockHeldError, sets client mode, returns client message', async () => {
      setMode('dormant');
      setActivate(async () => {
        throw new LockHeldError();
      });

      const result = await callTool({
        method: 'tools/call',
        params: { name: 'connect', arguments: {} },
      });
      expect(getMode()).toBe('client');
      expect(result.content[0].text).toBe(
        'Connected as client \u2014 messages and permissions relay through the active session.',
      );
    });

    test('re-throws non-LockHeldError errors', async () => {
      setMode('dormant');
      setActivate(async () => {
        throw new Error('SLACK_BOT_TOKEN not set');
      });

      await expect(
        callTool({
          method: 'tools/call',
          params: { name: 'connect', arguments: {} },
        }),
      ).rejects.toThrow('SLACK_BOT_TOKEN not set');
    });
  });
});
