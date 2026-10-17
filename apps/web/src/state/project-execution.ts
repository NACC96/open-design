// Per-project agent + model choice (the "execution stamp").
//
// A project carries `execution` — the local agent CLI and model it runs with —
// so each project can sit on a different CLI without anyone touching
// Settings → Execution. The app-config `agentId` + `agentModels` stay the
// default for NEW projects. Home keeps a separate draft and sends its choice
// explicitly when creating the project; project pickers only patch that project.
//
// A project without a stamp predates this field: it follows the app-config
// default until its first in-project change, which stamps it.
//
// Everything here is pure so the Home create path, the project view, and the
// tests all derive the same answer from the same inputs.

import type {
  AgentInfo,
  AgentModelChoice,
  AppConfig,
  ChatMessage,
  ProjectExecutionChoice,
} from '../types';
import {
  agentReasoningOptions,
  defaultAgentModelId,
  effectiveAgentModelChoice,
  mergeAgentModelChoice,
} from '../components/agentModelSelection';
import { isRetiredAgentId } from './local-ai-only';

type ExecutionConfig = Pick<AppConfig, 'agentId' | 'agentModels'>;
type ChoicePatch = { model?: string; reasoning?: string; serviceTier?: string };

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Build a stamp from an agent id + choice, keeping only the keys that are set. */
export function toProjectExecution(
  agentId: string,
  choice: AgentModelChoice | null | undefined,
): ProjectExecutionChoice {
  const next: ProjectExecutionChoice = { agentId };
  const model = nonEmpty(choice?.model);
  const reasoning = nonEmpty(choice?.reasoning);
  const serviceTier = nonEmpty(choice?.serviceTier);
  if (model) next.model = model;
  if (reasoning) next.reasoning = reasoning;
  if (serviceTier) next.serviceTier = serviceTier;
  return next;
}

/** A stamp this build can run: names an agent that is not a retired runtime. */
export function isUsableProjectExecution(
  stamp: ProjectExecutionChoice | null | undefined,
): stamp is ProjectExecutionChoice {
  return Boolean(
    stamp
      && typeof stamp.agentId === 'string'
      && stamp.agentId.trim()
      && !isRetiredAgentId(stamp.agentId),
  );
}

export function sameProjectExecution(
  left: ProjectExecutionChoice | null | undefined,
  right: ProjectExecutionChoice | null | undefined,
): boolean {
  if (!left || !right) return !left && !right;
  return left.agentId === right.agentId
    && (left.model ?? null) === (right.model ?? null)
    && (left.reasoning ?? null) === (right.reasoning ?? null)
    && (left.serviceTier ?? null) === (right.serviceTier ?? null);
}

/**
 * The app-config default expressed as a stamp: the selected agent plus its
 * saved choice. `null` when no usable agent is selected.
 */
export function projectExecutionFromConfig(
  config: ExecutionConfig,
  agents?: readonly AgentInfo[],
): ProjectExecutionChoice | null {
  const agentId = config.agentId;
  if (!agentId || isRetiredAgentId(agentId)) return null;
  const agent = agents?.find((candidate) => candidate.id === agentId) ?? null;
  return toProjectExecution(
    agentId,
    effectiveAgentModelChoice(agent, config.agentModels?.[agentId]),
  );
}

/** What a project runs with: its own stamp, else the app-config default. */
export function effectiveProjectExecution(
  stamp: ProjectExecutionChoice | null | undefined,
  config: ExecutionConfig,
): ProjectExecutionChoice | null {
  if (isUsableProjectExecution(stamp)) return stamp;
  return projectExecutionFromConfig(config);
}

/**
 * `config` as seen from inside a project: `agentId` and that agent's
 * `agentModels` slot replaced by the project's choice — exactly, not merged,
 * so a global effort or tier never bleeds into a project that did not pick
 * one. Returns `config` itself when nothing differs, so memoized consumers keep
 * a stable identity for unstamped projects.
 */
