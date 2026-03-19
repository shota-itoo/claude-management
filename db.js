const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'data.db');
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

// sql.js wrapper that mimics better-sqlite3's synchronous API
class DatabaseWrapper {
  constructor(sqlDb) {
    this._db = sqlDb;
  }

  pragma(str) {
    try { this._db.run(`PRAGMA ${str}`); } catch {}
  }

  exec(sql) {
    this._db.run(sql);
  }

  prepare(sql) {
    const db = this._db;
    const save = () => this.save();
    return {
      all(...params) {
        const stmt = db.prepare(sql);
        if (params.length > 0) stmt.bind(params);
        const rows = [];
        while (stmt.step()) {
          rows.push(stmt.getAsObject());
        }
        stmt.free();
        return rows;
      },
      get(...params) {
        const stmt = db.prepare(sql);
        if (params.length > 0) stmt.bind(params);
        const row = stmt.step() ? stmt.getAsObject() : undefined;
        stmt.free();
        return row;
      },
      run(...params) {
        const stmt = db.prepare(sql);
        if (params.length > 0) stmt.bind(params);
        stmt.step();
        stmt.free();
        const changes = db.getRowsModified();
        const lastStmt = db.prepare('SELECT last_insert_rowid() as id');
        lastStmt.step();
        const lastInsertRowid = lastStmt.getAsObject().id;
        lastStmt.free();
        save();
        return { changes, lastInsertRowid };
      },
    };
  }

  save() {
    const data = this._db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  }

  close() {
    this.save();
    try { this._db.close(); } catch {}
  }
}

let db;

async function init() {
  const SQL = await initSqlJs();
  let sqlDb;
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    sqlDb = new SQL.Database(buffer);
  } else {
    sqlDb = new SQL.Database();
  }
  db = new DatabaseWrapper(sqlDb);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);

  runMigrations();

  return db;
}

function runMigrations() {
  const applied = new Set(
    db.prepare('SELECT name FROM migrations').all().map((r) => r.name)
  );

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    db.exec(sql);
    db.prepare('INSERT INTO migrations (name) VALUES (?)').run(file);
    console.log(`Migration applied: ${file}`);
  }

  db.save();
}

process.on('exit', () => { if (db) db.save(); });

module.exports = { init, getDb: () => db };
