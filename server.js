const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { init: initDb, getDb } = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const TMP_IMAGES_DIR = path.join(__dirname, 'tmp', 'images');

// Multer storage configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const taskDir = path.join(TMP_IMAGES_DIR, req.params.taskId);
    fs.mkdirSync(taskDir, { recursive: true });
    cb(null, taskDir);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    cb(null, `${timestamp}_${originalName}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/attachments', express.static(TMP_IMAGES_DIR));

// Session store: Map<id, { pty, status, name, cwd, projectId }>
const sessions = new Map();
let nextId = 1;

const HOOK_SCRIPT = path.join(__dirname, 'hook.js').replace(/\\/g, '/');
const PORT = process.env.PORT || 3100;

// --- Hooks injection into .claude/settings.local.json ---

function ourHookEntry(status, event) {
  return { matcher: '', hooks: [{ type: 'command', command: `node ${HOOK_SCRIPT} ${status} ${event}` }] };
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

  const events = { PreToolUse: 'working', PermissionRequest: 'waiting', Notification: 'done', Stop: 'done' };
  for (const [event, status] of Object.entries(events)) {
    const list = data.hooks[event] || [];
    if (!list.some(isOurEntry)) {
      list.push(ourHookEntry(status, event));
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

// --- Permissions injection into .claude/settings.local.json ---

const TMPDIR = require('os').tmpdir().replace(/\\/g, '/');

function ourPermissionEntries() {
  return [
    `Bash(curl * http://localhost:${PORT}/api/*)`,
    'Bash(cd:*)',
    'Bash(CONTAINER=:*)',
    `Read(${TMPDIR}/*)`,
    `Edit(${TMPDIR}/*)`,
    `Write(${TMPDIR}/*)`,
    `Bash(mv ${TMPDIR}/*)`,
    `Bash(cp ${TMPDIR}/*)`,
    `Bash(rm ${TMPDIR}/*)`,
    `Bash(mkdir ${TMPDIR}/*)`,
    'Bash(find:*)',
    'Bash(ls:*)',
  ];
}

function isOurPermission(entry) {
  return /^Bash\(curl \* http:\/\/localhost:\d+\/api\/\*\)$/.test(entry) ||
    ourPermissionEntries().includes(entry);
}

function injectPermissions(cwd) {
  try {
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return;
  } catch { return; }

  const data = readLocalSettings(cwd) || {};
  if (!data.permissions) data.permissions = {};
  const allow = data.permissions.allow || [];

  const toAdd = ourPermissionEntries().filter((e) => !allow.includes(e));
  if (toAdd.length === 0) return;

  data.permissions.allow = [...allow, ...toAdd];
  writeLocalSettings(cwd, data);
}

function removePermissions(cwd) {
  // Don't remove if other sessions still use this cwd
  if (countSessionsForCwd(cwd) > 0) return;

  const data = readLocalSettings(cwd);
  if (!data || !data.permissions || !Array.isArray(data.permissions.allow)) return;

  data.permissions.allow = data.permissions.allow.filter((entry) => !isOurPermission(entry));

  // Clean up empty structures
  if (data.permissions.allow.length === 0) delete data.permissions.allow;
  if (Object.keys(data.permissions).length === 0) delete data.permissions;

  const p = path.join(cwd, '.claude', 'settings.local.json');
  if (Object.keys(data).length === 0) {
    try { fs.unlinkSync(p); } catch {}
  } else {
    writeLocalSettings(cwd, data);
  }
}

// --- Task skill injection ---

const SKILL_MARKER = 'managed-by: claude-management';

