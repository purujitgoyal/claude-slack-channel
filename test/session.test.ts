/**
 * Session State Tests
 *
 * Tests the in-memory thread state and permission tracking.
 * Disk persistence (saveSession) is verified via a writeFileSync mock
 * in the lastSeenEventTs suite; other suites test purely in-memory state.
 */

import { mock, describe, test, expect, beforeEach } from 'bun:test';

// ---------------------------------------------------------------------------
// Mock node:fs so saveSession doesn't touch the real filesystem in tests.
// The mock is hoisted — modules imported below will see these stubs.
// ---------------------------------------------------------------------------

const mockWriteFileSync = mock((_path: string, _data: string) => {});
const mockExistsSync = mock((_path: string) => true);
const mockMkdirSync = mock((_path: string, _opts?: any) => undefined);
const mockReadFileSync = mock((_path: string, _enc: string) => '');
const mockAppendFileSync = mock((_path: string, _data: string) => {});

mock.module('node:fs', () => ({
  writeFileSync: mockWriteFileSync,
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
  readFileSync: mockReadFileSync,
  appendFileSync: mockAppendFileSync,
}));

const {
  getActiveThreadTs,
  setActiveThreadTs,
  getLastSeenEventTs,
  setLastSeenEventTs,
  saveSession,
  resolvedPermissions,
} = await import('../src/session');

describe('Session State', () => {
  beforeEach(() => {
    setActiveThreadTs(null);
    resolvedPermissions.clear();
  });

  // =========================================================================
  // activeThreadTs
  // =========================================================================

  describe('activeThreadTs', () => {
    test('defaults to null after reset', () => {
      expect(getActiveThreadTs()).toBeNull();
    });

    test('set and get round-trips', () => {
      setActiveThreadTs('1234.5678');
      expect(getActiveThreadTs()).toBe('1234.5678');
    });

    test('can be set back to null', () => {
      setActiveThreadTs('1234.5678');
      setActiveThreadTs(null);
      expect(getActiveThreadTs()).toBeNull();
    });

    test('overwrites previous value', () => {
      setActiveThreadTs('1000.0000');
      setActiveThreadTs('2000.0000');
      expect(getActiveThreadTs()).toBe('2000.0000');
    });
  });

  // =========================================================================
  // resolvedPermissions
  // =========================================================================

  describe('resolvedPermissions', () => {
    test('starts empty after clear', () => {
      expect(resolvedPermissions.size).toBe(0);
    });

    test('tracks resolved permission IDs', () => {
      resolvedPermissions.add('req_1');
      expect(resolvedPermissions.has('req_1')).toBe(true);
      expect(resolvedPermissions.has('req_2')).toBe(false);
    });

    test('prevents duplicate resolution', () => {
      resolvedPermissions.add('req_1');
      resolvedPermissions.add('req_1');
      expect(resolvedPermissions.size).toBe(1);
    });

    test('tracks multiple independent requests', () => {
      resolvedPermissions.add('req_1');
      resolvedPermissions.add('req_2');
      resolvedPermissions.add('req_3');
      expect(resolvedPermissions.size).toBe(3);
    });

    test('clear removes all entries', () => {
      resolvedPermissions.add('req_1');
      resolvedPermissions.add('req_2');
      resolvedPermissions.clear();
      expect(resolvedPermissions.size).toBe(0);
      expect(resolvedPermissions.has('req_1')).toBe(false);
    });
  });

  // =========================================================================
  // lastSeenEventTs
  // =========================================================================

  describe('lastSeenEventTs', () => {
    beforeEach(() => {
      mockWriteFileSync.mockClear();
      setLastSeenEventTs(null);
    });

    test('defaults to null initially', () => {
      expect(getLastSeenEventTs()).toBeNull();
    });

    test('set and get round-trips', () => {
      setLastSeenEventTs('1775644620.743929');
      expect(getLastSeenEventTs()).toBe('1775644620.743929');
    });

    test('setter calls saveSession with new shape including lastSeenEventTs', () => {
      setActiveThreadTs('1000.0000');
      setLastSeenEventTs('1775644620.743929');

      expect(mockWriteFileSync).toHaveBeenCalled();
      const writtenData = mockWriteFileSync.mock.calls[mockWriteFileSync.mock.calls.length - 1][1] as string;
      const parsed = JSON.parse(writtenData);
      expect(parsed).toEqual({ threadTs: '1000.0000', lastSeenEventTs: '1775644620.743929' });
    });

    test('setter preserves current threadTs in saveSession call', () => {
      setActiveThreadTs(null);
      setLastSeenEventTs('1775644620.743929');

      const writtenData = mockWriteFileSync.mock.calls[mockWriteFileSync.mock.calls.length - 1][1] as string;
      const parsed = JSON.parse(writtenData);
      expect(parsed).toEqual({ threadTs: null, lastSeenEventTs: '1775644620.743929' });
    });

    test('cursor persists across threadTs reset (does NOT reset on activation path)', () => {
      // Simulate: cursor arrives first, then activation resets threadTs
      setLastSeenEventTs('1775644620.743929');
      // Activation resets threadTs but must preserve lastSeenEventTs
      saveSession({ threadTs: null, lastSeenEventTs: getLastSeenEventTs() });

      const writtenData = mockWriteFileSync.mock.calls[mockWriteFileSync.mock.calls.length - 1][1] as string;
      const parsed = JSON.parse(writtenData);
      expect(parsed.lastSeenEventTs).toBe('1775644620.743929');
      expect(parsed.threadTs).toBeNull();
    });
  });
});
