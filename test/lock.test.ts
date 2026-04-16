/**
 * Lock Tests
 *
 * Tests for LockHeldError and tryAcquireLock behavior.
 * Note: tryAcquireLock integration with flock(2) is tested via the
 * mocked lock module in connection.test.ts.
 */

import { describe, expect, test } from 'bun:test';
import { LockHeldError } from '../src/lock';

describe('LockHeldError', () => {
  test('is an instance of Error', () => {
    const err = new LockHeldError();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(LockHeldError);
  });

  test('has the expected name', () => {
    const err = new LockHeldError();
    expect(err.name).toBe('LockHeldError');
  });

  test('has a default message', () => {
    const err = new LockHeldError();
    expect(err.message).toBeTruthy();
  });

  test('accepts a custom message', () => {
    const err = new LockHeldError('custom msg');
    expect(err.message).toBe('custom msg');
  });
});
