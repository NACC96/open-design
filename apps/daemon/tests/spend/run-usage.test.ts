import { describe, expect, it } from 'vitest';
import { createRunUsageAccumulator } from '../../src/spend/run-usage.js';

function fold(events: Array<[string, unknown]>) {
  const accumulator = createRunUsageAccumulator();
  for (const [event, data] of events) accumulator.fold(event, data);
  return accumulator.snapshot();
}

describe('createRunUsageAccumulator', () => {
  it('sums Claude per-turn tokens and ignores its session running cost', () => {
    // Two `result` frames from one held-open stream-json process: `usage` is
    // per turn, `total_cost_usd` a running total that a resumed session can
    // carry over from earlier runs, so it says nothing about this run.
    const snapshot = fold([
      ['start', {}],
      ['agent', { type: 'status', label: 'initializing', model: 'claude-opus-5-5' }],
      ['agent', {
        type: 'usage',
        usage: {
          input_tokens: 10,
          output_tokens: 100,
          cache_read_input_tokens: 5000,
          cache_creation_input_tokens: 2000,
          cache_creation: { ephemeral_1h_input_tokens: 1500, ephemeral_5m_input_tokens: 500 },
        },
        costUsd: 9.86,
        costScope: 'session_cumulative',
      }],
      ['agent', {
        type: 'usage',
        usage: {
          input_tokens: 10,
          output_tokens: 101,
          cache_read_input_tokens: 7000,
          cache_creation_input_tokens: 100,
          cache_creation: { ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 0 },
        },
        costUsd: 10.14,
        costScope: 'session_cumulative',
      }],
    ]);
    expect(snapshot.tokens).toEqual({ input: 20, output: 201, cacheRead: 12000, cacheWrite: 2100, cacheWrite1h: 1600 });
    expect(snapshot.usageEvents).toBe(2);
    expect(snapshot.reportedCostUsd).toBeNull();
    expect(snapshot.reportedCostComplete).toBe(false);
    expect(snapshot.reportedModel).toBe('claude-opus-5-5');
  });

  it('reads an unmarked usage event by the scope its agent is known to use', () => {
    const events: Array<[string, unknown]> = [
      ['agent', { type: 'usage', usage: { input_tokens: 10, output_tokens: 20 }, costUsd: 3.5 }],
    ];
    // A Claude run log written before the scope marker existed.
    const claude = createRunUsageAccumulator({ agentId: 'claude' });
    for (const [event, data] of events) claude.fold(event, data);
    expect(claude.snapshot()).toMatchObject({ usageEvents: 1, reportedCostUsd: null, reportedCostComplete: false });

    const other = createRunUsageAccumulator({ agentId: 'opencode' });
    for (const [event, data] of events) other.fold(event, data);
    expect(other.snapshot()).toMatchObject({ reportedCostUsd: 3.5, reportedCostComplete: true });
  });

  it('keeps each retry attempt\'s process cost', () => {
    const snapshot = fold([
      ['start', {}],
      ['agent', { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 }, costUsd: 0.5, costScope: 'process_cumulative' }],
      ['start', {}],
      ['agent', { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 }, costUsd: 0.25, costScope: 'process_cumulative' }],
    ]);
    expect(snapshot.reportedCostUsd).toBeCloseTo(0.75, 10);
  });

  it('sums per-step usage and per-step cost (OpenCode step_finish)', () => {
    const snapshot = fold([
      ['agent', { type: 'usage', usage: { input_tokens: 100, output_tokens: 10, cached_read_tokens: 50 }, costUsd: 0.01 }],
      ['agent', { type: 'usage', usage: { input_tokens: 200, output_tokens: 20, cached_read_tokens: 150 }, costUsd: 0.02 }],
    ]);
    // Inclusive accounting: cached reads are part of input_tokens.
    expect(snapshot.tokens).toEqual({ input: 100, output: 30, cacheRead: 200, cacheWrite: 0, cacheWrite1h: 0 });
    expect(snapshot.reportedCostUsd).toBeCloseTo(0.03, 10);
    expect(snapshot.reportedCostComplete).toBe(true);
  });

  it('reads generic cache counts as additive when the total adds them on top of input (pi turn_end)', () => {
    // pi's own fixture: input 100 + output 50 + cache read 20 + cache write 5 = total 175.
    const snapshot = fold([
      ['agent', {
        type: 'usage',
        usage: { input_tokens: 100, output_tokens: 50, cached_read_tokens: 20, cached_write_tokens: 5, total_tokens: 175 },
      }],
    ]);
    expect(snapshot.tokens).toEqual({ input: 100, output: 50, cacheRead: 20, cacheWrite: 5, cacheWrite1h: 0 });
  });

  it('reads generic cache counts as inclusive when the total is input plus output', () => {
    const snapshot = fold([
      ['agent', { type: 'usage', usage: { input_tokens: 100, output_tokens: 50, cached_read_tokens: 20, total_tokens: 150 } }],
    ]);
    expect(snapshot.tokens).toEqual({ input: 80, output: 50, cacheRead: 20, cacheWrite: 0, cacheWrite1h: 0 });
  });

  it('treats a cache read larger than input as additive (AMR/pi Responses-style usage)', () => {
    const snapshot = fold([
      ['agent', { type: 'usage', usage: { input_tokens: 40, output_tokens: 5, cached_read_tokens: 9000 } }],
    ]);
    expect(snapshot.tokens).toEqual({ input: 40, output: 5, cacheRead: 9000, cacheWrite: 0, cacheWrite1h: 0 });
    expect(snapshot.reportedCostUsd).toBeNull();
    expect(snapshot.reportedCostComplete).toBe(false);
  });

  it('keeps only the latest Codex per-turn reading instead of summing thread totals', () => {
    const turnUsage = (input: number, cachedInput: number, output: number) => ({
      type: 'usage',
      usageScope: 'sessionCumulative',
      usage: { input_tokens: 50_000 + input, output_tokens: 900 + output, cached_read_tokens: 40_000 + cachedInput },
      turnTokenUsage: { input, cachedInput, cacheWrite: 0, output, reasoning: 0 },
    });
    const snapshot = fold([
      ['start', {}],
      ['agent', turnUsage(300, 200, 50)],
      ['agent', turnUsage(300, 200, 50)],
      ['agent', turnUsage(700, 550, 90)],
    ]);
    expect(snapshot.tokens).toEqual({ input: 150, output: 90, cacheRead: 550, cacheWrite: 0, cacheWrite1h: 0 });
    expect(snapshot.approximate).toBe(false);
    expect(snapshot.reportedCostComplete).toBe(false);
  });

  it('adds a finished Codex turn when a steered turn starts inside the same run', () => {
    const turn = (input: number, output: number) => ({
      type: 'usage',
      usageScope: 'sessionCumulative',
      usage: {},
      turnTokenUsage: { input, cachedInput: 0, cacheWrite: 0, output, reasoning: 0 },
    });
    const snapshot = fold([
      ['agent', turn(500, 40)],
      ['agent', turn(100, 5)],
    ]);
    expect(snapshot.tokens.input).toBe(600);
    expect(snapshot.tokens.output).toBe(45);
  });

  it('prices an older Codex log from evaluationTurnUsage, splitting cache like the thread', () => {
    // Logged before `turnTokenUsage` existed. One model call: the thread total
    // never grows within the run, so its growth alone would price it at zero.
    const snapshot = fold([
      ['agent', {
        type: 'usage',
        usageScope: 'sessionCumulative',
        usage: { input_tokens: 1_000_000, cached_read_tokens: 800_000, output_tokens: 100_000, thought_tokens: 40_000, total_tokens: 1_100_000 },
        evaluationTurnUsage: { input: 1_000_000, output: 100_000, total: 1_100_000, modelCalls: 1 },
      }],
    ]);
    expect(snapshot.tokens).toEqual({ input: 200_000, output: 100_000, cacheRead: 800_000, cacheWrite: 0, cacheWrite1h: 0 });
    expect(snapshot.reasoningTokens).toBe(40_000);
    expect(snapshot.approximate).toBe(true);
  });

  it('adds each turn of an older Codex log once, across repeats and a steered turn', () => {
    const reading = (input: number, output: number, modelCalls: number) => ({
      type: 'usage',
      usageScope: 'sessionCumulative',
      usage: { input_tokens: 1000, cached_read_tokens: 500, output_tokens: 100, total_tokens: 1100 },
      evaluationTurnUsage: { input, output, total: input + output, modelCalls },
    });
    const snapshot = fold([
      ['agent', reading(100, 10, 1)],
      ['agent', reading(100, 10, 1)],
      ['agent', reading(300, 30, 2)],
      // A steered follow-up: calls restart from one.
      ['agent', reading(50, 5, 1)],
    ]);
    // 350 cache-inclusive input, half of it cached as in the thread total.
    expect(snapshot.tokens).toEqual({ input: 175, output: 35, cacheRead: 175, cacheWrite: 0, cacheWrite1h: 0 });
  });

  it('falls back to thread-total growth, flagged approximate, with no per-turn reading at all', () => {
    const cumulative = (input: number, output: number) => ({
      type: 'usage',
      usageScope: 'sessionCumulative',
      usage: { input_tokens: input, output_tokens: output },
      turnTokenUsage: null,
    });
    const snapshot = fold([
      ['agent', cumulative(1000, 100)],
      ['agent', cumulative(1600, 160)],
    ]);
    expect(snapshot.tokens.input).toBe(600);
    expect(snapshot.tokens.output).toBe(60);
    expect(snapshot.approximate).toBe(true);
  });

  it('reads the model from a usage event provider/model pair', () => {
    const snapshot = fold([
      ['agent', { type: 'usage', provider: 'deepseek', model: 'deepseek-v4-pro', usage: { input_tokens: 1, output_tokens: 1 } }],
    ]);
    expect(snapshot.reportedModel).toBe('deepseek/deepseek-v4-pro');
  });

  it('reports which events changed the snapshot', () => {
    const accumulator = createRunUsageAccumulator();
    expect(accumulator.fold('agent', { type: 'text_delta', delta: 'hi' })).toBe(false);
    expect(accumulator.fold('agent', { type: 'status', label: 'model', model: 'kimi-k2.6' })).toBe(true);
    expect(accumulator.fold('agent', { type: 'status', label: 'model', model: 'kimi-k2.6' })).toBe(false);
    expect(accumulator.fold('agent', { type: 'usage', usage: { input_tokens: 1 } })).toBe(true);
    expect(accumulator.fold('agent', { type: 'usage', usage: null })).toBe(false);
  });
});
