/* global Terminal, FitAddon, io */

const socket = io();
const terminalSessions = new Map(); // id -> { terminal, fitAddon, wrapper }
let activeSessionId = null;
let projects = [];

// --- Tab name persistence (sessionStorage) ---

function saveTabNames() {
  const names = {};
  terminalSessions.forEach((s, id) => {
    const label = s.tab.querySelector('.tab-label');
    if (label) names[id] = label.textContent;
  });
  sessionStorage.setItem('tabNames', JSON.stringify(names));
}

function getStoredTabName(sessionId) {
  try {
    const names = JSON.parse(sessionStorage.getItem('tabNames') || '{}');
    return names[sessionId] || null;
  } catch { return null; }
}

function removeStoredTabName(sessionId) {
  try {
    const names = JSON.parse(sessionStorage.getItem('tabNames') || '{}');
    delete names[sessionId];
    sessionStorage.setItem('tabNames', JSON.stringify(names));
  } catch { /* ignore */ }
}

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
const editModal = document.getElementById('project-edit-modal');
const ganttModal = document.getElementById('gantt-modal');
const kanbanModal = document.getElementById('kanban-modal');

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
        <div class="project-item-name"><span class="project-code">${escapeHtml(p.code || '')}</span> ${escapeHtml(p.name)}</div>
        <div class="project-item-dir">${escapeHtml(p.directory)}</div>
      </div>
      <div class="project-item-actions">
        <button class="launch-btn" title="セッション起動">▶</button>
        <button class="delete-btn" title="削除">&times;</button>
      </div>
    `;
    el.querySelector('.launch-btn').addEventListener('click', (e) => { e.stopPropagation(); createSessionWithProject(p); });
    el.querySelector('.delete-btn').addEventListener('click', (e) => { e.stopPropagation(); deleteProject(p.id, p.name); });
    el.querySelector('.project-item-info').addEventListener('click', () => openProjectEditModal(p));
    projectListEl.appendChild(el);
  }
}

async function registerProject(code, name, directory) {
  const res = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, name, directory }),
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

// --- Project edit modal ---

function openProjectEditModal(project) {
  document.getElementById('edit-project-id').value = project.id;
  document.getElementById('edit-project-name').value = project.name;
  document.getElementById('edit-project-code').value = project.code || '';
  document.getElementById('edit-project-dir').value = project.directory;
  document.getElementById('edit-project-notes').value = project.notes || '';
  editModal.classList.remove('hidden');
}

function closeProjectEditModal() {
  editModal.classList.add('hidden');
}

editModal.querySelector('.modal-backdrop').addEventListener('click', closeProjectEditModal);
editModal.querySelector('.modal-close').addEventListener('click', closeProjectEditModal);
document.getElementById('edit-project-cancel').addEventListener('click', closeProjectEditModal);

document.getElementById('form-edit-project').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('edit-project-id').value;
  const name = document.getElementById('edit-project-name').value.trim();
  const code = document.getElementById('edit-project-code').value.trim();
  const directory = document.getElementById('edit-project-dir').value.trim();
  const notes = document.getElementById('edit-project-notes').value;
  if (!name || !code || !directory) return;

  const res = await fetch(`/api/projects/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, code, directory, notes }),
  });
  if (!res.ok) {
    const err = await res.json();
    alert(err.error || '更新に失敗しました');
    return;
  }
  closeProjectEditModal();
  await loadProjectList();
});

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
      <div class="modal-project-name"><span class="project-code">${escapeHtml(p.code || '')}</span> ${escapeHtml(p.name)}</div>
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

  // Ctrl+C (コピー: テキスト選択時) / Ctrl+V (貼り付け) をブラウザに委譲
  terminal.attachCustomKeyEventHandler((e) => {
    if (e.ctrlKey && e.key === 'c' && terminal.hasSelection()) {
      return false;
    }
    if (e.ctrlKey && e.key === 'v') {
      return false;
    }
    return true;
  });

  fitAddon.fit();

  // Create tab
  const tab = document.createElement('div');
  tab.className = 'tab';
  tab.draggable = true;
  tab.dataset.id = session.id;
  tab.innerHTML = `
    <span class="status-dot ${session.status || ''}"></span>
    <span class="tab-label">${escapeHtml(getStoredTabName(session.id) || session.name)}</span>
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
  removeStoredTabName(id);

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
    saveTabNames();
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

function safeParseTargetPaths(val) {
  if (!val) return [];
  try {
    const parsed = typeof val === 'string' ? JSON.parse(val) : val;
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function isValidDate(val) {
  return typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val);
}

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
  // Refresh Gantt/Kanban if open and showing this project
  if (!ganttModal.classList.contains('hidden')) {
    const ganttVal = document.getElementById('gantt-project-select').value;
    if (ganttVal === 'all' || Number(ganttVal) === projectId) loadGanttData();
  }
  if (!kanbanModal.classList.contains('hidden')) {
    const kanbanProjId = Number(document.getElementById('kanban-project-select').value);
    if (kanbanProjId === projectId) loadKanbanData();
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
  const code = document.getElementById('input-project-code').value.trim();
  const name = document.getElementById('input-project-name').value.trim();
  const directory = document.getElementById('input-project-dir').value.trim();
  if (!code || !name || !directory) return;
  await registerProject(code, name, directory);
  formNewProject.reset();
});

// Modal close handlers
modal.querySelector('.modal-backdrop').addEventListener('click', closeProjectSelectModal);
modal.querySelector('.modal-close').addEventListener('click', closeProjectSelectModal);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeAllMenus();
    if (!modal.classList.contains('hidden')) closeProjectSelectModal();
    if (!editModal.classList.contains('hidden')) closeProjectEditModal();
    if (!ganttModal.classList.contains('hidden')) closeGanttModal();
    if (!kanbanModal.classList.contains('hidden')) closeKanbanModal();
  }
});

// --- Task management ---

let sidebarMode = 'projects';
let selectedProjectId = null;
let tasks = [];
const activeFilters = new Set(['todo', 'in_progress', 'review']);
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
    opt.textContent = p.code ? `[${p.code}] ${p.name}` : p.name;
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
  // 初期表示時: ルートレベル（プロジェクト）のトグルをすべて閉じる
  collapsedTasks.clear();
  const tree = buildTaskTree(tasks);
  for (const node of tree) {
    if (node.children.length > 0) {
      collapsedTasks.add(node.id);
    }
  }
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
  if (activeFilters.size === 4) return tree;
  return tree.filter((t) => {
    // Always filter children first
    if (t.children.length > 0) {
      t.children = filterTasks(t.children);
    }
    if (activeFilters.has(t.status)) return true;
    // Keep parent if it has visible children
    return t.children.length > 0;
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
  if (isValidDate(node.due_date) && node.status !== 'done' && node.due_date < new Date().toISOString().slice(0, 10)) {
    title.classList.add('overdue');
  }
  title.textContent = `#${node.id} ${node.title}`;
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

  // Show target paths as small tags
  const nodePaths = safeParseTargetPaths(node.target_paths);
  if (nodePaths.length > 0) {
    const pathsRow = document.createElement('div');
    pathsRow.className = 'task-paths-preview';
    for (const p of nodePaths) {
      const badge = document.createElement('span');
      badge.className = 'task-path-badge';
      badge.textContent = p;
      pathsRow.appendChild(badge);
    }
    content.appendChild(pathsRow);
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

  const currentPaths = safeParseTargetPaths(node.target_paths);

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
        <option value="review" ${node.status === 'review' ? 'selected' : ''}>レビュー</option>
        <option value="done" ${node.status === 'done' ? 'selected' : ''}>完了</option>
      </select>
    </div>
    <div class="task-detail-field">
      <label>開始日</label>
      <input type="date" class="task-detail-start-date" value="${node.start_date || ''}">
    </div>
    <div class="task-detail-field">
      <label>期日</label>
      <input type="date" class="task-detail-date" value="${node.due_date || ''}">
    </div>
    <div class="task-detail-field">
      <label>対象フォルダ/ファイル</label>
      <div class="target-paths-container">
        <div class="target-paths-tags"></div>
        <div class="target-paths-input-wrap">
          <input type="text" class="target-paths-input" placeholder="パスを入力...">
          <div class="target-paths-suggestions"></div>
        </div>
      </div>
    </div>
    <div class="task-detail-field">
      <label>添付ファイル</label>
      <div class="attachment-container" data-task-id="${node.id}">
        <div class="attachment-list"></div>
        <div class="attachment-dropzone">
          <input type="file" class="attachment-file-input" multiple style="display:none">
          <button type="button" class="attachment-select-btn">ファイルを選択</button>
          <span class="attachment-drop-hint">またはドラッグ＆ドロップ</span>
        </div>
      </div>
    </div>
    <div class="task-detail-actions">
      ${(node.status !== 'done' && node.status !== 'review') ? '<button class="task-detail-assign">タスク割当</button><button class="task-detail-assign-new">新規セッション割当</button>' : ''}
      <button class="task-detail-save">保存</button>
      <button class="task-detail-close">閉じる</button>
    </div>
  `;

  // Initialize target paths UI
  initTargetPathsUI(panel, currentPaths, selectedProjectId);

  // Initialize attachment UI
  initAttachmentUI(panel, node.id);

  const assignBtn = panel.querySelector('.task-detail-assign');
  if (assignBtn) {
    assignBtn.addEventListener('click', () => {
      const taskData = {
        ...node,
        title: panel.querySelector('.task-detail-input').value.trim(),
        description: panel.querySelector('.task-detail-textarea').value,
        target_paths: getTargetPathsFromUI(panel),
      };
      assignTaskToSession(taskData);
    });
  }

  const assignNewBtn = panel.querySelector('.task-detail-assign-new');
  if (assignNewBtn) {
    assignNewBtn.addEventListener('click', () => {
      const taskData = {
        ...node,
        title: panel.querySelector('.task-detail-input').value.trim(),
        description: panel.querySelector('.task-detail-textarea').value,
        target_paths: getTargetPathsFromUI(panel),
      };
      openNewSessionAssignModal(taskData);
    });
  }

  panel.querySelector('.task-detail-save').addEventListener('click', async () => {
    const title = panel.querySelector('.task-detail-input').value.trim();
    const description = panel.querySelector('.task-detail-textarea').value;
    const status = panel.querySelector('.task-detail-select').value;
    const start_date = panel.querySelector('.task-detail-start-date').value;
    const due_date = panel.querySelector('.task-detail-date').value;
    const target_paths = getTargetPathsFromUI(panel);
    if (!title) { alert('タイトルは必須です'); return; }
    openDetailTaskId = null;
    await updateTask(node.id, { title, description, status, start_date, due_date, target_paths });
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

// --- Target paths UI ---

function getTargetPathsFromUI(panel) {
  const tags = panel.querySelectorAll('.target-path-tag');
  const paths = [];
  for (const tag of tags) {
    paths.push(tag.dataset.path);
  }
  return paths.length > 0 ? paths : [];
}

function initTargetPathsUI(panel, currentPaths, projectId) {
  const tagsContainer = panel.querySelector('.target-paths-tags');
  const input = panel.querySelector('.target-paths-input');
  const suggestionsEl = panel.querySelector('.target-paths-suggestions');
  let debounceTimer = null;
  let selectedIndex = -1;

  // Render existing tags
  for (const p of currentPaths) {
    addPathTag(p);
  }

  function addPathTag(pathStr) {
    const tag = document.createElement('span');
    tag.className = 'target-path-tag';
    tag.dataset.path = pathStr;
    tag.innerHTML = `<span class="target-path-tag-text">${escapeHtml(pathStr)}</span><button class="target-path-tag-remove">&times;</button>`;
    tag.querySelector('.target-path-tag-remove').addEventListener('click', () => tag.remove());
    tagsContainer.appendChild(tag);
  }

  function showSuggestions(entries) {
    suggestionsEl.innerHTML = '';
    selectedIndex = -1;
    if (entries.length === 0) {
      suggestionsEl.classList.remove('visible');
      return;
    }
    for (const entry of entries) {
      const item = document.createElement('div');
      item.className = 'target-paths-suggestion-item';
      item.innerHTML = `<span class="suggestion-icon">${entry.isDirectory ? '\uD83D\uDCC1' : '\uD83D\uDCC4'}</span><span class="suggestion-path">${escapeHtml(entry.path)}${entry.isDirectory ? '/' : ''}</span>`;
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (entry.isDirectory) {
          // Navigate into directory
          input.value = entry.path + '/';
          fetchSuggestions(entry.path + '/');
        } else {
          addPathTag(entry.path);
          input.value = '';
          hideSuggestions();
        }
        input.focus();
      });
      suggestionsEl.appendChild(item);
    }
    suggestionsEl.classList.add('visible');
  }

  function hideSuggestions() {
    suggestionsEl.classList.remove('visible');
    suggestionsEl.innerHTML = '';
    selectedIndex = -1;
  }

  function updateSelection() {
    const items = suggestionsEl.querySelectorAll('.target-paths-suggestion-item');
    items.forEach((item, i) => {
      item.classList.toggle('selected', i === selectedIndex);
    });
    if (selectedIndex >= 0 && items[selectedIndex]) {
      items[selectedIndex].scrollIntoView({ block: 'nearest' });
    }
  }

  async function fetchSuggestions(query) {
    if (!projectId) return;
    try {
      const res = await fetch(`/api/projects/${projectId}/paths?q=${encodeURIComponent(query)}`);
      if (!res.ok) { hideSuggestions(); return; }
      const entries = await res.json();
      // Filter out already added paths
      const existingPaths = new Set(getTargetPathsFromUI(panel));
      const filtered = entries.filter((e) => !existingPaths.has(e.path));
      showSuggestions(filtered);
    } catch {
      hideSuggestions();
    }
  }

  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const val = input.value;
    if (!val) {
      hideSuggestions();
      return;
    }
    debounceTimer = setTimeout(() => fetchSuggestions(val), 150);
  });

  input.addEventListener('focus', () => {
    if (input.value) fetchSuggestions(input.value);
  });

  input.addEventListener('blur', () => {
    // Delay to allow mousedown on suggestions
    setTimeout(() => hideSuggestions(), 200);
  });

  input.addEventListener('keydown', (e) => {
    const items = suggestionsEl.querySelectorAll('.target-paths-suggestion-item');
    const isVisible = suggestionsEl.classList.contains('visible');

    if (e.key === 'ArrowDown' && isVisible) {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
      updateSelection();
    } else if (e.key === 'ArrowUp' && isVisible) {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      updateSelection();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (isVisible && selectedIndex >= 0 && items[selectedIndex]) {
        items[selectedIndex].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      } else if (input.value.trim()) {
        // Add as manual path
        addPathTag(input.value.trim());
        input.value = '';
        hideSuggestions();
      }
    } else if (e.key === 'Escape') {
      hideSuggestions();
    } else if (e.key === 'Tab' && isVisible && selectedIndex >= 0) {
      e.preventDefault();
      items[selectedIndex].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    }
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
  // 一覧を再取得してローカルデータを同期
  const listRes = await fetch(`/api/projects/${selectedProjectId}/tasks`);
  if (listRes.ok) tasks = await listRes.json();
  // DOM再構築せず該当タスクだけ部分更新（トグル状態を保持）
  patchTaskDOM(taskId);
}

function patchTaskDOM(taskId) {
  const task = tasks.find(t => t.id === taskId);
  if (!task) return;

  const item = document.querySelector(`.task-item[data-task-id="${taskId}"]`);
  if (!item) return;

  // ステータスクラス更新
  item.classList.remove('todo', 'in_progress', 'review', 'done');
  item.classList.add(task.status);

  // タイトル更新
  const titleEl = item.querySelector('.task-title');
  if (titleEl) {
    titleEl.textContent = `#${task.id} ${task.title}`;
    const isOverdue = isValidDate(task.due_date) && task.status !== 'done' &&
      task.due_date < new Date().toISOString().slice(0, 10);
    titleEl.classList.toggle('overdue', isOverdue);
  }

  // 説明更新
  const contentEl = item.querySelector('.task-content');
  let descEl = item.querySelector('.task-desc');
  if (task.description) {
    if (!descEl) {
      descEl = document.createElement('div');
      descEl.className = 'task-desc';
      titleEl.after(descEl);
    }
    descEl.textContent = task.description;
  } else if (descEl) {
    descEl.remove();
  }

  // チェックボックス更新
  const checkbox = item.querySelector('.task-checkbox');
  if (checkbox) {
    checkbox.className = `task-checkbox ${task.status === 'done' ? 'checked' : ''}`;
    checkbox.textContent = task.status === 'done' ? '✓' : '';
  }

  // target paths更新
  const paths = safeParseTargetPaths(task.target_paths);
  let pathsRow = item.querySelector('.task-paths-preview');
  if (paths.length > 0) {
    if (!pathsRow) {
      pathsRow = document.createElement('div');
      pathsRow.className = 'task-paths-preview';
      contentEl.appendChild(pathsRow);
    }
    pathsRow.innerHTML = '';
    for (const p of paths) {
      const badge = document.createElement('span');
      badge.className = 'task-path-badge';
      badge.textContent = p;
      pathsRow.appendChild(badge);
    }
  } else if (pathsRow) {
    pathsRow.remove();
  }
}

