/**
 * Recovery Tests
 *
 * Tests the recoverMissedMessages helper that fetches and forwards Slack
 * messages missed during an outage. Verifies filtering, deduplication,
 * sorting, error handling, and cursor advancement.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test';
import {
  TEST_ALLOWED_USER,
  TEST_APP_TOKEN,
  TEST_BOT_TOKEN,
  TEST_CHANNEL_ID,
} from './helpers';

// ---------------------------------------------------------------------------
// Mock @slack/bolt
// ---------------------------------------------------------------------------

const apps: any[] = [];

const historyMock = mock(async () => ({ ok: true, messages: [] as any[] }));
const repliesMock = mock(async () => ({ ok: true, messages: [] as any[] }));

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
          history: historyMock,
          replies: repliesMock,
        },
        auth: {
          test: mock(async () => ({
            ok: true,
            user_id: TEST_BOT_USER_ID,
          })),
        },
        reactions: { add: mock(async () => ({ ok: true })) },
      };
      _messageHandlers: any[] = [];
      _eventHandlers = new Map<string, any[]>();
      _actionHandlers: [RegExp, Function][] = [];

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
        this._actionHandlers.push([p instanceof RegExp ? p : new RegExp(p), h]);
      }
      start = mock(async () => {});
      stop = mock(async () => {});
    },
  };
});

// ---------------------------------------------------------------------------
// Constants for this test file
// ---------------------------------------------------------------------------

const TEST_BOT_USER_ID = 'U_BOT_RECOVERY';
const TEST_ACTIVE_THREAD = '1775644600.000000';

// ---------------------------------------------------------------------------
// Import modules under test (after mock.module)
// ---------------------------------------------------------------------------

const {
  startSlack,
  stopSlack,
  resetBotUserId,
  resetIpcCallbacks,
  recoverMissedMessages,
} = await import('../src/slack');
const { setActiveThreadTs, setLastSeenEventTs, getLastSeenEventTs } =
  await import('../src/session');

// ---------------------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------------------

let mcpMock: { notification: ReturnType<typeof mock> };

beforeEach(async () => {
  apps.length = 0;
  historyMock.mockReset();
  repliesMock.mockReset();
  historyMock.mockResolvedValue({ ok: true, messages: [] });
  repliesMock.mockResolvedValue({ ok: true, messages: [] });

  mcpMock = { notification: mock(async () => {}) };

  await startSlack({
    mcp: mcpMock as any,
    botToken: TEST_BOT_TOKEN,
    appToken: TEST_APP_TOKEN,
    channelId: TEST_CHANNEL_ID,
    allowedUserId: TEST_ALLOWED_USER,
    onDead: () => {},
  });

  setActiveThreadTs(null);
  setLastSeenEventTs(null);
  mcpMock.notification.mockClear();
});

afterEach(async () => {
  await stopSlack();
  resetBotUserId();
});

afterAll(async () => {
  await stopSlack();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('recoverMissedMessages', () => {
  // =========================================================================
  // Test 1: Empty history returns { recovered: 0 }
  // =========================================================================

  test('returns 0 when history is empty', async () => {
    historyMock.mockResolvedValue({ ok: true, messages: [] });
    setActiveThreadTs(null);

    const result = await recoverMissedMessages(mcpMock as any, null);

    expect(result).toEqual({ recovered: 0 });
    expect(mcpMock.notification).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Test 2: Returns count for combined @mentions + active-thread replies
  // =========================================================================

  test('returns count for combined @mentions and active-thread replies', async () => {
    setActiveThreadTs(TEST_ACTIVE_THREAD);

    // One @mention from allowed user
    historyMock.mockResolvedValue({
      ok: true,
      messages: [
        {
          user: TEST_ALLOWED_USER,
          text: `<@${TEST_BOT_USER_ID}> do this task`,
          ts: '1775644620.100000',
        },
      ],
    });

    // Two replies from allowed user in the active thread
    repliesMock.mockResolvedValue({
      ok: true,
      messages: [
        // Parent message — should be filtered out (ts === thread_ts)
        {
          user: TEST_ALLOWED_USER,
          text: `<@${TEST_BOT_USER_ID}> parent`,
          ts: TEST_ACTIVE_THREAD,
          thread_ts: TEST_ACTIVE_THREAD,
        },
        // Reply 1
        {
          user: TEST_ALLOWED_USER,
          text: 'reply one',
          ts: '1775644620.200000',
          thread_ts: TEST_ACTIVE_THREAD,
        },
        // Reply 2
        {
          user: TEST_ALLOWED_USER,
          text: 'reply two',
          ts: '1775644620.300000',
          thread_ts: TEST_ACTIVE_THREAD,
        },
      ],
    });

    const result = await recoverMissedMessages(mcpMock as any, null);

    expect(result.recovered).toBe(3);
    expect(mcpMock.notification).toHaveBeenCalledTimes(3);
  });

  // =========================================================================
  // Test 3: Filters out bot's own messages
  // =========================================================================

  test("filters out bot's own messages", async () => {
    // One message from allowed user (@mention), one from the bot itself
    historyMock.mockResolvedValue({
      ok: true,
      messages: [
        {
          user: TEST_ALLOWED_USER,
          text: `<@${TEST_BOT_USER_ID}> hello`,
          ts: '1775644620.100000',
        },
        {
          user: TEST_BOT_USER_ID,
          text: `<@${TEST_BOT_USER_ID}> bot message`,
          ts: '1775644620.200000',
        },
      ],
    });

    const result = await recoverMissedMessages(mcpMock as any, null);

    // Only the allowed user's message should be forwarded
    expect(result.recovered).toBe(1);
    expect(mcpMock.notification).toHaveBeenCalledTimes(1);
  });

  // =========================================================================
  // Test 4: Skips events with event_ts <= lastSeenEventTs
  // =========================================================================

  test('skips events with event_ts <= lastSeenEventTs', async () => {
    const cursor = '1775644620.500000';
    setLastSeenEventTs(cursor);
    mcpMock.notification.mockClear(); // setLastSeenEventTs triggers a save but not a notification

    historyMock.mockResolvedValue({
      ok: true,
      messages: [
        {
          user: TEST_ALLOWED_USER,
          text: `<@${TEST_BOT_USER_ID}> old message`,
          ts: '1775644620.400000', // older than cursor — should be skipped
        },
        {
          user: TEST_ALLOWED_USER,
          text: `<@${TEST_BOT_USER_ID}> new message`,
          ts: '1775644620.700000', // newer than cursor — should be forwarded
        },
      ],
    });

    const result = await recoverMissedMessages(mcpMock as any, cursor);

    expect(result.recovered).toBe(1);
    expect(mcpMock.notification).toHaveBeenCalledTimes(1);
    const content = mcpMock.notification.mock.calls[0][0].params.content;
    expect(content).toContain('new message');
  });

  // =========================================================================
  // Test 5: Slack API error degrades gracefully
  // =========================================================================

  test('Slack API error degrades gracefully', async () => {
    historyMock.mockRejectedValue(new Error('channel_not_found'));

    let threw = false;
    let result: any;
    try {
      result = await recoverMissedMessages(mcpMock as any, null);
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result.recovered).toBe(0);
    expect(result.error).toBe('channel_not_found');
    expect(mcpMock.notification).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Test 6: Caps fetch oldest at now-3600 when cursor is null
  // =========================================================================

  test('caps fetch oldest at now-3600 when cursor is null', async () => {
    const before = Date.now() / 1000 - 3600;
    await recoverMissedMessages(mcpMock as any, null);
    const after = Date.now() / 1000 - 3600;

    expect(historyMock).toHaveBeenCalledTimes(1);
    const callArgs = historyMock.mock.calls[0][0] as {
      channel: string;
      oldest: string;
      limit: number;
    };
    const oldest = parseFloat(callArgs.oldest);

    // oldest should be within 5 seconds of (now - 3600)
    expect(oldest).toBeGreaterThanOrEqual(before - 5);
    expect(oldest).toBeLessThanOrEqual(after + 5);
  });

  // =========================================================================
  // Test 7: Filters @mentions by botUserId presence in text
  // =========================================================================

  test('filters @mentions by botUserId presence in text', async () => {
    historyMock.mockResolvedValue({
      ok: true,
      messages: [
        {
          user: TEST_ALLOWED_USER,
          text: 'just a regular message without mention',
          ts: '1775644620.100000',
        },
        {
          user: TEST_ALLOWED_USER,
          text: `<@${TEST_BOT_USER_ID}> this mentions the bot`,
          ts: '1775644620.200000',
        },
      ],
    });

    const result = await recoverMissedMessages(mcpMock as any, null);

    // Only the @mention message should be forwarded
    expect(result.recovered).toBe(1);
    expect(mcpMock.notification).toHaveBeenCalledTimes(1);
    const content = mcpMock.notification.mock.calls[0][0].params.content;
    expect(content).toContain('this mentions the bot');
  });

  // =========================================================================
  // Test 8: Skips active-thread fetch when no active thread
  // =========================================================================

  test('skips active-thread fetch when no active thread', async () => {
    setActiveThreadTs(null);

    await recoverMissedMessages(mcpMock as any, null);

    expect(repliesMock).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Test: sorts ascending by ts before forwarding
  // =========================================================================

  test('sorts messages ascending by ts before forwarding', async () => {
    setActiveThreadTs(TEST_ACTIVE_THREAD);

    // Provide messages out of order
    historyMock.mockResolvedValue({
      ok: true,
      messages: [
        {
          user: TEST_ALLOWED_USER,
          text: `<@${TEST_BOT_USER_ID}> third`,
          ts: '1775644620.300000',
        },
        {
          user: TEST_ALLOWED_USER,
          text: `<@${TEST_BOT_USER_ID}> first`,
          ts: '1775644620.100000',
        },
      ],
    });

    repliesMock.mockResolvedValue({
      ok: true,
      messages: [
        {
          user: TEST_ALLOWED_USER,
          text: 'second reply',
          ts: '1775644620.200000',
          thread_ts: TEST_ACTIVE_THREAD,
        },
      ],
    });

    await recoverMissedMessages(mcpMock as any, null);

    expect(mcpMock.notification).toHaveBeenCalledTimes(3);

    // Extract event_ts values from calls in order
    const eventTimes = mcpMock.notification.mock.calls.map(
      (call: any[]) => call[0].params.meta.event_ts,
    );
    expect(eventTimes).toEqual([
      '1775644620.100000',
      '1775644620.200000',
      '1775644620.300000',
    ]);
  });
});

// =========================================================================
// Client-thread recovery tests
// =========================================================================

const TEST_CLIENT_THREAD = '1.001';
const TEST_CLIENT_SESSION = 's1';
const TEST_PRIMARY_THREAD = '1775644600.000000'; // same as TEST_ACTIVE_THREAD

describe('recoverMissedMessages — client-thread recovery', () => {
  // These tests use a fresh startSlack with listClientThreads / forwardToClient /
  // evictClient callbacks so we can verify recovery routes to the right place.

  let forwardToClientMock: ReturnType<typeof mock>;
  let evictClientMock: ReturnType<typeof mock>;
  let listClientThreadsMock: ReturnType<typeof mock>;

  // Per-test replies mock factory — set in each test
  // The outer beforeEach already set up historyMock/repliesMock.
  // Inner beforeEach restarts Slack with IPC callbacks.

  beforeEach(async () => {
    // Stop the app started by the outer beforeEach
    await stopSlack();
    resetIpcCallbacks();

    forwardToClientMock = mock((_sid: string, _msg: any): boolean => true);
    evictClientMock = mock((_sid: string): void => {});
    listClientThreadsMock = mock(
      (): Array<{ sessionId: string; threadTs: string }> => [
        { sessionId: TEST_CLIENT_SESSION, threadTs: TEST_CLIENT_THREAD },
      ],
    );

    // Reset mocks to empty defaults (outer beforeEach already reset them)
    historyMock.mockResolvedValue({ ok: true, messages: [] });
    repliesMock.mockResolvedValue({ ok: true, messages: [] });
    mcpMock = { notification: mock(async () => {}) };

    await startSlack({
      mcp: mcpMock as any,
      botToken: TEST_BOT_TOKEN,
      appToken: TEST_APP_TOKEN,
      channelId: TEST_CHANNEL_ID,
      allowedUserId: TEST_ALLOWED_USER,
      onDead: () => {},
      forwardToClient: forwardToClientMock as any,
      evictClient: evictClientMock as any,
      listClientThreads: listClientThreadsMock as any,
    });

    setActiveThreadTs(TEST_PRIMARY_THREAD);
    setLastSeenEventTs(null);
    mcpMock.notification.mockClear();
  });

  // =========================================================================
  // Step 7 test: recovery delivers missed client-thread reply via IPC
  // =========================================================================

  test('delivers missed client-thread reply to the owning IPC client', async () => {
    const clientReplyTs = '1775644620.400000';
    const clientReplyText = 'reply in client thread';

    // history: no @mentions
    historyMock.mockResolvedValue({ ok: true, messages: [] });

    // replies: first call = primary's thread (no replies), second call = client's thread
    repliesMock
      .mockResolvedValueOnce({
        ok: true,
        messages: [
          // Primary thread parent + one reply
          {
            user: TEST_ALLOWED_USER,
            text: 'primary parent',
            ts: TEST_PRIMARY_THREAD,
            thread_ts: TEST_PRIMARY_THREAD,
          },
          {
            user: TEST_ALLOWED_USER,
            text: 'primary reply',
            ts: '1775644620.200000',
            thread_ts: TEST_PRIMARY_THREAD,
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        messages: [
          // Client thread parent + one reply
          {
            user: TEST_ALLOWED_USER,
            text: 'client parent',
            ts: TEST_CLIENT_THREAD,
            thread_ts: TEST_CLIENT_THREAD,
          },
          {
            user: TEST_ALLOWED_USER,
            text: clientReplyText,
            ts: clientReplyTs,
            thread_ts: TEST_CLIENT_THREAD,
          },
        ],
      });

    const result = await recoverMissedMessages(mcpMock as any, null);

    // forwardToClient called once with s1 and the correct envelope
    expect(forwardToClientMock).toHaveBeenCalledTimes(1);
    const [sid, envelope] = forwardToClientMock.mock.calls[0];
    expect(sid).toBe(TEST_CLIENT_SESSION);
    expect(envelope.type).toBe('inbound_message');
    expect(envelope.text).toBe(clientReplyText);
    expect(envelope.eventTs).toBe(clientReplyTs);
    expect(envelope.userId).toBe(TEST_ALLOWED_USER);
    expect(envelope.channelId).toBe(TEST_CHANNEL_ID);

    // Primary's thread reply forwarded via mcp.notification (thread_reply)
    expect(mcpMock.notification).toHaveBeenCalledTimes(1);

    // Cursor advanced to the most-recent ts
    expect(getLastSeenEventTs()).toBe(clientReplyTs);

    // recovered = 2 (one primary reply + one client reply)
    expect(result.recovered).toBe(2);
  });

  // =========================================================================
  // Step 11 test: stale client during recovery falls back to primary
  // =========================================================================

  test('evicts stale client and falls back to old_thread_reply on forwardToClient false', async () => {
    forwardToClientMock = mock((_sid: string, _msg: any): boolean => false);

    // Restart with the failing forwardToClient
    await stopSlack();
    resetIpcCallbacks();
    mcpMock = { notification: mock(async () => {}) };
    await startSlack({
      mcp: mcpMock as any,
      botToken: TEST_BOT_TOKEN,
      appToken: TEST_APP_TOKEN,
      channelId: TEST_CHANNEL_ID,
      allowedUserId: TEST_ALLOWED_USER,
      onDead: () => {},
      forwardToClient: forwardToClientMock as any,
      evictClient: evictClientMock as any,
      listClientThreads: listClientThreadsMock as any,
    });
    setActiveThreadTs(TEST_PRIMARY_THREAD);
    setLastSeenEventTs(null);
    mcpMock.notification.mockClear();

    const clientReplyTs = '1775644620.400000';

    historyMock.mockResolvedValue({ ok: true, messages: [] });
    repliesMock
      .mockResolvedValueOnce({ ok: true, messages: [] }) // primary: no replies
      .mockResolvedValueOnce({
        ok: true,
        messages: [
          {
            user: TEST_ALLOWED_USER,
            text: 'client parent',
            ts: TEST_CLIENT_THREAD,
            thread_ts: TEST_CLIENT_THREAD,
          },
          {
            user: TEST_ALLOWED_USER,
            text: 'stale client reply',
            ts: clientReplyTs,
            thread_ts: TEST_CLIENT_THREAD,
          },
        ],
      });

    await recoverMissedMessages(mcpMock as any, null);

    // evictClient called with the session ID
    expect(evictClientMock).toHaveBeenCalledTimes(1);
    expect(evictClientMock.mock.calls[0][0]).toBe(TEST_CLIENT_SESSION);

    // Fallback: forwardInboundMessage called with old_thread_reply
    // This goes through mcp.notification
    expect(mcpMock.notification).toHaveBeenCalledTimes(1);
    const notifParams = mcpMock.notification.mock.calls[0][0].params;
    // old_thread_reply builds content with thread context prefix
    expect(notifParams.meta.event_ts).toBe(clientReplyTs);

    // Cursor advanced for the fallback delivery
    expect(getLastSeenEventTs()).toBe(clientReplyTs);
  });

  // =========================================================================
  // Step 13 test: primary recovery still works unchanged when no clients
  // =========================================================================

  test('primary recovery unchanged when listClientThreads returns empty', async () => {
    listClientThreadsMock = mock(
      (): Array<{ sessionId: string; threadTs: string }> => [],
    );

    // Restart with no clients
    await stopSlack();
    resetIpcCallbacks();
    mcpMock = { notification: mock(async () => {}) };
    await startSlack({
      mcp: mcpMock as any,
      botToken: TEST_BOT_TOKEN,
      appToken: TEST_APP_TOKEN,
      channelId: TEST_CHANNEL_ID,
      allowedUserId: TEST_ALLOWED_USER,
      onDead: () => {},
      forwardToClient: forwardToClientMock as any,
      evictClient: evictClientMock as any,
      listClientThreads: listClientThreadsMock as any,
    });
    setActiveThreadTs(TEST_PRIMARY_THREAD);
    setLastSeenEventTs(null);
    mcpMock.notification.mockClear();

    const primaryReplyTs = '1775644620.200000';

    historyMock.mockResolvedValue({
      ok: true,
      messages: [
        {
          user: TEST_ALLOWED_USER,
          text: `<@${TEST_BOT_USER_ID}> a mention`,
          ts: '1775644620.100000',
        },
      ],
    });
    repliesMock.mockResolvedValueOnce({
      ok: true,
      messages: [
        {
          user: TEST_ALLOWED_USER,
          text: 'primary parent',
          ts: TEST_PRIMARY_THREAD,
          thread_ts: TEST_PRIMARY_THREAD,
        },
        {
          user: TEST_ALLOWED_USER,
          text: 'primary reply',
          ts: primaryReplyTs,
          thread_ts: TEST_PRIMARY_THREAD,
        },
      ],
    });

    const result = await recoverMissedMessages(mcpMock as any, null);

    // forwardToClient never called (no clients)
    expect(forwardToClientMock).not.toHaveBeenCalled();

    // Primary @mention + reply forwarded via mcp.notification
    expect(mcpMock.notification).toHaveBeenCalledTimes(2);

    // conversations.replies only called once (for primary's active thread)
    expect(repliesMock).toHaveBeenCalledTimes(1);

    // Cursor advanced
    expect(getLastSeenEventTs()).toBe(primaryReplyTs);

    expect(result.recovered).toBe(2);
  });

  // =========================================================================
  // Guard test: listClientThreads wired but forwardToClient/evictClient missing
  // → gracefully fall back to old_thread_reply on primary (no TypeError thrown)
  // =========================================================================

  test('falls back gracefully when listClientThreads is wired but forwardToClient/evictClient are not', async () => {
    // Restart with ONLY listClientThreads wired — no forwardToClient, no evictClient
    await stopSlack();
    resetIpcCallbacks();
    mcpMock = { notification: mock(async () => {}) };
    await startSlack({
      mcp: mcpMock as any,
      botToken: TEST_BOT_TOKEN,
      appToken: TEST_APP_TOKEN,
      channelId: TEST_CHANNEL_ID,
      allowedUserId: TEST_ALLOWED_USER,
      onDead: () => {},
      listClientThreads: listClientThreadsMock as any,
      // forwardToClient and evictClient intentionally omitted
    });
    setActiveThreadTs(TEST_PRIMARY_THREAD);
    setLastSeenEventTs(null);
    mcpMock.notification.mockClear();

    const clientReplyTs = '1775644620.400000';

    historyMock.mockResolvedValue({ ok: true, messages: [] });
    repliesMock
      .mockResolvedValueOnce({ ok: true, messages: [] }) // primary: no replies
      .mockResolvedValueOnce({
        ok: true,
        messages: [
          {
            user: TEST_ALLOWED_USER,
            text: 'client parent',
            ts: TEST_CLIENT_THREAD,
            thread_ts: TEST_CLIENT_THREAD,
          },
          {
            user: TEST_ALLOWED_USER,
            text: 'client reply with no ipc wiring',
            ts: clientReplyTs,
            thread_ts: TEST_CLIENT_THREAD,
          },
        ],
      });

    let threw = false;
    try {
      await recoverMissedMessages(mcpMock as any, null);
    } catch {
      threw = true;
    }

    // Must not throw TypeError from non-null assertions
    expect(threw).toBe(false);

    // Falls back to primary old_thread_reply path
    expect(mcpMock.notification).toHaveBeenCalledTimes(1);
    const notifParams = mcpMock.notification.mock.calls[0][0].params;
    expect(notifParams.meta.event_ts).toBe(clientReplyTs);

    // Cursor advanced
    expect(getLastSeenEventTs()).toBe(clientReplyTs);
  });
});
