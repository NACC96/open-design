import type { ModelPriceSource, ProjectSpendBucket } from '@open-design/contracts';

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** `$1,234.56`; amounts that would round to `$0.00` but are not zero read `<$0.01`. */
export function formatSpendUsd(value: number): string {
  if (value > 0 && value < 0.005) return '<$0.01';
  return USD.format(value);
}

/** Compact token count: `950`, `12.3K`, `4.5M`. */
export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

/** Total tokens a bucket moved, across every price bucket. */
export function totalTokens(bucket: ProjectSpendBucket): number {
  const { input, output, cacheRead, cacheWrite } = bucket.tokens;
  return input + output + cacheRead + cacheWrite;
}

export type SpendPriceLabel = ModelPriceSource | 'reported' | 'none';

/**
 * Which single label describes how a model row was costed: the agent's own
 * report when every priced turn was reported, otherwise where the price came
 * from, or `none` when no turn could be priced.
 */
export function spendPriceLabel(row: {
  pricedTurns: number;
  reportedTurns: number;
  priceSource: ModelPriceSource | null;
}): SpendPriceLabel {
  if (row.pricedTurns === 0) return 'none';
  if (row.reportedTurns === row.pricedTurns) return 'reported';
  return row.priceSource ?? 'none';
}
