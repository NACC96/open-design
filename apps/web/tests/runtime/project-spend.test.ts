import { describe, expect, it } from 'vitest';

import {
  emptyPriceOverrideRow,
  overridesFromRows,
  prefillFromBundled,
  rowsFromOverrides,
} from '../../src/runtime/model-price-overrides';
import {
  formatSpendUsd,
  formatTokenCount,
  spendPriceLabel,
} from '../../src/runtime/project-spend-format';

describe('project spend formatting', () => {
  it('formats USD, keeping tiny non-zero amounts visible', () => {
    expect(formatSpendUsd(0)).toBe('$0.00');
    expect(formatSpendUsd(0.001)).toBe('<$0.01');
    expect(formatSpendUsd(1234.567)).toBe('$1,234.57');
  });

  it('compacts token counts', () => {
    expect(formatTokenCount(950)).toBe('950');
    expect(formatTokenCount(12_345)).toBe('12.3K');
    expect(formatTokenCount(4_500_000)).toBe('4.5M');
  });

  it('labels a model row by how it was costed', () => {
    expect(spendPriceLabel({ pricedTurns: 0, reportedTurns: 0, priceSource: null })).toBe('none');
    expect(spendPriceLabel({ pricedTurns: 3, reportedTurns: 3, priceSource: 'bundled' })).toBe('reported');
    expect(spendPriceLabel({ pricedTurns: 3, reportedTurns: 1, priceSource: 'bundled' })).toBe('bundled');
    expect(spendPriceLabel({ pricedTurns: 2, reportedTurns: 0, priceSource: 'override' })).toBe('override');
  });
});

describe('model price override rows', () => {
  it('round-trips stored overrides through editable rows', () => {
    const rows = rowsFromOverrides({
      'gpt-5.4': { input: 2.5, output: 15, cacheRead: 0.25 },
      'claude-opus-5-5': { input: 4, output: 20 },
    });
    expect(rows.map((row) => row.model)).toEqual(['claude-opus-5-5', 'gpt-5.4']);
    expect(overridesFromRows(rows)).toEqual({
      ok: true,
      overrides: {
        'claude-opus-5-5': { input: 4, output: 20 },
        'gpt-5.4': { input: 2.5, output: 15, cacheRead: 0.25 },
      },
    });
  });

  it('drops blank rows and rejects incomplete or negative ones', () => {
    const blank = emptyPriceOverrideRow();
    const missingOutput = { ...emptyPriceOverrideRow(), model: 'm', input: '1' };
    const negative = { ...emptyPriceOverrideRow(), model: 'n', input: '1', output: '-2' };
    const badCache = { ...emptyPriceOverrideRow(), model: 'o', input: '1', output: '2', cacheRead: 'cheap' };
    expect(overridesFromRows([blank])).toEqual({ ok: true, overrides: {} });
    expect(overridesFromRows([blank, missingOutput, negative, badCache])).toEqual({
      ok: false,
      invalidRowIds: [missingOutput.id, negative.id, badCache.id],
    });
  });

  it('prefills a known model from the bundled table without overwriting typed prices', () => {
    const known = { ...emptyPriceOverrideRow(), model: 'anthropic/claude-sonnet-4.5' };
    expect(prefillFromBundled(known)).toMatchObject({
      input: '3',
      output: '15',
      cacheRead: '0.3',
      cacheWrite: '3.75',
    });
    const typed = { ...known, input: '1' };
    expect(prefillFromBundled(typed)).toBe(typed);
    const unknown = { ...emptyPriceOverrideRow(), model: 'my-llama' };
    expect(prefillFromBundled(unknown)).toBe(unknown);
  });
});