async function deleteTask(taskId, title) {
  if (!confirm(`「${title}」を削除しますか？（子タスクも削除されます）`)) return;
  await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
  await loadTasks(selectedProjectId);
}

// --- Task assignment ---

function buildTaskPrompt(task) {
  const desc = task.description ? `\n説明: ${task.description}` : '';
  const paths = safeParseTargetPaths(task.target_paths);
  const pathsInfo = paths.length > 0 ? `\n対象フォルダ/ファイル: ${paths.join(', ')}` : '';
  return `task-managementスキルを使って「${task.title}」(ID: ${task.id}) の作業を開始してください。${desc}${pathsInfo}`;
}

function assignTaskToSession(task) {
  if (!activeSessionId) {
    alert('アクティブなセッションがありません。先にセッションを起動してください。');
    return;
  }

  const prompt = buildTaskPrompt(task);
  socket.emit('terminal.input', { sessionId: activeSessionId, data: prompt + '\r' });

  // Focus the terminal
  const s = terminalSessions.get(activeSessionId);
  if (s) s.terminal.focus();
}

async function openNewSessionAssignModal(task) {
  const project = projects.find(p => p.id === selectedProjectId)
    || projects.find(p => p.id === task.project_id);
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
    const prompt = buildTaskPrompt(task);
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

document.getElementById('btn-gantt').addEventListener('click', () => {
  closeAllMenus();
  openGanttModal();
});

document.getElementById('btn-kanban').addEventListener('click', () => {
  closeAllMenus();
  openKanbanModal();
});

// --- Shared modal helper ---

function populateModalProjectSelect(selectId, addAllOption) {
  const select = document.getElementById(selectId);
  select.innerHTML = '';
  if (addAllOption) {
    const allOpt = document.createElement('option');
    allOpt.value = 'all';
    allOpt.textContent = 'すべてのプロジェクト';
    select.appendChild(allOpt);
  }
  for (const p of projects) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.code ? `[${p.code}] ${p.name}` : p.name;
    if (p.id === selectedProjectId) opt.selected = true;
    select.appendChild(opt);
  }
  if (selectedProjectId) select.value = selectedProjectId;
}

