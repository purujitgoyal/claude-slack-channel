/**
 * Session State Tests
 *
 * Tests the in-memory thread state and permission tracking.
 * Disk persistence (saveSession) is tested indirectly through
 * handler and lifecycle tests.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  getActiveThreadTs,
  setActiveThreadTs,
  resolvedPermissions,
} from '../src/session';

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
});
