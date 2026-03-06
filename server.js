const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Session store: Map<id, { pty, status, name }>
const sessions = new Map();
let nextId = 1;

const HOOK_SCRIPT = path.join(__dirname, 'hook.js');
const PORT = process.env.PORT || 3100;

// --- Hooks injection into .claude/settings.local.json ---

function ourHookEntry(status) {
  return { matcher: '', hooks: [{ type: 'command', command: `node ${HOOK_SCRIPT} ${status}` }] };
}

function isOurEntry(entry) {
  return entry?.hooks?.some((h) => /node\s+.*hook\.js\s+(working|waiting|done)/.test(h.command));
}

function countSessionsForCwd(cwd) {
  let count = 0;
  for (const [, s] of sessions) {
    if (s.cwd === cwd) count++;
  }
  return count;
}

function readLocalSettings(cwd) {
  const p = path.join(cwd, '.claude', 'settings.local.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function writeLocalSettings(cwd, data) {
  const claudeDir = path.join(cwd, '.claude');
  const p = path.join(claudeDir, 'settings.local.json');
  if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}

function injectHooks(cwd) {
  try {
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return;
  } catch { return; }

  const data = readLocalSettings(cwd) || {};
  if (!data.hooks) data.hooks = {};

  const events = { PreToolUse: 'working', Notification: 'waiting', Stop: 'done' };
  for (const [event, status] of Object.entries(events)) {
    const list = data.hooks[event] || [];
    if (!list.some(isOurEntry)) {
      list.push(ourHookEntry(status));
    }
    data.hooks[event] = list;
  }

  writeLocalSettings(cwd, data);
}

function removeHooks(cwd) {
  // Don't remove if other sessions still use this cwd
  if (countSessionsForCwd(cwd) > 0) return;

  const data = readLocalSettings(cwd);
  if (!data || !data.hooks) return;

  // Remove only our entries from each event
  for (const event of Object.keys(data.hooks)) {
    const list = data.hooks[event];
    if (!Array.isArray(list)) continue;
    data.hooks[event] = list.filter((entry) => !isOurEntry(entry));
    if (data.hooks[event].length === 0) delete data.hooks[event];
  }

  // Clean up empty hooks object
  if (Object.keys(data.hooks).length === 0) delete data.hooks;

  const p = path.join(cwd, '.claude', 'settings.local.json');
  if (Object.keys(data).length === 0) {
    try { fs.unlinkSync(p); } catch {}
  } else {
    writeLocalSettings(cwd, data);
  }
}

// --- REST API ---

app.get('/api/sessions', (req, res) => {
  const list = [];
  for (const [id, s] of sessions) {
    list.push({ id, status: s.status, name: s.name });
  }
  res.json(list);
});

app.post('/api/sessions', (req, res) => {
  const id = String(nextId++);
  const name = req.body?.name || `Session ${id}`;
  const cwd = req.body?.cwd;
  if (!cwd) return res.status(400).json({ error: 'cwd is required' });
  const cmd = req.body?.cmd || 'claude';
  const args = req.body?.args || [];

  // Inject hooks before spawning claude
  injectHooks(cwd);

  const ptyProcess = pty.spawn(cmd, args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      WEB_TERMINAL_SESSION_ID: id,
      WEB_TERMINAL_PORT: String(PORT),
    },
  });

  const session = {
    pty: ptyProcess,
    status: 'idle',
    name,
    cwd,
  };
  sessions.set(id, session);

  // Forward pty output to all connected clients subscribed to this session
  ptyProcess.onData((data) => {
    io.to(`session:${id}`).emit('terminal.output', { sessionId: id, data });
  });

  ptyProcess.onExit(({ exitCode }) => {
    io.to(`session:${id}`).emit('session.exit', { sessionId: id, exitCode });
    sessions.delete(id);
    removeHooks(cwd);
    io.emit('sessions.changed');
  });

  io.emit('sessions.changed');
  res.json({ id, name, status: session.status });
});

app.delete('/api/sessions/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  session.pty.kill();
  sessions.delete(req.params.id);
  removeHooks(session.cwd);
  io.emit('sessions.changed');
  res.json({ ok: true });
});

// --- Project API ---

app.get('/api/projects', (req, res) => {
  const projects = db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
  res.json(projects);
});

app.post('/api/projects', (req, res) => {
  const { name, directory } = req.body;
  if (!name || !directory) {
    return res.status(400).json({ error: 'name and directory are required' });
  }
  if (!fs.existsSync(directory)) {
    return res.status(400).json({ error: 'Directory does not exist' });
  }
  try {
    const result = db.prepare('INSERT INTO projects (name, directory) VALUES (?, ?)').run(name, directory);
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(result.lastInsertRowid);
    res.json(project);
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Directory already registered' });
    }
    throw e;
  }
});

app.delete('/api/projects/:id', (req, res) => {
  const result = db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Project not found' });
  res.json({ ok: true });
});

// --- Hooks endpoint ---

app.post('/api/hook/status', (req, res) => {
  const { sessionId, status } = req.body;

  if (!sessionId || !sessions.has(sessionId)) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const session = sessions.get(sessionId);
  if (status && ['working', 'waiting', 'done'].includes(status)) {
    // Ignore "waiting" if "done" was set very recently (Stop fires before Notification on task completion)
    if (status === 'waiting' && session.status === 'done' && session.doneAt && Date.now() - session.doneAt < 1000) {
      return res.json({ ok: true, sessionId, status: session.status });
    }

    session.status = status;
    if (status === 'done') session.doneAt = Date.now();
    io.emit('session.status', { sessionId, status });
  }

  res.json({ ok: true, sessionId, status: session.status });
});

// --- WebSocket ---

io.on('connection', (socket) => {
  socket.on('session.join', (sessionId) => {
    socket.join(`session:${sessionId}`);
  });

  socket.on('session.leave', (sessionId) => {
    socket.leave(`session:${sessionId}`);
  });

  socket.on('terminal.input', ({ sessionId, data }) => {
    const session = sessions.get(sessionId);
    if (session) {
      session.pty.write(data);
    }
  });

  socket.on('terminal.resize', ({ sessionId, cols, rows }) => {
    const session = sessions.get(sessionId);
    if (session) {
      session.pty.resize(cols, rows);
    }
  });
});

// --- Cleanup on server shutdown ---

function cleanupAll() {
  for (const [, session] of sessions) {
    removeHooks(session.cwd);
    session.pty.kill();
  }
  sessions.clear();
}

process.on('SIGINT', () => { cleanupAll(); process.exit(0); });
process.on('SIGTERM', () => { cleanupAll(); process.exit(0); });

// --- Start ---

// Clean up stale hooks from all registered projects on startup
function cleanupStaleHooks() {
  const projects = db.prepare('SELECT directory FROM projects').all();
  for (const { directory } of projects) {
    removeHooks(directory);
  }
  console.log(`Cleaned up hooks for ${projects.length} projects`);
}

cleanupStaleHooks();

server.listen(PORT, () => {
  console.log(`Web Terminal Manager running at http://localhost:${PORT}`);
});
