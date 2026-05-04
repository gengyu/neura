import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createId, nowIso } from "../shared/id.js";
import { INPUT_STATUSES, TASK_STATUSES } from "../shared/types.js";
import { similarityScore } from "../memory/memory.js";

export class Repository {
  constructor(store) {
    this.store = store;
  }

  ensureAgent(agent) {
    const now = nowIso();
    this.store.run(`
      INSERT INTO agents (id, name, status, created_at, updated_at)
      VALUES (${this.store.value(agent.id)}, ${this.store.value(agent.name)}, 'stopped', ${this.store.value(now)}, ${this.store.value(now)})
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at;
    `);
  }

  upsertPlugin(plugin, status = "enabled") {
    const now = nowIso();
    this.store.run(`
      INSERT INTO plugins (id, name, direction, type, status, enabled, config, created_at, updated_at)
      VALUES (
        ${this.store.value(plugin.id)},
        ${this.store.value(plugin.name)},
        ${this.store.value(plugin.direction)},
        ${this.store.value(plugin.type)},
        ${this.store.value(status)},
        ${plugin.enabled ? 1 : 0},
        ${this.store.json(plugin.config)},
        ${this.store.value(now)},
        ${this.store.value(now)}
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        direction = excluded.direction,
        type = excluded.type,
        config = excluded.config,
        updated_at = excluded.updated_at;
    `);
  }

  setPluginStatus(id, status) {
    this.store.run(`UPDATE plugins SET status = ${this.store.value(status)}, updated_at = ${this.store.value(nowIso())} WHERE id = ${this.store.value(id)};`);
  }

  setPluginEnabled(id, enabled) {
    this.store.run(`
      UPDATE plugins
      SET enabled = ${enabled ? 1 : 0}, status = ${this.store.value(enabled ? "enabled" : "disabled")}, updated_at = ${this.store.value(nowIso())}
      WHERE id = ${this.store.value(id)};
    `);
  }

  listPlugins() {
    return this.store.query("SELECT id, name, direction, type, status, enabled, config, created_at AS createdAt, updated_at AS updatedAt FROM plugins ORDER BY direction, id;");
  }

  isPluginEnabled(id) {
    const rows = this.store.query(`SELECT enabled FROM plugins WHERE id = ${this.store.value(id)} LIMIT 1;`);
    return rows[0]?.enabled === 1;
  }

  createInputEvent({ pluginId, type, content, metadata = {} }) {
    const event = {
      id: createId("input"),
      pluginId,
      type,
      content,
      metadata,
      status: INPUT_STATUSES.PENDING,
      createdAt: nowIso()
    };
    this.store.run(`
      INSERT INTO input_events (id, plugin_id, type, content, metadata, status, created_at)
      VALUES (${this.store.value(event.id)}, ${this.store.value(pluginId)}, ${this.store.value(type)}, ${this.store.json(content)}, ${this.store.json(metadata)}, ${this.store.value(event.status)}, ${this.store.value(event.createdAt)});
    `);
    return event;
  }

  updateInputEventStatus(id, status) {
    const processedAt = status === INPUT_STATUSES.COMPLETED || status === INPUT_STATUSES.FAILED ? nowIso() : null;
    this.store.run(`
      UPDATE input_events
      SET status = ${this.store.value(status)}, processed_at = ${this.store.value(processedAt)}
      WHERE id = ${this.store.value(id)};
    `);
  }

  createTask(inputEventId, type) {
    const task = {
      id: createId("task"),
      inputEventId,
      type,
      status: TASK_STATUSES.PROCESSING,
      createdAt: nowIso()
    };
    this.store.run(`
      INSERT INTO tasks (id, input_event_id, type, status, created_at)
      VALUES (${this.store.value(task.id)}, ${this.store.value(inputEventId)}, ${this.store.value(type)}, ${this.store.value(task.status)}, ${this.store.value(task.createdAt)});
    `);
    return task;
  }

  listTasks(limit = 20) {
    return this.store.query(`
      SELECT id, input_event_id AS inputEventId, type, status, result, error, created_at AS createdAt, finished_at AS finishedAt
      FROM tasks
      ORDER BY created_at DESC
      LIMIT ${Number(limit)};
    `);
  }

