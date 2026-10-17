// Fork policy: this build runs Local AI only — local CLI agents (Claude Code,
// Codex, OpenCode, Antigravity, …) spawned by the daemon. Open Design Cloud
// (the `amr` runtime), API-key mode (`mode: 'api'`, which runs the hidden
// `byok-opencode` runtime), first-run onboarding and team workspaces are not
// part of the product.
//
// This module is the single web-side source of that rule for saved state. The
// daemon no longer registers either retired runtime, so a config that still
// names one would point at an agent that cannot run; normalizing it here lets
// the App auto-pick an installed local agent instead.

import type { AgentInfo, AppConfig } from '../types';

/** Runtime ids the daemon no longer ships. Mirrors `RETIRED_AGENT_IDS` in
 *  `apps/daemon/src/runtimes/registry.ts`. */
export const RETIRED_AGENT_IDS: ReadonlySet<string> = new Set(['amr', 'byok-opencode']);

/** The local agent auto-selected on a fresh install when it is installed. */
export const PREFERRED_DEFAULT_AGENT_ID = 'claude';

export function isRetiredAgentId(id: string | null | undefined): boolean {
  return typeof id === 'string' && RETIRED_AGENT_IDS.has(id);
}

/**
 * Coerce a config into the Local-AI-only shape.
 *
 * - `mode` is always `'daemon'` (API-key mode is gone).
 * - An `agentId` naming a retired runtime is cleared, so the App's auto-pick
 *   chooses an installed local agent.
 * - Onboarding is always complete: there is no first-run flow to route to.
 *
 * Returns the same object when nothing needed to change, so callers can use
 * identity to decide whether to persist.
 */
export function enforceLocalAiOnlyConfig(config: AppConfig): AppConfig {
  const needsMode = config.mode !== 'daemon';
  const needsAgent = isRetiredAgentId(config.agentId);
  const needsOnboarding = config.onboardingCompleted !== true;
  if (!needsMode && !needsAgent && !needsOnboarding) return config;
  return {
    ...config,
    mode: 'daemon',
    agentId: needsAgent ? null : config.agentId,
    onboardingCompleted: true,
  };
}

/**
 * Pick the agent a config with no selection should default to: Claude Code
 * when it is installed, otherwise the first installed agent in the order
 * given (the App passes the canonical registry order).
 */
export function pickDefaultLocalAgent(agents: readonly AgentInfo[]): AgentInfo | null {
  const usable = agents.filter((agent) => agent.available && !isRetiredAgentId(agent.id));
  return (
    usable.find((agent) => agent.id === PREFERRED_DEFAULT_AGENT_ID)
    ?? usable[0]
    ?? null
  );
}
