CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  directory TEXT NOT NULL UNIQUE,
  created_at TEXT DEFAULT (datetime('now'))
);
