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

const { startSlack, stopSlack, resetBotUserId, recoverMissedMessages } =
  await import('../src/slack');
const { setActiveThreadTs, setLastSeenEventTs } = await import(
  '../src/session'
);

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
