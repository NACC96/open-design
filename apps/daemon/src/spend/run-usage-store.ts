/**
 * `run_usage`: one row per physical agent run (or, for history recorded
 * before this table existed, per assistant message), holding the normalized
 * token usage and model identity that project spend prices.
 *
 * Rows hang off their assistant message, so deleting a conversation or a
 * project removes its spend with it. Prices are NOT stored: a row keeps the
 * facts (tokens, models, the agent's reported cost, the catalog price at
 * launch) and pricing happens at read time, so editing a price override
 * re-prices history.
 */

import type Database from 'better-sqlite3';
import type { RunUsageSnapshot } from './run-usage.js';

type SqliteDb = Database.Database;

/** Where a row's usage came from. */
export type RunUsageSource =
  /** Folded from the run's live event stream. */
  | 'live'
  /** Replayed from the run's durable event log after the fact. */
  | 'replayed'
  /** Reconstructed from the assistant message's persisted events (lossy). */
  | 'message_events';

export interface RunUsageRecord {
  runId: string;
  messageId: string;
  agentId: string | null;
  requestedModel: string | null;
  launchModel: string | null;
  usage: RunUsageSnapshot;
  catalogPrice: { input: number; output: number } | null;
  source: RunUsageSource;
  /** Model identity was inferred rather than recorded for this run. */
  modelInferred?: boolean;
}

