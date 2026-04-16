/**
 * Permission Notification Mode-Branching Tests
 *
 * Tests the permission_request notification handler across all three modes:
 * - dormant: silently ignored
 * - connected: posts Block Kit buttons to Slack
 * - client: forwards perm_request over IPC
 *
 * Also tests server-side perm_request handling and client-side perm_response.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import type { IPCClient as IPCClientType, ServerMessage } from '../src/ipc';
import { encode, IPCClient, IPCServer, LineBuffer } from '../src/ipc';
import {
  getMode,
  mcp,
  setIpcClient,
  setMode,
  setSlackBridge,
} from '../src/mcp';
import { pendingPermissions } from '../src/session';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Invoke the permission_request notification handler directly */
async function sendPermissionNotification(params: {
  request_id: string;
  tool_name: string;
  description: string;
  input_preview: string;
}): Promise<void> {
  // Access the internal notification handler
  const handler = (mcp as any)._notificationHandlers?.get(
    'notifications/claude/channel/permission_request',
  );
  if (!handler) throw new Error('No permission_request handler registered');

  await handler({
    method: 'notifications/claude/channel/permission_request',
    params,
  });
}

function makeMockBridge() {
  return {
    postThreaded: mock(async () => 'bridge-ts'),
    addReaction: mock(async () => {}),
    channelId: 'C-test',
  };
}

function makeMockIpcClient(overrides?: Partial<IPCClientType>) {
  return {
    sendMessage: mock(async (_text: string) => 'mock-ts'),
    newThread: mock(async (_text?: string) => 'mock-thread-ts'),
    addReaction: mock(async (_emoji: string, _eventTs: string) => {}),
    sendPermRequest: mock(
      (
        _requestId: string,
        _toolName: string,
        _description: string,
        _inputPreview: string,
      ) => {},
    ),
    send: mock(() => {}),
    connect: mock(async () => 'mock-thread'),
    close: mock(() => {}),
    ...overrides,
  } as unknown as IPCClientType;
}

const SAMPLE_PERM = {
  request_id: 'req-123',
  tool_name: 'Bash',
  description: 'Run a shell command',
  input_preview: '{"command":"git status"}',
};

// ---------------------------------------------------------------------------
// Mode-branching tests
// ---------------------------------------------------------------------------

describe('Permission notification — mode branching', () => {
  afterEach(() => {
    setMode('dormant');
    setIpcClient(null);
    setSlackBridge(null!);
    pendingPermissions.clear();
  });

  // ── Dormant mode ──

  test('dormant mode: silently ignores permission_request (no throw, no Slack post)', async () => {
    setMode('dormant');
    // Should not throw
    await sendPermissionNotification(SAMPLE_PERM);
    // No side effects — just returns
  });

  test('dormant mode: does not store in pendingPermissions', async () => {
    setMode('dormant');
    await sendPermissionNotification(SAMPLE_PERM);
    expect(pendingPermissions.size).toBe(0);
  });

  // ── Connected mode ──

  test('connected mode: posts buttons to Slack via bridge', async () => {
    const mockBridge = makeMockBridge();
    setMode('connected');
    setSlackBridge(mockBridge as any);

    await sendPermissionNotification(SAMPLE_PERM);

    expect(mockBridge.postThreaded).toHaveBeenCalledTimes(1);
    const call = mockBridge.postThreaded.mock.calls[0][0];
    expect(call.text).toContain('Bash');
    expect(call.blocks).toBeDefined();

    // Check blocks include actions with allow/deny buttons
    const actionsBlock = call.blocks.find((b: any) => b.type === 'actions');
    expect(actionsBlock).toBeDefined();
    expect(actionsBlock.block_id).toBe('permission_req-123');
    expect(actionsBlock.elements).toHaveLength(2);
    expect(actionsBlock.elements[0].action_id).toBe('allow_req-123');
    expect(actionsBlock.elements[1].action_id).toBe('deny_req-123');
  });

  test('connected mode: stores entry in pendingPermissions', async () => {
    const mockBridge = makeMockBridge();
    setMode('connected');
    setSlackBridge(mockBridge as any);

    await sendPermissionNotification(SAMPLE_PERM);

    expect(pendingPermissions.has('req-123')).toBe(true);
    const entry = pendingPermissions.get('req-123')!;
    expect(entry.tool_name).toBe('Bash');
    expect(entry.description).toBe('Run a shell command');
  });

  // ── Client mode ──

  test('client mode: forwards perm_request over IPC', async () => {
    const mockIpc = makeMockIpcClient();
    setMode('client');
    setIpcClient(mockIpc);

    await sendPermissionNotification(SAMPLE_PERM);

    expect(mockIpc.sendPermRequest).toHaveBeenCalledTimes(1);
    expect(mockIpc.sendPermRequest).toHaveBeenCalledWith(
      'req-123',
      'Bash',
      'Run a shell command',
      '{"command":"git status"}',
    );
  });

  test('client mode: does not post to Slack bridge', async () => {
    const mockBridge = makeMockBridge();
    const mockIpc = makeMockIpcClient();
    setMode('client');
    setIpcClient(mockIpc);
    setSlackBridge(mockBridge as any);

    await sendPermissionNotification(SAMPLE_PERM);

    expect(mockBridge.postThreaded).not.toHaveBeenCalled();
  });

  test('client mode: does not store in pendingPermissions', async () => {
    const mockIpc = makeMockIpcClient();
    setMode('client');
    setIpcClient(mockIpc);

    await sendPermissionNotification(SAMPLE_PERM);

    expect(pendingPermissions.size).toBe(0);
  });

  test('client mode: silently ignores when IPC client is null (relay lost)', async () => {
    setMode('client');
    setIpcClient(null);

    // Should not throw
    await sendPermissionNotification(SAMPLE_PERM);
  });
});

