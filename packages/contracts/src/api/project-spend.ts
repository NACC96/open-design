import type {
  ModelPriceSource,
  ModelTokenPrice,
  PricedTokenCounts,
} from '../pricing/model-prices.js';

/**
 * `GET /api/projects/:id/spend` — what a project's agent turns cost.
 *
 * Every dollar figure is an API-equivalent estimate: the cost the same tokens
 * would bill at pay-per-token API rates. A turn is costed from the cost the
 * agent itself reported when it reported one for all of its usage (Claude
 * Code, Qoder, OpenCode, pi), otherwise from its token counts and the price of
 * its model (user override → the agent catalog's launch-time price → the
 * bundled table dated `priceTableDate`). A user override therefore re-prices
 * only turns whose agent did not report its own cost.
 */
export interface ProjectSpendBucket {
  /** API-equivalent USD across the priced turns in this bucket. */
  costUsd: number;
  /** Agent turns that consumed tokens. */
  turns: number;
  /** Turns that could be costed (reported or computed). */
  pricedTurns: number;
  /** Priced turns whose cost the agent reported itself. */
  reportedTurns: number;
  /**
   * Priced turns reconstructed from older history whose usage or model had to
   * be inferred (recorded before per-turn usage tracking, with no run log).
   */
  estimatedTurns: number;
  /** Turns with token usage but no known price for their model. */
  unpricedTurns: number;
  /** Token totals. `input` is uncached input only. */
  tokens: PricedTokenCounts;
}

export interface ProjectSpendModelRow extends ProjectSpendBucket {
  /** Normalized model id, or null when the model could not be determined. */
  model: string | null;
  /** Agents (CLI runtimes) that ran this model in the project. */
  agentIds: string[];
  /** Where the price applied to this model's computed turns came from. */
  priceSource: ModelPriceSource | null;
  /** The price applied to computed turns; null when unpriced. */
  price: ModelTokenPrice | null;
}

export interface ProjectSpendConversationRow extends ProjectSpendBucket {
  conversationId: string;
  title: string | null;
  updatedAt: number;
}

export interface ProjectSpendResponse {
  projectId: string;
  currency: 'USD';
  /** Date the bundled price table was last checked (`YYYY-MM-DD`). */
  priceTableDate: string;
  generatedAt: number;
  total: ProjectSpendBucket;
  /** Sorted by cost, highest first. */
  byModel: ProjectSpendModelRow[];
  /** Sorted by cost, highest first; conversations with no usage are omitted. */
  byConversation: ProjectSpendConversationRow[];
}
