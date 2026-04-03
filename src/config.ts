import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const LOG_PREFIX = '[slack-channel]';

export const DEBUG_LOG = process.env.SLACK_CHANNEL_DEBUG === '1';

export function log(message: string): void {
  console.error(`${LOG_PREFIX} ${message}`);
  if (DEBUG_LOG) {
    const line = `${new Date().toISOString()} ${LOG_PREFIX} ${message}\n`;
    try { appendFileSync(`${CHANNELS_DIR}/debug.log`, line); } catch {}
  }
}

export function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

export const MENTION_RE = /<@[A-Z0-9]+>\s*/g;

export function stripMentions(text: string): string {
  return text.replace(MENTION_RE, '').trim();
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const CHANNELS_DIR = join(homedir(), '.claude', 'channels', 'slack');
export const ENV_PATH = join(CHANNELS_DIR, '.env');
export const SESSION_PATH = join(CHANNELS_DIR, 'session.json');
export const LOCK_PATH = join(CHANNELS_DIR, 'server.lock');

export function ensureChannelsDir(): void {
  if (!existsSync(CHANNELS_DIR)) mkdirSync(CHANNELS_DIR, { recursive: true });
}

export function loadEnv(path: string): Record<string, string> {
  if (!existsSync(path)) {
    throw new Error(
      `Missing config: ${path}\nRun /slack:configure to set up tokens.`,
    );
  }
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    out[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
  }
  return out;
}
