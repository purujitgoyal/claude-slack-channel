/**
 * Observability instrumentation tests.
 *
 * Covers the client-info / client-capabilities snapshot populated by
 * `mcp.oninitialized`, and the fallback notification handler that logs
 * unhandled `notifications/claude/channel/*` traffic.
 *
 * The snapshot is used by the Phase 2 trust probe to warn users whose
 * session will not receive channel notifications (no --dangerously-load-
 * development-channels flag, no allowedChannelPlugins entry). Tests here
 * assert the plumbing, not the probe logic.
 */

import { describe, expect, test } from 'bun:test';
import {
  getClientCapabilitiesSnapshot,
  getClientInfoSnapshot,
  mcp,
} from '../src/mcp';

describe('mcp.oninitialized — client snapshot', () => {
  test('snapshot getters return the SDK-captured values after oninitialized fires', () => {
    // The oninitialized hook reads mcp.getClientVersion() and
    // mcp.getClientCapabilities() from the SDK. We invoke the hook directly
    // here because the full MCP initialize handshake requires a live
    // transport; the SDK getters return undefined in that case, and the
    // snapshot getters should mirror that exactly.
    mcp.oninitialized?.();

    expect(getClientInfoSnapshot()).toBe(mcp.getClientVersion());
    expect(getClientCapabilitiesSnapshot()).toBe(mcp.getClientCapabilities());
  });
});

describe('mcp.fallbackNotificationHandler — channel filter', () => {
  test('is registered on the server', () => {
    expect(mcp.fallbackNotificationHandler).toBeDefined();
    expect(typeof mcp.fallbackNotificationHandler).toBe('function');
  });

  test('returns without throwing for a claude/channel/* notification', async () => {
    await expect(
      mcp.fallbackNotificationHandler?.({
        method: 'notifications/claude/channel/something_new',
        params: { example: 'payload' },
      }),
    ).resolves.toBeUndefined();
  });

  test('returns without throwing for an unrelated notification', async () => {
    // Unrelated methods are ignored (no log, no error) so routine MCP
    // chatter like notifications/progress does not flood debug.log.
    await expect(
      mcp.fallbackNotificationHandler?.({
        method: 'notifications/progress',
        params: { progressToken: 'abc', progress: 0.5 },
      }),
    ).resolves.toBeUndefined();
  });

  test('tolerates missing params field', async () => {
    await expect(
      mcp.fallbackNotificationHandler?.({
        method: 'notifications/claude/channel/permission_request',
      }),
    ).resolves.toBeUndefined();
  });
});
