/**
 * Client-Mode Tool Handler Tests
 *
 * Tests the MCP tool handlers (reply, new_thread, react) when the session
 * is in client mode — verifying they forward over IPC rather than using
 * the local Slack bridge.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { IPCClient } from '../src/ipc';
import { setIpcClient, setMode, setSlackBridge } from '../src/mcp';

// ---------------------------------------------------------------------------
// Shared mock IPC client factory
// ---------------------------------------------------------------------------

function makeMockIpcClient(overrides?: Partial<IPCClient>) {
  return {
    sendMessage: mock(async (_text: string) => 'mock-ts'),
    newThread: mock(async (_text?: string) => 'mock-thread-ts'),
    addReaction: mock(async (_emoji: string, _eventTs: string) => {}),
    send: mock(() => {}),
    connect: mock(async () => 'mock-thread'),
    close: mock(() => {}),
    ...overrides,
  } as unknown as IPCClient;
}

// ---------------------------------------------------------------------------
// Shared mock SlackBridge (for connected mode baseline tests)
// ---------------------------------------------------------------------------

function makeMockBridge() {
  return {
    postThreaded: mock(async () => 'bridge-ts'),
    addReaction: mock(async () => {}),
    channelId: 'C-test',
  };
}

// ---------------------------------------------------------------------------
// Import the MCP handler machinery via dynamic import so mocks are in place
// ---------------------------------------------------------------------------

const { mcp } = await import('../src/mcp');

// Helper: invoke a tool via the MCP server's request handler
async function callTool(
  name: string,
  args: Record<string, any> = {},
): Promise<{ content: Array<{ type: string; text: string }> }> {
  // Use the internal handler directly by simulating a CallToolRequest
  const handler = (mcp as any)._requestHandlers?.get('tools/call');
  if (!handler) throw new Error('No tools/call handler registered');

  const result = await handler({
    method: 'tools/call',
    params: { name, arguments: args },
  });
  return result as { content: Array<{ type: string; text: string }> };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Client-mode tool handlers', () => {
  let mockIpc: ReturnType<typeof makeMockIpcClient>;

  beforeEach(() => {
    mockIpc = makeMockIpcClient();
    setMode('client');
    setIpcClient(mockIpc);
  });

  afterEach(() => {
    setMode('dormant');
    setIpcClient(null);
    setSlackBridge(null!);
  });

  // ── reply ──

  test('reply sends sendMessage over IPC and returns "sent"', async () => {
    const result = await callTool('reply', { text: 'hello from client' });
    expect(result.content[0].text).toBe('sent');
    expect(mockIpc.sendMessage).toHaveBeenCalledWith('hello from client');
  });

  test('reply propagates IPC error', async () => {
    (mockIpc.sendMessage as any).mockRejectedValueOnce(
      new Error('IPC request timed out'),
    );
    await expect(callTool('reply', { text: 'fail' })).rejects.toThrow(
      'IPC request timed out',
    );
  });

  // ── react ──

  test('react sends addReaction over IPC and returns "reacted"', async () => {
    const result = await callTool('react', {
      emoji: 'eyes',
      event_ts: '1234.5678',
    });
    expect(result.content[0].text).toBe('reacted');
    expect(mockIpc.addReaction).toHaveBeenCalledWith('eyes', '1234.5678');
  });

  test('react propagates IPC error', async () => {
    (mockIpc.addReaction as any).mockRejectedValueOnce(
      new Error('react failed: invalid_name'),
    );
    await expect(
      callTool('react', { emoji: 'bad', event_ts: '1234.5678' }),
    ).rejects.toThrow('react failed');
  });

  // ── new_thread ──

  test('new_thread sends newThread over IPC and returns success', async () => {
    const result = await callTool('new_thread', { text: 'fresh start' });
    expect(result.content[0].text).toBe('New thread started.');
    expect(mockIpc.newThread).toHaveBeenCalledWith('fresh start');
  });

  test('new_thread without text sends newThread(undefined)', async () => {
    const result = await callTool('new_thread', {});
    expect(result.content[0].text).toBe('New thread started.');
    expect(mockIpc.newThread).toHaveBeenCalledWith(undefined);
  });

  test('new_thread propagates IPC error', async () => {
    (mockIpc.newThread as any).mockRejectedValueOnce(
      new Error('IPC request timed out'),
    );
    await expect(callTool('new_thread', { text: 'fail' })).rejects.toThrow(
      'IPC request timed out',
    );
  });
});

describe('Dormant-mode tool handlers', () => {
  beforeEach(() => {
    setMode('dormant');
    setIpcClient(null);
    setSlackBridge(null!);
  });

  test('reply throws "not active" in dormant mode', async () => {
    await expect(callTool('reply', { text: 'hello' })).rejects.toThrow(
      'not active',
    );
  });

  test('react throws "not active" in dormant mode', async () => {
    await expect(
      callTool('react', { emoji: 'eyes', event_ts: '1234.5678' }),
    ).rejects.toThrow('not active');
  });

  test('new_thread throws "not active" in dormant mode', async () => {
    await expect(callTool('new_thread', { text: 'hello' })).rejects.toThrow(
      'not active',
    );
  });
});

describe('Client-mode with dead IPC', () => {
  beforeEach(() => {
    setMode('client');
    setIpcClient(null); // IPC client is null — simulates dead relay
  });

  afterEach(() => {
    setMode('dormant');
  });

  test('reply throws relay lost error', async () => {
    await expect(callTool('reply', { text: 'hello' })).rejects.toThrow(
      'Slack relay lost',
    );
  });

  test('react throws relay lost error', async () => {
    await expect(
      callTool('react', { emoji: 'eyes', event_ts: '1234.5678' }),
    ).rejects.toThrow('Slack relay lost');
  });

  test('new_thread throws relay lost error', async () => {
    await expect(callTool('new_thread', { text: 'hello' })).rejects.toThrow(
      'Slack relay lost',
    );
  });
});

describe('Connected-mode tool handlers (baseline)', () => {
  let mockBridge: ReturnType<typeof makeMockBridge>;

  beforeEach(() => {
    mockBridge = makeMockBridge();
    setMode('connected');
    setSlackBridge(mockBridge as any);
    setIpcClient(null);
  });

  afterEach(() => {
    setMode('dormant');
    setSlackBridge(null!);
  });

  test('reply uses bridge.postThreaded in connected mode', async () => {
    const result = await callTool('reply', { text: 'hello from connected' });
    expect(result.content[0].text).toBe('sent');
    expect(mockBridge.postThreaded).toHaveBeenCalledWith({
      text: 'hello from connected',
    });
  });

  test('react uses bridge.addReaction in connected mode', async () => {
    const result = await callTool('react', {
      emoji: 'thumbsup',
      event_ts: '9999.0001',
    });
    expect(result.content[0].text).toBe('reacted');
    expect(mockBridge.addReaction).toHaveBeenCalledWith(
      'C-test',
      'thumbsup',
      '9999.0001',
    );
  });
});
