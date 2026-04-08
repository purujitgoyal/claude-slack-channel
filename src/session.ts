import { writeFileSync } from 'node:fs';
import { ensureChannelsDir, log, SESSION_PATH } from './config.ts';

// ---------------------------------------------------------------------------
// Session persistence
// ---------------------------------------------------------------------------
// Persisted shape: { threadTs, lastSeenEventTs }
//
// threadTs — the active Slack thread for the current Claude session. Reset to
//   null on every activation so any stale ts from a prior crash is cleared.
//   The authoritative reset lives in activate(); cleanup() also clears it as
//   a belt-and-suspenders measure.
//
// lastSeenEventTs — a Slack event_ts high-water-mark cursor used by the outage
//   recovery path to replay missed messages. MUST NOT reset on activation —
//   only threadTs resets. The cursor advances as inbound messages arrive and
//   survives across sessions so recovery can pick up where the bridge left off.
// ---------------------------------------------------------------------------

export function saveSession(state: {
  threadTs: string | null;
  lastSeenEventTs: string | null;
}): void {
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
// lastSeenEventTs — Slack event_ts high-water-mark cursor for outage recovery
// ---------------------------------------------------------------------------
// Initialized to null on startup. Populated as inbound messages arrive.
// The setter immediately persists the new cursor alongside the current
// threadTs so the value survives process restarts.
// ---------------------------------------------------------------------------

let lastSeenEventTs: string | null = null;

export function getLastSeenEventTs(): string | null {
  return lastSeenEventTs;
}

export function setLastSeenEventTs(ts: string | null): void {
  lastSeenEventTs = ts;
  saveSession({ threadTs: activeThreadTs, lastSeenEventTs: ts });
}

// ---------------------------------------------------------------------------
// Permission state — tracks which permission requests have been resolved
// ---------------------------------------------------------------------------

export const resolvedPermissions = new Set<string>();

// ---------------------------------------------------------------------------
// Pending permission details — populated on request, consumed on verdict
// ---------------------------------------------------------------------------

export const pendingPermissions = new Map<
  string,
  { tool_name: string; description: string; input_preview: string }
>();
