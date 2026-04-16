/**
 * IPC Protocol Tests
 *
 * Tests for the line-delimited JSON codec: encode() and LineBuffer.
 * Tests for IPCServer and IPCClient lifecycle.
 * These types and codec underpin all IPC communication over Unix sockets.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import type { IPCMessage, ServerMessage } from '../src/ipc';
import { encode, IPCClient, IPCServer, LineBuffer } from '../src/ipc';

describe('encode', () => {
  test('returns JSON string terminated with newline', () => {
    const msg: IPCMessage = { type: 'shutdown' };
    const result = encode(msg);
    expect(result).toBe('{"type":"shutdown"}\n');
  });

  test('encodes a message with multiple fields', () => {
    const msg: IPCMessage = {
      type: 'register',
      sessionId: 'sess-1',
      label: 'my-session',
    };
    const result = encode(msg);
    const parsed = JSON.parse(result.trimEnd());
    expect(parsed).toEqual({
      type: 'register',
      sessionId: 'sess-1',
      label: 'my-session',
    });
    expect(result.endsWith('\n')).toBe(true);
  });

  test('encodes error message with optional requestId', () => {
    const msg: IPCMessage = {
      type: 'error',
      message: 'something failed',
    };
    const result = encode(msg);
    const parsed = JSON.parse(result.trimEnd());
    expect(parsed.type).toBe('error');
    expect(parsed.message).toBe('something failed');
    expect(parsed.requestId).toBeUndefined();
  });
});

describe('LineBuffer', () => {
  test('feed a complete line emits one parsed message', () => {
    const buf = new LineBuffer();
    const msgs = buf.feed(Buffer.from('{"type":"shutdown"}\n'));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ type: 'shutdown' });
  });

  test('feed two messages in one chunk emits two parsed messages', () => {
    const buf = new LineBuffer();
    const chunk = Buffer.from('{"type":"shutdown"}\n{"type":"unregister"}\n');
    const msgs = buf.feed(chunk);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ type: 'shutdown' });
    expect(msgs[1]).toEqual({ type: 'unregister' });
  });

  test('feed a partial line then the rest emits one message after completion', () => {
    const buf = new LineBuffer();
    const msgs1 = buf.feed(Buffer.from('{"type":"shut'));
    expect(msgs1).toHaveLength(0);

    const msgs2 = buf.feed(Buffer.from('down"}\n'));
    expect(msgs2).toHaveLength(1);
    expect(msgs2[0]).toEqual({ type: 'shutdown' });
  });

  test('feed a chunk that splits mid-UTF8 handles correctly', () => {
    const buf = new LineBuffer();
    // Create a message with a multi-byte UTF-8 character (emoji: 🎉 = 4 bytes)
    const fullMsg = '{"type":"error","message":"hello 🎉"}\n';
    const fullBuf = Buffer.from(fullMsg);
    // Split in the middle of the emoji (the emoji starts at some offset)
    const emojiOffset = fullBuf.indexOf(Buffer.from('🎉'));
    // Split 2 bytes into the 4-byte emoji
    const part1 = fullBuf.subarray(0, emojiOffset + 2);
    const part2 = fullBuf.subarray(emojiOffset + 2);

    const msgs1 = buf.feed(part1);
    expect(msgs1).toHaveLength(0);

    const msgs2 = buf.feed(part2);
    expect(msgs2).toHaveLength(1);
    expect(msgs2[0]).toEqual({
      type: 'error',
      message: 'hello 🎉',
    });
  });

  test('invalid JSON line emits an error message (not a crash)', () => {
    const buf = new LineBuffer();
    const msgs = buf.feed(Buffer.from('not valid json\n'));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('error');
    expect((msgs[0] as { type: 'error'; message: string }).message).toContain(
      'not valid json',
    );
  });

  test('empty lines are ignored', () => {
    const buf = new LineBuffer();
    const msgs = buf.feed(Buffer.from('\n\n{"type":"shutdown"}\n\n'));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ type: 'shutdown' });
  });

  test('mixed valid and invalid lines in one chunk', () => {
    const buf = new LineBuffer();
    const chunk = Buffer.from(
      '{"type":"shutdown"}\ngarbage\n{"type":"unregister"}\n',
    );
    const msgs = buf.feed(chunk);
    expect(msgs).toHaveLength(3);
    expect(msgs[0]).toEqual({ type: 'shutdown' });
    expect(msgs[1].type).toBe('error');
    expect(msgs[2]).toEqual({ type: 'unregister' });
  });

  test('valid JSON with missing required fields produces error message', () => {
    const buf = new LineBuffer();
    const msgs = buf.feed(Buffer.from('{"type":"register"}\n'));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('error');
    expect((msgs[0] as { type: 'error'; message: string }).message).toContain(
      'Validation failed',
    );
  });

  test('valid JSON with unknown type produces error message', () => {
    const buf = new LineBuffer();
    const msgs = buf.feed(
      Buffer.from('{"type":"unknown_garbage","foo":"bar"}\n'),
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('error');
    expect((msgs[0] as { type: 'error'; message: string }).message).toContain(
      'Validation failed',
    );
  });
});

// ── IPCServer & IPCClient Tests ──────────────────────────────────────

/** Helper: generate a unique temp socket path for test isolation */
function tmpSock(): string {
  return `/tmp/slack-channel-test-${randomUUID()}.sock`;
}

