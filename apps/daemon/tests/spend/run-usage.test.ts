import { describe, expect, it } from 'vitest';
import { createRunUsageAccumulator } from '../../src/spend/run-usage.js';

function fold(events: Array<[string, unknown]>) {
  const accumulator = createRunUsageAccumulator();
  for (const [event, data] of events) accumulator.fold(event, data);
  return accumulator.snapshot();
}

describe('createRunUsageAccumulator', () => {
  it('sums Claude per-turn tokens but counts the process-cumulative cost once', () => {
    // Two `result` frames from one held-open stream-json process: tokens are
    // per turn, `total_cost_usd` is the running process total.
    const snapshot = fold([
      ['start', {}],
      ['agent', { type: 'status', label: 'initializing', model: 'claude-opus-5-5' }],
      ['agent', {
        type: 'usage',
        usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 5000, cache_creation_input_tokens: 2000 },
        costUsd: 0.0187,
        costScope: 'process_cumulative',
      }],
      ['agent', {
        type: 'usage',
        usage: { input_tokens: 10, output_tokens: 101, cache_read_input_tokens: 7000, cache_creation_input_tokens: 100 },
        costUsd: 0.0219,
        costScope: 'process_cumulative',
      }],
    ]);
    expect(snapshot.tokens).toEqual({ input: 20, output: 201, cacheRead: 12000, cacheWrite: 2100 });
    expect(snapshot.reportedCostUsd).toBeCloseTo(0.0219, 10);
    expect(snapshot.reportedCostComplete).toBe(true);
    expect(snapshot.reportedModel).toBe('claude-opus-5-5');
  });

  it('takes Claude token totals from modelUsage, sub-agents included, as a process running total', () => {
    const result = (modelUsage: Record<string, unknown>, costUsd: number) => ({
      type: 'usage',
      usage: { input_tokens: 6, output_tokens: 1502, cache_read_input_tokens: 1_409_993, cache_creation_input_tokens: 16_063 },
      costUsd,
      costScope: 'process_cumulative',
      modelUsage,
    });
    const snapshot = fold([
      ['start', {}],
      ['agent', result({
        'claude-opus-5-5': { inputTokens: 100, outputTokens: 2000, cacheReadInputTokens: 5_000_000, cacheCreationInputTokens: 90_000, thinkingTokens: 300 },
      }, 10)],
      ['agent', result({
        'claude-opus-5-5': { inputTokens: 150, outputTokens: 3000, cacheReadInputTokens: 9_000_000, cacheCreationInputTokens: 120_000, thinkingTokens: 400 },
        'claude-haiku-5-5': { inputTokens: 500, outputTokens: 40, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      }, 26.8)],
    ]);
    // The latest running total, never the sum of readings, and never the main-thread `usage`.
    expect(snapshot.tokens).toEqual({ input: 650, output: 3040, cacheRead: 9_000_000, cacheWrite: 120_000 });
    expect(snapshot.reasoningTokens).toBe(400);
    expect(snapshot.reportedCostUsd).toBeCloseTo(26.8, 10);
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
    expect(snapshot.tokens).toEqual({ input: 100, output: 30, cacheRead: 200, cacheWrite: 0 });
    expect(snapshot.reportedCostUsd).toBeCloseTo(0.03, 10);
    expect(snapshot.reportedCostComplete).toBe(true);
  });

  it('treats a cache read larger than input as additive (AMR/pi Responses-style usage)', () => {
    const snapshot = fold([
      ['agent', { type: 'usage', usage: { input_tokens: 40, output_tokens: 5, cached_read_tokens: 9000 } }],
    ]);
    expect(snapshot.tokens).toEqual({ input: 40, output: 5, cacheRead: 9000, cacheWrite: 0 });
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
    expect(snapshot.tokens).toEqual({ input: 150, output: 90, cacheRead: 550, cacheWrite: 0 });
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

  it('falls back to thread-total growth, flagged approximate, without a per-turn reading', () => {
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