function generateSkillContent(projectId) {
  return `---
name: task-management
managed-by: claude-management
description: >
  プロジェクトのタスク管理を行います。
  タスクの一覧取得、ステータス更新、新規作成が可能です。
  「タスク」「task」「作業」「TODO」などのキーワードで発動します。
---

# タスク管理スキル

プロジェクトのタスクをAPI経由で管理する。

## API情報
- ベースURL: http://localhost:${PORT}
- プロジェクトID: ${projectId}

## タスク一覧を取得
curl -s http://localhost:${PORT}/api/projects/${projectId}/tasks

## タスクの作業を開始
1. ステータスを「進行中」に更新:
   curl -s -X PATCH http://localhost:${PORT}/api/tasks/{taskId} \\
     -H "Content-Type: application/json" -d '{"status":"in_progress"}'
2. タスクの内容に従って作業を実施
3. 作業完了後にステータスを「レビュー待ち」に更新:
   curl -s -X PATCH http://localhost:${PORT}/api/tasks/{taskId} \\
     -H "Content-Type: application/json" -d '{"status":"review"}'

## 新規タスク作成
curl -s -X POST http://localhost:${PORT}/api/projects/${projectId}/tasks \\
  -H "Content-Type: application/json" -d '{"title":"タスク名","description":"説明"}'

## タスク更新
curl -s -X PATCH http://localhost:${PORT}/api/tasks/{taskId} \\
  -H "Content-Type: application/json" \\
  -d '{"title":"新タイトル","description":"新説明","status":"todo|in_progress|review|done"}'

## 子タスク作成
curl -s -X POST http://localhost:${PORT}/api/projects/${projectId}/tasks \\
  -H "Content-Type: application/json" -d '{"title":"子タスク名","parent_id":{parentId}}'

## 引数なしで呼ばれた場合
タスク一覧を取得して表示し、ユーザーにどのタスクを作業するか確認する。

## 重要
- 作業開始前に必ずステータスを in_progress に更新すること
- 作業完了後は必ずステータスを review に更新すること（ユーザーレビュー待ち）
- レビュー承認後、ユーザーまたはレビュワーが done に更新する
`;
}

function injectTaskSkill(cwd, projectId) {
  if (!projectId) return;
  try {
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return;
  } catch { return; }

  const skillDir = path.join(cwd, '.claude', 'skills', 'task-management');
  const skillFile = path.join(skillDir, 'SKILL.md');

  // Don't overwrite user-created skill files
  if (fs.existsSync(skillFile)) {
    try {
      const content = fs.readFileSync(skillFile, 'utf-8');
      if (!content.includes(SKILL_MARKER)) return;
    } catch { return; }
  }

  if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(skillFile, generateSkillContent(projectId));
}

function removeTaskSkill(cwd) {
  if (countSessionsForCwd(cwd) > 0) return;

  const skillFile = path.join(cwd, '.claude', 'skills', 'task-management', 'SKILL.md');
  if (!fs.existsSync(skillFile)) return;

  try {
    const content = fs.readFileSync(skillFile, 'utf-8');
    if (!content.includes(SKILL_MARKER)) return;
    fs.unlinkSync(skillFile);

    // Clean up empty directories
    const skillDir = path.join(cwd, '.claude', 'skills', 'task-management');
    if (fs.existsSync(skillDir) && fs.readdirSync(skillDir).length === 0) {
      fs.rmdirSync(skillDir);
    }
  } catch {}
}

// --- REST API ---

app.get('/api/sessions', (req, res) => {
  const list = [];
  for (const [id, s] of sessions) {
    list.push({ id, status: s.status, name: s.name, projectId: s.projectId });
  }
  res.json(list);
});

app.post('/api/sessions', (req, res) => {
  const id = String(nextId++);
  const name = req.body?.name || `Session ${id}`;
  const cwd = req.body?.cwd;
  if (!cwd) return res.status(400).json({ error: 'cwd is required' });
  let cmd = req.body?.cmd || 'claude';
  const args = req.body?.args || [];

  // On Windows, node-pty needs the full path or .exe extension to find the executable
  if (process.platform === 'win32' && !cmd.includes('.') && !path.isAbsolute(cmd)) {
    const { execSync } = require('child_process');
    try {
      const resolved = execSync(`where ${cmd}`, { encoding: 'utf-8' }).trim().split(/\r?\n/)[0];
      if (resolved) cmd = resolved;
    } catch {}
  }

  // Resolve projectId: from request or lookup by cwd
  let projectId = req.body?.projectId || null;
  if (!projectId) {
    const project = process.platform === 'win32'
      ? getDb().prepare('SELECT id FROM projects WHERE LOWER(directory) = LOWER(?)').get(cwd)
      : getDb().prepare('SELECT id FROM projects WHERE directory = ?').get(cwd);
    if (project) projectId = project.id;
  }

  // Inject hooks, permissions and skill before spawning claude
  injectHooks(cwd);
  injectPermissions(cwd);
  injectTaskSkill(cwd, projectId);

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
    projectId,
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
    removePermissions(cwd);
    removeTaskSkill(cwd);
    io.emit('sessions.changed');
  });

  io.emit('sessions.changed');
  res.json({ id, name, status: session.status, projectId });
});

app.delete('/api/sessions/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  session.pty.kill();
  sessions.delete(req.params.id);
  removeHooks(session.cwd);
  removePermissions(session.cwd);
  removeTaskSkill(session.cwd);
  io.emit('sessions.changed');
  res.json({ ok: true });
});

// --- Project API ---