  finishTask(id, status, result, error = null) {
    this.store.run(`
      UPDATE tasks
      SET status = ${this.store.value(status)}, result = ${this.store.json(result)}, error = ${this.store.value(error)}, finished_at = ${this.store.value(nowIso())}
      WHERE id = ${this.store.value(id)};
    `);
  }

  createMemory({ content, summary, tags, sourceInputId, importance, confidence }) {
    const now = nowIso();
    const memory = {
      id: createId("memory"),
      content,
      summary,
      tags,
      sourceInputId,
      importance,
      confidence,
      createdAt: now,
      updatedAt: now
    };
    this.store.run(`
      INSERT INTO memories (id, content, summary, tags, source_input_id, importance, confidence, created_at, updated_at)
      VALUES (${this.store.value(memory.id)}, ${this.store.value(content)}, ${this.store.value(summary)}, ${this.store.json(tags)}, ${this.store.value(sourceInputId)}, ${importance}, ${confidence}, ${this.store.value(now)}, ${this.store.value(now)});
    `);
    return memory;
  }

  updateMemory(id, { content, summary, tags, sourceInputId, importance, confidence }) {
    const now = nowIso();
    const existing = this.getMemory(id);
    const mergedTags = mergeTags(existing?.tags, tags);
    const nextContent = mergeContent(existing?.content, content);
    const nextImportance = Math.max(Number(existing?.importance ?? 0), importance);
    const nextConfidence = Math.max(Number(existing?.confidence ?? 0), confidence);

    this.store.run(`
      UPDATE memories
      SET
        content = ${this.store.value(nextContent)},
        summary = ${this.store.value(summary)},
        tags = ${this.store.json(mergedTags)},
        source_input_id = ${this.store.value(sourceInputId)},
        importance = ${nextImportance},
        confidence = ${nextConfidence},
        updated_at = ${this.store.value(now)}
      WHERE id = ${this.store.value(id)};
    `);

    return {
      ...existing,
      id,
      content: nextContent,
      summary,
      tags: mergedTags,
      sourceInputId,
      importance: nextImportance,
      confidence: nextConfidence,
      updatedAt: now
    };
  }

  getMemory(id) {
    const rows = this.store.query(`
      SELECT id, content, summary, tags, source_input_id AS sourceInputId, importance, confidence, created_at AS createdAt, updated_at AS updatedAt
      FROM memories
      WHERE id = ${this.store.value(id)}
      LIMIT 1;
    `);
    return rows[0] ? decodeMemory(rows[0]) : null;
  }

  listMemories(limit = 20) {
    return this.store.query(`
      SELECT id, content, summary, tags, source_input_id AS sourceInputId, importance, confidence, created_at AS createdAt, updated_at AS updatedAt
      FROM memories
      ORDER BY created_at DESC
      LIMIT ${Number(limit)};
    `).map(decodeMemory);
  }

  searchMemories(query, limit = 20) {
    const like = `%${query}%`;
    return this.store.query(`
      SELECT id, content, summary, tags, source_input_id AS sourceInputId, importance, confidence, created_at AS createdAt, updated_at AS updatedAt
      FROM memories
      WHERE content LIKE ${this.store.value(like)} OR summary LIKE ${this.store.value(like)} OR tags LIKE ${this.store.value(like)}
      ORDER BY importance DESC, created_at DESC
      LIMIT ${Number(limit)};
    `).map(decodeMemory);
  }

  findSimilarMemory({ content, tags }, threshold = 0.78) {
    const tagQueries = (tags ?? []).filter((tag) => tag !== "未分类").slice(0, 4);
    const candidates = tagQueries.length > 0
      ? tagQueries.flatMap((tag) => this.searchMemories(tag, 8))
      : this.listMemories(12);
    const unique = new Map();
    for (const candidate of candidates) {
      unique.set(candidate.id, candidate);
    }

    let best = null;
    for (const candidate of unique.values()) {
      const score = Math.max(
        similarityScore(content, candidate.content),
        similarityScore(content, candidate.summary)
      );
      if (!best || score > best.score) best = { memory: candidate, score };
    }

    return best && best.score >= threshold ? best : null;
  }

  listInputEvents(limit = 20) {
    return this.store.query(`
      SELECT id, plugin_id AS pluginId, type, content, metadata, status, created_at AS createdAt, processed_at AS processedAt
      FROM input_events
      ORDER BY created_at DESC
      LIMIT ${Number(limit)};
    `).map((event) => ({
      ...event,
      content: parseJson(event.content),
      metadata: parseJson(event.metadata)
    }));
  }

