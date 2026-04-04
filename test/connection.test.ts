/**
 * Connection Monitoring Tests
 *
 * Tests the Socket Mode connection lifecycle — disconnect detection, health
 * timeouts, reconnection, and graceful shutdown. This is the most critical
 * test file because connection instability is the primary reliability issue.
 *
 * KEY BUG DOCUMENTED: Leaked health timeouts on rapid disconnect events.
 */

import { mock, describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  FakeTimers,
  HEALTH_TIMEOUT,
  TEST_CHANNEL_ID,
  TEST_ALLOWED_USER,
  TEST_BOT_TOKEN,
  TEST_APP_TOKEN,
} from './helpers';

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

const { startSlack, stopSlack } = await import('../src/slack');

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
    test('starts a health-check timeout', () => {
      expect(timers.pending).toBe(0);
      app.socketClient.emit('disconnected');
      expect(timers.pending).toBe(1);
    });

    test('sends disconnect notification to MCP', () => {
      app.socketClient.emit('disconnected');
      expect(mcpMock.notification).toHaveBeenCalled();
      const call = mcpMock.notification.mock.calls[0][0];
      expect(call.method).toBe('notifications/claude/channel');
      expect(call.params.content).toContain('connection lost');
    });

    test('includes channel_id in notification metadata', () => {
      app.socketClient.emit('disconnected');
      const meta = mcpMock.notification.mock.calls[0][0].params.meta;
      expect(meta.channel_id).toBe(TEST_CHANNEL_ID);
    });

    test('does NOT call onDead immediately', () => {
      app.socketClient.emit('disconnected');
      expect(onDead).not.toHaveBeenCalled();
    });

    test('swallows MCP notification errors', () => {
      mcpMock.notification.mockRejectedValue(new Error('transport dead'));
      expect(() => app.socketClient.emit('disconnected')).not.toThrow();
    });
  });

  // =========================================================================
  // Connected Event
  // =========================================================================

  describe('connected event', () => {
    test('clears health timeout from prior disconnect', () => {
      app.socketClient.emit('disconnected');
      expect(timers.pending).toBe(1);
      app.socketClient.emit('connected');
      expect(timers.pending).toBe(0);
    });

    test('sends reconnect notification to MCP', () => {
      app.socketClient.emit('connected');
      expect(mcpMock.notification).toHaveBeenCalled();
      const call = mcpMock.notification.mock.calls[0][0];
      expect(call.method).toBe('notifications/claude/channel');
      expect(call.params.content).toContain('restored');
    });

    test('is safe without prior disconnect (no timeout to clear)', () => {
      expect(() => app.socketClient.emit('connected')).not.toThrow();
      expect(timers.pending).toBe(0);
    });

    test('multiple connected events are harmless', () => {
      app.socketClient.emit('connected');
      app.socketClient.emit('connected');
      app.socketClient.emit('connected');
      expect(timers.pending).toBe(0);
    });

    test('swallows MCP notification errors', () => {
      mcpMock.notification.mockRejectedValue(new Error('transport dead'));
      expect(() => app.socketClient.emit('connected')).not.toThrow();
    });
  });

  // =========================================================================
  // Reconnecting Event
  // =========================================================================

  describe('reconnecting event', () => {
    test('does not affect pending health timeout', () => {
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

    test('does not affect pending health timeout', () => {
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
    test('reconnect within timeout window prevents onDead', async () => {
      app.socketClient.emit('disconnected');
      await timers.tick(60_000); // 60s — well within 120s window
      app.socketClient.emit('connected');
      await timers.tick(HEALTH_TIMEOUT); // past the original deadline
      expect(onDead).not.toHaveBeenCalled();
    });

    test('sends both notifications in correct order', () => {
      app.socketClient.emit('disconnected');
      app.socketClient.emit('connected');

      const calls = mcpMock.notification.mock.calls;
      expect(calls.length).toBe(2);
      expect(calls[0][0].params.content).toContain('connection lost');
      expect(calls[1][0].params.content).toContain('restored');
    });

    test('repeated clean cycles do not accumulate timeouts', async () => {
      for (let i = 0; i < 5; i++) {
        app.socketClient.emit('disconnected');
        await timers.tick(10_000);
        app.socketClient.emit('connected');
      }
      expect(timers.pending).toBe(0);
      await timers.tick(HEALTH_TIMEOUT * 2);
      expect(onDead).not.toHaveBeenCalled();
    });

    test('reconnect at the exact timeout boundary prevents onDead', async () => {
      app.socketClient.emit('disconnected');
      await timers.tick(HEALTH_TIMEOUT - 1);
      app.socketClient.emit('connected');
      await timers.tick(1);
      expect(onDead).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Disconnect → Timeout Expiry (Shutdown Path)
  // =========================================================================

  describe('disconnect → timeout expiry', () => {
    test('calls onDead after HEALTH_TIMEOUT (120s)', async () => {
      app.socketClient.emit('disconnected');
      expect(onDead).not.toHaveBeenCalled();
      await timers.tick(HEALTH_TIMEOUT);
      expect(onDead).toHaveBeenCalledTimes(1);
    });

    test('does NOT call onDead before HEALTH_TIMEOUT', async () => {
      app.socketClient.emit('disconnected');
      await timers.tick(HEALTH_TIMEOUT - 1);
      expect(onDead).not.toHaveBeenCalled();
    });

    test('sends shutdown notification before calling onDead', async () => {
      app.socketClient.emit('disconnected');
      mcpMock.notification.mockClear();

      await timers.tick(HEALTH_TIMEOUT);

      const shutdownCall = mcpMock.notification.mock.calls.find((c: any) =>
        c[0]?.params?.content?.includes('dead'),
      );
      expect(shutdownCall).toBeTruthy();
      expect(onDead).toHaveBeenCalled();
    });

    test('onDead still called even if shutdown notification throws', async () => {
      mcpMock.notification.mockRejectedValue(new Error('MCP transport gone'));
      app.socketClient.emit('disconnected');
      await timers.tick(HEALTH_TIMEOUT);
      expect(onDead).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Graceful Shutdown — stopSlack clears pending timers
  // =========================================================================

  describe('graceful shutdown', () => {
    test('stopSlack clears pending health timeout', async () => {
      app.socketClient.emit('disconnected');
      expect(timers.pending).toBe(1);

      await stopSlack();

      expect(timers.pending).toBe(0);
      await timers.tick(HEALTH_TIMEOUT);
      expect(onDead).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // FIXED: Rapid Disconnects — No Leaked Health Timeouts
  // =========================================================================

  describe('rapid disconnects — no leaked timeouts (FIXED)', () => {
    /*
     * Previously, rapid disconnect events leaked health timeouts because the
     * handler created a new setTimeout without clearing the previous one.
     * Now the handler clears any existing timeout first.
     */

    test('second disconnect replaces first timeout (only 1 pending)', () => {
      app.socketClient.emit('disconnected');
      expect(timers.pending).toBe(1);
      app.socketClient.emit('disconnected');
      expect(timers.pending).toBe(1); // replaced, not accumulated
    });

    test('reconnect after rapid disconnects clears the single timeout', async () => {
      app.socketClient.emit('disconnected');
      app.socketClient.emit('disconnected');
      app.socketClient.emit('connected');

      expect(timers.pending).toBe(0);

      await timers.tick(HEALTH_TIMEOUT);
      expect(onDead).not.toHaveBeenCalled();
    });

    test('rapid disconnect flurry still results in only one timeout', () => {
      app.socketClient.emit('disconnected');
      app.socketClient.emit('disconnected');
      app.socketClient.emit('disconnected');

      expect(timers.pending).toBe(1);
    });

    test('reconnect after flurry prevents false shutdown', async () => {
      app.socketClient.emit('disconnected');
      app.socketClient.emit('disconnected');
      app.socketClient.emit('disconnected');
      app.socketClient.emit('connected');

      expect(timers.pending).toBe(0);
      await timers.tick(HEALTH_TIMEOUT * 2);
      expect(onDead).not.toHaveBeenCalled();
    });

    test('disconnect burst → reconnect → disconnect still works correctly', async () => {
      app.socketClient.emit('disconnected');
      app.socketClient.emit('disconnected');
      app.socketClient.emit('connected');
      expect(timers.pending).toBe(0);

      app.socketClient.emit('disconnected');
      expect(timers.pending).toBe(1);
      await timers.tick(HEALTH_TIMEOUT);
      expect(onDead).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Complex / Edge-Case Scenarios
  // =========================================================================

  describe('complex scenarios', () => {
    test('error during disconnect phase does not interfere with timeout', async () => {
      app.socketClient.emit('disconnected');
      app.socketClient.emit('error', new Error('transient'));
      expect(timers.pending).toBe(1);
      await timers.tick(HEALTH_TIMEOUT);
      expect(onDead).toHaveBeenCalledTimes(1);
    });

    test('reconnecting event does NOT clear health timeout', async () => {
      app.socketClient.emit('disconnected');
      app.socketClient.emit('reconnecting');
      expect(timers.pending).toBe(1);
      await timers.tick(HEALTH_TIMEOUT);
      expect(onDead).toHaveBeenCalledTimes(1);
    });

    test('disconnect → reconnect → disconnect → timeout', async () => {
      app.socketClient.emit('disconnected');
      app.socketClient.emit('connected');
      expect(timers.pending).toBe(0);

      app.socketClient.emit('disconnected');
      await timers.tick(HEALTH_TIMEOUT);
      expect(onDead).toHaveBeenCalledTimes(1);
    });

    test('unable_to_socket_mode_start during active disconnect timer', () => {
      app.socketClient.emit('disconnected');
      expect(timers.pending).toBe(1);
      app.socketClient.emit('unable_to_socket_mode_start');
      // onDead called immediately by unable_to_socket_mode_start
      expect(onDead).toHaveBeenCalledTimes(1);
      // Note: health timeout is NOT cleared — it would fire later too
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

    test('alternating disconnect/error/reconnect sequence', async () => {
      app.socketClient.emit('disconnected');
      app.socketClient.emit('error', new Error('e1'));
      app.socketClient.emit('reconnecting');
      app.socketClient.emit('error', new Error('e2'));
      app.socketClient.emit('connected');

      expect(timers.pending).toBe(0);
      await timers.tick(HEALTH_TIMEOUT);
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
});
