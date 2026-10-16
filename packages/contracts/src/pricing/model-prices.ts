/**
 * Bundled pay-per-token API prices, used to estimate what a project's agent
 * runs would cost at standard API rates.
 *
 * Every figure is an estimate of the *API-equivalent* cost, not of money a
 * user was charged: subscription-backed CLIs (Claude Max, Codex on a ChatGPT
 * plan, Cursor, Copilot) bill by plan, and providers adjust prices without
 * notice. The table is dated so the UI and CLI can say how old it is; users
 * correct or extend it through `AppConfigPrefs.modelPriceOverrides`.
 *
 * Simplifications, deliberately not modeled: long-context tiers (OpenAI
 * >272K, Gemini Pro >200K, Claude Haiku 5.5 >100K input), off-peak discounts
 * (DeepSeek), batch / priority / fast-mode multipliers, and the 1-hour cache
 * write rate (cache writes are priced at the 5-minute rate).
 */

/** The date the bundled prices below were last checked against their sources. */
export const MODEL_PRICE_TABLE_DATE = '2026-10-16';

/** USD per 1M tokens. */
export interface ModelTokenPrice {
  /** Uncached input tokens. */
  input: number;
  /** Output tokens, reasoning/thinking tokens included. */
  output: number;
  /** Input tokens served from the prompt cache. Absent: billed at `input`. */
  cacheRead?: number;
  /** Input tokens written to the prompt cache. Absent: billed at `input`. */
  cacheWrite?: number;
}

export interface BundledModelPrice extends ModelTokenPrice {
  /** Canonical id, already in {@link normalizeModelIdForPricing} form. */
  id: string;
}

/** Token counts in the four buckets a price applies to. `input` is uncached input only. */
export interface PricedTokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// [id, input, output, cacheRead, cacheWrite] — USD per 1M tokens. A null cache
// price means the provider publishes none, so those tokens bill at `input`.
type PriceRow = readonly [string, number, number, number | null, number | null];

// Anthropic first-party API (Claude API docs, model table cached 2026-10-06).
// Cache writes are the 5-minute rate, 1.25x input. Cache reads are 0.1x input
// except Fable/Mythos 5.1 (0.025x), Fable/Mythos 5 ($1) and Opus 5.5 (0.05x).
const ANTHROPIC: readonly PriceRow[] = [
  ['claude-fable-5-1', 10, 50, 0.25, 12.5],
  ['claude-mythos-5-1', 10, 50, 0.25, 12.5],
  ['claude-fable-5', 10, 50, 1, 12.5],
  ['claude-mythos-5', 10, 50, 1, 12.5],
  ['claude-opus-5-5', 4, 20, 0.2, 5],
  ['claude-opus-5', 5, 25, 0.5, 6.25],
  ['claude-opus-4-8', 5, 25, 0.5, 6.25],
  ['claude-opus-4-7', 5, 25, 0.5, 6.25],
  ['claude-opus-4-6', 5, 25, 0.5, 6.25],
  ['claude-opus-4-5', 5, 25, 0.5, 6.25],
  ['claude-opus-4-1', 15, 75, 1.5, 18.75],
  ['claude-opus-4', 15, 75, 1.5, 18.75],
  ['claude-sonnet-5-5', 2, 10, 0.2, 2.5],
  ['claude-sonnet-5', 2, 10, 0.2, 2.5],
  ['claude-sonnet-4-6', 3, 15, 0.3, 3.75],
  ['claude-sonnet-4-5', 3, 15, 0.3, 3.75],
  ['claude-sonnet-4', 3, 15, 0.3, 3.75],
  ['claude-haiku-5-5', 0.1, 0.5, 0.01, 0.125],
  ['claude-haiku-4-5', 1, 5, 0.1, 1.25],
];

