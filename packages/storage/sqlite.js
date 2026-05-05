import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export class SQLiteStore {
  constructor(databasePath) {
    this.databasePath = resolve(databasePath);
    mkdirSync(dirname(this.databasePath), { recursive: true });
    this.db = new Database(this.databasePath);
    this.db.pragma("journal_mode = WAL");
    this.quoteStatement = this.db.prepare("SELECT quote(?) AS value");
  }

  run(sql) {
    this.db.exec(sql);
  }

  query(sql) {
    return this.db.prepare(sql).all();
  }

  value(value) {
    if (value === null || value === undefined) return "NULL";
    return this.quoteStatement.get(value).value;
  }

  json(value) {
    return this.value(JSON.stringify(value ?? {}));
  }

  initialize() {
    this.run(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plugins (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        direction TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        config TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS input_events (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL DEFAULT 'default-agent',
        plugin_id TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        processed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL DEFAULT 'default-agent',
        input_event_id TEXT,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL DEFAULT 'default-agent',
        content TEXT NOT NULL,
        summary TEXT NOT NULL,
        tags TEXT NOT NULL,
        source_input_id TEXT,
        importance INTEGER NOT NULL,
        confidence REAL NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS output_events (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL DEFAULT 'default-agent',
        plugin_id TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sent_at TEXT
      );
      CREATE TABLE IF NOT EXISTS tool_calls (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL DEFAULT 'default-agent',
        tool_name TEXT NOT NULL,
        input TEXT NOT NULL,
        output TEXT,
        status TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        created_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS confirmation_requests (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL DEFAULT 'default-agent',
        tool_name TEXT NOT NULL,
        payload TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        resolution TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL DEFAULT 'default-agent',
        name TEXT NOT NULL,
        mode TEXT NOT NULL,
        content TEXT NOT NULL,
        run_at TEXT NOT NULL,
        interval_ms INTEGER,
        status TEXT NOT NULL,
        last_run_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS logs (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL DEFAULT 'default-agent',
        level TEXT NOT NULL,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        metadata TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_vectors (
        memory_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL DEFAULT 'default-agent',
        vector TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.ensureColumn("input_events", "agent_id", "TEXT NOT NULL DEFAULT 'default-agent'");
    this.ensureColumn("tasks", "agent_id", "TEXT NOT NULL DEFAULT 'default-agent'");
    this.ensureColumn("memories", "agent_id", "TEXT NOT NULL DEFAULT 'default-agent'");
    this.ensureColumn("output_events", "agent_id", "TEXT NOT NULL DEFAULT 'default-agent'");
    this.ensureColumn("tool_calls", "agent_id", "TEXT NOT NULL DEFAULT 'default-agent'");
    this.ensureColumn("confirmation_requests", "agent_id", "TEXT NOT NULL DEFAULT 'default-agent'");
    this.ensureColumn("schedules", "agent_id", "TEXT NOT NULL DEFAULT 'default-agent'");
    this.ensureColumn("logs", "agent_id", "TEXT NOT NULL DEFAULT 'default-agent'");
  }

  ensureColumn(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
    }
  }
}
