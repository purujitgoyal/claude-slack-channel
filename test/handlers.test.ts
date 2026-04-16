/**
 * Bolt Handler Tests
 *
 * Tests the message, app_mention, and permission action handlers registered
 * on the Slack Bolt App. These handle the inbound Slack → Claude message relay.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  TEST_ALLOWED_USER,
  TEST_APP_TOKEN,
  TEST_BOT_TOKEN,
  TEST_CHANNEL_ID,
  TEST_OTHER_USER,
} from './helpers';

// ---------------------------------------------------------------------------
// Mock @slack/bolt
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
          replies: mock(async () => ({
            ok: true,
            messages: [
              { text: 'hello from user', bot_id: undefined },
              { text: 'response from bot', bot_id: 'B123' },
            ],
          })),
        },
        auth: {
          test: mock(async () => ({ ok: true, user_id: 'U_BOT_DEFAULT' })),
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
// IPC verdict routing — use the real routeVerdict controlled via setActiveServer
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Import modules under test
// ---------------------------------------------------------------------------

const { startSlack, stopSlack, getBotUserId, resetBotUserId } = await import(
  '../src/slack'
);
const {
  setActiveThreadTs,
  getActiveThreadTs,
  getLastSeenEventTs,
  setLastSeenEventTs,
  resolvedPermissions,
  pendingPermissions,
} = await import('../src/session');
const { setActiveServer } = await import('../src/ipc');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getApp() {
  return apps[apps.length - 1];
}

async function simulateMessage(msg: Record<string, any>) {
  const app = getApp();
  for (const handler of app._messageHandlers) {
    await handler({ message: msg });
  }
}

async function simulateAppMention(event: Record<string, any>) {
  const app = getApp();
  for (const handler of app._eventHandlers.get('app_mention') ?? []) {
    await handler({ event });
  }
}

async function simulateAction(actionId: string, payload: any) {
  const app = getApp();
  for (const [pattern, handler] of app._actionHandlers) {
    if (pattern.test(actionId)) {
      await handler(payload);
    }
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Bolt Handlers', () => {
  let mcpMock: { notification: ReturnType<typeof mock> };

  beforeEach(async () => {
    apps.length = 0;
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
    resolvedPermissions.clear();
    pendingPermissions.clear();
    mcpMock.notification.mockClear();
    // No active IPC server by default — routeVerdict returns { routed: false }
    setActiveServer(null);
  });

  afterEach(async () => {
    setActiveServer(null);
    await stopSlack();
    resetBotUserId();
  });

  // =========================================================================
  // Message Handler — Thread Replies
  // =========================================================================

  describe('message handler', () => {
    test('registers exactly one message handler', () => {
      expect(getApp()._messageHandlers.length).toBe(1);
    });

    test('forwards active thread reply from allowed user', async () => {
      setActiveThreadTs('1000.0000');
      await simulateMessage({
        user: TEST_ALLOWED_USER,
        text: 'hello claude',
        thread_ts: '1000.0000',
        ts: '1000.0001',
      });

      expect(mcpMock.notification).toHaveBeenCalledTimes(1);
      const call = mcpMock.notification.mock.calls[0][0];
      expect(call.method).toBe('notifications/claude/channel');
      expect(call.params.content).toBe('hello claude');
    });

    test('includes correct metadata in forwarded message', async () => {
      setActiveThreadTs('1000.0000');
      await simulateMessage({
        user: TEST_ALLOWED_USER,
        text: 'test',
        thread_ts: '1000.0000',
        ts: '1000.0001',
      });

      const meta = mcpMock.notification.mock.calls[0][0].params.meta;
      expect(meta.slack_user_id).toBe(TEST_ALLOWED_USER);
      expect(meta.channel_id).toBe(TEST_CHANNEL_ID);
      expect(meta.event_ts).toBe('1000.0001');
    });

    test('ignores messages from non-allowed users', async () => {
      setActiveThreadTs('1000.0000');
      await simulateMessage({
        user: TEST_OTHER_USER,
        text: 'hello',
        thread_ts: '1000.0000',
        ts: '1000.0001',
      });

      expect(mcpMock.notification).not.toHaveBeenCalled();
    });

    test('ignores top-level messages (no thread_ts)', async () => {
      await simulateMessage({
        user: TEST_ALLOWED_USER,
        text: 'hello',
        ts: '1000.0001',
        // no thread_ts
      });

      expect(mcpMock.notification).not.toHaveBeenCalled();
    });

    test('ignores messages with subtype', async () => {
      setActiveThreadTs('1000.0000');
      await simulateMessage({
        subtype: 'message_changed',
        user: TEST_ALLOWED_USER,
        text: 'edited',
        thread_ts: '1000.0000',
        ts: '1000.0001',
      });

      expect(mcpMock.notification).not.toHaveBeenCalled();
    });

    test('handles empty text gracefully', async () => {
      setActiveThreadTs('1000.0000');
      await simulateMessage({
        user: TEST_ALLOWED_USER,
        thread_ts: '1000.0000',
        ts: '1000.0001',
        // no text
      });

      expect(mcpMock.notification).toHaveBeenCalledTimes(1);
      expect(mcpMock.notification.mock.calls[0][0].params.content).toBe('');
    });

    // =========================================================================
    // Dedup gate + cursor advancement — message handler
    // =========================================================================

    test('dedup gate drops replayed event_ts', async () => {
      setActiveThreadTs('1000.0000');
      const msg = {
        user: TEST_ALLOWED_USER,
        text: 'hello',
        thread_ts: '1000.0000',
        ts: '1000.0001',
      };
      await simulateMessage(msg);
      await simulateMessage(msg); // replay same event_ts

      expect(mcpMock.notification).toHaveBeenCalledTimes(1);
      expect(getLastSeenEventTs()).toBe('1000.0001');
    });

    test('dedup gate drops events older than cursor', async () => {
      setLastSeenEventTs('1775644620.500000');
      setActiveThreadTs('1000.0000');
      await simulateMessage({
        user: TEST_ALLOWED_USER,
        text: 'old message',
        thread_ts: '1000.0000',
        ts: '1775644620.400000', // older than cursor
      });

      expect(mcpMock.notification).not.toHaveBeenCalled();
    });

    test('cursor advances after successful forward', async () => {
      setActiveThreadTs('1000.0000');
      const eventTs = '1775644620.999999';
      await simulateMessage({
        user: TEST_ALLOWED_USER,
        text: 'unique message',
        thread_ts: '1000.0000',
        ts: eventTs,
      });

      expect(getLastSeenEventTs()).toBe(eventTs);
    });

    test('cursor does not advance when forward throws', async () => {
      setActiveThreadTs('1000.0000');
      mcpMock.notification.mockRejectedValueOnce(new Error('transport dead'));

      let threw = false;
      try {
        await simulateMessage({
          user: TEST_ALLOWED_USER,
          text: 'will fail',
          thread_ts: '1000.0000',
          ts: '1775644621.000000',
        });
      } catch {
        threw = true;
      }

      // Whether it threw or not, cursor must NOT have advanced
      expect(getLastSeenEventTs()).toBeNull();
      // Suppress unused variable warning — we just need to catch the rejection
      void threw;
    });
  });

  // =========================================================================
  // Message Handler — Old Thread Replies
  // =========================================================================

  describe('old thread reply handling', () => {
    test('fetches summary from old thread', async () => {
      setActiveThreadTs('1000.0000');
      await simulateMessage({
        user: TEST_ALLOWED_USER,
        text: 'continuing from old thread',
        thread_ts: '999.0000', // different from active
        ts: '1000.0002',
      });

      const app = getApp();
      expect(app.client.conversations.replies).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: TEST_CHANNEL_ID,
          ts: '999.0000',
        }),
      );
    });

    test('posts "Continued in new thread" note in old thread', async () => {
      setActiveThreadTs('1000.0000');
      await simulateMessage({
        user: TEST_ALLOWED_USER,
        text: 'new message',
        thread_ts: '999.0000',
        ts: '1000.0002',
      });

      const app = getApp();
      expect(app.client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: TEST_CHANNEL_ID,
          thread_ts: '999.0000',
          text: expect.stringContaining('Continued'),
        }),
      );
    });

    test('resets active thread', async () => {
      setActiveThreadTs('1000.0000');
      await simulateMessage({
        user: TEST_ALLOWED_USER,
        text: 'new message',
        thread_ts: '999.0000',
        ts: '1000.0002',
      });

      expect(getActiveThreadTs()).toBeNull();
    });

    test('forwards with context summary', async () => {
      setActiveThreadTs('1000.0000');
      await simulateMessage({
        user: TEST_ALLOWED_USER,
        text: 'follow up',
        thread_ts: '999.0000',
        ts: '1000.0002',
      });

      expect(mcpMock.notification).toHaveBeenCalled();
      const content = mcpMock.notification.mock.calls[0][0].params.content;
      expect(content).toContain('Context from previous thread');
      expect(content).toContain('follow up');
    });

    test('handles summary fetch failure gracefully', async () => {
      const app = getApp();
      app.client.conversations.replies.mockRejectedValueOnce(
        new Error('channel_not_found'),
      );

      setActiveThreadTs('1000.0000');
      await simulateMessage({
        user: TEST_ALLOWED_USER,
        text: 'hello',
        thread_ts: '999.0000',
        ts: '1000.0002',
      });

      // Should still forward the message
      expect(mcpMock.notification).toHaveBeenCalled();
      const content = mcpMock.notification.mock.calls[0][0].params.content;
      expect(content).toContain('could not fetch');
    });

    test('reply to thread when no thread is active (null activeThreadTs)', async () => {
      setActiveThreadTs(null);
      await simulateMessage({
        user: TEST_ALLOWED_USER,
        text: 'out of the blue',
        thread_ts: '888.0000',
        ts: '1000.0003',
      });

      // Should treat as old thread reply (null !== '888.0000')
      expect(mcpMock.notification).toHaveBeenCalled();
      const content = mcpMock.notification.mock.calls[0][0].params.content;
      expect(content).toContain('Context from previous thread');
    });
  });

  // =========================================================================
  // App Mention Handler
  // =========================================================================

  describe('app_mention handler', () => {
    test('registers exactly one app_mention handler', () => {
      expect(getApp()._eventHandlers.get('app_mention')?.length).toBe(1);
    });

    test('starts a new thread rooted at the mention timestamp', async () => {
      await simulateAppMention({
        user: TEST_ALLOWED_USER,
        text: '<@BOT123> start a task',
        ts: '2000.0001',
      });

      expect(getActiveThreadTs()).toBe('2000.0001');
    });

    test('strips bot mention from text', async () => {
      await simulateAppMention({
        user: TEST_ALLOWED_USER,
        text: '<@BOT123> do something',
        ts: '2000.0001',
      });

      const content = mcpMock.notification.mock.calls[0][0].params.content;
      expect(content).toBe('do something');
      expect(content).not.toContain('<@');
    });

    test('sends "(new session)" for mention-only (no text)', async () => {
      await simulateAppMention({
        user: TEST_ALLOWED_USER,
        text: '<@BOT123>',
        ts: '2000.0001',
      });

      const content = mcpMock.notification.mock.calls[0][0].params.content;
      expect(content).toBe('(new session)');
    });

    test('ignores mention from non-allowed user', async () => {
      await simulateAppMention({
        user: TEST_OTHER_USER,
        text: '<@BOT123> hi',
        ts: '2000.0001',
      });

      expect(mcpMock.notification).not.toHaveBeenCalled();
      expect(getActiveThreadTs()).toBeNull(); // not changed
    });

    test('includes correct metadata', async () => {
      await simulateAppMention({
        user: TEST_ALLOWED_USER,
        text: '<@BOT123> hi',
        ts: '2000.0001',
      });

      const meta = mcpMock.notification.mock.calls[0][0].params.meta;
      expect(meta.slack_user_id).toBe(TEST_ALLOWED_USER);
      expect(meta.channel_id).toBe(TEST_CHANNEL_ID);
      expect(meta.event_ts).toBe('2000.0001');
    });

    test('overwrites previous active thread', async () => {
      setActiveThreadTs('1000.0000');
      await simulateAppMention({
        user: TEST_ALLOWED_USER,
        text: '<@BOT123> fresh start',
        ts: '3000.0001',
      });

      expect(getActiveThreadTs()).toBe('3000.0001');
    });

    test('strips multiple mentions', async () => {
      await simulateAppMention({
        user: TEST_ALLOWED_USER,
        text: '<@BOT123> <@U999> check this',
        ts: '2000.0001',
      });

      const content = mcpMock.notification.mock.calls[0][0].params.content;
      expect(content).toBe('check this');
    });

    // =========================================================================
    // Dedup gate + cursor advancement — app_mention handler
    // =========================================================================

    test('dedup gate drops replayed event_ts', async () => {
      const event = {
        user: TEST_ALLOWED_USER,
        text: '<@BOT123> hello',
        ts: '2000.0001',
      };
      await simulateAppMention(event);
      await simulateAppMention(event); // replay same event_ts

      expect(mcpMock.notification).toHaveBeenCalledTimes(1);
      expect(getLastSeenEventTs()).toBe('2000.0001');
    });

    test('dedup gate drops events older than cursor', async () => {
      setLastSeenEventTs('1775644620.500000');
      await simulateAppMention({
        user: TEST_ALLOWED_USER,
        text: '<@BOT123> old mention',
        ts: '1775644620.400000', // older than cursor
      });

      expect(mcpMock.notification).not.toHaveBeenCalled();
    });

    test('cursor advances after successful forward', async () => {
      const eventTs = '1775644621.000000';
      await simulateAppMention({
        user: TEST_ALLOWED_USER,
        text: '<@BOT123> unique mention',
        ts: eventTs,
      });

      expect(getLastSeenEventTs()).toBe(eventTs);
    });

    test('cursor does not advance when forward throws', async () => {
      mcpMock.notification.mockRejectedValueOnce(new Error('transport dead'));

      let threw = false;
      try {
        await simulateAppMention({
          user: TEST_ALLOWED_USER,
          text: '<@BOT123> will fail',
          ts: '1775644622.000000',
        });
      } catch {
        threw = true;
      }

      // Whether it threw or not, cursor must NOT have advanced
      expect(getLastSeenEventTs()).toBeNull();
      // Suppress unused variable warning — we just need to catch the rejection
      void threw;
    });
  });

  // =========================================================================
  // Permission Action Handler
  // =========================================================================

  describe('permission action handler', () => {
    function makeActionPayload(
      actionId: string,
      value: string,
      userId: string = TEST_ALLOWED_USER,
    ) {
      return {
        action: { value },
        ack: mock(async () => {}),
        body: {
          user: { id: userId },
          message: { ts: '5000.0001' },
          container: { channel_id: TEST_CHANNEL_ID },
        },
        client: {
          chat: { update: mock(async () => ({ ok: true })) },
        },
      };
    }

    test('registers one action handler with correct pattern', () => {
      const app = getApp();
      expect(app._actionHandlers.length).toBe(1);
      const [pattern] = app._actionHandlers[0];
      expect(pattern.test('allow_req_123')).toBe(true);
      expect(pattern.test('deny_req_456')).toBe(true);
      expect(pattern.test('other_action')).toBe(false);
    });

    test('acknowledges button click immediately', async () => {
      const payload = makeActionPayload('allow_req_1', 'allow:req_1');
      await simulateAction('allow_req_1', payload);
      expect(payload.ack).toHaveBeenCalledTimes(1);
    });

    test('sends allow verdict to MCP for connected-session perm', async () => {
      pendingPermissions.set('req_1', {
        tool_name: 'Bash',
        description: 'Run a command',
        input_preview: 'git status',
      });
      const payload = makeActionPayload('allow_req_1', 'allow:req_1');
      await simulateAction('allow_req_1', payload);

      expect(mcpMock.notification).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'notifications/claude/channel/permission',
          params: { request_id: 'req_1', behavior: 'allow' },
        }),
      );
    });

    test('sends deny verdict to MCP for connected-session perm', async () => {
      pendingPermissions.set('req_2', {
        tool_name: 'Edit',
        description: 'Edit a file',
        input_preview: 'src/slack.ts',
      });
      const payload = makeActionPayload('deny_req_2', 'deny:req_2');
      await simulateAction('deny_req_2', payload);

      expect(mcpMock.notification).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'notifications/claude/channel/permission',
          params: { request_id: 'req_2', behavior: 'deny' },
        }),
      );
    });

    test('updates Slack message to show allow verdict', async () => {
      pendingPermissions.set('req_1', {
        tool_name: 'Bash',
        description: 'Run a command',
        input_preview: 'git status',
      });
      const payload = makeActionPayload('allow_req_1', 'allow:req_1');
      await simulateAction('allow_req_1', payload);

      expect(payload.client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: TEST_CHANNEL_ID,
          ts: '5000.0001',
          text: expect.stringContaining('Allowed'),
        }),
      );
    });

    test('updates Slack message to show deny verdict', async () => {
      pendingPermissions.set('req_1', {
        tool_name: 'Bash',
        description: 'Run a command',
        input_preview: 'git status',
      });
      const payload = makeActionPayload('deny_req_1', 'deny:req_1');
      await simulateAction('deny_req_1', payload);

      expect(payload.client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Denied'),
        }),
      );
    });

    test('ignores duplicate resolution for same request_id', async () => {
      pendingPermissions.set('req_dup', {
        tool_name: 'Bash',
        description: 'Run a command',
        input_preview: 'git status',
      });
      const p1 = makeActionPayload('allow_req_dup', 'allow:req_dup');
      const p2 = makeActionPayload('allow_req_dup', 'allow:req_dup');

      await simulateAction('allow_req_dup', p1);
      await simulateAction('allow_req_dup', p2);

      expect(mcpMock.notification).toHaveBeenCalledTimes(1);
    });

    test('ignores button click from non-allowed user', async () => {
      const payload = makeActionPayload(
        'allow_req_1',
        'allow:req_1',
        TEST_OTHER_USER,
      );
      await simulateAction('allow_req_1', payload);

      // ack is still called (Slack requires it)
      expect(payload.ack).toHaveBeenCalled();
      // but no verdict sent
      expect(mcpMock.notification).not.toHaveBeenCalled();
    });

    test('ignores action with invalid value format (no colon)', async () => {
      const payload = makeActionPayload('allow_bad', 'invalid-no-colon');
      await simulateAction('allow_bad', payload);

      expect(mcpMock.notification).not.toHaveBeenCalled();
    });

    test('handles request_id containing colons', async () => {
      pendingPermissions.set('tool:Bash:cmd', {
        tool_name: 'Bash',
        description: 'Run a command',
        input_preview: 'git status',
      });
      const payload = makeActionPayload(
        'allow_complex_id',
        'allow:tool:Bash:cmd',
      );
      await simulateAction('allow_complex_id', payload);

      const params = mcpMock.notification.mock.calls[0][0].params;
      expect(params.behavior).toBe('allow');
      expect(params.request_id).toBe('tool:Bash:cmd');
    });

    test('confirmation includes tool name when pendingPermissions has entry', async () => {
      // pendingPermissions stores already-formatted preview (formatInputPreview
      // is called in mcp.ts when the request arrives, not at verdict time)
      pendingPermissions.set('req_1', {
        tool_name: 'Bash',
        description: 'Run a command',
        input_preview: 'git status',
      });
      const payload = makeActionPayload('allow_req_1', 'allow:req_1');
      await simulateAction('allow_req_1', payload);

      // Summary text contains tool name
      expect(payload.client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('`Bash`'),
        }),
      );
      // Command preview is in a separate code block within blocks array
      const call = payload.client.chat.update.mock.calls[0][0];
      const codeBlock = call.blocks.find(
        (b: any) =>
          b.type === 'section' && b.text?.text?.includes('git status'),
      );
      expect(codeBlock).toBeDefined();
      expect(codeBlock.text.text).toContain('```');
    });

    test('shows stale message when pendingPermissions has no entry and routeVerdict returns false', async () => {
      const payload = makeActionPayload('allow_req_1', 'allow:req_1');
      await simulateAction('allow_req_1', payload);

      expect(payload.client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Stale request'),
        }),
      );
    });

    test('cleans up pendingPermissions after verdict', async () => {
      pendingPermissions.set('req_1', {
        tool_name: 'Edit',
        description: 'Edit a file',
        input_preview: 'src/slack.ts',
      });
      const payload = makeActionPayload('allow_req_1', 'allow:req_1');
      await simulateAction('allow_req_1', payload);

      expect(pendingPermissions.has('req_1')).toBe(false);
    });

    test('MCP notification failure removes from resolvedPermissions (allows retry)', async () => {
      pendingPermissions.set('req_1', {
        tool_name: 'Bash',
        description: 'Run a command',
        input_preview: 'git status',
      });
      mcpMock.notification.mockRejectedValueOnce(new Error('transport dead'));
      const payload = makeActionPayload('allow_req_1', 'allow:req_1');
      await simulateAction('allow_req_1', payload);

      expect(resolvedPermissions.has('req_1')).toBe(false);
      // Message not updated on failure
      expect(payload.client.chat.update).not.toHaveBeenCalled();

      // Retry succeeds — re-add to pendingPermissions since it wasn't consumed
      pendingPermissions.set('req_1', {
        tool_name: 'Bash',
        description: 'Run a command',
        input_preview: 'git status',
      });
      mcpMock.notification.mockResolvedValueOnce(undefined as any);
      const retry = makeActionPayload('allow_req_1', 'allow:req_1');
      await simulateAction('allow_req_1', retry);

      expect(mcpMock.notification).toHaveBeenCalledTimes(2);
      expect(retry.client.chat.update).toHaveBeenCalled();
    });

    // =========================================================================
    // Three-way verdict routing
    // =========================================================================

    /**
     * Build a minimal fake IPCServer with a permRouting map and sendTo stub.
     * setActiveServer(fakeServer) makes routeVerdict() use it.
     */
    function makeFakeServer(
      entries?: Record<
        string,
        {
          sessionId: string;
          toolName: string;
          description: string;
          inputPreview: string;
        }
      >,
    ) {
      const permRouting = new Map<string, any>();
      if (entries) {
        for (const [id, e] of Object.entries(entries)) {
          permRouting.set(id, {
            ...e,
            slackTs: '5000.0001',
            timestamp: Date.now(),
          });
        }
      }
      const sendToMock = mock(() => true);
      const fakeServer = {
        permRouting,
        clients: new Map([
          [
            'sess-1',
            {
              label: 'test',
              threadTs: 'ts-1',
              socket: { write: mock(() => 1) },
            },
          ],
        ]),
        sendTo: sendToMock,
      };
      return { fakeServer, sendToMock };
    }

    test('client perm: routes via routeVerdict, does NOT call mcp.notification', async () => {
      const { fakeServer } = makeFakeServer({
        req_client: {
          sessionId: 'sess-1',
          toolName: 'Bash',
          description: 'Run a command',
          inputPreview: 'git status',
        },
      });
      setActiveServer(fakeServer as any);

      const payload = makeActionPayload('allow_req_client', 'allow:req_client');
      await simulateAction('allow_req_client', payload);

      // MCP notification must NOT be called (client handles its own)
      expect(mcpMock.notification).not.toHaveBeenCalled();

      // Slack message updated with tool details from routing map
      expect(payload.client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('`Bash`'),
        }),
      );
    });

    test('client perm deny: routes and updates message with Denied', async () => {
      const { fakeServer } = makeFakeServer({
        req_cd: {
          sessionId: 'sess-1',
          toolName: 'Edit',
          description: 'Edit a file',
          inputPreview: 'src/config.ts',
        },
      });
      setActiveServer(fakeServer as any);

      const payload = makeActionPayload('deny_req_cd', 'deny:req_cd');
      await simulateAction('deny_req_cd', payload);

      expect(mcpMock.notification).not.toHaveBeenCalled();
      expect(payload.client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Denied'),
        }),
      );
      expect(payload.client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('`Edit`'),
        }),
      );
    });

    test('client perm: includes inputPreview in Slack message blocks', async () => {
      const { fakeServer } = makeFakeServer({
        req_p: {
          sessionId: 'sess-1',
          toolName: 'Bash',
          description: 'Run a command',
          inputPreview: 'rm -rf /tmp/test',
        },
      });
      setActiveServer(fakeServer as any);

      const payload = makeActionPayload('allow_req_p', 'allow:req_p');
      await simulateAction('allow_req_p', payload);

      const call = payload.client.chat.update.mock.calls[0][0];
      const codeBlock = call.blocks.find(
        (b: any) =>
          b.type === 'section' && b.text?.text?.includes('rm -rf /tmp/test'),
      );
      expect(codeBlock).toBeDefined();
    });

    test('client perm: removes entry from permRouting after verdict', async () => {
      const { fakeServer } = makeFakeServer({
        req_rm: {
          sessionId: 'sess-1',
          toolName: 'Bash',
          description: 'Run a command',
          inputPreview: 'git status',
        },
      });
      setActiveServer(fakeServer as any);

      const payload = makeActionPayload('allow_req_rm', 'allow:req_rm');
      await simulateAction('allow_req_rm', payload);

      expect(fakeServer.permRouting.has('req_rm')).toBe(false);
    });

    test('stale button: neither routing map nor pendingPermissions', async () => {
      // No active server, no pendingPermissions entry
      const payload = makeActionPayload('allow_req_stale', 'allow:req_stale');
      await simulateAction('allow_req_stale', payload);

      // No MCP notification
      expect(mcpMock.notification).not.toHaveBeenCalled();

      // Slack message updated with stale text
      expect(payload.client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Stale request'),
        }),
      );
    });

    test('stale button: message mentions terminal fallback', async () => {
      const payload = makeActionPayload('deny_req_gone', 'deny:req_gone');
      await simulateAction('deny_req_gone', payload);

      expect(payload.client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('terminal'),
        }),
      );
    });

    test('connected-session perm: falls through when not in routing map', async () => {
      // No active server (routeVerdict returns { routed: false })
      pendingPermissions.set('req_own', {
        tool_name: 'Read',
        description: 'Read a file',
        input_preview: 'package.json',
      });
      const payload = makeActionPayload('allow_req_own', 'allow:req_own');
      await simulateAction('allow_req_own', payload);

      // Falls through to mcp.notification path
      expect(mcpMock.notification).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'notifications/claude/channel/permission',
          params: { request_id: 'req_own', behavior: 'allow' },
        }),
      );

      // Slack message updated with tool name
      expect(payload.client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('`Read`'),
        }),
      );
    });
  });

  // =========================================================================
  // Bot User ID Capture
  // =========================================================================

  describe('bot user ID capture', () => {
    test('captures bot user ID at startup', async () => {
      // beforeEach already called startSlack; auth.test defaults to U_BOT_DEFAULT.
      expect(getBotUserId()).toBe('U_BOT_DEFAULT');
    });

    test('tolerates auth.test failure', async () => {
      // Stop the app started by beforeEach and reset state.
      await stopSlack();
      resetBotUserId();

      const errorSpy = mock((..._args: any[]) => {});
      const origError = console.error;
      console.error = errorSpy;

      // startSlack synchronously calls `new App()` (pushing to apps[]) then hits
      // `await bolt.start()` — at that await point control returns here, so we can
      // safely patch auth.test on the new app before the microtask resumes.
      const startPromise = startSlack({
        mcp: mcpMock as any,
        botToken: TEST_BOT_TOKEN,
        appToken: TEST_APP_TOKEN,
        channelId: TEST_CHANNEL_ID,
        allowedUserId: TEST_ALLOWED_USER,
        onDead: () => {},
      });

      // Patch auth.test on the newly-constructed MockApp to reject.
      const newApp = apps[apps.length - 1];
      newApp.client.auth.test.mockRejectedValueOnce(new Error('invalid_auth'));

      await startPromise;

      console.error = origError;

      // startSlack must not throw — botUserId remains null
      expect(getBotUserId()).toBeNull();

      // A log message mentioning the failure must have been emitted
      const logged = errorSpy.mock.calls.some((call: any[]) =>
        String(call[0]).includes('bot user ID'),
      );
      expect(logged).toBe(true);
    });
  });
});