// OpenAI standard tier (developers.openai.com/api/docs/pricing, 2026-10-16).
// OpenAI bills no cache-write premium; `cacheRead` is the "cached input" rate.
const OPENAI: readonly PriceRow[] = [
  ['gpt-6-astra', 10, 50, 1, null],
  ['gpt-6.1-sol', 2, 10, 0.1, null],
  ['gpt-6-sol', 2, 10, 0.2, null],
  ['gpt-6-luna', 0.1, 0.5, 0.01, null],
  ['gpt-5.6-sol', 4, 20, 0.4, null],
  ['gpt-5.6', 4, 20, 0.4, null],
  ['gpt-5.6-terra', 2, 12, 0.2, null],
  ['gpt-5.6-luna', 0.2, 1.2, 0.02, null],
  ['gpt-5.5-pro', 30, 180, null, null],
  ['gpt-5.5', 5, 30, 0.5, null],
  ['gpt-5.4-pro', 30, 180, null, null],
  ['gpt-5.4-mini', 0.75, 4.5, 0.075, null],
  ['gpt-5.4-nano', 0.2, 1.25, 0.02, null],
  ['gpt-5.4', 2.5, 15, 0.25, null],
  ['gpt-5.3-codex', 1.75, 14, 0.175, null],
  ['gpt-5.2-pro', 21, 168, null, null],
  ['gpt-5.2-codex', 1.75, 14, 0.175, null],
  ['gpt-5.2', 1.75, 14, 0.175, null],
  ['gpt-5.1-codex-mini', 0.25, 2, 0.025, null],
  ['gpt-5.1-codex-max', 1.25, 10, 0.125, null],
  ['gpt-5.1-codex', 1.25, 10, 0.125, null],
  ['gpt-5.1', 1.25, 10, 0.125, null],
  ['gpt-5-pro', 15, 120, null, null],
  ['gpt-5-codex', 1.25, 10, 0.125, null],
  ['gpt-5-mini', 0.25, 2, 0.025, null],
  ['gpt-5-nano', 0.05, 0.4, 0.005, null],
  ['gpt-5', 1.25, 10, 0.125, null],
  ['gpt-4.1-mini', 0.4, 1.6, 0.1, null],
  ['gpt-4.1-nano', 0.1, 0.4, 0.025, null],
  ['gpt-4.1', 2, 8, 0.5, null],
  ['gpt-4o-mini', 0.15, 0.6, 0.075, null],
  ['gpt-4o', 2.5, 10, 1.25, null],
  ['o4-mini', 1.1, 4.4, 0.275, null],
  ['o3-pro', 20, 80, null, null],
  ['o3-mini', 1.1, 4.4, 0.55, null],
  ['o3', 2, 8, 0.5, null],
  ['o1', 15, 60, 7.5, null],
];

// Google Gemini API paid tier (ai.google.dev/gemini-api/docs/pricing,
// 2026-10-16), at or below the 200K-token tier.
const GOOGLE: readonly PriceRow[] = [
  ['gemini-4-argon', 2, 10, 0.1, null],
  ['gemini-3.8-flash', 0.75, 3.75, 0.075, null],
  ['gemini-3.7-flash', 0.75, 3.75, 0.075, null],
  ['gemini-3.6-flash', 0.75, 3.75, 0.075, null],
  ['gemini-3.5-flash-lite', 0.3, 2.5, 0.03, null],
  ['gemini-3.5-flash', 1.5, 9, 0.15, null],
  ['gemini-3.1-pro-preview', 2, 12, 0.2, null],
  ['gemini-3.1-flash-lite', 0.25, 1.5, 0.025, null],
  ['gemini-3-flash-preview', 0.5, 3, 0.05, null],
  ['gemini-2.5-pro', 1.25, 10, 0.125, null],
  ['gemini-2.5-flash-lite', 0.1, 0.4, 0.01, null],
  ['gemini-2.5-flash', 0.3, 2.5, 0.03, null],
];

// DeepSeek (api-docs.deepseek.com/quick_start/pricing, 2026-10-16), peak
// rates; off-peak is half. `deepseek-v4-flash` is the legacy name for Flash.
// deepseek-chat / -reasoner / -v3.2 are from the LiteLLM price list.
const DEEPSEEK: readonly PriceRow[] = [
  ['deepseek-v4-pro', 1.32, 3.96, 0.044, null],
  ['deepseek-v4-flash', 0.3, 1.2, 0.006, null],
  ['deepseek-flash', 0.3, 1.2, 0.006, null],
  ['deepseek-v3.2', 0.28, 0.4, 0.028, null],
  ['deepseek-chat', 0.28, 0.42, 0.028, null],
  ['deepseek-reasoner', 0.28, 0.42, 0.028, null],
];

