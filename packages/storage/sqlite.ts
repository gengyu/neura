import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export class SQLiteStore {
  constructor(databasePath) {
    this.databasePath = resolve(databasePath);
    mkdirSync(dirname(this.databasePath), { recursive: true });
    this.db = new Database(this.databasePath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.quoteStatement = this.db.query("SELECT quote(?) AS value");
  }

  run(sql) {
    this.db.exec(sql);
  }

  query(sql) {
    return this.db.query(sql).all();
  }

  checkpoint() {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  }

  value(value) {
    if (value === null || value === undefined) return "NULL";
    return this.quoteStatement.get(value).value;
  }

  json(value) {
    return this.value(JSON.stringify(value ?? {}));
  }

  initialize() {
    const statements = [
      `CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`,
      `CREATE TABLE IF NOT EXISTS plugins (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        direction TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        config TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`,
      `CREATE TABLE IF NOT EXISTS input_events (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL DEFAULT 'default-agent',
        plugin_id TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        processed_at TEXT
      );`,
      `CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL DEFAULT 'default-agent',
        input_event_id TEXT,
        source_type TEXT NOT NULL DEFAULT 'input_event',
        source_id TEXT,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        finished_at TEXT
      );`,
      `CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL DEFAULT 'default-agent',
        content TEXT NOT NULL,
        summary TEXT NOT NULL,
        tags TEXT NOT NULL,
        memory_kind TEXT NOT NULL DEFAULT 'note',
        memory_type TEXT,
        conflict_status TEXT NOT NULL DEFAULT 'none',
        conflict_memory_ids TEXT NOT NULL DEFAULT '[]',
        source_input_id TEXT,
        source_type TEXT NOT NULL DEFAULT 'input_event',
        source_id TEXT,
        importance INTEGER NOT NULL,
        confidence REAL NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`,
      `CREATE TABLE IF NOT EXISTS output_events (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL DEFAULT 'default-agent',
        plugin_id TEXT NOT NULL,
        source_type TEXT NOT NULL DEFAULT 'internal',
        source_id TEXT,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sent_at TEXT
      );`,
      `CREATE TABLE IF NOT EXISTS tool_calls (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL DEFAULT 'default-agent',
        tool_name TEXT NOT NULL,
        input TEXT NOT NULL,
        output TEXT,
        status TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        created_at TEXT NOT NULL,
        finished_at TEXT
      );`,
      `CREATE TABLE IF NOT EXISTS confirmation_requests (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL DEFAULT 'default-agent',
        tool_name TEXT NOT NULL,
        payload TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        resolution TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );`,
      `CREATE TABLE IF NOT EXISTS schedules (
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
      );`,
      `CREATE TABLE IF NOT EXISTS logs (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL DEFAULT 'default-agent',
        level TEXT NOT NULL,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        metadata TEXT NOT NULL,
        created_at TEXT NOT NULL
      );`,
      `CREATE TABLE IF NOT EXISTS runtime_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`,
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );`
    ];
    for (const statement of statements) {
      this.run(statement);
    }
    this.ensureColumn("input_events", "agent_id", "TEXT NOT NULL DEFAULT 'default-agent'");
    this.ensureColumn("tasks", "agent_id", "TEXT NOT NULL DEFAULT 'default-agent'");
    this.ensureColumn("tasks", "source_type", "TEXT NOT NULL DEFAULT 'input_event'");
    this.ensureColumn("tasks", "source_id", "TEXT");
    this.ensureColumn("memories", "agent_id", "TEXT NOT NULL DEFAULT 'default-agent'");
    this.ensureColumn("memories", "memory_kind", "TEXT NOT NULL DEFAULT 'note'");
    this.ensureColumn("memories", "memory_type", "TEXT");
    this.ensureColumn("memories", "conflict_status", "TEXT NOT NULL DEFAULT 'none'");
    this.ensureColumn("memories", "conflict_memory_ids", "TEXT NOT NULL DEFAULT '[]'");
    this.ensureColumn("memories", "source_type", "TEXT NOT NULL DEFAULT 'input_event'");
    this.ensureColumn("memories", "source_id", "TEXT");
    this.ensureColumn("output_events", "agent_id", "TEXT NOT NULL DEFAULT 'default-agent'");
    this.ensureColumn("output_events", "source_type", "TEXT NOT NULL DEFAULT 'internal'");
    this.ensureColumn("output_events", "source_id", "TEXT");
    this.ensureColumn("tool_calls", "agent_id", "TEXT NOT NULL DEFAULT 'default-agent'");
    this.ensureColumn("confirmation_requests", "agent_id", "TEXT NOT NULL DEFAULT 'default-agent'");
    this.ensureColumn("schedules", "agent_id", "TEXT NOT NULL DEFAULT 'default-agent'");
    this.ensureColumn("logs", "agent_id", "TEXT NOT NULL DEFAULT 'default-agent'");
    this.createIndexes();
    this.run(`
      INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
      VALUES (1, 'initial_runtime_schema', datetime('now'));
    `);
    this.run("DROP TABLE IF EXISTS memory_vectors;");
  }

  ensureColumn(table, column, definition) {
    const columns = this.db.query(`PRAGMA table_info(${table})`).all();
    if (!columns.length) return;
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
    }
  }

  createIndexes() {
    const indexes = [
      "CREATE INDEX IF NOT EXISTS idx_input_events_agent_created ON input_events(agent_id, created_at DESC);",
      "CREATE INDEX IF NOT EXISTS idx_tasks_agent_created ON tasks(agent_id, created_at DESC);",
      "CREATE INDEX IF NOT EXISTS idx_tasks_source ON tasks(agent_id, source_type, source_id);",
      "CREATE INDEX IF NOT EXISTS idx_memories_agent_updated ON memories(agent_id, updated_at DESC);",
      "CREATE INDEX IF NOT EXISTS idx_memories_agent_kind ON memories(agent_id, memory_kind, updated_at DESC);",
      "CREATE INDEX IF NOT EXISTS idx_memories_agent_conflict ON memories(agent_id, conflict_status, updated_at DESC);",
      "CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(agent_id, source_type, source_id);",
      "CREATE INDEX IF NOT EXISTS idx_output_events_agent_created ON output_events(agent_id, created_at DESC);",
      "CREATE INDEX IF NOT EXISTS idx_tool_calls_agent_created ON tool_calls(agent_id, created_at DESC);",
      "CREATE INDEX IF NOT EXISTS idx_confirmation_requests_agent_status ON confirmation_requests(agent_id, status, created_at DESC);",
      "CREATE INDEX IF NOT EXISTS idx_schedules_agent_status_run ON schedules(agent_id, status, run_at);",
      "CREATE INDEX IF NOT EXISTS idx_logs_agent_created ON logs(agent_id, created_at DESC);"
    ];
    for (const index of indexes) {
      this.run(index);
    }
  }
}