/** Small delay helper for async socket events to propagate */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('IPCServer', () => {
  let server: IPCServer;
  let sockPath: string;
  let posterMock: ReturnType<typeof mock>;
  let messageUpdaterMock: ReturnType<typeof mock>;
  let reacterMock: ReturnType<typeof mock>;

  beforeEach(() => {
    sockPath = tmpSock();
    posterMock = mock(async () => `thread-ts-${randomUUID()}`);
    messageUpdaterMock = mock(async () => {});
    reacterMock = mock(async () => {});
    server = new IPCServer({
      socketPath: sockPath,
      poster: posterMock as any,
      messageUpdater: messageUpdaterMock as any,
      reacter: reacterMock as any,
      channelId: 'C-test',
    });
  });

  afterEach(async () => {
    try {
      await server.close();
    } catch {
      // already closed
    }
    // Clean up socket file
    try {
      if (existsSync(sockPath)) unlinkSync(sockPath);
    } catch {
      // ignore
    }
  });

  test('binds to a temp socket path', async () => {
    await server.start();
    expect(existsSync(sockPath)).toBe(true);
  });

  test('accepts a client connection and handles register flow', async () => {
    await server.start();

    const threadTs = '1234567890.000100';
    posterMock.mockResolvedValueOnce(threadTs);

    const ackPromise = new Promise<any>((resolve) => {
      const client = new IPCClient({
        socketPath: sockPath,
        sessionId: 'sess-1',
        label: 'test-session',
        onMessage: (msg) => {
          if (msg.type === 'register_ack') resolve(msg);
        },
      });
      client.connect();
    });

    const ack = await ackPromise;
    expect(ack.type).toBe('register_ack');
    expect(ack.threadTs).toBe(threadTs);
  });

  test('stores client in connection map after register', async () => {
    await server.start();

    const threadTs = '1234567890.000100';
    posterMock.mockResolvedValueOnce(threadTs);

    const client = new IPCClient({
      socketPath: sockPath,
      sessionId: 'sess-1',
      label: 'test-session',
    });
    await client.connect();

    expect(server.clients.size).toBe(1);
    const entry = server.clients.get('sess-1');
    expect(entry).toBeDefined();
    expect(entry!.label).toBe('test-session');
    expect(entry!.threadTs).toBe(threadTs);
  });

  test('poster is called with thread header on register', async () => {
    await server.start();

    posterMock.mockResolvedValueOnce('ts-1');

    const client = new IPCClient({
      socketPath: sockPath,
      sessionId: 'sess-1',
      label: 'my-label',
    });
    await client.connect();

    expect(posterMock).toHaveBeenCalledTimes(1);
    const call = posterMock.mock.calls[0][0];
    expect(call.text).toContain('my-label');
  });

  test('multiple clients get separate entries in connection map', async () => {
    await server.start();

    posterMock.mockResolvedValueOnce('ts-1').mockResolvedValueOnce('ts-2');

    const c1 = new IPCClient({
      socketPath: sockPath,
      sessionId: 'sess-1',
      label: 'session-1',
    });
    const c2 = new IPCClient({
      socketPath: sockPath,
      sessionId: 'sess-2',
      label: 'session-2',
    });

    await c1.connect();
    await c2.connect();

    expect(server.clients.size).toBe(2);
    expect(server.clients.get('sess-1')!.threadTs).toBe('ts-1');
    expect(server.clients.get('sess-2')!.threadTs).toBe('ts-2');
  });

  test('client disconnect removes entry from map', async () => {
    await server.start();

    posterMock.mockResolvedValueOnce('ts-1');

    const client = new IPCClient({
      socketPath: sockPath,
      sessionId: 'sess-1',
      label: 'test-session',
    });
    await client.connect();
    expect(server.clients.size).toBe(1);

    client.close();
    // Allow socket close event to propagate
    await delay(100);

    expect(server.clients.size).toBe(0);
  });

  test('server close sends shutdown to all clients', async () => {
    await server.start();

    posterMock.mockResolvedValueOnce('ts-1');

    const shutdownReceived = new Promise<boolean>((resolve) => {
      const client = new IPCClient({
        socketPath: sockPath,
        sessionId: 'sess-1',
        label: 'test-session',
        onMessage: (msg) => {
          if (msg.type === 'shutdown') resolve(true);
        },
      });
      client.connect();
    });

    // Give client time to connect and register
    await delay(100);

    await server.close();

    const got = await Promise.race([
      shutdownReceived,
      delay(2000).then(() => false),
    ]);
    expect(got).toBe(true);
  });

  test('binds over stale socket file (unlink + rebind)', async () => {
    // Create a stale socket file
    writeFileSync(sockPath, '');
    expect(existsSync(sockPath)).toBe(true);

    await server.start();
    expect(existsSync(sockPath)).toBe(true);

    // Verify it works by connecting a client
    posterMock.mockResolvedValueOnce('ts-1');
    const client = new IPCClient({
      socketPath: sockPath,
      sessionId: 'sess-1',
      label: 'test',
    });
    await client.connect();
    expect(server.clients.size).toBe(1);
    client.close();
  });

  test('sendTo delivers a message to a specific client', async () => {
    await server.start();

    posterMock.mockResolvedValueOnce('ts-1');

    const msgReceived = new Promise<any>((resolve) => {
      const client = new IPCClient({
        socketPath: sockPath,
        sessionId: 'sess-1',
        label: 'test-session',
        onMessage: (msg) => {
          if (msg.type === 'perm_response') resolve(msg);
        },
      });
      client.connect();
    });

    // Wait for client to register
    await delay(100);

    server.sendTo('sess-1', {
      type: 'perm_response',
      requestId: 'req-1',
      behavior: 'allow',
    });

    const msg = await msgReceived;
    expect(msg.type).toBe('perm_response');
    expect(msg.requestId).toBe('req-1');
    expect(msg.behavior).toBe('allow');
  });

  test('sendTo returns false for unknown sessionId', async () => {
    await server.start();
    const result = server.sendTo('nonexistent-session', {
      type: 'perm_response',
      requestId: 'req-1',
      behavior: 'allow',
    });
    expect(result).toBe(false);
  });

  test('poster returning undefined sends error back to client (not added to map)', async () => {
    await server.start();

    posterMock.mockResolvedValueOnce(undefined);

    const errorReceived = new Promise<any>((resolve) => {
      const client = new IPCClient({
        socketPath: sockPath,
        sessionId: 'sess-fail',
        label: 'fail-session',
        onMessage: (msg) => {
          if (msg.type === 'error') resolve(msg);
        },
      });
      client.connect().catch(() => {
        // Client may reject since no ack is sent
      });
    });

    const msg = await Promise.race([
      errorReceived,
      delay(2000).then(() => null),
    ]);

    expect(msg).not.toBeNull();
    expect(msg.type).toBe('error');
    expect(msg.message).toContain('poster returned no ts');
    expect(server.clients.has('sess-fail')).toBe(false);
  });

  test('close unlinks socket file', async () => {
    await server.start();
    expect(existsSync(sockPath)).toBe(true);

    await server.close();
    expect(existsSync(sockPath)).toBe(false);
  });
});