// ---------------------------------------------------------------------------
// IPC Server — perm_request handling
// ---------------------------------------------------------------------------

/** Helper: generate a unique temp socket path for test isolation */
function tmpSock(): string {
  return `/tmp/slack-channel-test-perm-${randomUUID()}.sock`;
}

/** Small delay helper for async socket events to propagate */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('IPCServer — perm_request handling', () => {
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

  test('perm_request posts buttons to client thread', async () => {
    await server.start();
    const clientThreadTs = '1234567890.000100';
    posterMock.mockResolvedValueOnce(clientThreadTs); // register

    const permSlackTs = '1234567890.000200';
    posterMock.mockResolvedValueOnce(permSlackTs); // perm_request button post

    const client = new IPCClient({
      socketPath: sockPath,
      sessionId: 'sess-1',
      label: 'test-session',
    });
    await client.connect();

    // Send a perm_request
    client.send({
      type: 'perm_request',
      requestId: 'perm-req-1',
      toolName: 'Bash',
      description: 'Run a command',
      inputPreview: '{"command":"ls -la"}',
    });

    // Wait for server to process
    await delay(200);

    // Poster should be called twice: once for register, once for perm buttons
    expect(posterMock).toHaveBeenCalledTimes(2);
    const permCall = posterMock.mock.calls[1][0];
    expect(permCall.text).toContain('Bash');
    expect(permCall.text).toContain('Allow or Deny');
    expect(permCall.thread_ts).toBe(clientThreadTs);

    // Check blocks include actions with allow/deny buttons
    const actionsBlock = permCall.blocks.find((b: any) => b.type === 'actions');
    expect(actionsBlock).toBeDefined();
    expect(actionsBlock.block_id).toBe('permission_perm-req-1');
    expect(actionsBlock.elements).toHaveLength(2);

    client.close();
  });

  test('perm_request stores entry in permRouting map', async () => {
    await server.start();
    posterMock.mockResolvedValueOnce('thread-ts-1'); // register
    posterMock.mockResolvedValueOnce('perm-slack-ts'); // perm buttons

    const client = new IPCClient({
      socketPath: sockPath,
      sessionId: 'sess-1',
      label: 'test-session',
    });
    await client.connect();

    client.send({
      type: 'perm_request',
      requestId: 'perm-req-1',
      toolName: 'Edit',
      description: 'Edit a file',
      inputPreview: '{"file_path":"src/mcp.ts"}',
    });

    await delay(200);

    expect(server.permRouting.size).toBe(1);
    const entry = server.permRouting.get('perm-req-1');
    expect(entry).toBeDefined();
    expect(entry!.sessionId).toBe('sess-1');
    expect(entry!.slackTs).toBe('perm-slack-ts');
    expect(entry!.toolName).toBe('Edit');
    expect(entry!.description).toBe('Edit a file');
    expect(typeof entry!.timestamp).toBe('number');

    client.close();
  });

  test('perm_request from unregistered client is ignored', async () => {
    await server.start();

    // Connect raw socket and send perm_request without registering
    await new Promise<void>((resolve) => {
      Bun.connect<{ lineBuffer: LineBuffer }>({
        unix: sockPath,
        socket: {
          open: (socket) => {
            socket.data = { lineBuffer: new LineBuffer() };
            socket.write(
              encode({
                type: 'perm_request',
                requestId: 'orphan-req',
                toolName: 'Bash',
                description: 'cmd',
                inputPreview: '{}',
              }),
            );
            // Give server time to process, then resolve
            setTimeout(() => {
              socket.end();
              resolve();
            }, 200);
          },
          data: () => {},
          close: () => {},
          error: () => {},
        },
      });
    });

    // Poster should not have been called (no register, no perm buttons)
    expect(posterMock).not.toHaveBeenCalled();
    expect(server.permRouting.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// IPCClient — perm_response callback
// ---------------------------------------------------------------------------

describe('IPCClient — perm_response callback', () => {
  let server: IPCServer;
  let sockPath: string;
  let posterMock: ReturnType<typeof mock>;

  beforeEach(() => {
    sockPath = tmpSock();
    posterMock = mock(async () => `thread-ts-${randomUUID()}`);
    server = new IPCServer({
      socketPath: sockPath,
      poster: posterMock as any,
      messageUpdater: mock(async () => {}) as any,
      reacter: mock(async () => {}) as any,
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

  test('receiving perm_response calls onPermResponse callback', async () => {
    await server.start();
    posterMock.mockResolvedValueOnce('ts-1');

    const permResponseCb = mock((_requestId: string, _behavior: string) => {});
    const client = new IPCClient({
      socketPath: sockPath,
      sessionId: 'sess-1',
      label: 'test',
      onPermResponse: permResponseCb,
    });
    await client.connect();

    // Send perm_response from server
    server.sendTo('sess-1', {
      type: 'perm_response',
      requestId: 'req-42',
      behavior: 'allow',
    });

    await delay(100);

    expect(permResponseCb).toHaveBeenCalledTimes(1);
    expect(permResponseCb).toHaveBeenCalledWith('req-42', 'allow');

    client.close();
  });

  test('perm_response with deny behavior is forwarded correctly', async () => {
    await server.start();
    posterMock.mockResolvedValueOnce('ts-1');

    const permResponseCb = mock((_requestId: string, _behavior: string) => {});
    const client = new IPCClient({
      socketPath: sockPath,
      sessionId: 'sess-1',
      label: 'test',
      onPermResponse: permResponseCb,
    });
    await client.connect();

    server.sendTo('sess-1', {
      type: 'perm_response',
      requestId: 'req-99',
      behavior: 'deny',
    });

    await delay(100);

    expect(permResponseCb).toHaveBeenCalledWith('req-99', 'deny');

    client.close();
  });

  test('perm_response still dispatches to onMessage callback as well', async () => {
    await server.start();
    posterMock.mockResolvedValueOnce('ts-1');

    const messages: ServerMessage[] = [];
    const permResponseCb = mock((_requestId: string, _behavior: string) => {});
    const client = new IPCClient({
      socketPath: sockPath,
      sessionId: 'sess-1',
      label: 'test',
      onPermResponse: permResponseCb,
      onMessage: (msg) => messages.push(msg),
    });
    await client.connect();

    server.sendTo('sess-1', {
      type: 'perm_response',
      requestId: 'req-77',
      behavior: 'allow',
    });

    await delay(100);

    // Both callbacks should fire
    expect(permResponseCb).toHaveBeenCalledTimes(1);
    expect(messages.some((m) => m.type === 'perm_response')).toBe(true);

    client.close();
  });

  test('perm_response without onPermResponse callback does not throw', async () => {
    await server.start();
    posterMock.mockResolvedValueOnce('ts-1');

    // No onPermResponse callback
    const client = new IPCClient({
      socketPath: sockPath,
      sessionId: 'sess-1',
      label: 'test',
    });
    await client.connect();

    // Should not throw
    server.sendTo('sess-1', {
      type: 'perm_response',
      requestId: 'req-55',
      behavior: 'allow',
    });

    await delay(100);

    client.close();
  });
});

// ---------------------------------------------------------------------------
// IPCClient — sendPermRequest
// ---------------------------------------------------------------------------

describe('IPCClient — sendPermRequest', () => {
  let server: IPCServer;
  let sockPath: string;
  let posterMock: ReturnType<typeof mock>;

  beforeEach(() => {
    sockPath = tmpSock();
    posterMock = mock(async () => `thread-ts-${randomUUID()}`);
    server = new IPCServer({
      socketPath: sockPath,
      poster: posterMock as any,
      messageUpdater: mock(async () => {}) as any,
      reacter: mock(async () => {}) as any,
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

  test('sendPermRequest sends a perm_request message to the server', async () => {
    await server.start();
    posterMock
      .mockResolvedValueOnce('ts-1') // register
      .mockResolvedValueOnce('perm-ts'); // perm_request buttons

    const client = new IPCClient({
      socketPath: sockPath,
      sessionId: 'sess-1',
      label: 'test',
    });
    await client.connect();

    client.sendPermRequest(
      'req-abc',
      'Write',
      'Write to a file',
      '{"file_path":"test.txt","content":"hello"}',
    );

    await delay(200);

    // Poster called for register + perm buttons
    expect(posterMock).toHaveBeenCalledTimes(2);
    const permCall = posterMock.mock.calls[1][0];
    expect(permCall.text).toContain('Write');
    expect(permCall.thread_ts).toBe('ts-1');

    // Routing map should have the entry
    expect(server.permRouting.has('req-abc')).toBe(true);

    client.close();
  });

  test('sendPermRequest throws when not connected', () => {
    const client = new IPCClient({
      socketPath: sockPath,
      sessionId: 'sess-1',
      label: 'test',
    });

    expect(() => client.sendPermRequest('req-1', 'Bash', 'desc', '{}')).toThrow(
      'Not connected',
    );
  });
});