app.get('/api/projects', (req, res) => {
  const projects = getDb().prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
  res.json(projects);
});

app.post('/api/projects', (req, res) => {
  const { name, directory, code } = req.body;
  if (!name || !directory || !code) {
    return res.status(400).json({ error: 'name, directory and code are required' });
  }
  if (!/^[A-Za-z0-9_-]+$/.test(code)) {
    return res.status(400).json({ error: 'code must be alphanumeric (a-z, 0-9, -, _)' });
  }
  if (!fs.existsSync(directory)) {
    return res.status(400).json({ error: 'Directory does not exist' });
  }
  try {
    const result = getDb().prepare('INSERT INTO projects (name, directory, code) VALUES (?, ?, ?)').run(name, directory, code);
    const project = getDb().prepare('SELECT * FROM projects WHERE id = ?').get(result.lastInsertRowid);
    res.json(project);
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      const existing = getDb().prepare('SELECT code FROM projects WHERE code = ?').get(code);
      if (existing) return res.status(409).json({ error: 'Project code already exists' });
      return res.status(409).json({ error: 'Directory already registered' });
    }
    throw e;
  }
});

app.patch('/api/projects/:id', (req, res) => {
  const { id } = req.params;
  const project = getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const allowed = ['name', 'code', 'directory', 'notes'];
  const updates = [];
  const values = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      if (key === 'code' && !/^[A-Za-z0-9_-]+$/.test(req.body[key])) {
        return res.status(400).json({ error: 'code must be alphanumeric (a-z, 0-9, -, _)' });
      }
      if (key === 'directory' && !fs.existsSync(req.body[key])) {
        return res.status(400).json({ error: 'Directory does not exist' });
      }
      updates.push(`${key} = ?`);
      values.push(req.body[key]);
    }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  values.push(id);
  try {
    getDb().prepare(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    const updated = getDb().prepare('SELECT * FROM projects WHERE id = ?').get(id);
    res.json(updated);
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Project code already exists' });
    }
    throw e;
  }
});

app.delete('/api/projects/:id', (req, res) => {
  const result = getDb().prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Project not found' });
  res.json({ ok: true });
});

// --- Task API ---

app.get('/api/tasks/all', (req, res) => {
  const allTasks = getDb().prepare(
    `SELECT t.*, p.name as project_name, p.code as project_code
     FROM tasks t JOIN projects p ON t.project_id = p.id
     ORDER BY t.project_id, t.sort_order ASC, t.created_at ASC`
  ).all();
  res.json(allTasks);
});

app.get('/api/projects/:projectId/tasks', (req, res) => {
  const { projectId } = req.params;
  const project = getDb().prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const tasks = getDb().prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY sort_order ASC, created_at ASC').all(projectId);
  res.json(tasks);
});

app.post('/api/projects/:projectId/tasks', (req, res) => {
  const { projectId } = req.params;
  const project = getDb().prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { title, description, parent_id, target_paths } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });

  let depth = 0;
  if (parent_id) {
    const parent = getDb().prepare('SELECT depth FROM tasks WHERE id = ? AND project_id = ?').get(parent_id, projectId);
    if (!parent) return res.status(400).json({ error: 'Parent task not found' });
    depth = parent.depth + 1;
    if (depth > 4) return res.status(400).json({ error: 'Maximum depth (5 levels) exceeded' });
  }

  const maxOrder = getDb().prepare('SELECT MAX(sort_order) as max FROM tasks WHERE project_id = ? AND parent_id IS ?').get(projectId, parent_id || null);
  const sort_order = (maxOrder?.max ?? -1) + 1;

  const targetPathsJson = Array.isArray(target_paths) ? JSON.stringify(target_paths) : null;

  const result = getDb().prepare(
    'INSERT INTO tasks (project_id, parent_id, title, description, depth, sort_order, target_paths) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(projectId, parent_id || null, title, description || '', depth, sort_order, targetPathsJson);

  const task = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(result.lastInsertRowid);
  io.emit('tasks.changed', { projectId: Number(projectId) });
  res.json(task);
});

app.patch('/api/tasks/:taskId', (req, res) => {
  const { taskId } = req.params;
  const task = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const allowed = ['title', 'description', 'status', 'start_date', 'due_date', 'target_paths'];
  const updates = [];
  const values = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      if (key === 'target_paths') {
        updates.push(`${key} = ?`);
        values.push(Array.isArray(req.body[key]) ? JSON.stringify(req.body[key]) : null);
      } else {
        updates.push(`${key} = ?`);
        values.push(req.body[key] === '' ? null : req.body[key]);
      }
    }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  updates.push("updated_at = datetime('now')");
  values.push(taskId);
  getDb().prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  const updated = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  io.emit('tasks.changed', { projectId: updated.project_id });
  res.json(updated);
});