// Moonshot, xAI, Alibaba Qwen, Zhipu GLM, MiniMax and Mistral first-party
// rates as listed in the LiteLLM model price list (fetched 2026-10-16).
const OTHER: readonly PriceRow[] = [
  ['kimi-k3', 3, 15, 0.3, null],
  ['kimi-k2.7-code', 0.95, 4, 0.19, null],
  ['kimi-k2.6', 0.95, 4, 0.16, null],
  ['kimi-k2.5', 0.6, 3, 0.1, null],
  ['grok-4.7', 2, 6, 0.5, null],
  ['grok-4.6', 2, 6, 0.5, null],
  ['grok-4.5', 2, 6, 0.3, null],
  ['grok-4.3', 1.25, 2.5, 0.2, null],
  ['grok-4.20', 1.25, 2.5, 0.2, null],
  ['grok-code-fast-1', 1, 2, 0.2, null],
  ['grok-code-fast', 1, 2, 0.2, null],
  ['grok-build-0.1', 1, 2, 0.2, null],
  ['qwen3.8-max', 2, 6, 0.25, null],
  ['qwen3.8-flash', 0.15, 0.47, 0.016, null],
  ['qwen3.7-max', 2.5, 7.5, 0.5, null],
  ['glm-5.2', 1.4, 4.4, 0.28, null],
  ['glm-5.1', 1.4, 4.4, 0.26, null],
  ['minimax-m3', 0.3, 1.2, 0.06, null],
  ['minimax-m2.5', 0.3, 1.2, 0.03, null],
  ['mistral-medium-3.5', 1.5, 7.5, 0.15, null],
  ['mistral-large-4', 0.68, 2.09, 0.068, null],
  ['codestral-2508', 0.3, 0.9, 0.03, null],
];

function rowToPrice([id, input, output, cacheRead, cacheWrite]: PriceRow): BundledModelPrice {
  return {
    id,
    input,
    output,
    ...(cacheRead === null ? {} : { cacheRead }),
    ...(cacheWrite === null ? {} : { cacheWrite }),
  };
}

export const BUNDLED_MODEL_PRICES: readonly BundledModelPrice[] = [
  ...ANTHROPIC,
  ...OPENAI,
  ...GOOGLE,
  ...DEEPSEEK,
  ...OTHER,
].map(rowToPrice);

const BUNDLED_BY_ID: ReadonlyMap<string, BundledModelPrice> = new Map(
  BUNDLED_MODEL_PRICES.map((price) => [price.id, price]),
);

/**
 * Reduce the many spellings agents report for one model to the table's key.
 *
 *   anthropic/claude-sonnet-4.5            → claude-sonnet-4-5   (OpenCode / OpenRouter route, dotted)
 *   us.anthropic.claude-opus-4-6-v1:0      → claude-opus-4-6     (Bedrock)
 *   claude-haiku-4-5-20251001              → claude-haiku-4-5    (dated snapshot)
 *   claude-opus-4-5@20251101               → claude-opus-4-5     (Vertex)
 *   claude-opus-4-6[1m]                    → claude-opus-4-6     (Claude Code context suffix)
 *   od-byok/gpt-5.4                        → gpt-5.4             (BYOK route)
 *   gpt-5-2025-08-07                       → gpt-5
 *   Gemini 3.8 Flash (high)                → gemini-3.8-flash    (display name)
 */
export function normalizeModelIdForPricing(raw: string): string {
  let id = raw.trim().toLowerCase();
  id = id.replace(/\[[^\]]*\]$/, '');
  // Display names (Cursor, Antigravity): `Kimi K3 High`, `gemini 3.8 flash (high)`.
  id = id.replace(/\s*\([^)]*\)$/, '').trim().replace(/\s+/g, '-');
  const slash = id.lastIndexOf('/');
  if (slash >= 0) id = id.slice(slash + 1);
  id = id.replace(/^(?:[a-z]{2,6}\.)?anthropic\./, '');
  id = id.replace(/-v\d+:\d+$/, '');
  id = id.replace(/:[a-z0-9-]+$/, '');
  id = id.replace(/@\d{8}$/, '');
  id = id.replace(/-\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
  if (id.startsWith('claude-')) id = id.replace(/(\d)\.(\d)/g, '$1-$2');
  return id;
}

