#!/usr/bin/env node
// Web Terminal hook — called by Claude Code via settings.local.json
// Sends status updates to the web terminal server.

const http = require('http');

const sessionId = process.env.WEB_TERMINAL_SESSION_ID;
if (!sessionId) process.exit(0);

const port = process.env.WEB_TERMINAL_PORT || 3000;
let defaultStatus = process.argv[2] || 'working';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  // Override: AskUserQuestion → waiting (user needs to respond)
  if (defaultStatus === 'working') {
    const toolMatch = input.match(/"tool_name"\s*:\s*"([^"]+)"/);
    const toolName = toolMatch ? toolMatch[1] : '';
    if (['AskUserQuestion'].includes(toolName)) {
      defaultStatus = 'waiting';
    }
  }

  const body = JSON.stringify({ sessionId, status: defaultStatus });
  const req = http.request({
    hostname: 'localhost',
    port,
    path: '/api/hook/status',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, () => process.exit(0));

  req.on('error', () => process.exit(0));
  req.write(body);
  req.end();
});
