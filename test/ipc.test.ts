/**
 * IPC Protocol Tests
 *
 * Tests for the line-delimited JSON codec: encode() and LineBuffer.
 * These types and codec underpin all IPC communication over Unix sockets.
 */

import { describe, expect, test } from 'bun:test';
import type { IPCMessage } from '../src/ipc';
import { encode, LineBuffer } from '../src/ipc';

describe('encode', () => {
  test('returns JSON string terminated with newline', () => {
    const msg: IPCMessage = { type: 'shutdown' };
    const result = encode(msg);
    expect(result).toBe('{"type":"shutdown"}\n');
  });

  test('encodes a message with multiple fields', () => {
    const msg: IPCMessage = {
      type: 'register',
      sessionId: 'sess-1',
      label: 'my-session',
    };
    const result = encode(msg);
    const parsed = JSON.parse(result.trimEnd());
    expect(parsed).toEqual({
      type: 'register',
      sessionId: 'sess-1',
      label: 'my-session',
    });
    expect(result.endsWith('\n')).toBe(true);
  });

  test('encodes error message with optional requestId', () => {
    const msg: IPCMessage = {
      type: 'error',
      message: 'something failed',
    };
    const result = encode(msg);
    const parsed = JSON.parse(result.trimEnd());
    expect(parsed.type).toBe('error');
    expect(parsed.message).toBe('something failed');
    expect(parsed.requestId).toBeUndefined();
  });
});

describe('LineBuffer', () => {
  test('feed a complete line emits one parsed message', () => {
    const buf = new LineBuffer();
    const msgs = buf.feed(Buffer.from('{"type":"shutdown"}\n'));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ type: 'shutdown' });
  });

  test('feed two messages in one chunk emits two parsed messages', () => {
    const buf = new LineBuffer();
    const chunk = Buffer.from('{"type":"shutdown"}\n{"type":"unregister"}\n');
    const msgs = buf.feed(chunk);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ type: 'shutdown' });
    expect(msgs[1]).toEqual({ type: 'unregister' });
  });

  test('feed a partial line then the rest emits one message after completion', () => {
    const buf = new LineBuffer();
    const msgs1 = buf.feed(Buffer.from('{"type":"shut'));
    expect(msgs1).toHaveLength(0);

    const msgs2 = buf.feed(Buffer.from('down"}\n'));
    expect(msgs2).toHaveLength(1);
    expect(msgs2[0]).toEqual({ type: 'shutdown' });
  });

  test('feed a chunk that splits mid-UTF8 handles correctly', () => {
    const buf = new LineBuffer();
    // Create a message with a multi-byte UTF-8 character (emoji: 🎉 = 4 bytes)
    const fullMsg = '{"type":"error","message":"hello 🎉"}\n';
    const fullBuf = Buffer.from(fullMsg);
    // Split in the middle of the emoji (the emoji starts at some offset)
    const emojiOffset = fullBuf.indexOf(Buffer.from('🎉'));
    // Split 2 bytes into the 4-byte emoji
    const part1 = fullBuf.subarray(0, emojiOffset + 2);
    const part2 = fullBuf.subarray(emojiOffset + 2);

    const msgs1 = buf.feed(part1);
    expect(msgs1).toHaveLength(0);

    const msgs2 = buf.feed(part2);
    expect(msgs2).toHaveLength(1);
    expect(msgs2[0]).toEqual({
      type: 'error',
      message: 'hello 🎉',
    });
  });

  test('invalid JSON line emits an error message (not a crash)', () => {
    const buf = new LineBuffer();
    const msgs = buf.feed(Buffer.from('not valid json\n'));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('error');
    expect((msgs[0] as { type: 'error'; message: string }).message).toContain(
      'not valid json',
    );
  });

  test('empty lines are ignored', () => {
    const buf = new LineBuffer();
    const msgs = buf.feed(Buffer.from('\n\n{"type":"shutdown"}\n\n'));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ type: 'shutdown' });
  });

  test('mixed valid and invalid lines in one chunk', () => {
    const buf = new LineBuffer();
    const chunk = Buffer.from(
      '{"type":"shutdown"}\ngarbage\n{"type":"unregister"}\n',
    );
    const msgs = buf.feed(chunk);
    expect(msgs).toHaveLength(3);
    expect(msgs[0]).toEqual({ type: 'shutdown' });
    expect(msgs[1].type).toBe('error');
    expect(msgs[2]).toEqual({ type: 'unregister' });
  });

  test('valid JSON with missing required fields produces error message', () => {
    const buf = new LineBuffer();
    const msgs = buf.feed(Buffer.from('{"type":"register"}\n'));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('error');
    expect((msgs[0] as { type: 'error'; message: string }).message).toContain(
      'Validation failed',
    );
  });

  test('valid JSON with unknown type produces error message', () => {
    const buf = new LineBuffer();
    const msgs = buf.feed(
      Buffer.from('{"type":"unknown_garbage","foo":"bar"}\n'),
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('error');
    expect((msgs[0] as { type: 'error'; message: string }).message).toContain(
      'Validation failed',
    );
  });
});
