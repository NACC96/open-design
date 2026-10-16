import {
  BUNDLED_MODEL_PRICES,
  normalizeModelIdForPricing,
  type ModelTokenPrice,
} from '@open-design/contracts';

/** One editable row of the Settings price table; prices stay strings while typed. */
export interface PriceOverrideRow {
  id: string;
  model: string;
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
}

let nextRowId = 0;

function rowId(): string {
  nextRowId += 1;
  return `price-row-${nextRowId}`;
}

function priceText(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

export function emptyPriceOverrideRow(): PriceOverrideRow {
  return { id: rowId(), model: '', input: '', output: '', cacheRead: '', cacheWrite: '' };
}

export function rowsFromOverrides(
  overrides: Readonly<Record<string, ModelTokenPrice>> | null | undefined,
): PriceOverrideRow[] {
  return Object.entries(overrides ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([model, price]) => ({
      id: rowId(),
      model,
      input: priceText(price.input),
      output: priceText(price.output),
      cacheRead: priceText(price.cacheRead),
      cacheWrite: priceText(price.cacheWrite),
    }));
}

function parsePrice(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : Number.NaN;
}

export type OverridesFromRowsResult =
  | { ok: true; overrides: Record<string, ModelTokenPrice> }
  | { ok: false; invalidRowIds: string[] };

/**
 * Turn edited rows back into the stored overrides. Fully blank rows are
 * dropped; any other row needs a model id plus non-negative input and output
 * prices, and cache prices that are blank or non-negative.
 */
export function overridesFromRows(rows: readonly PriceOverrideRow[]): OverridesFromRowsResult {
  const overrides: Record<string, ModelTokenPrice> = {};
  const invalidRowIds: string[] = [];
  for (const row of rows) {
    const model = row.model.trim();
    const blank = !model && ![row.input, row.output, row.cacheRead, row.cacheWrite].some((v) => v.trim());
    if (blank) continue;
    const input = parsePrice(row.input);
    const output = parsePrice(row.output);
    const cacheRead = parsePrice(row.cacheRead);
    const cacheWrite = parsePrice(row.cacheWrite);
    if (
      !model
      || input === null || Number.isNaN(input)
      || output === null || Number.isNaN(output)
      || Number.isNaN(cacheRead)
      || Number.isNaN(cacheWrite)
    ) {
      invalidRowIds.push(row.id);
      continue;
    }
    overrides[model] = {
      input,
      output,
      ...(cacheRead === null ? {} : { cacheRead }),
      ...(cacheWrite === null ? {} : { cacheWrite }),
    };
  }
  return invalidRowIds.length > 0 ? { ok: false, invalidRowIds } : { ok: true, overrides };
}

/** Bundled ids offered as suggestions while typing a model id. */
export const BUNDLED_PRICE_MODEL_IDS: readonly string[] = BUNDLED_MODEL_PRICES.map((price) => price.id);

/** Fill a row's blank prices from the bundled table when its model is known there. */
export function prefillFromBundled(row: PriceOverrideRow): PriceOverrideRow {
  if ([row.input, row.output, row.cacheRead, row.cacheWrite].some((v) => v.trim())) return row;
  const id = normalizeModelIdForPricing(row.model);
  const bundled = BUNDLED_MODEL_PRICES.find((price) => price.id === id);
  if (!bundled) return row;
  return {
    ...row,
    input: priceText(bundled.input),
    output: priceText(bundled.output),
    cacheRead: priceText(bundled.cacheRead),
    cacheWrite: priceText(bundled.cacheWrite),
  };
}
