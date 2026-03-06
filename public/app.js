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
    body: JSON.stringify({ cwd: project.directory, name: project.name }),
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
  terminalSessions.set(session.id, { terminal, fitAddon, wrapper, tab });

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
