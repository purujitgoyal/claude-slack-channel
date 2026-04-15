// Prevent tests from writing to the real plugin debug log
// (~/.claude/channels/slack/debug.log).
process.env.SLACK_CHANNEL_DEBUG = '0';
