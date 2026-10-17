import type {
  ModelPriceSource,
  ProjectSpendBucket,
  ProjectSpendResponse,
} from '@open-design/contracts';

function usd(value: number): string {
  if (value > 0 && value < 0.01) return '<$0.01';
  return `$${value.toFixed(2)}`;
}

function tokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

function turnSummary(bucket: ProjectSpendBucket): string {
  const notes: string[] = [];
  if (bucket.unpricedTurns > 0) notes.push(`${bucket.unpricedTurns} unpriced`);
  if (bucket.estimatedTurns > 0) notes.push(`${bucket.estimatedTurns} estimated`);
  const turns = `${bucket.turns} turn${bucket.turns === 1 ? '' : 's'}`;
  return notes.length > 0 ? `${turns} (${notes.join(', ')})` : turns;
}

const PRICE_SOURCE_LABEL: Record<ModelPriceSource, string> = {
  override: 'your price',
  catalog: 'agent catalog price',
  bundled: 'bundled price',
};

function priceNote(row: ProjectSpendResponse['byModel'][number]): string {
  if (row.pricedTurns === 0) return 'no price — set one with `od config set modelPriceOverrides`';
  if (row.reportedTurns === row.pricedTurns) return 'reported by agent';
  return row.priceSource ? PRICE_SOURCE_LABEL[row.priceSource] : '';
}

function pad(value: string, width: number): string {
  return value.length >= width ? `${value} ` : value.padEnd(width);
}

/** Plain-text rendering of `GET /api/projects/:id/spend` for `od project spend`. */
export function formatProjectSpendText(spend: ProjectSpendResponse): string {
  const lines: string[] = [];
  const { total } = spend;
  lines.push(`Project spend — API-equivalent estimate (bundled prices as of ${spend.priceTableDate})`);
  if (total.turns === 0) {
    lines.push('  No agent usage recorded for this project yet.');
    return lines.join('\n');
  }
  lines.push(`  Total   ${usd(total.costUsd)}   ${turnSummary(total)}`);
  lines.push(
    `  Tokens  input ${tokens(total.tokens.input)} · cache read ${tokens(total.tokens.cacheRead)}`
      + ` · cache write ${tokens(total.tokens.cacheWrite)} · output ${tokens(total.tokens.output)}`,
  );
  lines.push('', 'By model');
  for (const row of spend.byModel) {
    const cost = row.pricedTurns > 0 ? usd(row.costUsd) : '—';
    lines.push(`  ${pad(row.model ?? '(unknown model)', 28)}${pad(cost, 10)}${pad(turnSummary(row), 30)}${priceNote(row)}`);
  }
  lines.push('', 'By conversation');
  for (const row of spend.byConversation) {
    const cost = row.pricedTurns > 0 ? usd(row.costUsd) : '—';
    lines.push(`  ${pad(cost, 10)}${pad(turnSummary(row), 30)}${row.title || row.conversationId}`);
  }
  if (total.estimatedTurns > 0) {
    lines.push('', 'Estimated turns were rebuilt from history recorded before per-turn usage tracking.');
  }
  return lines.join('\n');
}