  createOutputEvent({ pluginId, type, content, status = "sent" }) {
    const now = nowIso();
    const event = { id: createId("output"), pluginId, type, content, status, createdAt: now, sentAt: now };
    this.store.run(`
      INSERT INTO output_events (id, plugin_id, type, content, status, created_at, sent_at)
      VALUES (${this.store.value(event.id)}, ${this.store.value(pluginId)}, ${this.store.value(type)}, ${this.store.json(content)}, ${this.store.value(status)}, ${this.store.value(now)}, ${this.store.value(now)});
    `);
    return event;
  }

  createToolCall({ toolName, input, output = null, status, riskLevel = "low" }) {
    const now = nowIso();
    const id = createId("tool");
    this.store.run(`
      INSERT INTO tool_calls (id, tool_name, input, output, status, risk_level, created_at, finished_at)
      VALUES (${this.store.value(id)}, ${this.store.value(toolName)}, ${this.store.json(input)}, ${this.store.json(output)}, ${this.store.value(status)}, ${this.store.value(riskLevel)}, ${this.store.value(now)}, ${this.store.value(now)});
    `);
    return { id, toolName, input, output, status, riskLevel, createdAt: now, finishedAt: now };
  }

  listToolCalls(limit = 20) {
    return this.store.query(`
      SELECT id, tool_name AS toolName, input, output, status, risk_level AS riskLevel, created_at AS createdAt, finished_at AS finishedAt
      FROM tool_calls
      ORDER BY created_at DESC
      LIMIT ${Number(limit)};
    `).map((call) => ({
      ...call,
      input: parseJson(call.input),
      output: parseJson(call.output)
    }));
  }

  log(level, type, message, metadata = {}) {
    const createdAt = nowIso();
    this.store.run(`
      INSERT INTO logs (id, level, type, message, metadata, created_at)
      VALUES (${this.store.value(createId("log"))}, ${this.store.value(level)}, ${this.store.value(type)}, ${this.store.value(message)}, ${this.store.json(metadata)}, ${this.store.value(createdAt)});
    `);
    const logPath = resolve("logs/neura.log");
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, JSON.stringify({ createdAt, level, type, message, metadata }) + "\n");
  }

  recentLogs(limit = 12) {
    return this.store.query(`
      SELECT id, level, type, message, metadata, created_at AS createdAt
      FROM logs
      ORDER BY created_at DESC
      LIMIT ${Number(limit)};
    `);
  }

  setRuntimeState(key, value) {
    this.store.run(`
      INSERT INTO runtime_state (key, value, updated_at)
      VALUES (${this.store.value(key)}, ${this.store.json(value)}, ${this.store.value(nowIso())})
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
    `);
  }

  getRuntimeState(key) {
    const rows = this.store.query(`SELECT value, updated_at AS updatedAt FROM runtime_state WHERE key = ${this.store.value(key)} LIMIT 1;`);
    if (!rows[0]) return null;
    return { value: JSON.parse(rows[0].value), updatedAt: rows[0].updatedAt };
  }

  statusSummary() {
    const plugins = this.listPlugins();
    const inputCount = plugins.filter((plugin) => plugin.direction === "input" && plugin.enabled).length;
    const outputCount = plugins.filter((plugin) => plugin.direction === "output" && plugin.enabled).length;
    const counts = this.store.query(`
      SELECT
        (SELECT COUNT(*) FROM input_events) AS inputEvents,
        (SELECT COUNT(*) FROM tasks) AS tasks,
        (SELECT COUNT(*) FROM memories) AS memories,
        (SELECT COUNT(*) FROM output_events) AS outputEvents,
        (SELECT COUNT(*) FROM logs WHERE level = 'error') AS errors;
    `)[0];
    return { plugins, inputCount, outputCount, counts };
  }
}

function decodeMemory(row) {
  return {
    ...row,
    tags: parseJsonArray(row.tags)
  };
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJson(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function mergeTags(existing, next) {
  return [...new Set([...parseJsonArray(existing), ...(next ?? [])])].slice(0, 12);
}

function mergeContent(existing, next) {
  if (!existing) return next;
  if (existing === next || existing.includes(next)) return existing;
  if (next.includes(existing)) return next;
  return `${existing}\n\n${next}`;
}