// --- Gantt Chart ---

let ganttCurrentTasks = []; // current gantt tasks data
const ganttCollapsedTasks = new Set();
let ganttIsAllProjects = false;

function openGanttModal() {
  populateModalProjectSelect('gantt-project-select', true);
  ganttModal.classList.remove('hidden');
  loadGanttData();
}

function closeGanttModal() {
  ganttModal.classList.add('hidden');
  closeGanttTaskDetail();
}

ganttModal.querySelector('.modal-backdrop').addEventListener('click', closeGanttModal);
ganttModal.querySelector('.modal-close').addEventListener('click', closeGanttModal);
document.getElementById('gantt-project-select').addEventListener('change', loadGanttData);
document.getElementById('gantt-show-no-date').addEventListener('change', () => {
  if (ganttCurrentTasks.length > 0) renderGanttChart(ganttCurrentTasks);
});
document.getElementById('gantt-hide-done').addEventListener('change', () => {
  if (ganttCurrentTasks.length > 0) renderGanttChart(ganttCurrentTasks);
});

// Gantt header add task button
document.getElementById('gantt-add-task-btn').addEventListener('click', () => {
  const projectVal = document.getElementById('gantt-project-select').value;
  if (projectVal === 'all') {
    alert('タスクを追加するプロジェクトを選択してください');
    return;
  }
  const projectId = Number(projectVal);
  if (!projectId) return;
  const title = prompt('新規タスク名:');
  if (!title || !title.trim()) return;
  createTask(projectId, title.trim(), null).then(() => loadGanttData());
});

