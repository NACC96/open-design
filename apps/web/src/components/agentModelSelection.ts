import type { AgentInfo, AgentModelChoice } from '../types';

type AgentModelSource =
  | {
      id: AgentInfo['id'];
      models?: Array<{ id: string; enabled?: boolean; default?: boolean }>;
    }
  | null
  | undefined;

export function defaultAgentModelId(agent: AgentModelSource): string | null {
  const models = agent?.models ?? [];
  return (
    models.find((model) => model.default === true && model.enabled !== false)?.id ??
    models.find((model) => model.enabled !== false)?.id ??
    null
  );
}

type AgentReasoningSource<O extends { id: string }> =
  | {
      models?: Array<{ id: string; reasoningOptions?: O[] }>;
      reasoningOptions?: O[];
    }
  | null
  | undefined;

/**
 * The reasoning-effort options `modelId` offers. The model's own list wins —
 * an explicit empty list marks a model that takes no effort — and the
 * agent-level list covers the CLI default and model ids the catalog does not
 * list. Mirrors the daemon's `reasoningOptionsForModel`, which decides what a
 * run actually forwards, so every picker shows the same list the run honours.
 */
export function agentReasoningOptions<O extends { id: string }>(
  agent: AgentReasoningSource<O>,
  modelId: string | null | undefined,
): O[] | undefined {
  const modelOptions = agent?.models?.find((model) => model.id === modelId)?.reasoningOptions;
  return modelOptions ?? agent?.reasoningOptions;
}

/**
 * The reasoning half of a model change, for every surface that writes one.
 *
 * A saved effort the next model does not offer is cleared — `{ reasoning:
 * undefined }`, which `mergeAgentModelChoice` and Settings read as a delete —
 * the same way an incompatible service tier is dropped. Keeping it would leave
 * the picker showing the model's default while the stored choice still holds
 * the old level, and switching back to a model that lists it would silently
 * re-apply a level the user never picked again. A level the next model does
 * offer is kept, so moving between models with the same list loses nothing.
 */
export function reasoningPatchForModelChange<O extends { id: string }>(
  agent: AgentReasoningSource<O>,
  nextModelId: string | null | undefined,
  savedReasoning: string | null | undefined,
): { reasoning?: undefined } {
  if (!savedReasoning) return {};
  const nextOptions = agentReasoningOptions(agent, nextModelId) ?? [];
  return nextOptions.some((option) => option.id === savedReasoning)
    ? {}
    : { reasoning: undefined };
}

export function normalizeAgentModelChoice(
  agent: AgentModelSource,
  choice: AgentModelChoice | undefined,
): AgentModelChoice | null {
  const configuredModel =
    typeof choice?.model === 'string' && choice.model ? choice.model : null;
  if (agent?.id !== 'amr' || !configuredModel) return null;
  if (configuredModel === 'default') return null;

  const matchingModel = agent.models?.find((model) => model.id === configuredModel) ?? null;
  if (!matchingModel && (agent.models?.length ?? 0) === 0) {
    return null;
  }
  if (matchingModel && matchingModel.enabled !== false) return null;

  const fallbackModel = defaultAgentModelId(agent);
  if (!fallbackModel || fallbackModel === configuredModel) return null;

  return {
    ...choice,
    model: fallbackModel,
  };
}

export function effectiveAgentModelChoice(
  agent: AgentModelSource,
  choice: AgentModelChoice | undefined,
): AgentModelChoice | undefined {
  return normalizeAgentModelChoice(agent, choice) ?? choice;
}

export function effectiveAgentModelId(
  agent: AgentModelSource,
  choice: AgentModelChoice | undefined,
): string | null {
  const configuredModel = effectiveAgentModelChoice(agent, choice)?.model?.trim();
  return configuredModel && configuredModel !== 'default'
    ? configuredModel
    : defaultAgentModelId(agent);
}

/**
 * Whether `modelId` may be OFFERED to the user as a selectable model.
 *
 * This is the single definition of "locked" for every model-list surface — the
 * home composer's compact list, the execution-settings picker, and the project
 * composer's `AvatarMenu` list all ask it instead of re-deriving the rule. Only
 * AMR's catalog carries plan entitlement (`enabled: false` is what `vela model
 * list --json` reports for a model above the caller's plan); every other agent's
 * list is its own model ids and stays fully selectable.
 *
 * The invariant that makes it safe: this predicate is AT LEAST as strict as
 * `normalizeAgentModelChoice`. Every model normalization would coerce away is
 * unselectable here, so a surface that gates its rows on this can never offer a
 * pick that gets written and then silently reverted — which is exactly what the
 * compact list shipped with: the click was accepted, re-normalized back to the
 * default, and the chip snapped to the previous model with no explanation.
 * `agentModelSelection.test.ts` pins the strictness relation directly, so a
 * future change to either function that broke it would fail rather than quietly
 * reopen the silent-revert hole.
 */
export function agentModelIsSelectable(
  agent: AgentModelSource,
  modelId: string | null | undefined,
): boolean {
  if (!modelId) return false;
  if (agent?.id !== 'amr') return true;
  if (modelId === 'default') return true;
  const models = agent.models ?? [];
  // No catalog yet (vela not queried) — nothing to gate against, and no surface
  // can render a row for a model it has not been told about.
  if (models.length === 0) return true;
  const option = models.find((model) => model.id === modelId) ?? null;
  return option !== null && option.enabled !== false;
}
