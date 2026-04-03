#!/usr/bin/env bun
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { log, loadEnv, ENV_PATH } from './src/config.ts';
import { saveSession, setActiveThreadTs } from './src/session.ts';
import { acquireLock, releaseLock } from './src/lock.ts';
import { mcp, setSlackBridge, setChannelActive, isChannelActive } from './src/mcp.ts';
import { startSlack, stopSlack, postThreaded } from './src/slack.ts';

// ---------------------------------------------------------------------------
// Lazy activation — only when client negotiates claude/channel support
// ---------------------------------------------------------------------------

async function activate(): Promise<void> {
  const env = loadEnv(ENV_PATH);
  const botToken = env.SLACK_BOT_TOKEN ?? '';
  const appToken = env.SLACK_APP_TOKEN ?? '';
  const allowedUserId = env.ALLOWED_SLACK_USER_ID ?? '';
  const channelId = env.SLACK_CHANNEL_ID ?? '';

  if (!botToken || !appToken || !allowedUserId || !channelId) {
    throw new Error(
      'SLACK_BOT_TOKEN, SLACK_APP_TOKEN, ALLOWED_SLACK_USER_ID, and SLACK_CHANNEL_ID must all be set in ' +
        ENV_PATH,
    );
  }

  acquireLock();

  setActiveThreadTs(null);
  saveSession({ threadTs: null });

  const app = await startSlack({ mcp, botToken, appToken, channelId, allowedUserId });

  setSlackBridge({
    postThreaded,
    addReaction: (ch, name, ts) =>
      app.client.reactions.add({ channel: ch, name, timestamp: ts }).then(() => {}),
    channelId,
  });

  setChannelActive(true);
  await mcp.sendToolListChanged();
  log(`channel activated — ${channelId}`);
}

mcp.oninitialized = () => {
  const caps = mcp.getClientCapabilities();
  const hasChannel = caps?.experimental?.['claude/channel'] != null;
  const envActivate = process.env.SLACK_CHANNEL_ACTIVATE === '1';
  if (!hasChannel && !envActivate) {
    log('channel not requested — staying dormant');
    return;
  }
  log(`activating (channel=${hasChannel}, env=${envActivate})`);
  activate().catch((err) => {
    log(`activation failed: ${err}`);
  });
};

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdownGracefully() {
  if (isChannelActive()) saveSession({ threadTs: null });
  releaseLock();
  stopSlack().finally(() => process.exit(0));
}

process.on('SIGINT', shutdownGracefully);
process.on('SIGTERM', shutdownGracefully);
process.stdin.on('close', shutdownGracefully);

// ---------------------------------------------------------------------------
// Connect MCP transport
// ---------------------------------------------------------------------------

await mcp.connect(new StdioServerTransport());
log('MCP connected — waiting for channel activation');