async function loadGanttData() {
  const projectVal = document.getElementById('gantt-project-select').value;
  if (!projectVal) {
    document.getElementById('gantt-container').innerHTML =
      '<div class="gantt-empty">プロジェクトを選択してください</div>';
    return;
  }

  ganttIsAllProjects = projectVal === 'all';
  let ganttTasks;

  if (ganttIsAllProjects) {
    const res = await fetch('/api/tasks/all');
    if (!res.ok) return;
    ganttTasks = await res.json();
  } else {
    const res = await fetch(`/api/projects/${projectVal}/tasks`);
    if (!res.ok) return;
    ganttTasks = await res.json();
  }

  ganttCurrentTasks = ganttTasks;
  renderGanttChart(ganttTasks);
}

function renderGanttChart(ganttTasks) {
  const container = document.getElementById('gantt-container');
  container.innerHTML = '';
  closeGanttTaskDetail();

  // Filter tasks based on checkbox
  const showNoDate = document.getElementById('gantt-show-no-date').checked;
  const hideDone = document.getElementById('gantt-hide-done').checked;
  let tasksToShow = showNoDate
    ? ganttTasks
    : ganttTasks.filter(t => t.start_date || t.due_date);
  if (hideDone) tasksToShow = tasksToShow.filter(t => t.status !== 'done');

  if (tasksToShow.length === 0) {
    container.innerHTML = '<div class="gantt-empty">日付が設定されたタスクがありません。<br>タスクに開始日と期日を設定してください。</div>';
    return;
  }

  // Calculate date range from tasks that have dates
  const allDates = [];
  for (const t of tasksToShow) {
    if (t.start_date) allDates.push(new Date(t.start_date));
    if (t.due_date) allDates.push(new Date(t.due_date));
  }

  let minDate, maxDate;
  if (allDates.length > 0) {
    minDate = new Date(Math.min(...allDates));
    maxDate = new Date(Math.max(...allDates));
  } else {
    // No dates at all — default to 2 weeks around today
    minDate = new Date();
    maxDate = new Date();
    minDate.setDate(minDate.getDate() - 7);
    maxDate.setDate(maxDate.getDate() + 7);
  }

  // Add padding: 3 days before, 7 days after
  minDate.setDate(minDate.getDate() - 3);
  maxDate.setDate(maxDate.getDate() + 7);

  const dayCount = Math.ceil((maxDate - minDate) / (1000 * 60 * 60 * 24)) + 1;
  const DAY_WIDTH = 36;

  // Build display rows: group by project if all-projects mode
  let displayRows = []; // { type: 'task' | 'project-group', task?, projectName?, projectCode? }

  if (ganttIsAllProjects) {
    // Group by project_id
    const grouped = new Map();
    for (const t of tasksToShow) {
      const pid = t.project_id;
      if (!grouped.has(pid)) grouped.set(pid, []);
      grouped.get(pid).push(t);
    }
    for (const [pid, projectTasks] of grouped) {
      const first = projectTasks[0];
      const pName = first.project_name || `Project ${pid}`;
      const pCode = first.project_code || '';
      displayRows.push({ type: 'project-group', projectName: pName, projectCode: pCode });
      const tree = buildTaskTree(projectTasks);
      const flat = flattenTreeGantt(tree);
      for (const t of flat) {
        displayRows.push({ type: 'task', task: t });
      }
    }
  } else {
    const tree = buildTaskTree(tasksToShow);
    const flat = flattenTreeGantt(tree);
    for (const t of flat) {
      displayRows.push({ type: 'task', task: t });
    }
  }

  // --- Task list (left panel) ---
  const taskListDiv = document.createElement('div');
  taskListDiv.className = 'gantt-task-list';

  const taskListHeader = document.createElement('div');
  taskListHeader.className = 'gantt-task-list-header';
  taskListHeader.textContent = 'タスク';
  taskListDiv.appendChild(taskListHeader);

  const taskListBody = document.createElement('div');
  taskListBody.className = 'gantt-task-list-body';

  for (const row of displayRows) {
    if (row.type === 'project-group') {
      const groupEl = document.createElement('div');
      groupEl.className = 'gantt-project-group';
      groupEl.textContent = row.projectCode ? `[${row.projectCode}] ${row.projectName}` : row.projectName;
      taskListBody.appendChild(groupEl);
    } else {
      const t = row.task;
      const item = document.createElement('div');
      item.className = `gantt-task-list-item ${t.status}`;
      let indent = '';
      for (let i = 0; i < t.depth; i++) {
        indent += '<span class="gantt-task-indent"></span>';
      }

      const hasChildren = t.children && t.children.length > 0;
      const isCollapsed = ganttCollapsedTasks.has(t.id);
      const toggleBtn = document.createElement('span');
      toggleBtn.className = `gantt-toggle ${hasChildren ? '' : 'gantt-toggle-hidden'}`;
      toggleBtn.textContent = hasChildren ? (isCollapsed ? '▶' : '▼') : '';
      if (hasChildren) {
        toggleBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (isCollapsed) ganttCollapsedTasks.delete(t.id);
          else ganttCollapsedTasks.add(t.id);
          renderGanttChart(ganttCurrentTasks);
        });
      }

      const nameSpan = document.createElement('span');
      nameSpan.className = 'gantt-task-name-clickable';
      nameSpan.textContent = `#${t.id} ${t.title}`;
      nameSpan.addEventListener('click', (e) => {
        e.stopPropagation();
        openGanttTaskDetail(t, item);
      });

      item.innerHTML = indent;
      item.appendChild(toggleBtn);
      item.appendChild(nameSpan);

      taskListBody.appendChild(item);
    }
  }

  taskListDiv.appendChild(taskListBody);

  // Add task form at bottom of left panel
  const projectVal = document.getElementById('gantt-project-select').value;
  if (projectVal !== 'all') {
    const addForm = document.createElement('div');
    addForm.className = 'gantt-add-task-form';
    const addInput = document.createElement('input');
    addInput.type = 'text';
    addInput.placeholder = 'タスク名を入力...';
    const addBtn = document.createElement('button');
    addBtn.textContent = '追加';
    addBtn.addEventListener('click', () => {
      const title = addInput.value.trim();
      if (!title) return;
      createTask(Number(projectVal), title, null).then(() => loadGanttData());
      addInput.value = '';
    });
    addInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addBtn.click();
      }
    });
    addForm.appendChild(addInput);
    addForm.appendChild(addBtn);
    taskListDiv.appendChild(addForm);
  } else {
    // All projects mode: add form with project selector
    const addForm = document.createElement('div');
    addForm.className = 'gantt-add-task-form';
    const projSelect = document.createElement('select');
    for (const p of projects) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.code ? `[${p.code}]` : p.name.slice(0, 8);
      projSelect.appendChild(opt);
    }
    const addInput = document.createElement('input');
    addInput.type = 'text';
    addInput.placeholder = 'タスク名...';
    const addBtn = document.createElement('button');
    addBtn.textContent = '追加';
    addBtn.addEventListener('click', () => {
      const title = addInput.value.trim();
      if (!title) return;
      createTask(Number(projSelect.value), title, null).then(() => loadGanttData());
      addInput.value = '';
    });
    addInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addBtn.click();
      }
    });
    addForm.appendChild(projSelect);
    addForm.appendChild(addInput);
    addForm.appendChild(addBtn);
    taskListDiv.appendChild(addForm);
  }

  // --- Timeline (right panel) ---
  const timelineDiv = document.createElement('div');
  timelineDiv.className = 'gantt-timeline';

  // Timeline header (day columns)
  const headerDiv = document.createElement('div');
  headerDiv.className = 'gantt-timeline-header';
  headerDiv.style.width = `${dayCount * DAY_WIDTH}px`;

  const today = new Date().toISOString().slice(0, 10);
  const dayNames = ['日','月','火','水','木','金','土'];
  let todayOffset = -1;

  for (let i = 0; i < dayCount; i++) {
    const d = new Date(minDate);
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    const dayOfWeek = d.getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

    const col = document.createElement('div');
    col.className = 'gantt-day-header';
    if (isWeekend) col.classList.add('weekend');
    if (dateStr === today) { col.classList.add('today'); todayOffset = i; }
    col.innerHTML = `<div>${d.getMonth() + 1}/${d.getDate()}</div><div>${dayNames[dayOfWeek]}</div>`;
    headerDiv.appendChild(col);
  }
  timelineDiv.appendChild(headerDiv);

  // Timeline body (rows with bars)
  const bodyDiv = document.createElement('div');
  bodyDiv.className = 'gantt-timeline-body';
  bodyDiv.style.width = `${dayCount * DAY_WIDTH}px`;

  for (const row of displayRows) {
    if (row.type === 'project-group') {
      const groupRow = document.createElement('div');
      groupRow.className = 'gantt-project-group-row';
      bodyDiv.appendChild(groupRow);
    } else {
      const t = row.task;
      const rowEl = document.createElement('div');
      rowEl.className = 'gantt-row';

      const start = t.start_date ? new Date(t.start_date) : (t.due_date ? new Date(t.due_date) : null);
      const end = t.due_date ? new Date(t.due_date) : (t.start_date ? new Date(t.start_date) : null);

      if (start && end) {
        const startOffset = Math.floor((start - minDate) / (1000 * 60 * 60 * 24));
        const duration = Math.floor((end - start) / (1000 * 60 * 60 * 24)) + 1;

        const bar = document.createElement('div');
        bar.className = `gantt-bar ${t.status}`;
        bar.style.left = `${startOffset * DAY_WIDTH}px`;
        bar.style.width = `${Math.max(duration * DAY_WIDTH - 4, 8)}px`;
        bar.title = `#${t.id} ${t.title}\n${t.start_date || '?'} ~ ${t.due_date || '?'}`;
        bar.textContent = t.title;

        // Add drag handles
        const leftHandle = document.createElement('div');
        leftHandle.className = 'gantt-bar-handle gantt-bar-handle-left';
        bar.appendChild(leftHandle);

        const rightHandle = document.createElement('div');
        rightHandle.className = 'gantt-bar-handle gantt-bar-handle-right';
        bar.appendChild(rightHandle);

        // Initialize drag behavior
        initGanttBarDrag(bar, t, minDate, DAY_WIDTH);

        // Click on bar to open detail
        bar.addEventListener('click', (e) => {
          if (bar.dataset.dragged) { delete bar.dataset.dragged; return; }
          e.stopPropagation();
          // Find corresponding task list item
          const taskItems = taskListBody.querySelectorAll('.gantt-task-list-item');
          let anchorEl = null;
          for (const ti of taskItems) {
            const nameEl = ti.querySelector('.gantt-task-name-clickable');
            if (nameEl && nameEl.textContent.startsWith(`#${t.id} `)) {
              anchorEl = ti;
              break;
            }
          }
          openGanttTaskDetail(t, anchorEl || bar);
        });

        rowEl.appendChild(bar);

        // Add child task buttons (left of start, right of end)
        if (t.depth < 4) {
          const addLeftBtn = document.createElement('button');
          addLeftBtn.className = 'gantt-bar-add-child';
          addLeftBtn.textContent = '+';
          addLeftBtn.title = '子タスク追加';
          addLeftBtn.style.left = `${startOffset * DAY_WIDTH - 22}px`;
          addLeftBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            promptAndAddChildTask(t.id, t.project_id);
          });
          rowEl.appendChild(addLeftBtn);

          const addRightBtn = document.createElement('button');
          addRightBtn.className = 'gantt-bar-add-child';
          addRightBtn.textContent = '+';
          addRightBtn.title = '子タスク追加';
          addRightBtn.style.left = `${(startOffset + duration) * DAY_WIDTH}px`;
          addRightBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            promptAndAddChildTask(t.id, t.project_id);
          });
          rowEl.appendChild(addRightBtn);
        }
      }

      bodyDiv.appendChild(rowEl);
    }
  }

  // Today line
  if (todayOffset >= 0) {
    const todayLine = document.createElement('div');
    todayLine.className = 'gantt-today-line';
    todayLine.style.left = `${todayOffset * DAY_WIDTH + DAY_WIDTH / 2}px`;
    bodyDiv.appendChild(todayLine);
  }

  timelineDiv.appendChild(bodyDiv);

  container.appendChild(taskListDiv);
  container.appendChild(timelineDiv);

  // Sync vertical scrolling between task list body and timeline
  timelineDiv.addEventListener('scroll', () => {
    taskListBody.scrollTop = timelineDiv.scrollTop;
  });
  taskListBody.addEventListener('scroll', () => {
    timelineDiv.scrollTop = taskListBody.scrollTop;
  });
}

