/* global Terminal, FitAddon, io */

const socket = io();
const terminalSessions = new Map(); // id -> { terminal, fitAddon, wrapper }
let activeSessionId = null;
let projects = [];

const tabsEl = document.getElementById('tabs');
const containerEl = document.getElementById('terminal-container');
const btnNew = document.getElementById('btn-new');
const btnProjects = document.getElementById('btn-projects');
const btnCloseSidebar = document.getElementById('btn-close-sidebar');
const sidebar = document.getElementById('sidebar');
const formNewProject = document.getElementById('form-new-project');
const projectListEl = document.getElementById('project-list');
const modal = document.getElementById('project-select-modal');
const modalProjectList = document.getElementById('modal-project-list');

// --- Project management ---

async function loadProjectList() {
  const res = await fetch('/api/projects');
  projects = await res.json();
  renderSidebarProjects();
}

function renderSidebarProjects() {
  projectListEl.innerHTML = '';
  if (projects.length === 0) {
    projectListEl.innerHTML = '<div style="text-align:center;color:#888;padding:16px;font-size:13px;">プロジェクト未登録</div>';
    return;
  }
  for (const p of projects) {
    const el = document.createElement('div');
    el.className = 'project-item';
    el.innerHTML = `
      <div class="project-item-info">
        <div class="project-item-name">${escapeHtml(p.name)}</div>
        <div class="project-item-dir">${escapeHtml(p.directory)}</div>
      </div>
      <div class="project-item-actions">
        <button class="launch-btn" title="セッション起動">▶</button>
        <button class="delete-btn" title="削除">&times;</button>
      </div>
    `;
    el.querySelector('.launch-btn').addEventListener('click', () => createSessionWithProject(p));
    el.querySelector('.delete-btn').addEventListener('click', () => deleteProject(p.id, p.name));
    projectListEl.appendChild(el);
  }
}

async function registerProject(name, directory) {
  const res = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, directory }),
  });
  if (!res.ok) {
    const err = await res.json();
    alert(err.error || '登録に失敗しました');
    return;
  }
  await loadProjectList();
}

async function deleteProject(id, name) {
  if (!confirm(`「${name}」を削除しますか？`)) return;
  await fetch(`/api/projects/${id}`, { method: 'DELETE' });
  await loadProjectList();
}

// --- Sidebar ---

function toggleSidebar() {
  sidebar.classList.toggle('hidden');
  // Refit terminal after sidebar animation
  setTimeout(() => {
    if (activeSessionId) {
      const s = terminalSessions.get(activeSessionId);
      if (s) {
        s.fitAddon.fit();
        socket.emit('terminal.resize', {
          sessionId: activeSessionId,
          cols: s.terminal.cols,
          rows: s.terminal.rows,
        });
      }
    }
  }, 250);
}

// --- Project select modal ---

function openProjectSelectModal() {
  renderModalProjects();
  modal.classList.remove('hidden');
}

function closeProjectSelectModal() {
  modal.classList.add('hidden');
}

function renderModalProjects() {
  modalProjectList.innerHTML = '';
  if (projects.length === 0) {
    modalProjectList.innerHTML = '<div class="modal-empty">プロジェクトが登録されていません。<br>サイドバーからプロジェクトを登録してください。</div>';
    return;
  }
  for (const p of projects) {
    const el = document.createElement('div');
    el.className = 'modal-project-item';
    el.innerHTML = `
      <div class="modal-project-name">${escapeHtml(p.name)}</div>
      <div class="modal-project-dir">${escapeHtml(p.directory)}</div>
    `;
    el.addEventListener('click', () => {
      closeProjectSelectModal();
      createSessionWithProject(p);
    });
    modalProjectList.appendChild(el);
  }
}

// --- Session management ---

async function createSessionWithProject(project) {
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd: project.directory, name: project.name, projectId: project.id }),
  });
  const session = await res.json();
  addSessionUI(session);
  switchTo(session.id);
}

