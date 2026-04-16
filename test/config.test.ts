/**
 * Config Utility Tests
 *
 * Tests pure utility functions from src/config.ts — env loading,
 * mention stripping, path constants.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getSessionLabel,
  loadEnv,
  MENTION_RE,
  SOCKET_PATH,
  stripMentions,
  textResult,
} from '../src/config';

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

// ---------------------------------------------------------------------------
// SOCKET_PATH
// ---------------------------------------------------------------------------

describe('SOCKET_PATH', () => {
  test('ends with primary.sock', () => {
    expect(SOCKET_PATH).toMatch(/primary\.sock$/);
  });

  test('is under CHANNELS_DIR', () => {
    expect(SOCKET_PATH).toContain('.claude/channels/slack/');
  });
});

// ---------------------------------------------------------------------------
// getSessionLabel
// ---------------------------------------------------------------------------

describe('getSessionLabel', () => {
  test('returns a non-empty string', () => {
    const label = getSessionLabel();
    expect(label.length).toBeGreaterThan(0);
  });

  test('includes basename of cwd', () => {
    const cwd = process.cwd();
    const base = cwd.split('/').pop()!;
    const label = getSessionLabel();
    expect(label).toContain(base);
  });

  test('includes git branch when in a git repo', () => {
    // This test runs inside the claude-slack-channel repo,
    // so it should have a branch name
    const label = getSessionLabel();
    expect(label).toContain(':');
  });

  test('strips backticks', () => {
    const label = getSessionLabel();
    expect(label).not.toContain('`');
  });

  test('does not exceed 60 characters', () => {
    const label = getSessionLabel();
    expect(label.length).toBeLessThanOrEqual(60);
  });
});
