/**
 * Session State Tests
 *
 * Tests the in-memory thread state and permission tracking.
 * Disk persistence (saveSession) is verified by reading the actual JSON file
 * from disk after each write; no fs mocking is used so other test files are
 * not contaminated.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { SESSION_PATH } from '../src/config';
import {
  getActiveThreadTs,
  getLastSeenEventTs,
  resolvedPermissions,
  saveSession,
  setActiveThreadTs,
  setLastSeenEventTs,
} from '../src/session';

// ---------------------------------------------------------------------------
// Before/after hooks — back up any real session file so tests don't clobber
// production state. The directory is guaranteed to exist (ensureChannelsDir
// is called by saveSession itself, or we create it here for the backup step).
// ---------------------------------------------------------------------------

let backupData: string | null = null;
const SESSION_DIR = dirname(SESSION_PATH);

beforeAll(() => {
  // Ensure the directory exists so saveSession can write into it.
  if (!existsSync(SESSION_DIR)) {
    mkdirSync(SESSION_DIR, { recursive: true });
  }
  // Back up any existing session so we can restore it after tests.
  if (existsSync(SESSION_PATH)) {
    backupData = readFileSync(SESSION_PATH, 'utf8');
  }
});

afterAll(() => {
  // Restore the original session file (or remove the one written by tests).
  if (backupData !== null) {
    writeFileSync(SESSION_PATH, backupData, 'utf8');
  } else if (existsSync(SESSION_PATH)) {
    rmSync(SESSION_PATH);
  }
});

describe('Session State', () => {
  beforeEach(() => {
    setActiveThreadTs(null);
    setLastSeenEventTs(null);
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

      const parsed = JSON.parse(readFileSync(SESSION_PATH, 'utf8'));
      expect(parsed).toEqual({
        threadTs: '1000.0000',
        lastSeenEventTs: '1775644620.743929',
      });
    });

    test('setter preserves current threadTs in saveSession call', () => {
      setActiveThreadTs(null);
      setLastSeenEventTs('1775644620.743929');

      const parsed = JSON.parse(readFileSync(SESSION_PATH, 'utf8'));
      expect(parsed).toEqual({
        threadTs: null,
        lastSeenEventTs: '1775644620.743929',
      });
    });

    test('cursor persists across threadTs reset (does NOT reset on activation path)', () => {
      // Simulate: cursor arrives first, then activation resets threadTs
      setLastSeenEventTs('1775644620.743929');
      // Activation resets threadTs but must preserve lastSeenEventTs
      saveSession({ threadTs: null, lastSeenEventTs: getLastSeenEventTs() });

      const parsed = JSON.parse(readFileSync(SESSION_PATH, 'utf8'));
      expect(parsed.lastSeenEventTs).toBe('1775644620.743929');
      expect(parsed.threadTs).toBeNull();
    });
  });
});