function addSessionUI(session) {
  // Create xterm.js instance
  const terminal = new Terminal({
    fontSize: 14,
    fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", monospace',
    theme: {
      background: '#1e1e1e',
      foreground: '#d4d4d4',
      cursor: '#d4d4d4',
    },
    cursorBlink: true,
    allowProposedApi: true,
  });

  const fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);

  // Create terminal wrapper
  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-wrapper';
  wrapper.id = `term-${session.id}`;
  containerEl.appendChild(wrapper);

  terminal.open(wrapper);
  fitAddon.fit();

  // Create tab
  const tab = document.createElement('div');
  tab.className = 'tab';
  tab.draggable = true;
  tab.dataset.id = session.id;
  tab.innerHTML = `
    <span class="status-dot ${session.status || ''}"></span>
    <span class="tab-label">${escapeHtml(session.name)}</span>
    <button class="close-btn" title="セッション終了">&times;</button>
  `;
  tab.addEventListener('click', (e) => {
    if (!e.target.classList.contains('close-btn')) {
      switchTo(session.id);
    }
  });
  tab.addEventListener('dblclick', (e) => {
    if (!e.target.classList.contains('close-btn')) {
      renameTab(session.id);
    }
  });
  tab.querySelector('.close-btn').addEventListener('click', () => deleteSession(session.id));
  tabsEl.appendChild(tab);

  // Store references
  terminalSessions.set(session.id, { terminal, fitAddon, wrapper, tab, projectId: session.projectId });

  // Subscribe to this session's output
  socket.emit('session.join', session.id);

  // Terminal input -> server
  terminal.onData((data) => {
    socket.emit('terminal.input', { sessionId: session.id, data });
    if (data === '\r' || data === '\n') {
      const dot = tab.querySelector('.status-dot');
      dot.className = 'status-dot working';
    }
  });

  // Send initial size
  socket.emit('terminal.resize', {
    sessionId: session.id,
    cols: terminal.cols,
    rows: terminal.rows,
  });
}

function switchTo(id) {
  // Hide all, show target
  for (const [sid, s] of terminalSessions) {
    s.wrapper.classList.toggle('active', sid === id);
    s.tab.classList.toggle('active', sid === id);
  }
  activeSessionId = id;

  const s = terminalSessions.get(id);
  if (s) {
    s.fitAddon.fit();
    s.terminal.focus();
    socket.emit('terminal.resize', {
      sessionId: id,
      cols: s.terminal.cols,
      rows: s.terminal.rows,
    });
  }
}

async function deleteSession(id) {
  await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
  cleanupSession(id);
}

function cleanupSession(id) {
  const s = terminalSessions.get(id);
  if (!s) return;

  socket.emit('session.leave', id);
  s.terminal.dispose();
  s.wrapper.remove();
  s.tab.remove();
  terminalSessions.delete(id);

  // Switch to another session if needed
  if (activeSessionId === id) {
    const remaining = [...terminalSessions.keys()];
    if (remaining.length > 0) {
      switchTo(remaining[remaining.length - 1]);
    } else {
      activeSessionId = null;
    }
  }
}

// --- Tab rename ---

function renameTab(id) {
  const s = terminalSessions.get(id);
  if (!s) return;

  const label = s.tab.querySelector('.tab-label');
  const current = label.textContent;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'tab-rename-input';
  input.value = current;

  label.replaceWith(input);
  input.focus();
  input.select();

  const commit = () => {
    const newName = input.value.trim() || current;
    const span = document.createElement('span');
    span.className = 'tab-label';
    span.textContent = newName;
    input.replaceWith(span);
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { input.value = current; input.blur(); }
  });
}

// --- Tab drag & drop ---

let draggedTab = null;

tabsEl.addEventListener('dragstart', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  draggedTab = tab;
  tab.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
});

tabsEl.addEventListener('dragend', () => {
  if (draggedTab) draggedTab.classList.remove('dragging');
  draggedTab = null;
  document.querySelectorAll('.tab.drag-over').forEach((t) => t.classList.remove('drag-over'));
});

tabsEl.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const target = e.target.closest('.tab');
  if (!target || target === draggedTab) return;

  document.querySelectorAll('.tab.drag-over').forEach((t) => t.classList.remove('drag-over'));
  const rect = target.getBoundingClientRect();
  const midX = rect.left + rect.width / 2;
  if (e.clientX < midX) {
    target.classList.add('drag-over');
    tabsEl.insertBefore(draggedTab, target);
  } else {
    target.classList.add('drag-over');
    tabsEl.insertBefore(draggedTab, target.nextSibling);
  }
});

tabsEl.addEventListener('drop', (e) => {
  e.preventDefault();
  document.querySelectorAll('.tab.drag-over').forEach((t) => t.classList.remove('drag-over'));
});

