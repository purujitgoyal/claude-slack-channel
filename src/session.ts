import { writeFileSync } from 'node:fs';
import { SESSION_PATH, ensureChannelsDir, log } from './config.ts';

// ---------------------------------------------------------------------------
// Session persistence
// ---------------------------------------------------------------------------
// Each Claude Code session gets its own Slack thread. threadTs is persisted to
// disk so that mid-session tools (reply, new_thread) can find the active thread
// after an @mention or old-thread-reply changes it. On activation, any stale
// threadTs from a prior crash is cleared — the authoritative reset lives in
// activate(), not cleanup(), so it runs regardless of how the previous session
// ended. cleanup() also clears it as a belt-and-suspenders measure.
// ---------------------------------------------------------------------------

export function saveSession(state: { threadTs: string | null }): void {
  try {
    ensureChannelsDir();
    writeFileSync(SESSION_PATH, JSON.stringify(state), 'utf8');
  } catch (err) {
    log(`failed to save session state: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Mutable thread state — exposed via getter/setter for ESM compatibility
// ---------------------------------------------------------------------------
// ESM does not allow importers to reassign a module's `let` export directly.
// Using getter/setter functions gives callers a stable API that works across
// both mcp.ts (tool handlers) and slack.ts (Bolt handlers).
// ---------------------------------------------------------------------------

let activeThreadTs: string | null = null;

export function getActiveThreadTs(): string | null {
  return activeThreadTs;
}

export function setActiveThreadTs(ts: string | null): void {
  activeThreadTs = ts;
}

// ---------------------------------------------------------------------------
// Permission state — tracks which permission requests have been resolved
// ---------------------------------------------------------------------------

export const resolvedPermissions = new Set<string>();
