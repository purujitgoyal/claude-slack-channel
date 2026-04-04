#!/usr/bin/env bun
/**
 * Connection Diagnostics Script
 *
 * Long-running script that monitors the Slack Socket Mode connection and logs
 * all lifecycle events with timestamps and details. Use this to investigate
 * connection drops in real-world conditions.
 *
 * Usage:
 *   bun test/diagnose.ts                    # Monitor indefinitely
 *   bun test/diagnose.ts --duration 300     # Monitor for 5 minutes
 *   bun test/diagnose.ts --block 8000       # Simulate 8s event loop block
 *
 * Output: Logs to stderr + writes JSON report to test/diagnostics-report.json
 */

import { writeFileSync } from 'node:fs';
import { App } from '@slack/bolt';
import { loadEnv, ENV_PATH, log } from '../src/config';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const durationMs = getArg('--duration', 0) * 1000; // 0 = indefinite
const blockMs = getArg('--block', 0); // simulate event loop block

function getArg(flag: string, defaultVal: number): number {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return defaultVal;
  return parseInt(args[idx + 1], 10) || defaultVal;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const env = loadEnv(ENV_PATH);
const botToken = env.SLACK_BOT_TOKEN;
const appToken = env.SLACK_APP_TOKEN;
const channelId = env.SLACK_CHANNEL_ID;

if (!botToken || !appToken || !channelId) {
  console.error('Missing tokens in', ENV_PATH);
  process.exit(1);
}

interface Event {
  time: number;
  elapsed: string;
  event: string;
  detail?: string;
  wsReadyState?: number;
  wsCloseCode?: number;
  wsCloseReason?: string;
}

const events: Event[] = [];
const startTime = Date.now();

function elapsed(): string {
  const ms = Date.now() - startTime;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m${s % 60}s`;
}

function record(event: string, detail?: string, extra?: Partial<Event>) {
  const entry: Event = {
    time: Date.now() - startTime,
    elapsed: elapsed(),
    event,
    detail,
    ...extra,
  };
  events.push(entry);
  console.error(`[${entry.elapsed}] ${event}${detail ? ` — ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
// Create App and monitor
// ---------------------------------------------------------------------------

const app = new App({
  token: botToken,
  appToken,
  socketMode: true,
  logLevel: 'warn' as any,
});

const sc = (app.receiver as any).client;

// Connection lifecycle events
sc.on('connecting', () => record('connecting'));
sc.on('connected', () => {
  const ws = sc.websocket;
  record('connected', undefined, { wsReadyState: ws?.readyState });
});
sc.on('reconnecting', () => record('reconnecting'));
sc.on('disconnecting', () => record('disconnecting'));
sc.on('disconnected', (err?: Error) => {
  const ws = sc.websocket;
  record('disconnected', err?.message, {
    wsReadyState: ws?.readyState,
  });
});
sc.on('error', (err: any) => {
  record('error', err?.original?.message ?? err?.message ?? String(err));
});

// WebSocket-level events (attached after connection)
function attachWsMonitoring() {
  const ws = sc.websocket;
  if (!ws) return;

  ws.on('close', (code: number, reason: Buffer) => {
    record('ws:close', `code=${code} reason=${reason?.toString() || '(none)'}`, {
      wsCloseCode: code,
      wsCloseReason: reason?.toString(),
    });
  });

  ws.on('error', (err: Error) => {
    record('ws:error', err.message);
  });

  ws.on('unexpected-response', (_req: any, res: any) => {
    record('ws:unexpected-response', `status=${res?.statusCode}`);
  });

  // Track ping/pong frequency
  let lastPing = Date.now();
  ws.on('ping', () => {
    const gap = Date.now() - lastPing;
    lastPing = Date.now();
    record('ws:ping', `gap=${gap}ms`);
  });

  ws.on('pong', () => {
    record('ws:pong');
  });
}

// Re-attach WebSocket monitoring on each reconnect
sc.on('connected', attachWsMonitoring);

// ---------------------------------------------------------------------------
// Event loop latency monitoring
// ---------------------------------------------------------------------------

let eventLoopCheckInterval: ReturnType<typeof setInterval>;

function startEventLoopMonitor() {
  let lastCheck = Date.now();
  eventLoopCheckInterval = setInterval(() => {
    const now = Date.now();
    const delta = now - lastCheck - 1000; // expected 1000ms interval
    if (delta > 100) {
      record('event-loop-lag', `${delta}ms (expected 0ms)`);
    }
    lastCheck = now;
  }, 1000);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.error('='.repeat(60));
  console.error('Slack Connection Diagnostics');
  console.error(`Duration: ${durationMs ? `${durationMs / 1000}s` : 'indefinite (Ctrl+C to stop)'}`);
  if (blockMs) console.error(`Will simulate ${blockMs}ms event loop block after 10s`);
  console.error('='.repeat(60));

  record('starting');
  await app.start();
  record('started', `channel=${channelId}`);

  // Report SocketModeClient config
  console.error('\nSocketModeClient config:');
  console.error(`  autoReconnectEnabled: ${sc.autoReconnectEnabled ?? true}`);
  console.error(`  clientPingTimeout: ${sc.clientPingTimeoutMillis ?? 5000}ms`);
  console.error(`  serverPingTimeout: ${sc.serverPingTimeoutMillis ?? 30000}ms`);
  console.error('');

  startEventLoopMonitor();
  attachWsMonitoring();

  // Simulate event loop block if requested
  if (blockMs) {
    setTimeout(() => {
      record('blocking-event-loop', `${blockMs}ms`);
      const start = Date.now();
      while (Date.now() - start < blockMs) {
        // busy wait
      }
      record('block-released', `actual=${Date.now() - start}ms`);
    }, 10_000);
  }

  // Run for duration or until interrupted
  if (durationMs) {
    await Bun.sleep(durationMs);
    await shutdown();
  } else {
    // Run until SIGINT/SIGTERM
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}

async function shutdown() {
  record('shutting-down');
  clearInterval(eventLoopCheckInterval);

  try {
    await app.stop();
    record('stopped');
  } catch (err) {
    record('stop-error', String(err));
  }

  // Write report
  const report = {
    startTime: new Date(startTime).toISOString(),
    duration: elapsed(),
    totalEvents: events.length,
    disconnects: events.filter((e) => e.event === 'disconnected').length,
    reconnects: events.filter((e) => e.event === 'connected').length,
    errors: events.filter((e) => e.event === 'error' || e.event === 'ws:error').length,
    eventLoopLags: events.filter((e) => e.event === 'event-loop-lag').length,
    events,
  };

  const reportPath = new URL('./diagnostics-report.json', import.meta.url).pathname;
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.error(`\nReport written to ${reportPath}`);

  // Summary
  console.error('\n' + '='.repeat(60));
  console.error('Summary:');
  console.error(`  Duration: ${report.duration}`);
  console.error(`  Disconnects: ${report.disconnects}`);
  console.error(`  Reconnects: ${report.reconnects}`);
  console.error(`  Errors: ${report.errors}`);
  console.error(`  Event loop lags >100ms: ${report.eventLoopLags}`);
  console.error('='.repeat(60));

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