app.patch('/api/tasks/:taskId/move', (req, res) => {
  const { taskId } = req.params;
  const task = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const { parent_id, sort_order } = req.body;
  const newParentId = parent_id === undefined ? task.parent_id : (parent_id || null);

  // Circular reference check: ensure new parent is not a descendant
  if (newParentId) {
    let cur = newParentId;
    while (cur) {
      if (String(cur) === String(taskId)) {
        return res.status(400).json({ error: 'Cannot move a task under its own descendant' });
      }
      const p = getDb().prepare('SELECT parent_id FROM tasks WHERE id = ?').get(cur);
      cur = p ? p.parent_id : null;
    }
  }

  // Calculate new depth
  let newDepth = 0;
  if (newParentId) {
    const parent = getDb().prepare('SELECT depth FROM tasks WHERE id = ?').get(newParentId);
    if (!parent) return res.status(400).json({ error: 'Parent task not found' });
    newDepth = parent.depth + 1;
  }

  // Check depth limit for this task and its subtree
  const maxSubtreeDepth = getMaxSubtreeDepth(taskId, task.depth);
  const depthIncrease = newDepth - task.depth;
  if (maxSubtreeDepth + depthIncrease > 4) {
    return res.status(400).json({ error: 'Maximum depth (5 levels) exceeded' });
  }

  // Update task
  getDb().prepare('UPDATE tasks SET parent_id = ?, depth = ?, sort_order = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(newParentId, newDepth, sort_order ?? 0, taskId);

  // Recursively update children depths
  updateChildDepths(taskId, newDepth);

  const updated = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  io.emit('tasks.changed', { projectId: updated.project_id });
  res.json(updated);
});

function getMaxSubtreeDepth(taskId, currentDepth) {
  let max = currentDepth;
  const children = getDb().prepare('SELECT id, depth FROM tasks WHERE parent_id = ?').all(taskId);
  for (const child of children) {
    const childMax = getMaxSubtreeDepth(child.id, child.depth);
    if (childMax > max) max = childMax;
  }
  return max;
}

function updateChildDepths(parentId, parentDepth) {
  const children = getDb().prepare('SELECT id FROM tasks WHERE parent_id = ?').all(parentId);
  for (const child of children) {
    getDb().prepare('UPDATE tasks SET depth = ? WHERE id = ?').run(parentDepth + 1, child.id);
    updateChildDepths(child.id, parentDepth + 1);
  }
}

// --- Path autocomplete API ---

app.get('/api/projects/:projectId/paths', (req, res) => {
  const { projectId } = req.params;
  const project = getDb().prepare('SELECT directory FROM projects WHERE id = ?').get(projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const query = req.query.q || '';
  const baseDir = project.directory;

  try {
    // Resolve the target directory to list
    const targetDir = query ? path.join(baseDir, query) : baseDir;
    const parentDir = fs.statSync(targetDir).isDirectory() ? targetDir : path.dirname(targetDir);
    const prefix = query && !fs.statSync(targetDir).isDirectory() ? path.basename(query) : '';

    const entries = fs.readdirSync(parentDir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.'))
      .filter((e) => !prefix || e.name.toLowerCase().startsWith(prefix.toLowerCase()))
      .slice(0, 50)
      .map((e) => {
        const relativePath = path.relative(baseDir, path.join(parentDir, e.name)).replace(/\\/g, '/');
        return {
          name: e.name,
          path: relativePath,
          isDirectory: e.isDirectory(),
        };
      })
      .sort((a, b) => {
        // Directories first, then alphabetical
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    res.json(entries);
  } catch {
    res.json([]);
  }
});

app.delete('/api/tasks/:taskId', (req, res) => {
  const { taskId } = req.params;
  const task = getDb().prepare('SELECT project_id FROM tasks WHERE id = ?').get(taskId);

  // Collect all descendant task IDs to clean up attachments
  const taskIdsToClean = [taskId];
  function collectChildIds(parentId) {
    const children = getDb().prepare('SELECT id FROM tasks WHERE parent_id = ?').all(parentId);
    for (const child of children) {
      taskIdsToClean.push(String(child.id));
      collectChildIds(child.id);
    }
  }
  collectChildIds(taskId);

  const result = getDb().prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
  if (result.changes === 0) return res.status(404).json({ error: 'Task not found' });

  // Clean up attachment directories
  for (const id of taskIdsToClean) {
    const dir = path.join(TMP_IMAGES_DIR, id);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  if (task) io.emit('tasks.changed', { projectId: task.project_id });
  res.json({ ok: true });
});

// --- Attachment API ---

app.post('/api/tasks/:taskId/attachments', upload.array('files', 20), (req, res) => {
  const { taskId } = req.params;
  const task = getDb().prepare('SELECT id FROM tasks WHERE id = ?').get(taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const files = (req.files || []).map((f) => ({
    name: f.filename,
    originalName: Buffer.from(f.originalname, 'latin1').toString('utf8'),
    size: f.size,
    url: `/attachments/${taskId}/${encodeURIComponent(f.filename)}`,
  }));
  res.json(files);
});

app.get('/api/tasks/:taskId/attachments', (req, res) => {
  const { taskId } = req.params;
  const dir = path.join(TMP_IMAGES_DIR, taskId);
  if (!fs.existsSync(dir)) return res.json([]);

  try {
    const files = fs.readdirSync(dir).map((name) => {
      const stat = fs.statSync(path.join(dir, name));
      return {
        name,
        originalName: name.replace(/^\d+_/, ''),
        size: stat.size,
        url: `/attachments/${taskId}/${encodeURIComponent(name)}`,
      };
    });
    res.json(files);
  } catch {
    res.json([]);
  }
});

app.delete('/api/tasks/:taskId/attachments/:filename', (req, res) => {
  const { taskId, filename } = req.params;
  const filePath = path.join(TMP_IMAGES_DIR, taskId, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  fs.unlinkSync(filePath);
  res.json({ ok: true });
});

// --- Hooks endpoint ---

app.post('/api/hook/status', (req, res) => {
  const { sessionId, status, event } = req.body;

  if (!sessionId || !sessions.has(sessionId)) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const session = sessions.get(sessionId);
  if (!status || !['working', 'waiting', 'done'].includes(status)) {
    return res.json({ ok: true, sessionId, status: session.status });
  }

  const now = Date.now();

  // 1. Never transition from waiting (red) to done (blue) directly — must go through working first
  if (status === 'done' && session.status === 'waiting') {
    if (session.doneTimer) clearTimeout(session.doneTimer);
    return res.json({ ok: true, sessionId, status: session.status });
  }

  // 2. Debounce 'done' from Stop events (300ms) to prevent race with PermissionRequest
  if (status === 'done' && event === 'Stop') {
    if (session.doneTimer) clearTimeout(session.doneTimer);
    session.doneTimer = setTimeout(() => {
      if (session.status === 'waiting') return; // Re-check: don't override waiting
      session.status = 'done';
      session.doneAt = Date.now();
      session.statusAt = Date.now();
      io.emit('session.status', { sessionId, status: 'done' });
    }, 300);
    return res.json({ ok: true, sessionId, status: session.status });
  }

  // 3. Don't let 'working' override 'waiting' within 500ms (race condition guard)
  if (status === 'working' && session.status === 'waiting' &&
      session.statusAt && now - session.statusAt < 500) {
    return res.json({ ok: true, sessionId, status: session.status });
  }

  // 4. Cancel pending Stop debounce when higher-priority status arrives
  if (session.doneTimer) {
    clearTimeout(session.doneTimer);
    session.doneTimer = null;
  }

  // 5. Apply the status
  session.status = status;
  session.statusAt = now;
  if (status === 'done') session.doneAt = now;
  io.emit('session.status', { sessionId, status });

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
    removePermissions(session.cwd);
    session.pty.kill();
  }
  sessions.clear();
  // Remove skill files and permissions after all sessions are cleared
  const projects = getDb().prepare('SELECT directory FROM projects').all();
  for (const { directory } of projects) {
    removePermissions(directory);
    removeTaskSkill(directory);
  }
}

process.on('SIGINT', () => { cleanupAll(); process.exit(0); });
process.on('SIGTERM', () => { cleanupAll(); process.exit(0); });

// --- Start ---

// Clean up stale hooks from all registered projects on startup
function cleanupStaleHooks() {
  const projects = getDb().prepare('SELECT directory FROM projects').all();
  for (const { directory } of projects) {
    removeHooks(directory);
    removePermissions(directory);
    removeTaskSkill(directory);
  }
  console.log(`Cleaned up hooks, permissions and skills for ${projects.length} projects`);
}

initDb().then(() => {
  cleanupStaleHooks();
  server.listen(PORT, () => {
    console.log(`Web Terminal Manager running at http://localhost:${PORT}`);
  });
}).catch((err) => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
