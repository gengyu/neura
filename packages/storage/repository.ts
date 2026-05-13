import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createId, nowIso } from "../shared/id.ts";
import {
  AGENT_STATUSES,
  APPROVAL_STATUSES,
  INPUT_STATUSES,
  INPUT_TYPES,
  OUTPUT_STATUSES,
  PLUGIN_STATUSES,
  SCHEDULE_STATUSES,
  SOURCE_TYPES,
  TASK_STATUSES
} from "../shared/types.ts";
import { detectMemoryConflict, inferMemoryKind, normalizeMemoryKind, similarityScore } from "../memory/memory.ts";
import { searchMemoryRecords } from "../memory/langchain-memory.ts";

export class Repository {
  constructor(store) {
    this.store = store;
  }

  ensureAgent(agent) {
    const now = nowIso();
    this.store.run(`
      INSERT INTO agents (id, name, status, created_at, updated_at)
      VALUES (${this.store.value(agent.id)}, ${this.store.value(agent.name)}, ${this.store.value(AGENT_STATUSES.STOPPED)}, ${this.store.value(now)}, ${this.store.value(now)})
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at;
    `);
  }

  createAgent({ id = createId("agent"), name }) {
    const now = nowIso();
    this.store.run(`
      INSERT INTO agents (id, name, status, created_at, updated_at)
      VALUES (${this.store.value(id)}, ${this.store.value(name)}, ${this.store.value(AGENT_STATUSES.ACTIVE)}, ${this.store.value(now)}, ${this.store.value(now)});
    `);
    return { id, name, status: AGENT_STATUSES.ACTIVE, createdAt: now, updatedAt: now };
  }

  listAgents() {
    return this.store.query(`
      SELECT id, name, status, created_at AS createdAt, updated_at AS updatedAt
      FROM agents
      ORDER BY created_at ASC;
    `);
  }

  setActiveAgent(id) {
    const agent = this.store.query(`SELECT id FROM agents WHERE id = ${this.store.value(id)} LIMIT 1;`)[0];
    if (!agent) throw new Error(`Agent not found: ${id}`);
    this.setRuntimeState("active_agent", { id });
    return this.getActiveAgent();
  }

  getActiveAgentId() {
    return this.getRuntimeState("active_agent")?.value?.id ?? "default-agent";
  }

  getActiveAgent() {
    const id = this.getActiveAgentId();
    return this.store.query(`
      SELECT id, name, status, created_at AS createdAt, updated_at AS updatedAt
      FROM agents
      WHERE id = ${this.store.value(id)}
      LIMIT 1;
    `)[0] ?? null;
  }

  setAgentStatus(id, status) {
    this.store.run(`
      UPDATE agents
      SET status = ${this.store.value(status)}, updated_at = ${this.store.value(nowIso())}
      WHERE id = ${this.store.value(id)};
    `);
  }