function flattenTree(tree) {
  const result = [];
  for (const node of tree) {
    result.push(node);
    if (node.children && node.children.length > 0) {
      result.push(...flattenTree(node.children));
    }
  }
  return result;
}

function flattenTreeGantt(tree) {
  const result = [];
  for (const node of tree) {
    result.push(node);
    if (node.children && node.children.length > 0 && !ganttCollapsedTasks.has(node.id)) {
      result.push(...flattenTreeGantt(node.children));
    }
  }
  return result;
}

// --- Gantt Task Detail Popover ---

let ganttDetailPopover = null;

function closeGanttTaskDetail() {
  if (ganttDetailPopover) {
    ganttDetailPopover.remove();
    ganttDetailPopover = null;
  }
}

function openGanttTaskDetail(task, anchorEl) {
  closeGanttTaskDetail();

  const popover = document.createElement('div');
  popover.className = 'gantt-detail-popover';
  ganttDetailPopover = popover;

  popover.innerHTML = `
    <div class="task-detail-field">
      <label>タイトル</label>
      <input type="text" class="task-detail-input" value="${escapeHtml(task.title)}">
    </div>
    <div class="task-detail-field">
      <label>メモ</label>
      <textarea class="task-detail-textarea" rows="2">${escapeHtml(task.description || '')}</textarea>
    </div>
    <div class="task-detail-field">
      <label>ステータス</label>
      <select class="task-detail-select">
        <option value="todo" ${task.status === 'todo' ? 'selected' : ''}>未着手</option>
        <option value="in_progress" ${task.status === 'in_progress' ? 'selected' : ''}>進行中</option>
        <option value="review" ${task.status === 'review' ? 'selected' : ''}>レビュー</option>
        <option value="done" ${task.status === 'done' ? 'selected' : ''}>完了</option>
      </select>
    </div>
    <div class="task-detail-field">
      <label>開始日</label>
      <input type="date" class="task-detail-date gantt-popover-start" value="${task.start_date || ''}">
    </div>
    <div class="task-detail-field">
      <label>期日</label>
      <input type="date" class="task-detail-date gantt-popover-due" value="${task.due_date || ''}">
    </div>
    ${(task.status !== 'done' && task.status !== 'review') ? `
    <div class="task-detail-actions">
      <button class="task-detail-assign">タスク割当</button>
      <button class="task-detail-assign-new">新規セッション割当</button>
    </div>` : ''}
    <div class="task-detail-actions">
      <button class="task-detail-save">保存</button>
      <button class="task-detail-close">閉じる</button>
    </div>
  `;

  popover.querySelector('.task-detail-save').addEventListener('click', async () => {
    const title = popover.querySelector('.task-detail-input').value.trim();
    const description = popover.querySelector('.task-detail-textarea').value;
    const status = popover.querySelector('.task-detail-select').value;
    const start_date = popover.querySelector('.gantt-popover-start').value;
    const due_date = popover.querySelector('.gantt-popover-due').value;
    if (!title) { alert('タイトルは必須です'); return; }

    const res = await fetch(`/api/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, description, status, start_date, due_date }),
    });
    if (!res.ok) {
      const err = await res.json();
      alert(err.error || '更新に失敗しました');
      return;
    }
    closeGanttTaskDetail();
    await loadGanttData();
  });

  popover.querySelector('.task-detail-close').addEventListener('click', closeGanttTaskDetail);

  const assignBtn = popover.querySelector('.task-detail-assign');
  if (assignBtn) {
    assignBtn.addEventListener('click', () => {
      assignTaskToSession(task);
      closeGanttTaskDetail();
    });
  }
  const assignNewBtn = popover.querySelector('.task-detail-assign-new');
  if (assignNewBtn) {
    assignNewBtn.addEventListener('click', () => {
      openNewSessionAssignModal(task);
      closeGanttTaskDetail();
    });
  }

  // Prevent clicks inside popover from propagating
  popover.addEventListener('click', (e) => e.stopPropagation());

  // Position the popover
  const ganttBody = document.getElementById('gantt-body');
  ganttBody.style.position = 'relative';
  ganttBody.appendChild(popover);

  // Position near anchor
  if (anchorEl) {
    const bodyRect = ganttBody.getBoundingClientRect();
    const anchorRect = anchorEl.getBoundingClientRect();
    let top = anchorRect.bottom - bodyRect.top + 4;
    let left = anchorRect.left - bodyRect.left;

    // Keep within bounds
    if (left + 320 > bodyRect.width) left = bodyRect.width - 330;
    if (left < 0) left = 10;
    if (top + 350 > bodyRect.height) top = anchorRect.top - bodyRect.top - 350;
    if (top < 0) top = 10;

    popover.style.top = `${top}px`;
    popover.style.left = `${left}px`;
  } else {
    popover.style.top = '50px';
    popover.style.left = '50px';
  }

  // Close on outside click
  const outsideHandler = (e) => {
    if (!popover.contains(e.target)) {
      closeGanttTaskDetail();
      document.removeEventListener('click', outsideHandler);
    }
  };
  setTimeout(() => document.addEventListener('click', outsideHandler), 0);
}

// --- Gantt Bar Drag ---

function initGanttBarDrag(bar, task, minDate, DAY_WIDTH) {
  const leftHandle = bar.querySelector('.gantt-bar-handle-left');
  const rightHandle = bar.querySelector('.gantt-bar-handle-right');

  let dragType = null; // 'left', 'right', 'move'
  let startX = 0;
  let origLeft = 0;
  let origWidth = 0;

  function onMouseDown(e, type) {
    e.preventDefault();
    e.stopPropagation();
    dragType = type;
    startX = e.clientX;
    origLeft = parseInt(bar.style.left) || 0;
    origWidth = parseInt(bar.style.width) || 0;
    bar.classList.add('dragging');
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  function onMouseMove(e) {
    const dx = e.clientX - startX;

    if (dragType === 'left') {
      const newLeft = origLeft + dx;
      const newWidth = origWidth - dx;
      if (newWidth >= 8) {
        bar.style.left = `${newLeft}px`;
        bar.style.width = `${newWidth}px`;
      }
    } else if (dragType === 'right') {
      const newWidth = origWidth + dx;
      if (newWidth >= 8) {
        bar.style.width = `${newWidth}px`;
      }
    } else if (dragType === 'move') {
      bar.style.left = `${origLeft + dx}px`;
    }
  }

  async function onMouseUp(e) {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    bar.classList.remove('dragging');

    const dx = e.clientX - startX;
    if (Math.abs(dx) < 3) {
      dragType = null;
      return;
    }

    bar.dataset.dragged = 'true';

    const finalLeft = parseInt(bar.style.left) || 0;
    const finalWidth = parseInt(bar.style.width) || 0;

    // Calculate new dates
    const startDayOffset = Math.round(finalLeft / DAY_WIDTH);
    const endDayOffset = Math.round((finalLeft + finalWidth + 4) / DAY_WIDTH) - 1;

    const newStart = new Date(minDate);
    newStart.setDate(newStart.getDate() + startDayOffset);
    const newEnd = new Date(minDate);
    newEnd.setDate(newEnd.getDate() + endDayOffset);

    const newStartStr = newStart.toISOString().slice(0, 10);
    const newEndStr = newEnd.toISOString().slice(0, 10);

    const updates = {};
    if (dragType === 'left' || dragType === 'move') {
      updates.start_date = newStartStr;
    }
    if (dragType === 'right' || dragType === 'move') {
      updates.due_date = newEndStr;
    }

    dragType = null;

    const res = await fetch(`/api/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (res.ok) {
      await loadGanttData();
    }
  }

  leftHandle.addEventListener('mousedown', (e) => onMouseDown(e, 'left'));
  rightHandle.addEventListener('mousedown', (e) => onMouseDown(e, 'right'));
  bar.addEventListener('mousedown', (e) => {
    // Only trigger move on bar body, not handles
    if (e.target === leftHandle || e.target === rightHandle) return;
    onMouseDown(e, 'move');
  });
}

// --- Gantt Child Task Add ---

async function promptAndAddChildTask(parentId, projectId) {
  const title = prompt('子タスク名:');
  if (!title || !title.trim()) return;
  await createTask(projectId, title.trim(), parentId);
  await loadGanttData();
}

// --- Kanban Board ---

function openKanbanModal() {
  populateModalProjectSelect('kanban-project-select');
  kanbanModal.classList.remove('hidden');
  loadKanbanData();
}

function closeKanbanModal() {
  kanbanModal.classList.add('hidden');
}

kanbanModal.querySelector('.modal-backdrop').addEventListener('click', closeKanbanModal);
kanbanModal.querySelector('.modal-close').addEventListener('click', closeKanbanModal);
document.getElementById('kanban-project-select').addEventListener('change', loadKanbanData);

let kanbanTasks = [];

async function loadKanbanData() {
  const projectId = document.getElementById('kanban-project-select').value;
  if (!projectId) {
    document.getElementById('kanban-container').innerHTML =
      '<div class="kanban-empty">プロジェクトを選択してください</div>';
    return;
  }
  const res = await fetch(`/api/projects/${projectId}/tasks`);
  if (!res.ok) return;
  kanbanTasks = await res.json();
  renderKanbanBoard();
}

function renderKanbanBoard() {
  const container = document.getElementById('kanban-container');
  container.innerHTML = '';

  const columns = [
    { status: 'todo', label: '未着手' },
    { status: 'in_progress', label: '進行中' },
    { status: 'review', label: 'レビュー' },
    { status: 'done', label: '完了' },
  ];

  for (const col of columns) {
    const colTasks = kanbanTasks.filter(t => t.status === col.status);

    const colDiv = document.createElement('div');
    colDiv.className = `kanban-column ${col.status}`;
    colDiv.dataset.status = col.status;

    const header = document.createElement('div');
    header.className = 'kanban-column-header';
    header.innerHTML = `
      <span>${col.label}</span>
      <span class="kanban-column-count">${colTasks.length}</span>
    `;
    colDiv.appendChild(header);

    const body = document.createElement('div');
    body.className = 'kanban-column-body';
    body.dataset.status = col.status;

    if (colTasks.length === 0) {
      body.innerHTML = '<div class="kanban-empty">タスクなし</div>';
    } else {
      for (const t of colTasks) {
        body.appendChild(createKanbanCard(t));
      }
    }

    // Drag-and-drop target events
    body.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      body.classList.add('drag-over');
    });

    body.addEventListener('dragleave', (e) => {
      if (!body.contains(e.relatedTarget)) {
        body.classList.remove('drag-over');
      }
    });

    body.addEventListener('drop', async (e) => {
      e.preventDefault();
      body.classList.remove('drag-over');
      const taskId = e.dataTransfer.getData('text/plain');
      if (!taskId) return;
      const newStatus = body.dataset.status;
      const task = kanbanTasks.find(t => t.id === Number(taskId));
      if (!task || task.status === newStatus) return;

      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (res.ok) {
        await loadKanbanData();
      }
    });

    colDiv.appendChild(body);
    container.appendChild(colDiv);
  }
}

