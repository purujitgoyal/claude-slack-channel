import { dlopen, suffix } from 'bun:ffi';
import { closeSync, openSync, writeFileSync } from 'node:fs';
import { ensureChannelsDir, LOCK_PATH, log } from './config.ts';

// ---------------------------------------------------------------------------
// Private module state
// ---------------------------------------------------------------------------

let lockFd: number | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Acquires an exclusive non-blocking file lock to prevent multiple instances.
 * Throws if the lock cannot be acquired (another instance is already running).
 */
export function acquireLock(): void {
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
    throw new Error(
      'Another slack-channel instance is already running. Only one session can use the Slack channel at a time.',
    );
  }

  writeFileSync(LOCK_PATH, String(process.pid), 'utf8');
  log(`Lock acquired (pid=${process.pid})`);
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
