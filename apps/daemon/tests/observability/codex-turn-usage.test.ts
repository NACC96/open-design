import { expect, it } from 'vitest';
import { createCodexTurnTokenUsage, createCodexTurnUsage } from '../../src/observability/codex-turn-usage.js';
it('A-08 sums deduplicated last-call counters in one explicit turn', () => {
  const usage = createCodexTurnUsage();
  usage.start('turn-a');
  const first = { last: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }, total: { inputTokens: 1010, outputTokens: 202, totalTokens: 1212 } };
  expect(usage.add('turn-a', first)).toEqual({ input: 10, output: 2, total: 12, modelCalls: 1 });
  expect(usage.add('turn-a', first)).toEqual({ input: 10, output: 2, total: 12, modelCalls: 1 });
  expect(usage.add('turn-a', { last: { inputTokens: 15, outputTokens: 5, totalTokens: 20 }, total: { inputTokens: 1025, outputTokens: 207, totalTokens: 1232 } })).toEqual({ input: 25, output: 7, total: 32, modelCalls: 2 });
  expect(usage.add('turn-a', first)).toBeNull();
  usage.start('turn-b');
  expect(usage.add('turn-a', first)).toBeNull();
});

it('measures a turn as the growth of the thread total, cache split included', () => {
  const usage = createCodexTurnTokenUsage();
  usage.start('turn-b');
  const call = (total: Record<string, number>, last: Record<string, number>) => ({ total, last });
  // Prior turns already put 1000 input (800 cached) / 100 output on the thread.
  const first = call(
    { inputTokens: 1300, cachedInputTokens: 1000, cacheWriteInputTokens: 40, outputTokens: 150, reasoningOutputTokens: 20 },
    { inputTokens: 300, cachedInputTokens: 200, cacheWriteInputTokens: 40, outputTokens: 50, reasoningOutputTokens: 20 },
  );
  expect(usage.add('turn-b', first)).toEqual({ input: 300, cachedInput: 200, cacheWrite: 40, output: 50, reasoning: 20 });
  // A repeated notification for the same call does not double count.
  expect(usage.add('turn-b', first)).toEqual({ input: 300, cachedInput: 200, cacheWrite: 40, output: 50, reasoning: 20 });
  expect(usage.add('turn-b', call(
    { inputTokens: 1700, cachedInputTokens: 1350, cacheWriteInputTokens: 40, outputTokens: 190, reasoningOutputTokens: 20 },
    { inputTokens: 400, cachedInputTokens: 350, cacheWriteInputTokens: 0, outputTokens: 40, reasoningOutputTokens: 0 },
  ))).toEqual({ input: 700, cachedInput: 550, cacheWrite: 40, output: 90, reasoning: 20 });
});

it('refuses to measure without an explicit, matching turn or with malformed counters', () => {
  const usage = createCodexTurnTokenUsage();
  const payload = { total: { inputTokens: 10, outputTokens: 1 }, last: { inputTokens: 10, outputTokens: 1 } };
  expect(usage.add('turn-x', payload)).toBeNull();
  usage.start('turn-y');
  expect(usage.add('turn-z', payload)).toBeNull();
  usage.start('turn-w');
  expect(usage.add('turn-w', { total: { inputTokens: -1 }, last: {} })).toBeNull();
});