function createKanbanCard(task) {
  const card = document.createElement('div');
  card.className = 'kanban-card';
  card.draggable = true;
  card.dataset.taskId = task.id;

  const today = new Date().toISOString().slice(0, 10);
  const isOverdue = isValidDate(task.due_date) && task.status !== 'done' && task.due_date < today;

  let metaHtml = '';
  if (task.start_date || task.due_date) {
    const dateStr = task.start_date && task.due_date
      ? `${task.start_date} ~ ${task.due_date}`
      : (task.start_date || task.due_date);
    metaHtml = `<span class="${isOverdue ? 'overdue' : ''}">${dateStr}</span>`;
  }

  card.innerHTML = `
    <div class="kanban-card-title">
      <span class="kanban-card-id">#${task.id}</span>${escapeHtml(task.title)}
    </div>
    ${task.description ? `<div class="kanban-card-desc">${escapeHtml(task.description)}</div>` : ''}
    ${metaHtml ? `<div class="kanban-card-meta">${metaHtml}</div>` : ''}
  `;

  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', String(task.id));
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });

  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    document.querySelectorAll('.kanban-column-body.drag-over').forEach(el => {
      el.classList.remove('drag-over');
    });
  });

  return card;
}

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

// --- Attachment UI ---

function isImageFile(filename) {
  return /\.(jpe?g|png|gif|webp|svg|bmp|ico)$/i.test(filename);
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function renderAttachmentItem(file, taskId, listEl) {
  const item = document.createElement('div');
  item.className = 'attachment-item';

  if (isImageFile(file.name)) {
    item.innerHTML = `
      <a href="${file.url}" target="_blank" class="attachment-thumb-link">
        <img src="${file.url}" class="attachment-thumb" alt="${escapeHtml(file.originalName)}">
      </a>
      <div class="attachment-info">
        <span class="attachment-name" title="${escapeHtml(file.originalName)}">${escapeHtml(file.originalName)}</span>
        <span class="attachment-size">${formatFileSize(file.size)}</span>
      </div>
      <button class="attachment-delete" title="削除">&times;</button>
    `;
  } else {
    item.innerHTML = `
      <a href="${file.url}" target="_blank" class="attachment-file-badge">
        <span class="attachment-file-icon">&#128196;</span>
        <span class="attachment-name" title="${escapeHtml(file.originalName)}">${escapeHtml(file.originalName)}</span>
      </a>
      <span class="attachment-size">${formatFileSize(file.size)}</span>
      <button class="attachment-delete" title="削除">&times;</button>
    `;
  }

  item.querySelector('.attachment-delete').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm(`「${file.originalName}」を削除しますか？`)) return;
    await fetch(`/api/tasks/${taskId}/attachments/${encodeURIComponent(file.name)}`, { method: 'DELETE' });
    item.remove();
  });

  listEl.appendChild(item);
}

