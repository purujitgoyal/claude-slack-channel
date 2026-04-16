import { dlopen, suffix } from 'bun:ffi';
import { closeSync, openSync, writeFileSync } from 'node:fs';
import { ensureChannelsDir, LOCK_PATH, log } from './config.ts';

// ---------------------------------------------------------------------------
// Private module state
// ---------------------------------------------------------------------------

let lockFd: number | null = null;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when the lock is already held by another instance.
 * Callers can catch this specifically to enter client mode instead of failing.
 */
export class LockHeldError extends Error {
  constructor(message?: string) {
    super(
      message ??
        'Another slack-channel instance is already running. Only one session can use the Slack channel at a time.',
    );
    this.name = 'LockHeldError';
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Acquires an exclusive non-blocking file lock to prevent multiple instances.
 * Throws if the lock cannot be acquired (another instance is already running).
 */
export function acquireLock(): void {
  if (!tryAcquireLock()) {
    throw new LockHeldError();
  }
}

/**
 * Non-throwing variant of acquireLock(). Returns true if the lock was
 * successfully acquired, false if another instance already holds it.
 */
export function tryAcquireLock(): boolean {
  ensureChannelsDir();

  const LOCK_EX = 2;
  const LOCK_NB = 4;

  const libc = dlopen(`libc.${suffix}`, {
    flock: { args: ['i32', 'i32'], returns: 'i32' },
  });

  lockFd = openSync(LOCK_PATH, 'w');
  if (libc.symbols.flock(lockFd, LOCK_EX | LOCK_NB) !== 0) {
    closeSync(lockFd);
    lockFd = null;
    return false;
  }

  writeFileSync(LOCK_PATH, String(process.pid), 'utf8');
  log(`Lock acquired (pid=${process.pid})`);
  return true;
}

/**
 * Releases the file lock. Safe to call multiple times — no-op if already released.
 */
export function releaseLock(): void {
  if (lockFd != null) {
    try {
      closeSync(lockFd);
    } catch {}
    lockFd = null;
    log('Lock released');
  }
}
