/**
 * Config Utility Tests
 *
 * Tests pure utility functions from src/config.ts — env loading,
 * mention stripping, path constants.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadEnv, stripMentions, textResult, MENTION_RE } from '../src/config';

// ---------------------------------------------------------------------------
// loadEnv
// ---------------------------------------------------------------------------

describe('loadEnv', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function writeEnv(content: string): string {
    tmpDir = mkdtempSync(join(tmpdir(), 'slack-channel-test-'));
    const envPath = join(tmpDir, '.env');
    writeFileSync(envPath, content);
    return envPath;
  }

  test('parses simple key=value pairs', () => {
    const path = writeEnv('FOO=bar\nBAZ=qux');
    const env = loadEnv(path);
    expect(env.FOO).toBe('bar');
    expect(env.BAZ).toBe('qux');
  });

  test('skips comments', () => {
    const path = writeEnv('# this is a comment\nFOO=bar');
    const env = loadEnv(path);
    expect(env['# this is a comment']).toBeUndefined();
    expect(env.FOO).toBe('bar');
  });

  test('skips empty lines', () => {
    const path = writeEnv('FOO=bar\n\n\nBAZ=qux\n');
    const env = loadEnv(path);
    expect(env.FOO).toBe('bar');
    expect(env.BAZ).toBe('qux');
  });

  test('handles values containing = signs', () => {
    const path = writeEnv('TOKEN=xoxb-123=456=789');
    const env = loadEnv(path);
    expect(env.TOKEN).toBe('xoxb-123=456=789');
  });

  test('handles empty values', () => {
    const path = writeEnv('EMPTY=');
    const env = loadEnv(path);
    expect(env.EMPTY).toBe('');
  });

  test('trims whitespace from lines (both sides)', () => {
    const path = writeEnv('  FOO=bar  \n  BAZ=qux  ');
    const env = loadEnv(path);
    // loadEnv trims the entire line before splitting on '='
    expect(env.FOO).toBe('bar');
    expect(env.BAZ).toBe('qux');
  });

  test('throws for missing file', () => {
    expect(() => loadEnv('/nonexistent/path/.env')).toThrow('Missing config');
  });

  test('throws with helpful message mentioning /slack:configure', () => {
    expect(() => loadEnv('/nonexistent')).toThrow('/slack:configure');
  });

  test('returns empty object for file with only comments', () => {
    const path = writeEnv('# comment 1\n# comment 2\n');
    const env = loadEnv(path);
    expect(Object.keys(env).length).toBe(0);
  });

  test('ignores lines without = delimiter', () => {
    const path = writeEnv('VALID=yes\nINVALID_LINE\nALSO_VALID=true');
    const env = loadEnv(path);
    expect(env.VALID).toBe('yes');
    expect(env.ALSO_VALID).toBe('true');
    expect(env.INVALID_LINE).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// stripMentions
// ---------------------------------------------------------------------------

describe('stripMentions', () => {
  test('strips a single mention', () => {
    expect(stripMentions('<@U0123ABC> hello')).toBe('hello');
  });

  test('strips multiple mentions', () => {
    expect(stripMentions('<@U0123ABC> <@U9876DEF> check this')).toBe(
      'check this',
    );
  });

  test('returns text unchanged when no mentions', () => {
    expect(stripMentions('just a message')).toBe('just a message');
  });

  test('returns empty string when only mention', () => {
    expect(stripMentions('<@U0123ABC>')).toBe('');
  });

  test('handles mention at end of text', () => {
    expect(stripMentions('hello <@U0123ABC> ')).toBe('hello');
  });

  test('handles empty input', () => {
    expect(stripMentions('')).toBe('');
  });

  test('preserves non-mention angle brackets', () => {
    expect(stripMentions('use <code> blocks')).toBe('use <code> blocks');
  });
});

// ---------------------------------------------------------------------------
// MENTION_RE
// ---------------------------------------------------------------------------

describe('MENTION_RE', () => {
  test('matches standard Slack user mention format', () => {
    expect(MENTION_RE.test('<@U0123ABC>')).toBe(true);
  });

  test('matches mention with trailing space', () => {
    MENTION_RE.lastIndex = 0;
    const match = '<@U0123ABC> text'.match(MENTION_RE);
    expect(match).not.toBeNull();
    expect(match![0]).toBe('<@U0123ABC> ');
  });

  test('does not match channel references', () => {
    MENTION_RE.lastIndex = 0;
    expect(MENTION_RE.test('<#C0123>')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// textResult
// ---------------------------------------------------------------------------

describe('textResult', () => {
  test('wraps text in MCP-compatible content array', () => {
    const result = textResult('hello');
    expect(result).toEqual({
      content: [{ type: 'text', text: 'hello' }],
    });
  });

  test('handles empty text', () => {
    const result = textResult('');
    expect(result.content[0].text).toBe('');
  });
});