// --- Utility ---

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- Notifications ---

function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function sendNotification(title, body) {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  new Notification(title, { body });
}

function getTabName(sessionId) {
  const s = terminalSessions.get(sessionId);
  if (!s) return 'Unknown';
  const label = s.tab.querySelector('.tab-label');
  return label ? label.textContent : 'Unknown';
}

// --- Socket events ---

socket.on('terminal.output', ({ sessionId, data }) => {
  const s = terminalSessions.get(sessionId);
  if (s) s.terminal.write(data);
});

socket.on('session.status', ({ sessionId, status }) => {
  const s = terminalSessions.get(sessionId);
  if (!s) return;

  const dot = s.tab.querySelector('.status-dot');
  dot.className = `status-dot ${status}`;

  const tabName = getTabName(sessionId);
  if (status === 'waiting') {
    sendNotification(`【${tabName}】確認要求`, 'Claude Codeがユーザーの確認を待っています');
  } else if (status === 'done') {
    sendNotification(`【${tabName}】タスク完了`, 'Claude Codeの処理が完了しました');
  }
});

socket.on('session.exit', ({ sessionId }) => {
  cleanupSession(sessionId);
});

socket.on('tasks.changed', ({ projectId }) => {
  if (projectId === selectedProjectId) {
    loadTasks(selectedProjectId);
  }
});

socket.on('sessions.changed', async () => {
  // Refresh session list to sync with server state
  const res = await fetch('/api/sessions');
  const serverSessions = await res.json();
  const serverIds = new Set(serverSessions.map((s) => s.id));

  // Remove local sessions that no longer exist on server
  for (const id of terminalSessions.keys()) {
    if (!serverIds.has(id)) {
      cleanupSession(id);
    }
  }
});

// --- Resize handling ---

window.addEventListener('resize', () => {
  if (activeSessionId) {
    const s = terminalSessions.get(activeSessionId);
    if (s) {
      s.fitAddon.fit();
      socket.emit('terminal.resize', {
        sessionId: activeSessionId,
        cols: s.terminal.cols,
        rows: s.terminal.rows,
      });
    }
  }
});

// --- Menu dropdown ---

function closeAllMenus() {
  document.querySelectorAll('.menu-group.open').forEach((g) => g.classList.remove('open'));
}

document.querySelectorAll('.menu-group').forEach((group) => {
  const trigger = group.querySelector('.menu-item');
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = group.classList.contains('open');
    closeAllMenus();
    if (!wasOpen) group.classList.add('open');
  });

  // Hover to switch between open menus
  group.addEventListener('mouseenter', () => {
    if (document.querySelector('.menu-group.open') && !group.classList.contains('open')) {
      closeAllMenus();
      group.classList.add('open');
    }
  });
});

// Close menu on outside click
document.addEventListener('click', closeAllMenus);

// --- Event listeners ---

btnNew.addEventListener('click', () => { closeAllMenus(); openProjectSelectModal(); });
document.getElementById('btn-new-tab').addEventListener('click', openProjectSelectModal);
document.getElementById('btn-rename-tab').addEventListener('click', () => {
  closeAllMenus();
  if (activeSessionId) renameTab(activeSessionId);
});
btnProjects.addEventListener('click', () => { closeAllMenus(); toggleSidebar(); });
btnCloseSidebar.addEventListener('click', toggleSidebar);

formNewProject.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('input-project-name').value.trim();
  const directory = document.getElementById('input-project-dir').value.trim();
  if (!name || !directory) return;
  await registerProject(name, directory);
  formNewProject.reset();
});

// Modal close handlers
modal.querySelector('.modal-backdrop').addEventListener('click', closeProjectSelectModal);
modal.querySelector('.modal-close').addEventListener('click', closeProjectSelectModal);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeAllMenus();
    if (!modal.classList.contains('hidden')) closeProjectSelectModal();
  }
});

// --- Task management ---

let sidebarMode = 'projects';
let selectedProjectId = null;
let tasks = [];
const activeFilters = new Set(['todo', 'in_progress']);
const collapsedTasks = new Set();

const sidebarProjectsEl = document.getElementById('sidebar-projects');
const sidebarTasksEl = document.getElementById('sidebar-tasks');
const taskProjectSelect = document.getElementById('task-project-select');
const btnRefreshTasks = document.getElementById('btn-refresh-tasks');
const taskListEl = document.getElementById('task-list');
const formNewTask = document.getElementById('form-new-task');
const btnTasks = document.getElementById('btn-tasks');