async function loadAttachments(taskId, listEl) {
  listEl.innerHTML = '';
  try {
    const res = await fetch(`/api/tasks/${taskId}/attachments`);
    const files = await res.json();
    for (const file of files) {
      renderAttachmentItem(file, taskId, listEl);
    }
  } catch { /* ignore */ }
}

async function uploadFiles(taskId, files, listEl) {
  if (!files || files.length === 0) return;

  const formData = new FormData();
  for (const file of files) {
    formData.append('files', file);
  }

  try {
    const res = await fetch(`/api/tasks/${taskId}/attachments`, {
      method: 'POST',
      body: formData,
    });
    const uploaded = await res.json();
    for (const file of uploaded) {
      renderAttachmentItem(file, taskId, listEl);
    }
  } catch (err) {
    alert('ファイルのアップロードに失敗しました');
  }
}

function initAttachmentUI(panel, taskId) {
  const container = panel.querySelector('.attachment-container');
  if (!container) return;

  const listEl = container.querySelector('.attachment-list');
  const dropzone = container.querySelector('.attachment-dropzone');
  const fileInput = container.querySelector('.attachment-file-input');
  const selectBtn = container.querySelector('.attachment-select-btn');

  // Load existing attachments
  loadAttachments(taskId, listEl);

  // File select button
  selectBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    fileInput.click();
  });

  fileInput.addEventListener('change', () => {
    uploadFiles(taskId, fileInput.files, listEl);
    fileInput.value = '';
  });

  // Drag and drop
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.classList.add('drag-over');
  });

  dropzone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.classList.remove('drag-over');
  });

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.classList.remove('drag-over');
    uploadFiles(taskId, e.dataTransfer.files, listEl);
  });
}
