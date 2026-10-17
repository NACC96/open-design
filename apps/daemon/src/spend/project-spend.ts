/**
 * Project spend: price every recorded agent turn in a project and roll the
 * result up by model and by conversation.
 *
 * Turns recorded before `run_usage` existed are backfilled on first read:
 * replayed through the same accumulator from the run's durable event log when
 * it is still on disk, or — for runs with no log — reconstructed from the
 * usage events persisted on the assistant message. That last source lost the
 * cache split and the scope markers, so its rows are always flagged estimated.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';
import {
  MODEL_PRICE_TABLE_DATE,
  normalizeModelIdForPricing,
  resolveModelPrice,
  tokenCostUsd,
  type ModelTokenPrice,
  type PricedTokenCounts,
  type ProjectSpendBucket,
  type ProjectSpendConversationRow,
  type ProjectSpendModelRow,
  type ProjectSpendResponse,
  type ResolvedModelPrice,
} from '@open-design/contracts';
import { createRunUsageAccumulator, type RunUsageSnapshot } from './run-usage.js';
import {
  inheritedRunUsageRecord,
  insertBackfilledRunUsage,
  listPersistedUsageEvents,
  listProjectRunUsage,
  listProjectSessionModels,
  listUntrackedAssistantMessages,
  type ProjectRunUsageRow,
  type RunUsageRecord,
  type UntrackedAssistantMessage,
} from './run-usage-store.js';

type SqliteDb = Database.Database;

export interface ComputeProjectSpendOptions {
  /** `<RUNTIME_DATA_DIR>/runs`, where durable run event logs live; null skips replay. */
  runsLogDir: string | null;
  overrides?: Readonly<Record<string, ModelTokenPrice>> | null;
  now?: number;
}

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function replayRunLog(
  runsLogDir: string,
  message: UntrackedAssistantMessage,
): Promise<RunUsageRecord | null> {
  const runId = message.runId;
  if (!runId || !SAFE_RUN_ID.test(runId)) return null;
  const runDir = path.join(runsLogDir, runId);
  let log: string;
  try {
    log = await readFile(path.join(runDir, 'events.jsonl'), 'utf8');
  } catch {
    return null;
  }
  let state: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(path.join(runDir, 'state.json'), 'utf8'));
    if (parsed && typeof parsed === 'object') state = parsed;
  } catch {
    // The event log alone still carries the usage; the model may be reported in it.
  }
  const agentId = stringOrNull(state.agentId) ?? message.agentId;
  const accumulator = createRunUsageAccumulator({ agentId });
  for (const line of log.split('\n')) {
    if (!line) continue;
    try {
      const record = JSON.parse(line);
      if (record && typeof record.event === 'string') accumulator.fold(record.event, record.data);
    } catch {
      // A torn final line from a crash is expected; skip it.
    }
  }
  const requestedModel = stringOrNull(state.model);
  return {
    runId,
    messageId: message.messageId,
    agentId,
    requestedModel,
    launchModel: stringOrNull(state.resolvedModelId),
    usage: accumulator.snapshot(),
    catalogPrice: null,
    source: 'replayed',
  };
}

// Persisted message events predate the scope markers, so the scope is read
// off the agent: Codex usage is a running thread total and Claude/Qoder cost
// is a running process total. Every other runtime reports per step.
//
// These events also dropped the cache counts, so Claude's tokens can't be
// priced and its reported cost is used instead. That is safe only because a
// run with no log predates durable run logs, and the Claude Code builds of
// that time reset the running total per process; newer builds carry it across
// `--resume`, which is why logged runs are priced from their tokens.
const CUMULATIVE_USAGE_AGENTS = new Set(['codex']);
type InputOutput = { input: number; output: number };
const MODEL_ID_SHAPE = /^[A-Za-z0-9][\w.:/@[\]-]{1,127}$/;
const CUMULATIVE_COST_AGENTS = new Set(['claude', 'qoder']);