export function withProjectExecution(
  config: AppConfig,
  execution: ProjectExecutionChoice | null,
): AppConfig {
  if (!execution) return config;
  const { agentId, ...choice } = execution;
  const current = config.agentModels?.[agentId];
  if (
    config.agentId === agentId
    && sameProjectExecution(toProjectExecution(agentId, current), execution)
  ) {
    return config;
  }
  return {
    ...config,
    agentId,
    agentModels: { ...(config.agentModels ?? {}), [agentId]: choice },
  };
}

/**
 * The stamp a project moves to when its picker switches CLI.
 *
 * Seeds the new agent's model from the app-config slot for that agent (read
 * only — the global default is never written from inside a project), then
 * drops an effort or service tier the seeded model does not offer, the same
 * way a model change does. Picking the agent the project already runs keeps
 * its current choice.
 */
export function nextProjectExecutionForAgent(
  current: ProjectExecutionChoice | null,
  agentId: string,
  globalConfig: ExecutionConfig,
  agents: readonly AgentInfo[],
): ProjectExecutionChoice {
  if (current?.agentId === agentId) return current;
  const agent = agents.find((candidate) => candidate.id === agentId) ?? null;
  const seeded: AgentModelChoice = {
    ...(effectiveAgentModelChoice(agent, globalConfig.agentModels?.[agentId]) ?? {}),
  };
  const modelId = nonEmpty(seeded.model) ?? defaultAgentModelId(agent);
  if (seeded.reasoning) {
    const options = agentReasoningOptions(agent, modelId) ?? [];
    if (!options.some((option) => option.id === seeded.reasoning)) {
      delete seeded.reasoning;
    }
  }
  if (seeded.serviceTier) {
    const tiers = agent?.models?.find((model) => model.id === modelId)?.serviceTierOptions ?? [];
    if (!tiers.some((tier) => tier.id === seeded.serviceTier)) {
      delete seeded.serviceTier;
    }
  }
  return toProjectExecution(agentId, seeded);
}

/**
 * Apply a picker's model / effort / tier patch to a project's stamp, with the
 * same merge semantics as the global writer (`mergeAgentModelChoice`: an own
 * `undefined` clears). A patch for a different agent starts from that agent.
 */
export function nextProjectExecutionForChoice(
  current: ProjectExecutionChoice | null,
  agentId: string,
  patch: ChoicePatch,
): ProjectExecutionChoice {
  const base: AgentModelChoice = {};
  if (current && current.agentId === agentId) {
    if (current.model) base.model = current.model;
    if (current.reasoning) base.reasoning = current.reasoning;
    if (current.serviceTier) base.serviceTier = current.serviceTier;
  }
  return toProjectExecution(agentId, mergeAgentModelChoice(base, patch));
}

/**
 * The config one run is sent with: the project's choice, except when the send
 * answers an OD Next clarification. That continuation is locked by the daemon
 * to the agent that asked (a different `agentId` is refused with
 * `STRATEGY_TASK_AGENT_MISMATCH`), so a CLI switch made while the question was
 * open applies from the next new turn instead of failing this one.
 */
export function projectRunConfig(
  globalConfig: AppConfig,
  execution: ProjectExecutionChoice | null,
  strategyTaskExecutionId: string | undefined,
  messages: readonly ChatMessage[],
): AppConfig {
  let runExecution = execution;
  if (strategyTaskExecutionId) {
    let lockedAgentId: string | undefined;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (
        message?.role === 'assistant'
        && message.strategyTaskExecutionId === strategyTaskExecutionId
        && message.agentId
      ) {
        lockedAgentId = message.agentId;
        break;
      }
    }
    if (
      lockedAgentId
      && lockedAgentId !== execution?.agentId
      && !isRetiredAgentId(lockedAgentId)
    ) {
      runExecution = projectExecutionFromConfig({
        agentId: lockedAgentId,
        agentModels: globalConfig.agentModels,
      });
    }
  }
  return withProjectExecution(globalConfig, runExecution);
}