function switchSidebarMode(mode) {
  sidebarMode = mode;
  document.querySelectorAll('.sidebar-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.mode === mode);
  });
  sidebarProjectsEl.style.display = mode === 'projects' ? '' : 'none';
  sidebarTasksEl.style.display = mode === 'tasks' ? '' : 'none';

  if (mode === 'tasks') {
    updateTaskProjectSelect();
    if (selectedProjectId) loadTasks(selectedProjectId);
  }
}

function updateTaskProjectSelect() {
  taskProjectSelect.innerHTML = '';
  if (projects.length === 0) {
    taskProjectSelect.innerHTML = '<option value="">プロジェクト未登録</option>';
    return;
  }
  for (const p of projects) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    if (p.id === selectedProjectId) opt.selected = true;
    taskProjectSelect.appendChild(opt);
  }
  if (!selectedProjectId && projects.length > 0) {
    selectedProjectId = projects[0].id;
  }
  taskProjectSelect.value = selectedProjectId || '';
}

async function loadTasks(projectId) {
  if (!projectId) { tasks = []; renderTaskList(); return; }
  const res = await fetch(`/api/projects/${projectId}/tasks`);
  if (!res.ok) { tasks = []; renderTaskList(); return; }
  tasks = await res.json();
  renderTaskList();
}

function buildTaskTree(flatTasks) {
  const map = new Map();
  const roots = [];
  for (const t of flatTasks) {
    map.set(t.id, { ...t, children: [] });
  }
  for (const t of flatTasks) {
    const node = map.get(t.id);
    if (t.parent_id && map.has(t.parent_id)) {
      map.get(t.parent_id).children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function filterTasks(tree) {
  if (activeFilters.size === 3) return tree;
  return tree.filter((t) => {
    if (activeFilters.has(t.status)) return true;
    if (t.children.length > 0) {
      t.children = filterTasks(t.children);
      return t.children.length > 0;
    }
    return false;
  });
}

function renderTaskList() {
  taskListEl.innerHTML = '';
  const tree = buildTaskTree(tasks);
  const filtered = filterTasks(tree);

  if (filtered.length === 0) {
    taskListEl.innerHTML = '<div class="task-empty">タスクがありません</div>';
    return;
  }

  for (const node of filtered) {
    taskListEl.appendChild(renderTaskNode(node));
  }
}

function renderTaskNode(node) {
  const el = document.createElement('div');
  el.dataset.taskId = node.id;

  const item = document.createElement('div');
  item.className = `task-item ${node.status}`;
  item.style.paddingLeft = `${8 + node.depth * 16}px`;
  item.draggable = true;
  item.dataset.taskId = node.id;
  item.dataset.parentId = node.parent_id || '';
  item.dataset.depth = node.depth;

  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsedTasks.has(node.id);

  // Toggle button
  const toggle = document.createElement('button');
  toggle.className = `task-toggle ${hasChildren ? '' : 'hidden'}`;
  toggle.textContent = isCollapsed ? '▶' : '▼';
  toggle.addEventListener('click', () => {
    if (isCollapsed) collapsedTasks.delete(node.id);
    else collapsedTasks.add(node.id);
    renderTaskList();
  });

  // Checkbox
  const checkbox = document.createElement('button');
  checkbox.className = `task-checkbox ${node.status === 'done' ? 'checked' : ''}`;
  checkbox.textContent = node.status === 'done' ? '✓' : '';
  checkbox.addEventListener('click', async () => {
    const newStatus = node.status === 'done' ? 'todo' : 'done';
    await updateTask(node.id, { status: newStatus });
  });

  // Content
  const content = document.createElement('div');
  content.className = 'task-content';

  const title = document.createElement('div');
  title.className = 'task-title';
  if (node.due_date && node.status !== 'done' && new Date(node.due_date) < new Date(new Date().toISOString().slice(0, 10))) {
    title.classList.add('overdue');
  }
  title.textContent = node.title;
  title.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleTaskDetail(node, el);
  });

  content.appendChild(title);

  if (node.description) {
    const desc = document.createElement('div');
    desc.className = 'task-desc';
    desc.textContent = node.description;
    desc.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleTaskDetail(node, el);
    });
    content.appendChild(desc);
  }

  // Actions
  const actions = document.createElement('div');
  actions.className = 'task-actions';

  if (node.depth < 4) {
    const addChild = document.createElement('button');
    addChild.className = 'task-add-child';
    addChild.title = '子タスク追加';
    addChild.textContent = '+';
    addChild.addEventListener('click', () => startAddChild(node.id, el));
    actions.appendChild(addChild);
  }

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'task-delete';
  deleteBtn.title = '削除';
  deleteBtn.textContent = '×';
  deleteBtn.addEventListener('click', () => deleteTask(node.id, node.title));
  actions.appendChild(deleteBtn);

  item.appendChild(toggle);
  item.appendChild(checkbox);
  item.appendChild(content);
  item.appendChild(actions);
  el.appendChild(item);

  // Children
  if (hasChildren && !isCollapsed) {
    const childContainer = document.createElement('div');
    childContainer.className = 'task-children';
    for (const child of node.children) {
      childContainer.appendChild(renderTaskNode(child));
    }
    el.appendChild(childContainer);
  }

  return el;
}