describe('IPCClient', () => {
  let server: IPCServer;
  let sockPath: string;
  let posterMock: ReturnType<typeof mock>;
  let messageUpdaterMock: ReturnType<typeof mock>;
  let reacterMock: ReturnType<typeof mock>;

  beforeEach(() => {
    sockPath = tmpSock();
    posterMock = mock(async () => `thread-ts-${randomUUID()}`);
    messageUpdaterMock = mock(async () => {});
    reacterMock = mock(async () => {});
    server = new IPCServer({
      socketPath: sockPath,
      poster: posterMock as any,
      messageUpdater: messageUpdaterMock as any,
      reacter: reacterMock as any,
      channelId: 'C-test',
    });
  });

  afterEach(async () => {
    try {
      await server.close();
    } catch {
      // already closed
    }
    try {
      if (existsSync(sockPath)) unlinkSync(sockPath);
    } catch {
      // ignore
    }
  });

  test('connect resolves with threadTs on register_ack', async () => {
    await server.start();
    posterMock.mockResolvedValueOnce('1234.5678');

    const client = new IPCClient({
      socketPath: sockPath,
      sessionId: 'sess-1',
      label: 'test',
    });
    const threadTs = await client.connect();
    expect(threadTs).toBe('1234.5678');
    client.close();
  });

  test('connect rejects on timeout when server is unreachable', async () => {
    // No server started — socket file doesn't exist
    const client = new IPCClient({
      socketPath: `/tmp/nonexistent-sock-${randomUUID()}.sock`,
      sessionId: 'sess-1',
      label: 'test',
      connectTimeoutMs: 500,
    });

    await expect(client.connect()).rejects.toThrow();
  });

  test('onMessage callback receives server messages', async () => {
    await server.start();
    posterMock.mockResolvedValueOnce('ts-1');

    const messages: ServerMessage[] = [];
    const client = new IPCClient({
      socketPath: sockPath,
      sessionId: 'sess-1',
      label: 'test',
      onMessage: (msg) => messages.push(msg),
    });
    await client.connect();

    // Send a message from the server
    server.sendTo('sess-1', {
      type: 'perm_response',
      requestId: 'r1',
      behavior: 'deny',
    });

    await delay(100);
    // register_ack + perm_response
    expect(messages.some((m) => m.type === 'register_ack')).toBe(true);
    expect(messages.some((m) => m.type === 'perm_response')).toBe(true);
    client.close();
  });

  test('onDisconnect callback fires on server close', async () => {
    await server.start();
    posterMock.mockResolvedValueOnce('ts-1');

    const disconnected = new Promise<boolean>((resolve) => {
      const client = new IPCClient({
        socketPath: sockPath,
        sessionId: 'sess-1',
        label: 'test',
        onDisconnect: () => resolve(true),
      });
      client.connect();
    });

    await delay(100);
    await server.close();

    const got = await Promise.race([
      disconnected,
      delay(2000).then(() => false),
    ]);
    expect(got).toBe(true);
  });

  test('send writes a message to the server', async () => {
    await server.start();
    posterMock.mockResolvedValueOnce('ts-1');

    const client = new IPCClient({
      socketPath: sockPath,
      sessionId: 'sess-1',
      label: 'test',
    });
    await client.connect();

    // send a message — this exercises the write path; server ignores unknown request
    // but it should not throw
    client.send({
      type: 'send_message',
      requestId: 'req-1',
      text: 'hello from client',
    });

    // No crash means success
    await delay(50);
    client.close();
  });
});
