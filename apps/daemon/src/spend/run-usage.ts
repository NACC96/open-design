/**
 * Folds one run's agent events into the token usage and reported cost that
 * project spend prices.
 *
 * Runtimes disagree about what a `usage` event measures, so each is folded by
 * what it declares about itself rather than by which agent sent it:
 *
 *   - Most usage events describe one step, turn, or prompt (OpenCode
 *     `step_finish`, pi `turn_end`, ACP prompt end, Claude `result`, Codex
 *     exec `turn.completed`): their tokens are summed.
 *   - `usageScope: 'sessionCumulative'` (Codex app-server) is a running
 *     thread total. Its `turnTokenUsage` is the turn's own share; the latest
 *     reading of each turn is kept, never summed. Logs from before that field
 *     fall back to `evaluationTurnUsage` (the turn's own input and output,
 *     cache split estimated from the thread), then to the thread total's
 *     growth over the run, which misses the first call.
 *   - `costScope: 'process_cumulative'` (Qoder) marks a `costUsd` that is the
 *     CLI process's running total: the attempt's highest reading counts once.
 *   - `costScope: 'session_cumulative'` (Claude Code) marks a running total
 *     this run's share can't be read off: newer CLI builds carry it over from
 *     every earlier process of a `--resume`d session, older ones reset it per
 *     process. It is ignored and the run is priced from its tokens — Claude's
 *     `usage` is the turn's own, and prices to the CLI's own figure. Only a
 *     Task sub-agent's calls are missing from it, so such a turn is undercounted.
 *   - Any other `costUsd` is that event's own cost.
 *
 * Run logs written before the producers declared a scope fall back to the
 * scope their agent is known to use ({@link LEGACY_COST_SCOPES}).
 *
 * `input` is always UNCACHED input. Additive (Anthropic-style) and inclusive
 * (OpenAI-style) payloads are told apart by {@link cacheIsAdditive}.
 */

import type { PricedTokenCounts } from '@open-design/contracts';
import { extractUsageCacheFields, type UsageCacheFields } from '../run-analytics-observability.js';

export interface RunUsageSnapshot {
  tokens: Required<PricedTokenCounts>;
  reasoningTokens: number;
  /** Usage events that carried token counts. */
  usageEvents: number;
  /** Sum of agent-reported cost; null when no usage event reported one. */
  reportedCostUsd: number | null;
  /** True when every usage event carried a reported cost. */
  reportedCostComplete: boolean;
  /** Model id the agent reported for this run (init frame, model status, usage). */
  reportedModel: string | null;
  /** True when a cumulative counter could not be split per turn exactly. */
  approximate: boolean;
}

interface Buckets extends PricedTokenCounts {
  cacheWrite1h: number;
  reasoning: number;
}

function emptyBuckets(): Buckets {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0 };
}

function addBuckets(into: Buckets, from: Buckets): void {
  into.input += from.input;
  into.output += from.output;
  into.cacheRead += from.cacheRead;
  into.cacheWrite += from.cacheWrite;
  into.cacheWrite1h += from.cacheWrite1h;
  into.reasoning += from.reasoning;
}

