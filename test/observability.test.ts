/**
 * Observability instrumentation tests.
 *
 * Covers the fallback notification handler that logs unhandled
 * `notifications/claude/channel/*` traffic.
 */

import { describe, expect, test } from 'bun:test';
import { mcp } from '../src/mcp';

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
