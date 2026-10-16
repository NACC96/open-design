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
 *     reading of each turn is kept, never summed.
 *   - `costScope: 'process_cumulative'` (Claude Code, Qoder) marks a
 *     `costUsd` that is the CLI process's running total: the attempt's highest
 *     reading counts once. Any other `costUsd` is that event's own cost. Such
 *     an event's `modelUsage` (Claude Code's per-model totals, sub-agents
 *     included) is a running total too, and when present it is the attempt's
 *     token count: `usage` there covers the main conversation only.
 *
 * `input` is always UNCACHED input. Additive (Anthropic-style) and inclusive
 * (OpenAI-style) payloads are told apart with the same rule run analytics
 * uses: a cache-read count larger than the input count can only be additive.
 */

import type { PricedTokenCounts } from '@open-design/contracts';
import { extractUsageCacheFields } from '../run-analytics-observability.js';

export interface RunUsageSnapshot {
  tokens: PricedTokenCounts;
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
  reasoning: number;
}

function emptyBuckets(): Buckets {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

function addBuckets(into: Buckets, from: Buckets): void {
  into.input += from.input;
  into.output += from.output;
  into.cacheRead += from.cacheRead;
  into.cacheWrite += from.cacheWrite;
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
  const cacheRead = Math.max(0, fields.cacheReadInputTokens ?? 0);
  const cacheWrite = Math.max(0, fields.cacheCreationInputTokens ?? 0);
  const additive =
    fields.cacheTokenSource === 'anthropic'
    || (fields.cacheTokenSource === 'openai' && cacheRead > input);
  return {
    input: additive ? input : Math.max(0, input - cacheRead - cacheWrite),
    output: Math.max(0, fields.outputTokens ?? 0),
    cacheRead,
    cacheWrite,
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
    reasoning,
  };
}

/**
 * Claude Code's `modelUsage`: `{ [model]: { inputTokens, outputTokens,
 * cacheReadInputTokens, cacheCreationInputTokens, thinkingTokens, … } }`,
 * summed across models. Null when no entry carries a token count.
 */
function bucketsFromModelUsage(value: unknown): Buckets | null {
  if (!isRecord(value)) return null;
  const total = emptyBuckets();
  let found = false;
  for (const entry of Object.values(value)) {
    if (!isRecord(entry)) continue;
    const input = nonNegative(entry.inputTokens);
    const output = nonNegative(entry.outputTokens);
    const cacheRead = nonNegative(entry.cacheReadInputTokens);
    const cacheWrite = nonNegative(entry.cacheCreationInputTokens);
    if (input === null && output === null && cacheRead === null && cacheWrite === null) continue;
    found = true;
    total.input += input ?? 0;
    total.output += output ?? 0;
    total.cacheRead += cacheRead ?? 0;
    total.cacheWrite += cacheWrite ?? 0;
    total.reasoning += nonNegative(entry.thinkingTokens) ?? 0;
  }
  return found ? total : null;
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

/**
 * `fold` returns true when the event changed the snapshot, so a caller that
 * persists incrementally can skip writes for the vast majority of events.
 */
export function createRunUsageAccumulator(): RunUsageAccumulator {
  const summed = emptyBuckets();
  // Codex app-server: the latest per-turn reading and completed turns.
  const completedTurns = emptyBuckets();
  let currentTurn: Buckets | null = null;
  // Codex app-server fallback when no per-turn reading exists: thread totals.
  let firstCumulative: Buckets | null = null;
  let lastCumulative: Buckets | null = null;
  let sawTurnReading = false;
  let approximate = false;

  let usageEvents = 0;
  let costedEvents = 0;
  let deltaCost = 0;
  let committedAttemptCost = 0;
  let attemptCost: number | null = null;
  // Process-cumulative token totals (`modelUsage`): finished attempts and the latest reading.
  const committedAttemptTokens = emptyBuckets();
  let attemptTokens: Buckets | null = null;
  let sawCost = false;
  let reportedModel: string | null = null;

  const commitAttempt = () => {
    if (attemptCost !== null) committedAttemptCost += attemptCost;
    attemptCost = null;
    if (attemptTokens) addBuckets(committedAttemptTokens, attemptTokens);
    attemptTokens = null;
    if (currentTurn) addBuckets(completedTurns, currentTurn);
    currentTurn = null;
  };

  return {
    fold(event, data) {
      if (event === 'start') {
        const pending = attemptCost !== null || attemptTokens !== null || currentTurn !== null;
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
          const totals = isRecord(data.usage) ? bucketsFromUsagePayload(data.usage) : null;
          if (totals) {
            firstCumulative ??= totals;
            lastCumulative = totals;
          }
        }
        usageEvents += 1;
        return true;
      }

      const usage = isRecord(data.usage)
        ? data.usage
        : isRecord(data.modelUsage)
          ? data.modelUsage
          : null;
      const processCumulative = data.costScope === 'process_cumulative';
      const processTokens = processCumulative ? bucketsFromModelUsage(data.modelUsage) : null;
      const buckets = usage ? bucketsFromUsagePayload(usage) : null;
      const cost = nonNegative(data.costUsd);
      if (!processTokens && !buckets && cost === null) return changed;
      if (processTokens) {
        attemptTokens = processTokens;
      } else if (buckets) {
        addBuckets(summed, buckets);
      }
      usageEvents += 1;
      if (cost !== null) {
        sawCost = true;
        costedEvents += 1;
        if (processCumulative) {
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
      addBuckets(total, committedAttemptTokens);
      if (attemptTokens) addBuckets(total, attemptTokens);
      let isApproximate = approximate;
      if (!sawTurnReading && firstCumulative && lastCumulative) {
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