export function migrateRunUsage(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_usage (
      run_id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      agent_id TEXT,
      requested_model TEXT,
      launch_model TEXT,
      reported_model TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      usage_events INTEGER NOT NULL DEFAULT 0,
      reported_cost_usd REAL,
      reported_cost_complete INTEGER NOT NULL DEFAULT 0,
      catalog_input_price REAL,
      catalog_output_price REAL,
      source TEXT NOT NULL,
      approximate INTEGER NOT NULL DEFAULT 0,
      model_inferred INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_run_usage_message
      ON run_usage(message_id);
  `);
}

function recordParams(record: RunUsageRecord, now: number) {
  const { usage } = record;
  return {
    runId: record.runId,
    messageId: record.messageId,
    agentId: record.agentId,
    requestedModel: record.requestedModel,
    launchModel: record.launchModel,
    reportedModel: usage.reportedModel,
    inputTokens: Math.round(usage.tokens.input),
    outputTokens: Math.round(usage.tokens.output),
    cacheReadTokens: Math.round(usage.tokens.cacheRead),
    cacheWriteTokens: Math.round(usage.tokens.cacheWrite),
    cacheWrite1hTokens: Math.round(usage.tokens.cacheWrite1h),
    reasoningTokens: Math.round(usage.reasoningTokens),
    usageEvents: usage.usageEvents,
    reportedCostUsd: usage.reportedCostUsd,
    reportedCostComplete: usage.reportedCostComplete ? 1 : 0,
    catalogInputPrice: record.catalogPrice?.input ?? null,
    catalogOutputPrice: record.catalogPrice?.output ?? null,
    source: record.source,
    approximate: usage.approximate ? 1 : 0,
    modelInferred: record.modelInferred ? 1 : 0,
    now,
  };
}

const COLUMNS = `
  run_id, message_id, agent_id, requested_model, launch_model, reported_model,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens, reasoning_tokens,
  usage_events, reported_cost_usd, reported_cost_complete,
  catalog_input_price, catalog_output_price, source, approximate, model_inferred,
  created_at, updated_at
`;

const VALUES = `
  @runId, @messageId, @agentId, @requestedModel, @launchModel, @reportedModel,
  @inputTokens, @outputTokens, @cacheReadTokens, @cacheWriteTokens, @cacheWrite1hTokens, @reasoningTokens,
  @usageEvents, @reportedCostUsd, @reportedCostComplete,
  @catalogInputPrice, @catalogOutputPrice, @source, @approximate, @modelInferred,
  @now, @now
`;

/** Insert or replace the live row for a run; `created_at` survives updates. */
export function upsertRunUsage(db: SqliteDb, record: RunUsageRecord, now = Date.now()): void {
  db.prepare(`
    INSERT INTO run_usage (${COLUMNS}) VALUES (${VALUES})
    ON CONFLICT(run_id) DO UPDATE SET
      message_id = excluded.message_id,
      agent_id = excluded.agent_id,
      requested_model = excluded.requested_model,
      launch_model = excluded.launch_model,
      reported_model = excluded.reported_model,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      cache_write_tokens = excluded.cache_write_tokens,
      cache_write_1h_tokens = excluded.cache_write_1h_tokens,
      reasoning_tokens = excluded.reasoning_tokens,
      usage_events = excluded.usage_events,
      reported_cost_usd = excluded.reported_cost_usd,
      reported_cost_complete = excluded.reported_cost_complete,
      catalog_input_price = excluded.catalog_input_price,
      catalog_output_price = excluded.catalog_output_price,
      source = excluded.source,
      approximate = excluded.approximate,
      model_inferred = excluded.model_inferred,
      updated_at = excluded.updated_at
  `).run(recordParams(record, now));
}

/** Insert backfilled rows; a row that already exists (a concurrent backfill, a live run) wins. */
export function insertBackfilledRunUsage(db: SqliteDb, records: RunUsageRecord[], now = Date.now()): void {
  if (records.length === 0) return;
  const insert = db.prepare(`INSERT OR IGNORE INTO run_usage (${COLUMNS}) VALUES (${VALUES})`);
  const tx = db.transaction((rows: RunUsageRecord[]) => {
    for (const record of rows) insert.run(recordParams(record, now));
  });
  tx(records);
}

export interface ProjectRunUsageRow {
  runId: string;
  messageId: string;
  conversationId: string;
  conversationTitle: string | null;
  conversationUpdatedAt: number;
  agentId: string | null;
  requestedModel: string | null;
  launchModel: string | null;
  reportedModel: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens: number;
  usageEvents: number;
  reportedCostUsd: number | null;
  reportedCostComplete: boolean;
  catalogInputPrice: number | null;
  catalogOutputPrice: number | null;
  source: RunUsageSource;
  approximate: boolean;
  modelInferred: boolean;
}

export function listProjectRunUsage(db: SqliteDb, projectId: string): ProjectRunUsageRow[] {
  const rows = db.prepare(`
    SELECT
      ru.run_id AS runId,
      ru.message_id AS messageId,
      c.id AS conversationId,
      c.title AS conversationTitle,
      c.updated_at AS conversationUpdatedAt,
      ru.agent_id AS agentId,
      ru.requested_model AS requestedModel,
      ru.launch_model AS launchModel,
      ru.reported_model AS reportedModel,
      ru.input_tokens AS inputTokens,
      ru.output_tokens AS outputTokens,
      ru.cache_read_tokens AS cacheReadTokens,
      ru.cache_write_tokens AS cacheWriteTokens,
      ru.cache_write_1h_tokens AS cacheWrite1hTokens,
      ru.usage_events AS usageEvents,
      ru.reported_cost_usd AS reportedCostUsd,
      ru.reported_cost_complete AS reportedCostComplete,
      ru.catalog_input_price AS catalogInputPrice,
      ru.catalog_output_price AS catalogOutputPrice,
      ru.source AS source,
      ru.approximate AS approximate,
      ru.model_inferred AS modelInferred
    FROM run_usage ru
    JOIN messages m ON m.id = ru.message_id
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.project_id = ?
    ORDER BY c.updated_at DESC, m.position ASC
  `).all(projectId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    ...(row as unknown as ProjectRunUsageRow),
    reportedCostComplete: row.reportedCostComplete === 1,
    approximate: row.approximate === 1,
    modelInferred: row.modelInferred === 1,
  }));
}

export interface UntrackedAssistantMessage {
  messageId: string;
  conversationId: string;
  runId: string | null;
  agentId: string | null;
  position: number;
}

/** Assistant messages in a project that have no `run_usage` row yet (recorded before tracking). */
export function listUntrackedAssistantMessages(
  db: SqliteDb,
  projectId: string,
): UntrackedAssistantMessage[] {
  return db.prepare(`
    SELECT
      m.id AS messageId,
      m.conversation_id AS conversationId,
      m.run_id AS runId,
      m.agent_id AS agentId,
      m.position AS position
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.project_id = ?
      AND m.role = 'assistant'
      AND NOT EXISTS (SELECT 1 FROM run_usage ru WHERE ru.message_id = m.id)
    ORDER BY m.conversation_id, m.position
  `).all(projectId) as UntrackedAssistantMessage[];
}

/**
 * The usage, cost, and model events persisted on the given messages, in
 * stream order. Filters inside SQLite so the (often large) rest of each
 * message's event history is never parsed in JavaScript.
 */
export function listPersistedUsageEvents(
  db: SqliteDb,
  messageIds: string[],
): Map<string, Array<Record<string, unknown>>> {
  const byMessage = new Map<string, Array<Record<string, unknown>>>();
  if (messageIds.length === 0) return byMessage;
  const statement = db.prepare(`
    SELECT je.value AS event
    FROM messages m, json_each(m.events_json) je
    WHERE m.id = ?
      AND json_valid(m.events_json)
      AND (
        json_extract(je.value, '$.kind') = 'usage'
        OR (
          json_extract(je.value, '$.kind') = 'status'
          AND json_extract(je.value, '$.label') IN ('initializing', 'model')
        )
      )
    ORDER BY CAST(je.key AS INTEGER)
  `);
  for (const messageId of messageIds) {
    const events: Array<Record<string, unknown>> = [];
    for (const row of statement.all(messageId) as Array<{ event: string }>) {
      try {
        const parsed = JSON.parse(row.event);
        if (parsed && typeof parsed === 'object') events.push(parsed);
      } catch {
        // A malformed element cannot carry usage worth counting.
      }
    }
    byMessage.set(messageId, events);
  }
  return byMessage;
}

/** `agent_sessions.model` per `conversationId\0agentId` — the last model a conversation's agent session ran. */
export function listProjectSessionModels(db: SqliteDb, projectId: string): Map<string, string> {
  const rows = db.prepare(`
    SELECT s.conversation_id AS conversationId, s.agent_id AS agentId, s.model AS model
    FROM agent_sessions s
    JOIN conversations c ON c.id = s.conversation_id
    WHERE c.project_id = ? AND s.model IS NOT NULL AND s.model != ''
  `).all(projectId) as Array<{ conversationId: string; agentId: string; model: string }>;
  return new Map(rows.map((row) => [`${row.conversationId}\0${row.agentId}`, row.model]));
}
