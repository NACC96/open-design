import { describe, expect, it } from 'vitest';
import {
  BUNDLED_MODEL_PRICES,
  isValidModelTokenPrice,
  normalizeModelIdForPricing,
  resolveModelPrice,
  tokenCostUsd,
} from '../src/pricing/model-prices';

describe('normalizeModelIdForPricing', () => {
  it.each([
    ['claude-opus-5-5', 'claude-opus-5-5'],
    ['Claude-Haiku-4-5-20251001', 'claude-haiku-4-5'],
    ['anthropic/claude-sonnet-4.5', 'claude-sonnet-4-5'],
    ['openrouter/anthropic/claude-opus-4.6', 'claude-opus-4-6'],
    ['us.anthropic.claude-opus-4-6-v1:0', 'claude-opus-4-6'],
    ['anthropic.claude-sonnet-4-5-20250929-v1:0', 'claude-sonnet-4-5'],
    ['claude-opus-4-5@20251101', 'claude-opus-4-5'],
    ['claude-opus-4-6[1m]', 'claude-opus-4-6'],
    ['od-byok/gpt-5.4', 'gpt-5.4'],
    ['openai/gpt-5.6-sol', 'gpt-5.6-sol'],
    ['gpt-5-2025-08-07', 'gpt-5'],
    ['models/gemini-2.5-pro', 'gemini-2.5-pro'],
    ['deepseek-v4-flash', 'deepseek-v4-flash'],
    ['kimi-k2.6', 'kimi-k2.6'],
    ['Kimi K3 High', 'kimi-k3-high'],
    ['gemini 3.8 flash (high)', 'gemini-3.8-flash'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeModelIdForPricing(raw)).toBe(expected);
  });
});

describe('resolveModelPrice', () => {
  it('finds bundled entries for dated and routed spellings', () => {
    expect(resolveModelPrice('claude-haiku-4-5-20251001')).toMatchObject({
      source: 'bundled',
      matchedId: 'claude-haiku-4-5',
      price: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    });
    expect(resolveModelPrice('openai/gpt-5.6-sol')?.matchedId).toBe('gpt-5.6-sol');
  });

  it('falls back to the longest prefix only at a dash boundary', () => {
    expect(resolveModelPrice('gemini-2.5-pro-preview-06-05')?.matchedId).toBe('gemini-2.5-pro');
    expect(resolveModelPrice('gpt-5.1-codex-max-high')?.matchedId).toBe('gpt-5.1-codex-max');
    expect(resolveModelPrice('Kimi K3 High')?.matchedId).toBe('kimi-k3');
    // `gpt-5.9` must not borrow `gpt-5`'s price just because it shares a stem.
    expect(resolveModelPrice('gpt-5.9')).toBeNull();
  });

  it('returns null for unknown or missing models', () => {
    expect(resolveModelPrice('my-local-llama')).toBeNull();
    expect(resolveModelPrice(null)).toBeNull();
    expect(resolveModelPrice('default')).toBeNull();
  });

  it('lets a user override outrank the catalog and the bundled table', () => {
    const resolved = resolveModelPrice('claude-opus-5-5-20260901', {
      overrides: { 'anthropic/claude-opus-5-5': { input: 1, output: 2 } },
      catalog: { input: 9, output: 9 },
    });
    expect(resolved).toEqual({
      source: 'override',
      matchedId: 'claude-opus-5-5',
      price: { input: 1, output: 2 },
    });
  });

  it('ignores malformed overrides', () => {
    const resolved = resolveModelPrice('claude-opus-5-5', {
      overrides: { 'claude-opus-5-5': { input: -1, output: 2 } as never },
    });
    expect(resolved?.source).toBe('bundled');
  });

  it('applies the bundled cache discount to a catalog price', () => {
    const resolved = resolveModelPrice('deepseek-v4-pro', {
      catalog: { input: 2.64, output: 7.92 },
    });
    expect(resolved?.source).toBe('catalog');
    expect(resolved?.price.input).toBe(2.64);
    expect(resolved?.price.output).toBe(7.92);
    // Bundled: 0.044 / 1.32 of input.
    expect(resolved?.price.cacheRead).toBeCloseTo(0.088, 6);
  });

  it('uses a catalog price for a model the bundled table does not know', () => {
    expect(resolveModelPrice('vendor-secret-model', { catalog: { input: 1, output: 3 } })).toEqual({
      source: 'catalog',
      matchedId: 'vendor-secret-model',
      price: { input: 1, output: 3 },
    });
  });
});

describe('tokenCostUsd', () => {
  it('prices each bucket at its own rate', () => {
    const cost = tokenCostUsd(
      { input: 1_000_000, output: 100_000, cacheRead: 2_000_000, cacheWrite: 400_000 },
      { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    );
    // 3 + 1.5 + 0.6 + 1.5
    expect(cost).toBeCloseTo(6.6, 10);
  });

  it('bills cache buckets at the input rate when the price has no cache rate', () => {
    expect(
      tokenCostUsd({ input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 1_000_000 }, { input: 2, output: 8 }),
    ).toBe(4);
  });

  it('bills one-hour cache writes at twice the input rate', () => {
    // Turn one of claude-2.1.259-partial-two-turns.jsonl (daemon fixtures):
    // Claude Code reported total_cost_usd 0.0186959 for exactly this usage.
    const haiku = resolveModelPrice('claude-haiku-4-5-20251001')!.price;
    const cost = tokenCostUsd(
      { input: 18, output: 459, cacheRead: 40_749, cacheWrite: 6_154, cacheWrite1h: 6_154 },
      haiku,
    );
    expect(cost).toBeCloseTo(0.0186959, 10);
  });

  it('never bills more one-hour writes than there are cache writes', () => {
    expect(
      tokenCostUsd({ input: 0, output: 0, cacheRead: 0, cacheWrite: 100, cacheWrite1h: 1_000 }, { input: 1, output: 1, cacheWrite: 1.25 }),
    ).toBeCloseTo(0.0002, 12);
  });
});

describe('BUNDLED_MODEL_PRICES', () => {
  it('has unique, normalized ids and valid prices', () => {
    const ids = BUNDLED_MODEL_PRICES.map((price) => price.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const price of BUNDLED_MODEL_PRICES) {
      expect(normalizeModelIdForPricing(price.id)).toBe(price.id);
      expect(isValidModelTokenPrice(price)).toBe(true);
    }
  });
});