function reconstructFromMessageEvents(
  db: SqliteDb,
  projectId: string,
  messages: UntrackedAssistantMessage[],
): RunUsageRecord[] {
  if (messages.length === 0) return [];
  const eventsByMessage = listPersistedUsageEvents(db, messages.map((m) => m.messageId));
  const sessionModels = listProjectSessionModels(db, projectId);
  const records: RunUsageRecord[] = [];
  for (const message of messages) {
    const events = eventsByMessage.get(message.messageId) ?? [];
    const agentId = message.agentId ?? '';
    let input = 0;
    let output = 0;
    let usageEvents = 0;
    let costedEvents = 0;
    let cost: number | null = null;
    let reportedModel: string | null = null;
    // Typed by assertion: an annotated `= null` narrows to `null` inside the loop.
    let last = null as InputOutput | null;
    for (const event of events) {
      if (event.kind === 'status') {
        // The persisted `detail` of an init/model status is the model id when
        // the runtime reported one, but other runtimes put prose there.
        const detail = stringOrNull(event.detail);
        if (detail && MODEL_ID_SHAPE.test(detail)) reportedModel = detail;
        continue;
      }
      const eventInput = finiteOrNull(event.inputTokens);
      const eventOutput = finiteOrNull(event.outputTokens);
      const eventCost = finiteOrNull(event.costUsd);
      if (eventInput === null && eventOutput === null && eventCost === null) continue;
      usageEvents += 1;
      if (CUMULATIVE_USAGE_AGENTS.has(agentId)) {
        last = { input: eventInput ?? last?.input ?? 0, output: eventOutput ?? last?.output ?? 0 };
      } else {
        input += eventInput ?? 0;
        output += eventOutput ?? 0;
      }
      if (eventCost !== null && eventCost >= 0) {
        costedEvents += 1;
        cost = CUMULATIVE_COST_AGENTS.has(agentId) ? Math.max(cost ?? 0, eventCost) : (cost ?? 0) + eventCost;
      }
    }
    if (last) {
      // The thread's running total; read time subtracts the previous turn's.
      input = last.input;
      output = last.output;
    }
    const sessionModel = reportedModel
      ? null
      : sessionModels.get(`${message.conversationId}\0${agentId}`) ?? null;
    const usage: RunUsageSnapshot = {
      tokens: { input, output, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 },
      reasoningTokens: 0,
      usageEvents,
      reportedCostUsd: cost,
      reportedCostComplete: usageEvents > 0 && costedEvents === usageEvents,
      reportedModel,
      approximate: true,
      sessionId: null,
      sessionTotal: last !== null,
    };
    records.push({
      runId: `message:${message.messageId}`,
      messageId: message.messageId,
      agentId: message.agentId,
      requestedModel: null,
      launchModel: sessionModel,
      usage,
      catalogPrice: null,
      source: 'message_events',
      modelInferred: Boolean(sessionModel),
    });
  }
  return records;
}

/** Give every assistant message in the project a `run_usage` row. Idempotent. */
export async function backfillProjectRunUsage(
  db: SqliteDb,
  projectId: string,
  runsLogDir: string | null,
): Promise<void> {
  const untracked = listUntrackedAssistantMessages(db, projectId);
  if (untracked.length === 0) return;
  const records: RunUsageRecord[] = [];
  const withoutLog: UntrackedAssistantMessage[] = [];
  for (const message of untracked) {
    if (message.inherited) {
      records.push(inheritedRunUsageRecord(message.messageId, message.agentId));
      continue;
    }
    const replayed = runsLogDir ? await replayRunLog(runsLogDir, message) : null;
    if (replayed) records.push(replayed);
    else withoutLog.push(message);
  }
  records.push(...reconstructFromMessageEvents(db, projectId, withoutLog));
  insertBackfilledRunUsage(db, records);
}

const SESSION_TOTAL_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'cacheWrite1hTokens',
] as const;

/**
 * Turn rows that hold a session's running total (Codex exec, Codex logs with
 * no per-turn reading, Codex message events) into each run's own share: its
 * growth since the session's previous run in the conversation. A different
 * session id, or a total that shrank, means a new thread, whose total is all
 * its own. Without session ids on both runs, growth is an inference, so the
 * row is flagged estimated.
 */
function sessionTotalsToRunShares(rows: ProjectRunUsageRow[]): ProjectRunUsageRow[] {
  const previousByThread = new Map<string, ProjectRunUsageRow>();
  return rows.map((row) => {
    if (!row.sessionTotal || row.usageEvents === 0) return row;
    // Rows arrive in message order within each conversation.
    const key = `${row.conversationId}\0${row.agentId ?? ''}`;
    const previous = previousByThread.get(key);
    previousByThread.set(key, row);
    if (!previous) return row;
    const knownSessions = Boolean(previous.sessionId && row.sessionId);
    if (knownSessions && previous.sessionId !== row.sessionId) return row;
    if (SESSION_TOTAL_FIELDS.some((field) => row[field] < previous[field])) return row;
    const share = { ...row, approximate: row.approximate || !knownSessions };
    for (const field of SESSION_TOTAL_FIELDS) share[field] = row[field] - previous[field];
    return share;
  });
}

type CostBasis = 'reported' | 'computed' | 'unpriced';

interface PricedTurn {
  row: ProjectRunUsageRow;
  model: string | null;
  tokens: PricedTokenCounts;
  costUsd: number | null;
  basis: CostBasis;
  estimated: boolean;
  price: ResolvedModelPrice | null;
}

function modelCandidates(row: ProjectRunUsageRow): string[] {
  const candidates: string[] = [];
  for (const value of [row.reportedModel, row.launchModel, row.requestedModel]) {
    const model = stringOrNull(value);
    if (!model || model === 'default' || candidates.includes(model)) continue;
    candidates.push(model);
  }
  return candidates;
}

/**
 * Cost one turn. A cost the agent reported for all of its usage (OpenCode,
 * pi, Qoder; never Claude Code, see run-usage.ts) is used as is. Otherwise the
 * tokens are priced — user override, then the launch-time catalog price, then
 * the bundled table.
 */