/**
 * Find the entry for `normalizedId` in `table`: an exact key first, then the
 * longest key that prefixes it at a `-` boundary, so a variant such as
 * `gemini-2.5-pro-preview-06-05` falls back to `gemini-2.5-pro` while
 * `gpt-5.6-luna` can never fall back to `gpt-5`.
 */
function lookupByIdOrPrefix<T>(
  table: ReadonlyMap<string, T>,
  normalizedId: string,
): { key: string; value: T } | null {
  const exact = table.get(normalizedId);
  if (exact !== undefined) return { key: normalizedId, value: exact };
  let best: { key: string; value: T } | null = null;
  for (const [key, value] of table) {
    if (!normalizedId.startsWith(`${key}-`)) continue;
    if (!best || key.length > best.key.length) best = { key, value };
  }
  return best;
}

export type ModelPriceSource = 'override' | 'catalog' | 'bundled';

export interface ResolvedModelPrice {
  price: ModelTokenPrice;
  source: ModelPriceSource;
  /** The table or override key that matched. */
  matchedId: string;
}

export interface ResolveModelPriceOptions {
  /** User overrides keyed by model id (any spelling — keys are normalized here). */
  overrides?: Readonly<Record<string, ModelTokenPrice>> | null;
  /**
   * Input/output price the agent's own model catalog reported when the run
   * launched (AMR's catalog carries one). It outranks the bundled table but
   * carries no cache prices, so the bundled entry's cache discount is applied
   * to it when the model is in the table.
   */
  catalog?: { input: number; output: number } | null;
}

function normalizedOverrides(
  overrides: Readonly<Record<string, ModelTokenPrice>>,
): Map<string, ModelTokenPrice> {
  const map = new Map<string, ModelTokenPrice>();
  for (const [key, price] of Object.entries(overrides)) {
    const id = normalizeModelIdForPricing(key);
    if (id && isValidModelTokenPrice(price)) map.set(id, price);
  }
  return map;
}

/**
 * The price a model's tokens bill at: user override, then the launch-time
 * catalog price, then the bundled table. Null when none knows the model.
 */
export function resolveModelPrice(
  modelId: string | null | undefined,
  options: ResolveModelPriceOptions = {},
): ResolvedModelPrice | null {
  const normalized = modelId ? normalizeModelIdForPricing(modelId) : '';
  if (normalized && options.overrides) {
    const override = lookupByIdOrPrefix(normalizedOverrides(options.overrides), normalized);
    if (override) return { price: override.value, source: 'override', matchedId: override.key };
  }
  const bundled = normalized ? lookupByIdOrPrefix(BUNDLED_BY_ID, normalized) : null;
  const catalog = options.catalog;
  if (catalog && isNonNegativeNumber(catalog.input) && isNonNegativeNumber(catalog.output)) {
    const price: ModelTokenPrice = { input: catalog.input, output: catalog.output };
    const base = bundled?.value;
    if (base && base.input > 0) {
      if (base.cacheRead !== undefined) price.cacheRead = catalog.input * (base.cacheRead / base.input);
      if (base.cacheWrite !== undefined) price.cacheWrite = catalog.input * (base.cacheWrite / base.input);
    }
    return { price, source: 'catalog', matchedId: normalized || (modelId ?? '') };
  }
  if (bundled) return { price: bundled.value, source: 'bundled', matchedId: bundled.key };
  return null;
}

/** USD cost of `tokens` at `price`. */
export function tokenCostUsd(tokens: PricedTokenCounts, price: ModelTokenPrice): number {
  return (
    tokens.input * price.input
    + tokens.output * price.output
    + tokens.cacheRead * (price.cacheRead ?? price.input)
    + tokens.cacheWrite * (price.cacheWrite ?? price.input)
  ) / 1_000_000;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Whether `value` is a well-formed price: finite, non-negative, input and output present. */
export function isValidModelTokenPrice(value: unknown): value is ModelTokenPrice {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const price = value as Record<string, unknown>;
  if (!isNonNegativeNumber(price.input) || !isNonNegativeNumber(price.output)) return false;
  if (price.cacheRead !== undefined && !isNonNegativeNumber(price.cacheRead)) return false;
  if (price.cacheWrite !== undefined && !isNonNegativeNumber(price.cacheWrite)) return false;
  return true;
}