  upsertPlugin(plugin, status = PLUGIN_STATUSES.ENABLED) {
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
        status = excluded.status,
        enabled = excluded.enabled,
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
      SET enabled = ${enabled ? 1 : 0}, status = ${this.store.value(enabled ? PLUGIN_STATUSES.ENABLED : PLUGIN_STATUSES.DISABLED)}, updated_at = ${this.store.value(nowIso())}
      WHERE id = ${this.store.value(id)};
    `);
  }

  listPlugins() {
    return this.store.query("SELECT id, name, direction, type, status, enabled, config, created_at AS createdAt, updated_at AS updatedAt FROM plugins ORDER BY direction, id;");
  }

  pruneMissingPlugins(activeIds) {
    if (!activeIds.length) return;
    const ids = activeIds.map((id) => this.store.value(id)).join(", ");
    this.store.run(`DELETE FROM plugins WHERE id NOT IN (${ids});`);
  }

  isPluginEnabled(id) {
    const rows = this.store.query(`SELECT enabled FROM plugins WHERE id = ${this.store.value(id)} LIMIT 1;`);
    return rows[0]?.enabled === 1;
  }

  createInputEvent({ pluginId, type, content, metadata = {} }) {
    if (!INPUT_TYPES.has(type)) {
      throw new Error(`Unsupported input type: ${type}`);
    }
    const agentId = this.getActiveAgentId();
    const event = {
      id: createId("input"),
      agentId,
      pluginId,
      type,
      content,
      metadata,
      status: INPUT_STATUSES.PENDING,
      createdAt: nowIso()
    };
    this.store.run(`
      INSERT INTO input_events (id, agent_id, plugin_id, type, content, metadata, status, created_at)
      VALUES (${this.store.value(event.id)}, ${this.store.value(agentId)}, ${this.store.value(pluginId)}, ${this.store.value(type)}, ${this.store.json(content)}, ${this.store.json(metadata)}, ${this.store.value(event.status)}, ${this.store.value(event.createdAt)});
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

  createTask(sourceOrInputEventId, maybeType) {
    const source = typeof sourceOrInputEventId === "object"
      ? sourceOrInputEventId
      : { sourceType: SOURCE_TYPES.INPUT_EVENT, sourceId: sourceOrInputEventId, type: maybeType };
    const agentId = this.getActiveAgentId();
    const sourceType = source.sourceType ?? SOURCE_TYPES.INTERNAL;
    const sourceId = source.sourceId ?? null;
    const inputEventId = source.inputEventId ?? (sourceType === SOURCE_TYPES.INPUT_EVENT ? sourceId : null);
    const task = {
      id: createId("task"),
      agentId,
      inputEventId,
      sourceType,
      sourceId,
      type: source.type,
      status: TASK_STATUSES.PROCESSING,
      createdAt: nowIso()
    };
    this.store.run(`
      INSERT INTO tasks (id, agent_id, input_event_id, source_type, source_id, type, status, created_at)
      VALUES (${this.store.value(task.id)}, ${this.store.value(agentId)}, ${this.store.value(inputEventId)}, ${this.store.value(sourceType)}, ${this.store.value(sourceId)}, ${this.store.value(task.type)}, ${this.store.value(task.status)}, ${this.store.value(task.createdAt)});
    `);
    return task;
  }

  listTasks(limit = 20) {
    return this.store.query(`
      SELECT id, input_event_id AS inputEventId, source_type AS sourceType, source_id AS sourceId, type, status, result, error, created_at AS createdAt, finished_at AS finishedAt
      FROM tasks
      WHERE agent_id = ${this.store.value(this.getActiveAgentId())}
      ORDER BY created_at DESC
      LIMIT ${Number(limit)};
    `);
  }

  listCaptures(limit = 20, filters = {}) {
    const queryLimit = hasCaptureFilters(filters) ? Math.max(Number(limit) * 5, 100) : limit;
    return this.queryCaptures({ limit: queryLimit, filters }).slice(0, Number(limit));
  }

  getCapture(id) {
    const captures = this.queryCaptures({
      limit: 1,
      filters: { includeArchived: true },
      where: `(id = ${this.store.value(id)} OR input_event_id = ${this.store.value(id)})`
    });
    return captures[0] ?? null;
  }

  queryCaptures({ limit = 20, filters = {}, where = null } = {}) {
    const clauses = [
      `agent_id = ${this.store.value(this.getActiveAgentId())}`,
      "type = 'agent_loop'",
      "result IS NOT NULL"
    ];
    if (where) clauses.push(where);
    const rows = this.store.query(`
      SELECT id, input_event_id AS inputEventId, source_type AS sourceType, source_id AS sourceId, status, result, error, created_at AS createdAt, finished_at AS finishedAt
      FROM tasks
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT ${Number(limit)};
    `);
    return rows.map((task) => {
      const result = parseJson(task.result) ?? {};
      return {
        id: task.id,
        inputEventId: task.inputEventId,
        sourceType: task.sourceType,
        sourceId: task.sourceId,
        status: task.status,
        error: task.error,
        createdAt: task.createdAt,
        finishedAt: task.finishedAt,
        taskType: result.taskType,
        decision: result.decision ?? [],
        summary: result.capture?.summary ?? result.summary,
        title: result.capture?.title ?? result.normalizedInput?.title ?? result.summary,
        tags: result.tags ?? [],
        archived: Boolean(result.capture?.archived ?? result.archived),
        memory: result.capture?.memory ?? {
          remembered: result.remembered,
          action: result.memoryAction,
          id: result.memoryId,
          type: result.memoryType
        },
        schedule: result.capture?.schedule ?? result.schedule ?? null,
        capture: result.capture ?? null,
        result
      };
    }).filter((capture) => matchesCaptureFilters(capture, filters));
  }

  finishTask(id, status, result, error = null) {
    this.store.run(`
      UPDATE tasks
      SET status = ${this.store.value(status)}, result = ${this.store.json(result)}, error = ${this.store.value(error)}, finished_at = ${this.store.value(nowIso())}
      WHERE id = ${this.store.value(id)};
    `);
  }

  updateCaptureArchived(id, archived) {
    const capture = this.getCapture(id);
    if (!capture) return null;
    const result = {
      ...capture.result,
      archived: Boolean(archived),
      capture: {
        ...(capture.result?.capture ?? capture.capture ?? {}),
        archived: Boolean(archived),
        archivedAt: archived ? nowIso() : null
      }
    };
    this.store.run(`
      UPDATE tasks
      SET result = ${this.store.json(result)}
      WHERE id = ${this.store.value(capture.id)} AND agent_id = ${this.store.value(this.getActiveAgentId())};
    `);
    return this.getCapture(capture.id);
  }

  createMemory({ content, summary, tags, memoryKind = null, memoryType = null, conflictStatus = "none", conflictMemoryIds = [], sourceInputId, sourceType = SOURCE_TYPES.INPUT_EVENT, sourceId = sourceInputId ?? null, importance, confidence }) {
    const now = nowIso();
    const agentId = this.getActiveAgentId();
    const normalizedMemoryKind = memoryKind
      ? normalizeMemoryKind(memoryKind)
      : inferMemoryKind({ memoryType, tags, summary, content });
    let nextConflictStatus = conflictStatus ?? "none";
    let nextConflictMemoryIds = normalizeIdList(conflictMemoryIds);
    let nextConfidence = confidence;
    if (nextConflictStatus === "none") {
      const conflicts = this.findMemoryConflicts({ content, summary, tags, memoryKind: normalizedMemoryKind, memoryType }, { limit: 5 });
      if (conflicts.length > 0) {
        nextConflictStatus = "suspected";
        nextConflictMemoryIds = conflicts.map((item) => item.memory.id);
        nextConfidence = Math.min(Number(confidence ?? 0.7), 0.55);
      }
    }
    const memory = {
      id: createId("memory"),
      agentId,
      content,
      summary,
      tags,
      memoryKind: normalizedMemoryKind,
      memoryType,
      conflictStatus: nextConflictStatus,
      conflictMemoryIds: normalizeIdList(nextConflictMemoryIds),
      sourceInputId,
      sourceType,
      sourceId,
      importance,
      confidence: nextConfidence,
      createdAt: now,
      updatedAt: now
    };
    this.store.run(`
      INSERT INTO memories (id, agent_id, content, summary, tags, memory_kind, memory_type, conflict_status, conflict_memory_ids, source_input_id, source_type, source_id, importance, confidence, created_at, updated_at)
      VALUES (${this.store.value(memory.id)}, ${this.store.value(agentId)}, ${this.store.value(content)}, ${this.store.value(summary)}, ${this.store.json(tags)}, ${this.store.value(normalizedMemoryKind)}, ${this.store.value(memoryType)}, ${this.store.value(nextConflictStatus)}, ${this.store.json(memory.conflictMemoryIds)}, ${this.store.value(sourceInputId)}, ${this.store.value(sourceType)}, ${this.store.value(sourceId)}, ${importance}, ${nextConfidence}, ${this.store.value(now)}, ${this.store.value(now)});
    `);
    return memory;
  }

  updateMemory(id, { content, summary, tags, memoryKind = null, memoryType = null, conflictStatus = "none", conflictMemoryIds = [], sourceInputId, sourceType = SOURCE_TYPES.INPUT_EVENT, sourceId = sourceInputId ?? null, importance, confidence }) {
    const now = nowIso();
    const existing = this.getMemory(id);
    const mergedTags = mergeTags(existing?.tags, tags);
    const nextContent = mergeContent(existing?.content, content);
    const nextMemoryType = memoryType ?? existing?.memoryType ?? null;
    const inferredMemoryKind = inferMemoryKind({ memoryType: nextMemoryType, tags: mergedTags, summary, content: nextContent });
    const nextMemoryKind = memoryKind
      ? normalizeMemoryKind(memoryKind)
      : chooseMergedMemoryKind([{ memoryKind: existing?.memoryKind }, { memoryKind: inferredMemoryKind }]);
    const nextConflictStatus = conflictStatus ?? "none";
    const nextConflictMemoryIds = normalizeIdList(conflictMemoryIds);
    const nextImportance = Math.max(Number(existing?.importance ?? 0), importance);
    const nextConfidence = nextConflictStatus === "suspected"
      ? Math.min(Number(existing?.confidence ?? confidence), confidence)
      : Math.max(Number(existing?.confidence ?? 0), confidence);

    this.store.run(`
      UPDATE memories
      SET
        content = ${this.store.value(nextContent)},
        summary = ${this.store.value(summary)},
        tags = ${this.store.json(mergedTags)},
        memory_kind = ${this.store.value(nextMemoryKind)},
        memory_type = ${this.store.value(nextMemoryType)},
        conflict_status = ${this.store.value(nextConflictStatus)},
        conflict_memory_ids = ${this.store.json(nextConflictMemoryIds)},
        source_input_id = ${this.store.value(sourceInputId)},
        source_type = ${this.store.value(sourceType)},
        source_id = ${this.store.value(sourceId)},
        importance = ${nextImportance},
        confidence = ${nextConfidence},
        updated_at = ${this.store.value(now)}
      WHERE id = ${this.store.value(id)};
    `);

    const memory = {
      ...existing,
      id,
      content: nextContent,
      summary,
      tags: mergedTags,
      memoryKind: nextMemoryKind,
      memoryType: nextMemoryType,
      conflictStatus: nextConflictStatus,
      conflictMemoryIds: nextConflictMemoryIds,
      sourceInputId,
      sourceType,
      sourceId,
      importance: nextImportance,
      confidence: nextConfidence,
      updatedAt: now
    };
    return memory;
  }

  updateMemoryTags(id, tags) {
    const existing = this.getMemory(id);
    if (!existing) return null;
    const normalizedTags = [...new Set((tags ?? []).map((tag) => String(tag).trim()).filter(Boolean))].slice(0, 12);
    const now = nowIso();
    this.store.run(`
      UPDATE memories
      SET tags = ${this.store.json(normalizedTags)},
          updated_at = ${this.store.value(now)}
      WHERE id = ${this.store.value(id)} AND agent_id = ${this.store.value(this.getActiveAgentId())};
    `);
    const memory = {
      ...existing,
      tags: normalizedTags,
      updatedAt: now
    };
    return memory;
  }

  editMemory(id, { summary = undefined, content = undefined, tags = undefined, memoryKind = undefined, memoryType = undefined, conflictStatus = undefined, conflictMemoryIds = undefined, importance = undefined, confidence = undefined } = {}) {
    const existing = this.getMemory(id);
    if (!existing) return null;
    const next = {
      summary: summary === undefined ? existing.summary : String(summary).trim(),
      content: content === undefined ? existing.content : String(content).trim(),
      tags: tags === undefined ? existing.tags : normalizeTags(tags),
      memoryType: memoryType === undefined ? existing.memoryType ?? null : String(memoryType).trim() || null,
      conflictStatus: conflictStatus === undefined ? existing.conflictStatus ?? "none" : String(conflictStatus || "none"),
      conflictMemoryIds: conflictMemoryIds === undefined ? existing.conflictMemoryIds ?? [] : normalizeIdList(conflictMemoryIds),
      importance: importance === undefined ? existing.importance : clampNumber(importance, 1, 5),
      confidence: confidence === undefined ? existing.confidence : clampNumber(confidence, 0, 1),
      updatedAt: nowIso()
    };
    next.memoryKind = memoryKind === undefined
      ? (memoryType === undefined && tags === undefined && summary === undefined && content === undefined
        ? normalizeMemoryKind(existing.memoryKind)
        : inferMemoryKind({ memoryType: next.memoryType, tags: next.tags, summary: next.summary, content: next.content }))
      : normalizeMemoryKind(memoryKind);
    if (!next.summary) next.summary = existing.summary;
    if (!next.content) next.content = existing.content;
    this.store.run(`
      UPDATE memories
      SET summary = ${this.store.value(next.summary)},
          content = ${this.store.value(next.content)},
          tags = ${this.store.json(next.tags)},
          memory_kind = ${this.store.value(next.memoryKind)},
          memory_type = ${this.store.value(next.memoryType)},
          conflict_status = ${this.store.value(next.conflictStatus)},
          conflict_memory_ids = ${this.store.json(next.conflictMemoryIds)},
          importance = ${next.importance},
          confidence = ${next.confidence},
          updated_at = ${this.store.value(next.updatedAt)}
      WHERE id = ${this.store.value(id)} AND agent_id = ${this.store.value(this.getActiveAgentId())};
    `);
    this.log("info", "memory", "Memory edited", { memoryId: id });
    return this.getMemory(id);
  }

  deleteMemory(id) {
    const existing = this.getMemory(id);
    if (!existing) return null;
    this.store.run(`
      DELETE FROM memories
      WHERE id = ${this.store.value(id)} AND agent_id = ${this.store.value(this.getActiveAgentId())};
    `);
    this.log("info", "memory", "Memory deleted", { memoryId: id, summary: existing.summary });
    return existing;
  }

  mergeMemories(targetId, sourceIds = []) {
    const target = this.getMemory(targetId);
    if (!target) return null;
    const sources = sourceIds.map((id) => this.getMemory(id)).filter(Boolean);
    if (sources.length === 0) return target;

    const mergedContent = mergeContent(target.content, sources.map((memory) => memory.content).join("\n\n"));
    const mergedSummary = target.summary;
    const mergedTags = mergeTags(target.tags, sources.flatMap((memory) => memory.tags ?? []));
    const mergedKind = chooseMergedMemoryKind([target, ...sources]);
    const mergedType = target.memoryType ?? sources.find((memory) => memory.memoryType)?.memoryType ?? null;
    const mergedImportance = Math.max(Number(target.importance ?? 0), ...sources.map((memory) => Number(memory.importance ?? 0)));
    const mergedConfidence = Math.max(Number(target.confidence ?? 0), ...sources.map((memory) => Number(memory.confidence ?? 0)));
    const updated = this.editMemory(targetId, {
      summary: mergedSummary,
      content: mergedContent,
      tags: mergedTags,
      memoryKind: mergedKind,
      memoryType: mergedType,
      importance: mergedImportance,
      confidence: mergedConfidence
    });

    for (const source of sources) {
      this.store.run(`
        DELETE FROM memories
        WHERE id = ${this.store.value(source.id)} AND agent_id = ${this.store.value(this.getActiveAgentId())};
      `);
    }
    this.log("info", "memory", "Memories merged", {
      targetId,
      sourceIds: sources.map((memory) => memory.id)
    });
    return { memory: updated, mergedIds: sources.map((memory) => memory.id) };
  }

  getMemory(id) {
    const rows = this.store.query(`
      SELECT id, content, summary, tags, memory_kind AS memoryKind, memory_type AS memoryType, conflict_status AS conflictStatus, conflict_memory_ids AS conflictMemoryIds, source_input_id AS sourceInputId, source_type AS sourceType, source_id AS sourceId, importance, confidence, created_at AS createdAt, updated_at AS updatedAt
      FROM memories
      WHERE id = ${this.store.value(id)} AND agent_id = ${this.store.value(this.getActiveAgentId())}
      LIMIT 1;
    `);
    return rows[0] ? decodeMemory(rows[0]) : null;
  }

  listMemories(limit = 20, filters = {}) {
    const clauses = [`agent_id = ${this.store.value(this.getActiveAgentId())}`];
    if (filters.kind) {
      clauses.push(`memory_kind = ${this.store.value(normalizeMemoryKind(filters.kind))}`);
    }
    if (filters.conflicts) {
      clauses.push("conflict_status != 'none'");
    }
    return this.store.query(`
      SELECT id, agent_id AS agentId, content, summary, tags, memory_kind AS memoryKind, memory_type AS memoryType, conflict_status AS conflictStatus, conflict_memory_ids AS conflictMemoryIds, source_input_id AS sourceInputId, source_type AS sourceType, source_id AS sourceId, importance, confidence, created_at AS createdAt, updated_at AS updatedAt
      FROM memories
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT ${Number(limit)};
    `).map(decodeMemory);
  }

  async searchMemories(query, limit = 20, filters = {}) {
    const memoryPool = this.listMemories(1_000, filters);
    const vectorMatches = await searchMemoryRecords(query, memoryPool, limit);
    if (vectorMatches.length > 0) return vectorMatches;
    const like = `%${query}%`;
    const clauses = [
      `agent_id = ${this.store.value(this.getActiveAgentId())}`,
      `(content LIKE ${this.store.value(like)} OR summary LIKE ${this.store.value(like)} OR tags LIKE ${this.store.value(like)} OR memory_kind LIKE ${this.store.value(like)} OR memory_type LIKE ${this.store.value(like)})`
    ];
    if (filters.kind) {
      clauses.push(`memory_kind = ${this.store.value(normalizeMemoryKind(filters.kind))}`);
    }
    if (filters.conflicts) {
      clauses.push("conflict_status != 'none'");
    }
    return this.store.query(`
      SELECT id, agent_id AS agentId, content, summary, tags, memory_kind AS memoryKind, memory_type AS memoryType, conflict_status AS conflictStatus, conflict_memory_ids AS conflictMemoryIds, source_input_id AS sourceInputId, source_type AS sourceType, source_id AS sourceId, importance, confidence, created_at AS createdAt, updated_at AS updatedAt
      FROM memories
      WHERE ${clauses.join(" AND ")}
      ORDER BY importance DESC, created_at DESC
      LIMIT ${Number(limit)};
    `).map((memory) => ({ ...decodeMemory(memory), vectorScore: 0 }));
  }

  findMemoryConflicts(payload, { limit = 5, excludeIds = [] } = {}) {
    const exclude = new Set(excludeIds.map(String));
    const kind = normalizeMemoryKind(payload.memoryKind ?? inferMemoryKind(payload));
    const candidates = this.listMemories(200, { kind })
      .filter((memory) => !exclude.has(String(memory.id)));
    const payloadText = memoryConflictText(payload);

    return candidates
      .map((memory) => {
        const conflict = detectMemoryConflict(payloadText, memoryConflictText(memory));
        return {
          memory,
          score: Number(conflict.score.toFixed(6)),
          conflicting: conflict.conflicting,
          reasons: conflict.reasons
        };
      })
      .filter((item) => item.conflicting && item.score >= 0.3)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  memoryStats() {
    const agentId = this.store.value(this.getActiveAgentId());
    const byKind = this.store.query(`
      SELECT memory_kind AS kind, COUNT(*) AS count, AVG(importance) AS averageImportance, AVG(confidence) AS averageConfidence
      FROM memories
      WHERE agent_id = ${agentId}
      GROUP BY memory_kind
      ORDER BY count DESC, kind ASC;
    `).map((row) => ({
      kind: normalizeMemoryKind(row.kind),
      count: Number(row.count ?? 0),
      averageImportance: roundNumber(row.averageImportance),
      averageConfidence: roundNumber(row.averageConfidence)
    }));
    const totals = this.store.query(`
      SELECT
        COUNT(*) AS count,
        SUM(CASE WHEN conflict_status != 'none' THEN 1 ELSE 0 END) AS conflicts
      FROM memories
      WHERE agent_id = ${agentId};
    `)[0] ?? {};
    return { total: Number(totals.count ?? 0), conflicts: Number(totals.conflicts ?? 0), byKind };
  }

  async findSimilarMemory({ content, tags }, threshold = 0.78) {
    const tagQueries = (tags ?? []).filter((tag) => tag !== "未分类").slice(0, 4);
    const candidates = tagQueries.length > 0
      ? (await Promise.all(tagQueries.map((tag) => this.searchMemories(tag, 8)))).flat()
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
      WHERE agent_id = ${this.store.value(this.getActiveAgentId())}
      ORDER BY created_at DESC
      LIMIT ${Number(limit)};
    `).map((event) => ({
      ...event,
      content: parseJson(event.content),
      metadata: parseJson(event.metadata)
    }));
  }

  createOutputEvent({ pluginId, sourceType = SOURCE_TYPES.INTERNAL, sourceId = null, type, content, status = OUTPUT_STATUSES.SENT }) {
    const now = nowIso();
    const agentId = this.getActiveAgentId();
    const sentAt = status === OUTPUT_STATUSES.SENT ? now : null;
    const event = { id: createId("output"), agentId, pluginId, sourceType, sourceId, type, content, status, createdAt: now, sentAt };
    this.store.run(`
      INSERT INTO output_events (id, agent_id, plugin_id, source_type, source_id, type, content, status, created_at, sent_at)
      VALUES (${this.store.value(event.id)}, ${this.store.value(agentId)}, ${this.store.value(pluginId)}, ${this.store.value(sourceType)}, ${this.store.value(sourceId)}, ${this.store.value(type)}, ${this.store.json(content)}, ${this.store.value(status)}, ${this.store.value(now)}, ${this.store.value(sentAt)});
    `);
    return event;
  }

  updateOutputEventStatus(id, status, content = undefined) {
    const sentAt = status === OUTPUT_STATUSES.SENT ? nowIso() : null;
    const contentSql = content === undefined ? "content" : this.store.json(content);
    this.store.run(`
      UPDATE output_events
      SET status = ${this.store.value(status)},
          content = ${contentSql},
          sent_at = ${this.store.value(sentAt)}
      WHERE id = ${this.store.value(id)};
    `);
  }

  listOutputEvents(limit = 20) {
    return this.store.query(`
      SELECT id, plugin_id AS pluginId, source_type AS sourceType, source_id AS sourceId, type, content, status, created_at AS createdAt, sent_at AS sentAt
      FROM output_events
      WHERE agent_id = ${this.store.value(this.getActiveAgentId())}
      ORDER BY created_at DESC
      LIMIT ${Number(limit)};
    `).map((event) => ({
      ...event,
      content: parseJson(event.content)
    }));
  }

  createConfirmationRequest({ toolName, payload, reason }) {
    const now = nowIso();
    const agentId = this.getActiveAgentId();
    const request = {
      id: createId("confirm"),
      agentId,
      toolName,
      payload,
      reason,
      status: APPROVAL_STATUSES.PENDING,
      resolution: null,
      createdAt: now,
      resolvedAt: null
    };
    this.store.run(`
      INSERT INTO confirmation_requests (id, agent_id, tool_name, payload, reason, status, resolution, created_at, resolved_at)
      VALUES (${this.store.value(request.id)}, ${this.store.value(agentId)}, ${this.store.value(toolName)}, ${this.store.json(payload)}, ${this.store.value(reason)}, ${this.store.value(APPROVAL_STATUSES.PENDING)}, NULL, ${this.store.value(now)}, NULL);
    `);
    return request;
  }

  getConfirmationRequest(id) {
    const rows = this.store.query(`
      SELECT id, tool_name AS toolName, payload, reason, status, resolution, created_at AS createdAt, resolved_at AS resolvedAt
      FROM confirmation_requests
      WHERE id = ${this.store.value(id)} AND agent_id = ${this.store.value(this.getActiveAgentId())}
      LIMIT 1;
    `);
    return rows[0] ? decodeConfirmationRequest(rows[0]) : null;
  }

  listConfirmationRequests(status = null, limit = 20) {
    const where = status
      ? `WHERE agent_id = ${this.store.value(this.getActiveAgentId())} AND status = ${this.store.value(status)}`
      : `WHERE agent_id = ${this.store.value(this.getActiveAgentId())}`;
    return this.store.query(`
      SELECT id, tool_name AS toolName, payload, reason, status, resolution, created_at AS createdAt, resolved_at AS resolvedAt
      FROM confirmation_requests
      ${where}
      ORDER BY created_at DESC
      LIMIT ${Number(limit)};
    `).map(decodeConfirmationRequest);
  }

  resolveConfirmationRequest(id, resolution) {
    const status = resolution === APPROVAL_STATUSES.APPROVED ? APPROVAL_STATUSES.APPROVED : APPROVAL_STATUSES.REJECTED;
    const resolvedAt = nowIso();
    this.store.run(`
      UPDATE confirmation_requests
      SET status = ${this.store.value(status)}, resolution = ${this.store.value(resolution)}, resolved_at = ${this.store.value(resolvedAt)}
      WHERE id = ${this.store.value(id)};
    `);
    return this.getConfirmationRequest(id);
  }

  createSchedule({ name, mode, content, runAt, intervalMs = null, status = SCHEDULE_STATUSES.ACTIVE }) {
    const now = nowIso();
    const agentId = this.getActiveAgentId();
    const schedule = {
      id: createId("schedule"),
      agentId,
      name,
      mode,
      content,
      runAt,
      intervalMs,
      status,
      lastRunAt: null,
      createdAt: now,
      updatedAt: now
    };
    this.store.run(`
      INSERT INTO schedules (id, agent_id, name, mode, content, run_at, interval_ms, status, last_run_at, created_at, updated_at)
      VALUES (
        ${this.store.value(schedule.id)},
        ${this.store.value(agentId)},
        ${this.store.value(name)},
        ${this.store.value(mode)},
        ${this.store.json(content)},
        ${this.store.value(runAt)},
        ${intervalMs === null ? "NULL" : Number(intervalMs)},
        ${this.store.value(status)},
        NULL,
        ${this.store.value(now)},
        ${this.store.value(now)}
      );
    `);
    return schedule;
  }

  listSchedules(status = null, limit = 50) {
    const where = status
      ? `WHERE agent_id = ${this.store.value(this.getActiveAgentId())} AND status = ${this.store.value(status)}`
      : `WHERE agent_id = ${this.store.value(this.getActiveAgentId())}`;
    return this.store.query(`
      SELECT id, name, mode, content, run_at AS runAt, interval_ms AS intervalMs, status, last_run_at AS lastRunAt, created_at AS createdAt, updated_at AS updatedAt
      FROM schedules
      ${where}
      ORDER BY run_at ASC
      LIMIT ${Number(limit)};
    `).map(decodeSchedule);
  }

  getDueSchedules(now = nowIso()) {
    return this.store.query(`
      SELECT id, name, mode, content, run_at AS runAt, interval_ms AS intervalMs, status, last_run_at AS lastRunAt, created_at AS createdAt, updated_at AS updatedAt
      FROM schedules
      WHERE agent_id = ${this.store.value(this.getActiveAgentId())} AND status = ${this.store.value(SCHEDULE_STATUSES.ACTIVE)} AND run_at <= ${this.store.value(now)}
      ORDER BY run_at ASC;
    `).map(decodeSchedule);
  }

  markScheduleRun(id, { nextRunAt = null, status = null } = {}) {
    const now = nowIso();
    const existing = this.store.query(`
      SELECT id, name, mode, content, run_at AS runAt, interval_ms AS intervalMs, status, last_run_at AS lastRunAt, created_at AS createdAt, updated_at AS updatedAt
      FROM schedules
      WHERE id = ${this.store.value(id)} AND agent_id = ${this.store.value(this.getActiveAgentId())}
      LIMIT 1;
    `)[0];
    if (!existing) return null;
    const nextStatus = status ?? existing.status;
    const nextRun = nextRunAt ?? existing.runAt;
    this.store.run(`
      UPDATE schedules
      SET run_at = ${this.store.value(nextRun)},
          status = ${this.store.value(nextStatus)},
          last_run_at = ${this.store.value(now)},
          updated_at = ${this.store.value(now)}
      WHERE id = ${this.store.value(id)};
    `);
    return this.listSchedules().find((item) => item.id === id) ?? null;
  }

  updateScheduleStatus(id, status) {
    this.store.run(`
      UPDATE schedules
      SET status = ${this.store.value(status)}, updated_at = ${this.store.value(nowIso())}
      WHERE id = ${this.store.value(id)} AND agent_id = ${this.store.value(this.getActiveAgentId())};
    `);
  }

  deleteSchedule(id) {
    this.store.run(`DELETE FROM schedules WHERE id = ${this.store.value(id)} AND agent_id = ${this.store.value(this.getActiveAgentId())};`);
  }

  createToolCall({ toolName, input, output = null, status, riskLevel = "low" }) {
    const now = nowIso();
    const agentId = this.getActiveAgentId();
    const id = createId("tool");
    this.store.run(`
      INSERT INTO tool_calls (id, agent_id, tool_name, input, output, status, risk_level, created_at, finished_at)
      VALUES (${this.store.value(id)}, ${this.store.value(agentId)}, ${this.store.value(toolName)}, ${this.store.json(input)}, ${this.store.json(output)}, ${this.store.value(status)}, ${this.store.value(riskLevel)}, ${this.store.value(now)}, ${this.store.value(now)});
    `);
    return { id, agentId, toolName, input, output, status, riskLevel, createdAt: now, finishedAt: now };
  }

  listToolCalls(limit = 20) {
    return this.store.query(`
      SELECT id, tool_name AS toolName, input, output, status, risk_level AS riskLevel, created_at AS createdAt, finished_at AS finishedAt
      FROM tool_calls
      WHERE agent_id = ${this.store.value(this.getActiveAgentId())}
      ORDER BY created_at DESC
      LIMIT ${Number(limit)};
    `).map((call) => ({
      ...call,
      input: parseJson(call.input),
      output: parseJson(call.output)
    }));
  }

  clearCurrentAgentHistory() {
    const agentId = this.getActiveAgentId();
    const quotedAgentId = this.store.value(agentId);
    const counts = this.store.query(`
      SELECT
        (SELECT COUNT(*) FROM input_events WHERE agent_id = ${quotedAgentId}) AS inputEvents,
        (SELECT COUNT(*) FROM tasks WHERE agent_id = ${quotedAgentId}) AS tasks,
        (SELECT COUNT(*) FROM memories WHERE agent_id = ${quotedAgentId}) AS memories,
        (SELECT COUNT(*) FROM output_events WHERE agent_id = ${quotedAgentId}) AS outputEvents,
        (SELECT COUNT(*) FROM confirmation_requests WHERE agent_id = ${quotedAgentId}) AS approvals,
        (SELECT COUNT(*) FROM schedules WHERE agent_id = ${quotedAgentId}) AS schedules,
        (SELECT COUNT(*) FROM tool_calls WHERE agent_id = ${quotedAgentId}) AS toolCalls,
        (SELECT COUNT(*) FROM logs WHERE agent_id = ${quotedAgentId}) AS logs;
    `)[0];

    for (const table of [
      "input_events",
      "tasks",
      "memories",
      "output_events",
      "confirmation_requests",
      "schedules",
      "tool_calls",
      "logs"
    ]) {
      this.store.run(`DELETE FROM ${table} WHERE agent_id = ${quotedAgentId};`);
    }

    return { agentId, deleted: counts };
  }

  log(level, type, message, metadata = {}) {
    const createdAt = nowIso();
    const agentId = this.getActiveAgentId();
    this.store.run(`
      INSERT INTO logs (id, agent_id, level, type, message, metadata, created_at)
      VALUES (${this.store.value(createId("log"))}, ${this.store.value(agentId)}, ${this.store.value(level)}, ${this.store.value(type)}, ${this.store.value(message)}, ${this.store.json(metadata)}, ${this.store.value(createdAt)});
    `);
    const logPath = resolve("logs/neura.log");
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, JSON.stringify({ createdAt, level, type, message, metadata }) + "\n");
  }

  recentLogs(limit = 12) {
    return this.store.query(`
      SELECT id, level, type, message, metadata, created_at AS createdAt
      FROM logs
      WHERE agent_id = ${this.store.value(this.getActiveAgentId())}
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
        (SELECT COUNT(*) FROM input_events WHERE agent_id = ${this.store.value(this.getActiveAgentId())}) AS inputEvents,
        (SELECT COUNT(*) FROM tasks WHERE agent_id = ${this.store.value(this.getActiveAgentId())}) AS tasks,
        (SELECT COUNT(*) FROM memories WHERE agent_id = ${this.store.value(this.getActiveAgentId())}) AS memories,
        (SELECT COUNT(*) FROM output_events WHERE agent_id = ${this.store.value(this.getActiveAgentId())}) AS outputEvents,
        (SELECT COUNT(*) FROM confirmation_requests WHERE agent_id = ${this.store.value(this.getActiveAgentId())} AND status = ${this.store.value(APPROVAL_STATUSES.PENDING)}) AS pendingApprovals,
        (SELECT COUNT(*) FROM schedules WHERE agent_id = ${this.store.value(this.getActiveAgentId())} AND status = ${this.store.value(SCHEDULE_STATUSES.ACTIVE)}) AS activeSchedules,
        (SELECT COUNT(*) FROM logs WHERE agent_id = ${this.store.value(this.getActiveAgentId())} AND level = 'error') AS errors;
    `)[0];
    return { plugins, inputCount, outputCount, counts };
  }
}

function decodeMemory(row) {
  const memoryType = row.memoryType ?? null;
  const memoryKind = row.memoryKind
    ? normalizeMemoryKind(row.memoryKind)
    : inferMemoryKind({ memoryType, tags: parseJsonArray(row.tags), summary: row.summary, content: row.content });
  return {
    ...row,
    memoryKind,
    memoryType,
    conflictStatus: row.conflictStatus ?? "none",
    conflictMemoryIds: parseJsonArray(row.conflictMemoryIds),
    tags: parseJsonArray(row.tags)
  };
}

function decodeConfirmationRequest(row) {
  return {
    ...row,
    payload: parseJson(row.payload)
  };
}

function decodeSchedule(row) {
  return {
    ...row,
    content: parseJson(row.content)
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

function normalizeTags(tags) {
  return [...new Set((Array.isArray(tags) ? tags : String(tags ?? "").split(","))
    .map((tag) => String(tag).trim())
    .filter(Boolean)
  )].slice(0, 12);
}

function normalizeIdList(values) {
  return [...new Set((Array.isArray(values) ? values : parseJsonArray(values))
    .map((value) => String(value).trim())
    .filter(Boolean)
  )].slice(0, 12);
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function roundNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(3)) : 0;
}

function mergeContent(existing, next) {
  if (!existing) return next;
  if (existing === next || existing.includes(next)) return existing;
  if (next.includes(existing)) return next;
  return `${existing}\n\n${next}`;
}

function memoryConflictText(memory) {
  return [
    memory.summary,
    memory.content,
    memory.memoryKind,
    memory.memoryType,
    ...(Array.isArray(memory.tags) ? memory.tags : [])
  ].filter(Boolean).join("\n");
}

function chooseMergedMemoryKind(memories) {
  const priority = ["decision", "preference", "project", "person", "task", "knowledge", "fact", "note"];
  const kinds = new Set(memories.map((memory) => normalizeMemoryKind(memory?.memoryKind)));
  return priority.find((kind) => kinds.has(kind)) ?? "note";
}

function matchesCaptureFilters(capture, filters = {}) {
  if (!filters.includeArchived && !filters.archived && capture.archived) return false;
  if (filters.archived !== undefined && Boolean(capture.archived) !== Boolean(filters.archived)) return false;
  if (filters.taskType && capture.taskType !== filters.taskType) return false;
  if (filters.action && !(capture.decision ?? []).includes(filters.action)) return false;
  if (filters.remembered !== undefined && Boolean(capture.memory?.remembered) !== Boolean(filters.remembered)) return false;
  if (filters.scheduled !== undefined && Boolean(capture.schedule?.runAt) !== Boolean(filters.scheduled)) return false;
  if (filters.tag && !(capture.tags ?? []).includes(filters.tag)) return false;
  if (filters.query) {
    const haystack = [
      capture.title,
      capture.summary,
      ...(capture.tags ?? []),
      capture.result?.answer,
      capture.result?.normalizedInput?.title
    ].filter(Boolean).join("\n").toLowerCase();
    if (!haystack.includes(String(filters.query).toLowerCase())) return false;
  }
  return true;
}

function hasCaptureFilters(filters = {}) {
  return Object.values(filters).some((value) => value !== undefined && value !== false && value !== "");
}