// --- Task detail panel ---

let openDetailTaskId = null;

function toggleTaskDetail(node, el) {
  const existing = el.querySelector('.task-detail');
  if (existing) {
    existing.remove();
    openDetailTaskId = null;
    return;
  }

  // Close other open detail panels
  document.querySelectorAll('.task-detail').forEach((d) => d.remove());
  openDetailTaskId = node.id;

  const panel = document.createElement('div');
  panel.className = 'task-detail';
  panel.style.marginLeft = `${8 + node.depth * 16}px`;

  panel.innerHTML = `
    <div class="task-detail-field">
      <label>タイトル</label>
      <input type="text" class="task-detail-input" value="${escapeHtml(node.title)}">
    </div>
    <div class="task-detail-field">
      <label>メモ</label>
      <textarea class="task-detail-textarea" rows="3">${escapeHtml(node.description || '')}</textarea>
    </div>
    <div class="task-detail-field">
      <label>ステータス</label>
      <select class="task-detail-select">
        <option value="todo" ${node.status === 'todo' ? 'selected' : ''}>未着手</option>
        <option value="in_progress" ${node.status === 'in_progress' ? 'selected' : ''}>進行中</option>
        <option value="done" ${node.status === 'done' ? 'selected' : ''}>完了</option>
      </select>
    </div>
    <div class="task-detail-field">
      <label>期日</label>
      <input type="date" class="task-detail-date" value="${node.due_date || ''}">
    </div>
    <div class="task-detail-actions">
      ${node.status !== 'done' ? '<button class="task-detail-assign">タスク割当</button><button class="task-detail-assign-new">新規セッション割当</button>' : ''}
      <button class="task-detail-save">保存</button>
      <button class="task-detail-close">閉じる</button>
    </div>
  `;

  const assignBtn = panel.querySelector('.task-detail-assign');
  if (assignBtn) {
    assignBtn.addEventListener('click', () => assignTaskToSession(node));
  }

  const assignNewBtn = panel.querySelector('.task-detail-assign-new');
  if (assignNewBtn) {
    assignNewBtn.addEventListener('click', () => openNewSessionAssignModal(node));
  }

  panel.querySelector('.task-detail-save').addEventListener('click', async () => {
    const title = panel.querySelector('.task-detail-input').value.trim();
    const description = panel.querySelector('.task-detail-textarea').value;
    const status = panel.querySelector('.task-detail-select').value;
    const due_date = panel.querySelector('.task-detail-date').value;
    if (!title) { alert('タイトルは必須です'); return; }
    openDetailTaskId = null;
    await updateTask(node.id, { title, description, status, due_date });
  });

  panel.querySelector('.task-detail-close').addEventListener('click', () => {
    panel.remove();
    openDetailTaskId = null;
  });

  // Prevent clicks inside panel from bubbling
  panel.addEventListener('click', (e) => e.stopPropagation());

  // Insert after the task-item
  const taskItem = el.querySelector('.task-item');
  taskItem.after(panel);
  requestAnimationFrame(() => {
    panel.scrollIntoView({ behavior: 'smooth', block: 'end' });
  });
}

// --- Task drag & drop ---

let draggedTaskId = null;
let draggedTaskDescendants = new Set();