export function priceRunUsageRow(
  row: ProjectRunUsageRow,
  overrides: Readonly<Record<string, ModelTokenPrice>> | null,
): PricedTurn {
  const tokens: PricedTokenCounts = {
    input: row.inputTokens,
    output: row.outputTokens,
    cacheRead: row.cacheReadTokens,
    cacheWrite: row.cacheWriteTokens,
    cacheWrite1h: row.cacheWrite1hTokens,
  };
  const catalog = row.catalogInputPrice !== null && row.catalogOutputPrice !== null
    ? { input: row.catalogInputPrice, output: row.catalogOutputPrice }
    : null;
  const candidates = modelCandidates(row);
  // The catalog price was frozen for the launch model; it prices any spelling of it.
  const launchModel = row.launchModel ? normalizeModelIdForPricing(row.launchModel) : null;
  let model = candidates[0] ? normalizeModelIdForPricing(candidates[0]) : null;
  let price: ResolvedModelPrice | null = null;
  for (const candidate of candidates) {
    price = resolveModelPrice(candidate, {
      overrides,
      catalog: normalizeModelIdForPricing(candidate) === launchModel ? catalog : null,
    });
    if (price) {
      model = price.matchedId || normalizeModelIdForPricing(candidate);
      break;
    }
  }
  let estimated = row.approximate || row.modelInferred || row.source === 'message_events';
  const reported = row.reportedCostUsd;
  let costUsd: number | null = null;
  let basis: CostBasis = 'unpriced';
  if (reported !== null && row.reportedCostComplete) {
    costUsd = reported;
    basis = 'reported';
  } else if (price) {
    costUsd = tokenCostUsd(tokens, price.price);
    basis = 'computed';
  } else if (reported !== null) {
    // Only some of the usage reported a cost and the model has no price:
    // the reported part is the best floor available.
    costUsd = reported;
    basis = 'reported';
    estimated = true;
  }
  return { row, model, tokens, costUsd, basis, estimated, price };
}

function emptyBucket(): ProjectSpendBucket {
  return {
    costUsd: 0,
    turns: 0,
    pricedTurns: 0,
    reportedTurns: 0,
    estimatedTurns: 0,
    unpricedTurns: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function addTurn(bucket: ProjectSpendBucket, turn: PricedTurn): void {
  bucket.turns += 1;
  bucket.tokens.input += turn.tokens.input;
  bucket.tokens.output += turn.tokens.output;
  bucket.tokens.cacheRead += turn.tokens.cacheRead;
  bucket.tokens.cacheWrite += turn.tokens.cacheWrite;
  if (turn.costUsd === null) {
    bucket.unpricedTurns += 1;
    return;
  }
  bucket.costUsd += turn.costUsd;
  bucket.pricedTurns += 1;
  if (turn.basis === 'reported') bucket.reportedTurns += 1;
  if (turn.estimated) bucket.estimatedTurns += 1;
}

function byCostThenTurns(a: ProjectSpendBucket, b: ProjectSpendBucket): number {
  return b.costUsd - a.costUsd || b.turns - a.turns;
}

export async function computeProjectSpend(
  db: SqliteDb,
  projectId: string,
  options: ComputeProjectSpendOptions,
): Promise<ProjectSpendResponse> {
  await backfillProjectRunUsage(db, projectId, options.runsLogDir);
  const overrides = options.overrides ?? null;
  const total = emptyBucket();
  const models = new Map<string, ProjectSpendModelRow>();
  const conversations = new Map<string, ProjectSpendConversationRow>();
  for (const row of sessionTotalsToRunShares(listProjectRunUsage(db, projectId))) {
    if (row.usageEvents === 0 && row.reportedCostUsd === null) continue;
    const turn = priceRunUsageRow(row, overrides);
    addTurn(total, turn);

    const modelKey = turn.model ?? '';
    let modelRow = models.get(modelKey);
    if (!modelRow) {
      modelRow = { ...emptyBucket(), model: turn.model, agentIds: [], priceSource: null, price: null };
      models.set(modelKey, modelRow);
    }
    addTurn(modelRow, turn);
    if (row.agentId && !modelRow.agentIds.includes(row.agentId)) modelRow.agentIds.push(row.agentId);
    if (turn.price) {
      modelRow.priceSource = turn.price.source;
      modelRow.price = turn.price.price;
    }

    let conversationRow = conversations.get(row.conversationId);
    if (!conversationRow) {
      conversationRow = {
        ...emptyBucket(),
        conversationId: row.conversationId,
        title: row.conversationTitle,
        updatedAt: row.conversationUpdatedAt,
      };
      conversations.set(row.conversationId, conversationRow);
    }
    addTurn(conversationRow, turn);
  }
  return {
    projectId,
    currency: 'USD',
    priceTableDate: MODEL_PRICE_TABLE_DATE,
    generatedAt: options.now ?? Date.now(),
    total,
    byModel: [...models.values()].sort(byCostThenTurns),
    byConversation: [...conversations.values()].sort(byCostThenTurns),
  };
}
