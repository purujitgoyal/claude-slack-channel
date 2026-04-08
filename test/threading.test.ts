/**
 * Threading Tests
 *
 * Tests the postThreaded helper and thread lifecycle — how new threads
 * are created, how active threads are continued, and how thread state
 * is managed.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
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
let postMessageMock: ReturnType<typeof mock>;

mock.module('@slack/bolt', () => {
  const { EventEmitter } = require('node:events');
  return {
    App: class MockApp {
      socketClient = new EventEmitter();
      receiver: any;
      client: any;
      _messageHandlers: any[] = [];
      _eventHandlers = new Map<string, any[]>();
      _actionHandlers: any[] = [];

      constructor() {
        postMessageMock = mock(async () => ({ ok: true, ts: '9000.0001' }));
        this.client = {
          chat: {
            postMessage: postMessageMock,
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
// Import modules under test
// ---------------------------------------------------------------------------

const { startSlack, stopSlack, postThreaded } = await import('../src/slack');
const { setActiveThreadTs, getActiveThreadTs } = await import('../src/session');

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Thread Management', () => {
  beforeEach(async () => {
    apps.length = 0;
    setActiveThreadTs(null);

    await startSlack({
      mcp: { notification: mock(async () => {}) } as any,
      botToken: TEST_BOT_TOKEN,
      appToken: TEST_APP_TOKEN,
      channelId: TEST_CHANNEL_ID,
      allowedUserId: TEST_ALLOWED_USER,
      onDead: () => {},
    });
  });

  afterEach(async () => {
    await stopSlack();
  });

  // =========================================================================
  // postThreaded — New Thread Creation
  // =========================================================================

  describe('postThreaded — no active thread', () => {
    test('posts without thread_ts (creates top-level message)', async () => {
      await postThreaded({ text: 'starting new thread' });

      expect(postMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: TEST_CHANNEL_ID,
          text: 'starting new thread',
          thread_ts: undefined,
        }),
      );
    });

    test('sets response.ts as the new active thread', async () => {
      await postThreaded({ text: 'hello' });
      expect(getActiveThreadTs()).toBe('9000.0001');
    });

    test('returns the message timestamp', async () => {
      const ts = await postThreaded({ text: 'hello' });
      expect(ts).toBe('9000.0001');
    });
  });

  // =========================================================================
  // postThreaded — Continuing Active Thread
  // =========================================================================

  describe('postThreaded — active thread exists', () => {
    beforeEach(() => {
      setActiveThreadTs('5000.0000');
    });

    test('posts with thread_ts of active thread', async () => {
      await postThreaded({ text: 'reply in thread' });

      expect(postMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: TEST_CHANNEL_ID,
          text: 'reply in thread',
          thread_ts: '5000.0000',
        }),
      );
    });

    test('does NOT change active thread', async () => {
      await postThreaded({ text: 'reply' });
      expect(getActiveThreadTs()).toBe('5000.0000');
    });

    test('supports Block Kit blocks', async () => {
      const blocks = [
        { type: 'section', text: { type: 'mrkdwn', text: 'hi' } },
      ];
      await postThreaded({ text: 'fallback', blocks });

      expect(postMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({ blocks }),
      );
    });
  });

  // =========================================================================
  // Thread Lifecycle
  // =========================================================================

  describe('thread lifecycle', () => {
    test('first post creates thread, second post replies to it', async () => {
      // First post — no active thread
      await postThreaded({ text: 'first' });
      expect(getActiveThreadTs()).toBe('9000.0001');

      // Second post — replies to thread
      postMessageMock.mockResolvedValueOnce({ ok: true, ts: '9000.0002' });
      await postThreaded({ text: 'second' });

      const lastCall =
        postMessageMock.mock.calls[postMessageMock.mock.calls.length - 1][0];
      expect(lastCall.thread_ts).toBe('9000.0001');
    });

    test('resetting active thread allows new thread creation', async () => {
      setActiveThreadTs('5000.0000');
      setActiveThreadTs(null);

      await postThreaded({ text: 'fresh start' });

      expect(postMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({ thread_ts: undefined }),
      );
      expect(getActiveThreadTs()).toBe('9000.0001');
    });
  });
});
