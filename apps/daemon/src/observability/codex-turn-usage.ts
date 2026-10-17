type Counters = { input: number; output: number; total: number; modelCalls: number };
type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};

/** Per-call last usage, deduplicated by cumulative provider counters within an explicit Turn. */
export function createCodexTurnUsage() {
  let turnId = '';
  let invalid = false;
  let previousTotal = -1;
  let result: Counters = { input: 0, output: 0, total: 0, modelCalls: 0 };
  const seen = new Set<string>();
  return {
    start(id: string) { turnId = id; invalid = !id; previousTotal = -1; seen.clear(); result = { input: 0, output: 0, total: 0, modelCalls: 0 }; },
    add(id: string, tokenUsage: unknown): Counters | null {
      const usage = row(tokenUsage); const total = row(usage.total); const last = row(usage.last);
      const counters = [last.inputTokens, last.outputTokens, last.totalTokens, total.totalTokens];
      if (!turnId || id !== turnId || counters.some(v => typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)) invalid = true;
      if (Number(total.totalTokens) < previousTotal) invalid = true;
      if (invalid) return null;
      const fingerprint = JSON.stringify([total.inputTokens, total.outputTokens, total.totalTokens]);
      if (!seen.has(fingerprint)) {
        seen.add(fingerprint);
        result.input += Number(last.inputTokens); result.output += Number(last.outputTokens); result.total += Number(last.totalTokens); result.modelCalls += 1;
      }
      previousTotal = Number(total.totalTokens);
      return { ...result };
    },
  };
}

export function codexTurnUsageFromEvents(events: Array<{ event: string; data: unknown }>): Counters | null {
  let result: Counters | null = null;
  for (const event of events) {
    const data = row(event.data);
    if (event.event !== 'agent' || data.type !== 'usage' || !('evaluationTurnUsage' in data)) continue;
    const usage = row(data.evaluationTurnUsage);
    result = ['input', 'output', 'total', 'modelCalls'].every(key => typeof usage[key] === 'number' && Number.isSafeInteger(usage[key]) && Number(usage[key]) >= 0)
      ? usage as Counters : null;
  }
  return result;
}

/** One turn's token usage split the way prices apply. `input` includes `cachedInput` (OpenAI accounting). */
export type CodexTurnTokenUsage = {
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
};

const TURN_TOKEN_KEYS = [
  ['input', 'inputTokens'],
  ['cachedInput', 'cachedInputTokens'],
  ['cacheWrite', 'cacheWriteInputTokens'],
  ['output', 'outputTokens'],
  ['reasoning', 'reasoningOutputTokens'],
] as const;

function tokenCount(value: unknown): number | null {
  if (value === undefined) return 0;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * A turn's usage across every counter, read as the growth of the
 * thread-cumulative `total` since the turn began.
 *
 * The baseline is `total - last` on the turn's first notification: the thread
 * total just before that turn's first model call. Measuring growth from it is
 * idempotent under the repeated notifications codex sends for one call, and
 * keeps the cache split that `createCodexTurnUsage` does not track. Null when
 * the turn is unknown or a counter is malformed, so callers can tell "no
 * measurement" from zero.
 */
export function createCodexTurnTokenUsage() {
  let turnId = '';
  let baseline: CodexTurnTokenUsage | null = null;
  let invalid = false;
  return {
    start(id: string) { turnId = id; baseline = null; invalid = !id; },
    add(id: string, tokenUsage: unknown): CodexTurnTokenUsage | null {
      if (!turnId || id !== turnId) invalid = true;
      const usage = row(tokenUsage); const total = row(usage.total); const last = row(usage.last);
      const current = {} as CodexTurnTokenUsage;
      const firstCall = {} as CodexTurnTokenUsage;
      for (const [key, field] of TURN_TOKEN_KEYS) {
        const now = tokenCount(total[field]);
        const call = tokenCount(last[field]);
        if (now === null || call === null) invalid = true;
        current[key] = now ?? 0;
        firstCall[key] = call ?? 0;
      }
      if (invalid) return null;
      if (!baseline) {
        baseline = {} as CodexTurnTokenUsage;
        for (const [key] of TURN_TOKEN_KEYS) baseline[key] = Math.max(0, current[key] - firstCall[key]);
      }
      const result = {} as CodexTurnTokenUsage;
      for (const [key] of TURN_TOKEN_KEYS) {
        if (current[key] < baseline[key]) { invalid = true; return null; }
        result[key] = current[key] - baseline[key];
      }
      return result;
    },
  };
}
