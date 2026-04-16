/**
 * Mode Enum Tests
 *
 * Tests the mode state machine that replaces the boolean channelActive flag.
 * Three modes: 'dormant' (default), 'connected' (owns Slack bridge), 'client' (relays via IPC).
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { getMode, isClient, isConnected, setMode } from '../src/mcp';

describe('Mode enum', () => {
  beforeEach(() => {
    setMode('dormant');
  });

  test('getMode() returns dormant initially', () => {
    expect(getMode()).toBe('dormant');
  });

  test('setMode(connected) -> getMode() returns connected', () => {
    setMode('connected');
    expect(getMode()).toBe('connected');
  });

  test('setMode(client) -> getMode() returns client', () => {
    setMode('client');
    expect(getMode()).toBe('client');
  });

  test('setMode(dormant) resets to dormant', () => {
    setMode('connected');
    setMode('dormant');
    expect(getMode()).toBe('dormant');
  });

  test('isConnected() returns true only in connected mode', () => {
    expect(isConnected()).toBe(false);

    setMode('connected');
    expect(isConnected()).toBe(true);

    setMode('client');
    expect(isConnected()).toBe(false);

    setMode('dormant');
    expect(isConnected()).toBe(false);
  });

  test('isClient() returns true only in client mode', () => {
    expect(isClient()).toBe(false);

    setMode('client');
    expect(isClient()).toBe(true);

    setMode('connected');
    expect(isClient()).toBe(false);

    setMode('dormant');
    expect(isClient()).toBe(false);
  });
});