function getDescendantIds(taskId) {
  const ids = new Set();
  const find = (pid) => {
    for (const t of tasks) {
      if (t.parent_id === pid) {
        ids.add(t.id);
        find(t.id);
      }
    }
  };
  find(taskId);
  return ids;
}

function getTaskMaxSubtreeDepth(taskId) {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return 0;
  let max = task.depth;
  const check = (pid) => {
    for (const t of tasks) {
      if (t.parent_id === pid) {
        if (t.depth > max) max = t.depth;
        check(t.id);
      }
    }
  };
  check(taskId);
  return max - task.depth; // relative depth of deepest descendant
}

taskListEl.addEventListener('dragstart', (e) => {
  const item = e.target.closest('.task-item');
  if (!item) return;
  draggedTaskId = Number(item.dataset.taskId);
  draggedTaskDescendants = getDescendantIds(draggedTaskId);
  item.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
});

taskListEl.addEventListener('dragend', () => {
  document.querySelectorAll('.task-item.dragging').forEach((el) => el.classList.remove('dragging'));
  clearDropIndicators();
  draggedTaskId = null;
  draggedTaskDescendants = new Set();
});

function clearDropIndicators() {
  document.querySelectorAll('.drop-above, .drop-below, .drop-inside').forEach((el) => {
    el.classList.remove('drop-above', 'drop-below', 'drop-inside');
  });
}

function getDropZone(e, el) {
  const rect = el.getBoundingClientRect();
  const y = e.clientY - rect.top;
  const h = rect.height;
  if (y < h * 0.25) return 'above';
  if (y > h * 0.75) return 'below';
  return 'inside';
}

taskListEl.addEventListener('dragover', (e) => {
  e.preventDefault();
  const item = e.target.closest('.task-item');
  if (!item) return;

  const targetId = Number(item.dataset.taskId);
  if (targetId === draggedTaskId || draggedTaskDescendants.has(targetId)) {
    e.dataTransfer.dropEffect = 'none';
    return;
  }

  // Check depth limit for 'inside' drop
  const zone = getDropZone(e, item);
  const targetDepth = Number(item.dataset.depth);
  const subtreeRelativeDepth = getTaskMaxSubtreeDepth(draggedTaskId);

  if (zone === 'inside' && targetDepth + 1 + subtreeRelativeDepth > 4) {
    e.dataTransfer.dropEffect = 'none';
    return;
  }

  e.dataTransfer.dropEffect = 'move';
  clearDropIndicators();
  item.classList.add(`drop-${zone}`);
});

taskListEl.addEventListener('dragleave', (e) => {
  const item = e.target.closest('.task-item');
  if (item) item.classList.remove('drop-above', 'drop-below', 'drop-inside');
});