function bucketTotal(b: Buckets): number {
  return b.input + b.output + b.cacheRead + b.cacheWrite;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function nonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Whether `input` excludes the cache counts. The generic cache aliases are
 * used both ways — pi reports additive counters under them, OpenAI-style
 * payloads inclusive ones — so a reported total that matches one convention
 * exactly decides it. Without one, only a cache read larger than the input
 * proves the counts additive.
 */
function cacheIsAdditive(
  fields: UsageCacheFields,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
): boolean {
  if (fields.cacheTokenSource === 'anthropic') return true;
  if (fields.cacheTokenSource !== 'openai') return false;
  const total = fields.totalTokens;
  if (total !== undefined && cacheRead + cacheWrite > 0) {
    if (total === input + output + cacheRead + cacheWrite) return true;
    if (total === input + output) return false;
  }
  return cacheRead > input;
}

/** Normalize one provider usage payload into price buckets; null when it carries no tokens. */
export function bucketsFromUsagePayload(usage: Record<string, unknown>): Buckets | null {
  const fields = extractUsageCacheFields(usage);
  if (
    fields.inputTokens === undefined
    && fields.outputTokens === undefined
    && fields.cacheReadInputTokens === undefined
    && fields.cacheCreationInputTokens === undefined
  ) {
    return null;
  }
  const input = Math.max(0, fields.inputTokens ?? 0);
  const output = Math.max(0, fields.outputTokens ?? 0);
  const cacheRead = Math.max(0, fields.cacheReadInputTokens ?? 0);
  const cacheWrite = Math.max(0, fields.cacheCreationInputTokens ?? 0);
  // Anthropic splits cache writes by lifetime; a one-hour write bills higher.
  const cacheCreation = isRecord(usage.cache_creation) ? usage.cache_creation : null;
  const oneHour = nonNegative(cacheCreation?.ephemeral_1h_input_tokens) ?? 0;
  return {
    input: cacheIsAdditive(fields, input, output, cacheRead, cacheWrite)
      ? input
      : Math.max(0, input - cacheRead - cacheWrite),
    output,
    cacheRead,
    cacheWrite,
    cacheWrite1h: Math.min(cacheWrite, oneHour),
    reasoning: Math.max(0, fields.thoughtTokens ?? 0),
  };
}

/** Codex's per-turn counters (`input` includes the cached share) as price buckets. */
function bucketsFromCodexTurnUsage(value: unknown): Buckets | null {
  if (!isRecord(value)) return null;
  const input = nonNegative(value.input);
  const cachedInput = nonNegative(value.cachedInput);
  const cacheWrite = nonNegative(value.cacheWrite);
  const output = nonNegative(value.output);
  const reasoning = nonNegative(value.reasoning);
  if (input === null || cachedInput === null || cacheWrite === null || output === null || reasoning === null) {
    return null;
  }
  return {
    input: Math.max(0, input - cachedInput - cacheWrite),
    output,
    cacheRead: cachedInput,
    cacheWrite,
    cacheWrite1h: 0,
    reasoning,
  };
}

/** Codex's `evaluationTurnUsage`: one turn's cache-inclusive input and output, with no cache split. */
interface CodexEvaluationReading {
  input: number;
  output: number;
  total: number;
  modelCalls: number;
}

function codexEvaluationReading(value: unknown): CodexEvaluationReading | null {
  if (!isRecord(value)) return null;
  const input = nonNegative(value.input);
  const output = nonNegative(value.output);
  const total = nonNegative(value.total);
  const modelCalls = nonNegative(value.modelCalls);
  if (input === null || output === null || total === null || modelCalls === null) return null;
  return { input, output, total, modelCalls };
}

/**
 * Split a turn's cache-inclusive input and its output in the proportions of
 * the thread's running totals — the closest guess for logs that kept no
 * per-turn cache split.
 */
function splitByThreadShares(input: number, output: number, thread: Buckets): Buckets {
  const threadInput = thread.input + thread.cacheRead + thread.cacheWrite;
  const cacheRead = threadInput > 0 ? Math.round((input * thread.cacheRead) / threadInput) : 0;
  const cacheWrite = threadInput > 0 ? Math.round((input * thread.cacheWrite) / threadInput) : 0;
  return {
    input: Math.max(0, input - cacheRead - cacheWrite),
    output,
    cacheRead,
    cacheWrite,
    cacheWrite1h: 0,
    reasoning: thread.output > 0 ? Math.round((output * thread.reasoning) / thread.output) : 0,
  };
}

type CostScope = 'process_cumulative' | 'session_cumulative';

/** The cost scope of agents whose older run logs predate the `costScope` marker. */
const LEGACY_COST_SCOPES: Readonly<Record<string, CostScope>> = {
  claude: 'session_cumulative',
  qoder: 'process_cumulative',
};

function costScopeOf(data: Record<string, unknown>, agentId: string | null): CostScope | null {
  if (data.costScope === 'process_cumulative' || data.costScope === 'session_cumulative') {
    return data.costScope;
  }
  if (data.costScope !== undefined || !agentId) return null;
  return LEGACY_COST_SCOPES[agentId] ?? null;
}

function reportedModelFrom(data: Record<string, unknown>): string | null {
  const model = typeof data.model === 'string' ? data.model.trim() : '';
  if (!model) return null;
  if (data.type === 'usage') {
    const provider = typeof data.provider === 'string' ? data.provider.trim() : '';
    return provider && !model.includes('/') ? `${provider}/${model}` : model;
  }
  if (data.type === 'status' && (data.label === 'initializing' || data.label === 'model')) {
    return model;
  }
  return null;
}

export interface RunUsageAccumulator {
  /** Fold one run event (`event` is the SSE event name, `data` its payload). */
  fold(event: string, data: unknown): boolean;
  snapshot(): RunUsageSnapshot;
}

export interface RunUsageAccumulatorOptions {
  /** The run's agent, used to read usage events that carry no `costScope`. */
  agentId?: string | null;
}

/**
 * `fold` returns true when the event changed the snapshot, so a caller that
 * persists incrementally can skip writes for the vast majority of events.
 */
export function createRunUsageAccumulator(options: RunUsageAccumulatorOptions = {}): RunUsageAccumulator {
  const agentId = options.agentId ?? null;
  const summed = emptyBuckets();
  // Codex app-server: the latest per-turn reading and completed turns.
  const completedTurns = emptyBuckets();
  let currentTurn: Buckets | null = null;
  // Codex app-server logs from before `turnTokenUsage`: per-turn input and
  // output from `evaluationTurnUsage`, and the thread totals.
  const completedEvaluation = { input: 0, output: 0 };
  let currentEvaluation: CodexEvaluationReading | null = null;
  let sawEvaluationReading = false;
  let firstCumulative: Buckets | null = null;
  let lastCumulative: Buckets | null = null;
  let sawTurnReading = false;
  let approximate = false;

  let usageEvents = 0;
  let costedEvents = 0;
  let deltaCost = 0;
  let committedAttemptCost = 0;
  let attemptCost: number | null = null;
  let sawCost = false;
  let reportedModel: string | null = null;

  const commitEvaluation = () => {
    if (!currentEvaluation) return;
    completedEvaluation.input += currentEvaluation.input;
    completedEvaluation.output += currentEvaluation.output;
    currentEvaluation = null;
  };

  const commitAttempt = () => {
    if (attemptCost !== null) committedAttemptCost += attemptCost;
    attemptCost = null;
    if (currentTurn) addBuckets(completedTurns, currentTurn);
    currentTurn = null;
    commitEvaluation();
  };

  return {
    fold(event, data) {
      if (event === 'start') {
        const pending = attemptCost !== null || currentTurn !== null || currentEvaluation !== null;
        commitAttempt();
        return pending;
      }
      if (event !== 'agent' || !isRecord(data)) return false;
      let changed = false;
      const model = reportedModelFrom(data);
      if (model && model !== reportedModel) {
        reportedModel = model;
        changed = true;
      }
      if (data.type !== 'usage') return changed;

      if (data.usageScope === 'sessionCumulative') {
        const turn = bucketsFromCodexTurnUsage(data.turnTokenUsage);
        if (turn) {
          sawTurnReading = true;
          // A reading smaller than the last one means a new turn began inside
          // this run (a steered follow-up): keep the finished turn.
          if (currentTurn && bucketTotal(turn) < bucketTotal(currentTurn)) {
            addBuckets(completedTurns, currentTurn);
          }
          currentTurn = turn;
        } else {
          if (sawTurnReading) approximate = true;
          const evaluation = codexEvaluationReading(data.evaluationTurnUsage);
          if (evaluation) {
            sawEvaluationReading = true;
            // Within a turn a reading only changes when a call is added, so
            // fewer calls, or as many with a different total, is a new turn.
            const previous = currentEvaluation;
            if (previous && (evaluation.modelCalls < previous.modelCalls
              || (evaluation.modelCalls === previous.modelCalls && evaluation.total !== previous.total))) {
              commitEvaluation();
            }
            currentEvaluation = evaluation;
          }
          const totals = isRecord(data.usage) ? bucketsFromUsagePayload(data.usage) : null;
          if (totals) {
            firstCumulative ??= totals;
            lastCumulative = totals;
          }
        }
        usageEvents += 1;
        return true;
      }

      const scope = costScopeOf(data, agentId);
      const buckets = isRecord(data.usage) ? bucketsFromUsagePayload(data.usage) : null;
      const cost = scope === 'session_cumulative' ? null : nonNegative(data.costUsd);
      if (!buckets && cost === null) return changed;
      if (buckets) addBuckets(summed, buckets);
      usageEvents += 1;
      if (cost !== null) {
        sawCost = true;
        costedEvents += 1;
        if (scope === 'process_cumulative') {
          attemptCost = Math.max(attemptCost ?? 0, cost);
        } else {
          deltaCost += cost;
        }
      }
      return true;
    },

    snapshot() {
      const total = emptyBuckets();
      addBuckets(total, summed);
      addBuckets(total, completedTurns);
      if (currentTurn) addBuckets(total, currentTurn);
      let isApproximate = approximate;
      const evaluationInput = completedEvaluation.input + (currentEvaluation?.input ?? 0);
      const evaluationOutput = completedEvaluation.output + (currentEvaluation?.output ?? 0);
      if (!sawTurnReading && sawEvaluationReading && lastCumulative) {
        // The turn's own tokens, with the cache split guessed from the thread.
        addBuckets(total, splitByThreadShares(evaluationInput, evaluationOutput, lastCumulative));
        isApproximate = true;
      } else if (!sawTurnReading && firstCumulative && lastCumulative) {
        // No per-turn reading at all: the growth of the thread total over the
        // run misses the first call's share, so mark it approximate.
        total.input += Math.max(0, lastCumulative.input - firstCumulative.input);
        total.output += Math.max(0, lastCumulative.output - firstCumulative.output);
        total.cacheRead += Math.max(0, lastCumulative.cacheRead - firstCumulative.cacheRead);
        total.cacheWrite += Math.max(0, lastCumulative.cacheWrite - firstCumulative.cacheWrite);
        total.reasoning += Math.max(0, lastCumulative.reasoning - firstCumulative.reasoning);
        isApproximate = true;
      }
      const reported = sawCost ? deltaCost + committedAttemptCost + (attemptCost ?? 0) : null;
      return {
        tokens: {
          input: total.input,
          output: total.output,
          cacheRead: total.cacheRead,
          cacheWrite: total.cacheWrite,
          cacheWrite1h: total.cacheWrite1h,
        },
        reasoningTokens: total.reasoning,
        usageEvents,
        reportedCostUsd: reported,
        reportedCostComplete: usageEvents > 0 && costedEvents === usageEvents,
        reportedModel,
        approximate: isApproximate,
      };
    },
  };
}
