import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const LOG_PREFIX = '[slack-channel]';

export const DEBUG_LOG = process.env.SLACK_CHANNEL_DEBUG === '1';

export function log(message: string): void {
  console.error(`${LOG_PREFIX} ${message}`);
  if (DEBUG_LOG) {
    const line = `${new Date().toISOString()} ${LOG_PREFIX} ${message}\n`;
    try {
      appendFileSync(`${CHANNELS_DIR}/debug.log`, line);
    } catch {}
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
// Format raw JSON input_preview into a readable one-liner for confirmations
// ---------------------------------------------------------------------------

const PREVIEW_MAX = 2500; // Slack section block mrkdwn limit is 3000; leave room for formatting

function truncate(s: string, max: number = PREVIEW_MAX): string {
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

import type { KnownBlock } from '@slack/types';

export function codePreviewBlock(preview: string): KnownBlock[] {
  if (!preview) return [];
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `\`\`\`\n${preview}\n\`\`\`` },
    },
  ];
}

export function buildPermissionBlocks(
  requestId: string,
  toolName: string,
  description: string,
  preview: string,
): any[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Claude wants to use \`${toolName}\`*\n${description}`,
      },
    },
    ...codePreviewBlock(preview),
    {
      type: 'actions',
      block_id: `permission_${requestId}`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Allow' },
          style: 'primary',
          action_id: `allow_${requestId}`,
          value: `allow:${requestId}`,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Deny' },
          style: 'danger',
          action_id: `deny_${requestId}`,
          value: `deny:${requestId}`,
        },
      ],
    },
  ];
}

export function formatInputPreview(toolName: string, raw: string): string {
  try {
    const obj = JSON.parse(raw);
    switch (toolName) {
      case 'Bash':
        return truncate(obj.command ?? raw);
      case 'Write':
      case 'Read':
      case 'Glob':
        return truncate(obj.file_path ?? obj.pattern ?? raw);
      case 'Edit':
        return truncate(obj.file_path ?? raw);
      case 'Grep':
        return obj.pattern ? truncate(`/${obj.pattern}/`) : truncate(raw);
      default:
        // For unknown tools, show first string value as a hint
        for (const v of Object.values(obj)) {
          if (typeof v === 'string' && v.length > 0) return truncate(v);
        }
        return truncate(raw);
    }
  } catch {
    return truncate(raw);
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const CHANNELS_DIR = join(homedir(), '.claude', 'channels', 'slack');
export const ENV_PATH = join(CHANNELS_DIR, '.env');
export const SESSION_PATH = join(CHANNELS_DIR, 'session.json');
export const LOCK_PATH = join(CHANNELS_DIR, 'server.lock');
export const SOCKET_PATH = join(CHANNELS_DIR, 'primary.sock');

/**
 * Returns a human-readable session label: `basename(cwd):git-branch`.
 * Falls back to just `basename(cwd)` if not in a git repo or git fails.
 * Sanitized: trimmed, backticks stripped, truncated to 60 chars.
 */
export function getSessionLabel(): string {
  const cwd = process.cwd();
  const base = basename(cwd);

  let branch = '';
  try {
    const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      timeout: 3000,
    });
    if (result.status === 0 && result.stdout) {
      branch = result.stdout.toString().trim();
    }
  } catch {
    // Not a git repo or git not available — fall back to just basename
  }

  let label = branch ? `${base}:${branch}` : base;
  label = label.replace(/`/g, '').trim();
  if (label.length > 60) label = label.slice(0, 60);
  return label;
}

export function ensureChannelsDir(): void {
  mkdirSync(CHANNELS_DIR, { recursive: true });
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
