import type Database from 'better-sqlite3';
import { createRunUsageAccumulator, type RunUsageAccumulator } from './run-usage.js';
import { upsertRunUsage } from './run-usage-store.js';

type SqliteDb = Database.Database;

/** The fields of a live run this recorder reads. */
export interface RunUsageRunState {
  id: string;
  assistantMessageId?: string | null;
  agentId?: string | null;
  /** Model the request asked for (`'default'` lets the CLI choose). */
  model?: string | null;
  /** Model actually passed to the agent CLI, set just before spawn; null for the CLI default. */
  launchModel?: string | null;
  /** The CLI's own default model, when a preflight resolved it (Codex). */
  resolvedModelId?: string | null;
  /** Input/output price the agent's model catalog listed for `launchModel`. */
  launchModelPrice?: { input: number; output: number } | null;
}

const accumulators = new WeakMap<object, RunUsageAccumulator>();
const warnedRuns = new WeakSet<object>();

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Fold one run event into the run's usage and persist the result.
 *
 * Called for every event a run persists to its assistant message, so the row
 * stays current while the run is live and survives a daemon crash with the
 * usage seen so far. Writes only on `start` (so every tracked turn has a row)
 * and on events that changed usage or model identity. Never throws: losing a
 * spend record must not fail a run.
 */
export function recordRunUsageEvent(
  db: SqliteDb,
  run: RunUsageRunState,
  event: string,
  data: unknown,
): void {
  if (!run.assistantMessageId || typeof run.id !== 'string' || !run.id) return;
  let accumulator = accumulators.get(run);
  if (!accumulator) {
    accumulator = createRunUsageAccumulator();
    accumulators.set(run, accumulator);
  }
  const changed = accumulator.fold(event, data);
  if (!changed && event !== 'start') return;
  try {
    const price = run.launchModelPrice;
    upsertRunUsage(db, {
      runId: run.id,
      messageId: run.assistantMessageId,
      agentId: stringOrNull(run.agentId),
      requestedModel: stringOrNull(run.model),
      launchModel: stringOrNull(run.launchModel) ?? stringOrNull(run.resolvedModelId),
      usage: accumulator.snapshot(),
      catalogPrice: price && Number.isFinite(price.input) && Number.isFinite(price.output) ? price : null,
      source: 'live',
    });
  } catch (err) {
    if (warnedRuns.has(run)) return;
    warnedRuns.add(run);
    console.warn('[spend] run usage persistence failed', err);
  }
}