taskListEl.addEventListener('drop', async (e) => {
  e.preventDefault();
  const item = e.target.closest('.task-item');
  if (!item || draggedTaskId === null) return;

  const targetId = Number(item.dataset.taskId);
  if (targetId === draggedTaskId || draggedTaskDescendants.has(targetId)) return;

  const zone = getDropZone(e, item);
  const targetTask = tasks.find((t) => t.id === targetId);
  if (!targetTask) return;

  let newParentId, sortOrder;

  if (zone === 'inside') {
    // Become child of target
    newParentId = targetId;
    const siblings = tasks.filter((t) => t.parent_id === targetId);
    sortOrder = siblings.length;
  } else {
    // Become sibling of target (same parent)
    newParentId = targetTask.parent_id || null;
    const siblings = tasks.filter((t) =>
      (t.parent_id || null) === (newParentId || null) && t.id !== draggedTaskId
    ).sort((a, b) => a.sort_order - b.sort_order);
    const targetIndex = siblings.findIndex((t) => t.id === targetId);
    sortOrder = zone === 'above' ? targetIndex : targetIndex + 1;
  }

  clearDropIndicators();

  const res = await fetch(`/api/tasks/${draggedTaskId}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parent_id: newParentId, sort_order: sortOrder }),
  });

  if (!res.ok) {
    const err = await res.json();
    alert(err.error || '移動に失敗しました');
  }

  await loadTasks(selectedProjectId);
});

function startAddChild(parentId, parentEl) {
  // Check if already adding
  if (parentEl.querySelector('.task-child-input')) return;

  const form = document.createElement('div');
  form.style.paddingLeft = '36px';
  form.style.paddingBottom = '4px';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'task-edit-input task-child-input';
  input.placeholder = '子タスク名...';
  form.appendChild(input);
  parentEl.appendChild(form);
  input.focus();

  const commit = async () => {
    const title = input.value.trim();
    form.remove();
    if (title) {
      await createTask(selectedProjectId, title, parentId);
    }
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { input.value = ''; input.blur(); }
  });
}

async function createTask(projectId, title, parentId) {
  const body = { title };
  if (parentId) body.parent_id = parentId;
  const res = await fetch(`/api/projects/${projectId}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json();
    alert(err.error || 'タスク作成に失敗しました');
    return;
  }
  await loadTasks(projectId);
}

async function updateTask(taskId, fields) {
  const res = await fetch(`/api/tasks/${taskId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  if (!res.ok) {
    const err = await res.json();
    alert(err.error || '更新に失敗しました');
    return;
  }
  await loadTasks(selectedProjectId);
}

async function deleteTask(taskId, title) {
  if (!confirm(`「${title}」を削除しますか？（子タスクも削除されます）`)) return;
  await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
  await loadTasks(selectedProjectId);
}

// --- Task assignment ---

function assignTaskToSession(task) {
  if (!activeSessionId) {
    alert('アクティブなセッションがありません。先にセッションを起動してください。');
    return;
  }

  const desc = task.description ? `\n説明: ${task.description}` : '';
  const prompt = `task-managementスキルを使って「${task.title}」(ID: ${task.id}) の作業を開始してください。${desc}`;

  socket.emit('terminal.input', { sessionId: activeSessionId, data: prompt + '\r' });

  // Focus the terminal
  const s = terminalSessions.get(activeSessionId);
  if (s) s.terminal.focus();
}

async function openNewSessionAssignModal(task) {
  const project = projects.find(p => p.id === selectedProjectId);
  if (!project) {
    alert('プロジェクトが見つかりません。');
    return;
  }

  const sessionName = task.title.slice(0, 6);
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd: project.directory, name: sessionName, projectId: project.id }),
  });
  const session = await res.json();
  addSessionUI(session);
  switchTo(session.id);

  setTimeout(() => {
    const desc = task.description ? `\n説明: ${task.description}` : '';
    const prompt = `task-managementスキルを使って「${task.title}」(ID: ${task.id}) の作業を開始してください。${desc}`;
    socket.emit('terminal.input', { sessionId: session.id, data: prompt + '\r' });
    const s = terminalSessions.get(session.id);
    if (s) s.terminal.focus();
  }, 500);
}

// Task event listeners
document.querySelectorAll('.sidebar-tab').forEach((tab) => {
  tab.addEventListener('click', () => switchSidebarMode(tab.dataset.mode));
});

taskProjectSelect.addEventListener('change', (e) => {
  selectedProjectId = Number(e.target.value) || null;
  if (selectedProjectId) loadTasks(selectedProjectId);
});

btnRefreshTasks.addEventListener('click', () => {
  if (!selectedProjectId) return;
  btnRefreshTasks.classList.add('spinning');
  loadTasks(selectedProjectId).then(() => {
    setTimeout(() => btnRefreshTasks.classList.remove('spinning'), 300);
  });
});

document.querySelectorAll('.task-filter-check input').forEach((cb) => {
  cb.addEventListener('change', () => {
    if (cb.checked) activeFilters.add(cb.dataset.filter);
    else activeFilters.delete(cb.dataset.filter);
    renderTaskList();
  });
});

formNewTask.addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('input-task-title');
  const title = input.value.trim();
  if (!title || !selectedProjectId) return;
  await createTask(selectedProjectId, title, null);
  input.value = '';
});

btnTasks.addEventListener('click', () => {
  closeAllMenus();
  if (sidebar.classList.contains('hidden')) toggleSidebar();
  switchSidebarMode('tasks');
});

document.getElementById('btn-tasks-menu').addEventListener('click', () => {
  closeAllMenus();
  if (sidebar.classList.contains('hidden')) toggleSidebar();
  switchSidebarMode('tasks');
});

// --- Init ---

(async () => {
  requestNotificationPermission();

  // Load projects first
  await loadProjectList();

  // Load existing sessions on page load
  const res = await fetch('/api/sessions');
  const existing = await res.json();
  for (const session of existing) {
    addSessionUI(session);
  }
  if (existing.length > 0) {
    switchTo(existing[0].id);
  }
})();
