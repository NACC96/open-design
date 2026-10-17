/** Retired chat runtimes are never inherited as daemon execution defaults. */
export const RETIRED_AGENT_IDS: ReadonlySet<string> = new Set(['amr', 'byok-opencode']);

/** Pure read/write projection; runtime availability is resolved by the caller. */
export function normalizeLocalAgentId(agentId: string | null): string | null {
  return agentId !== null && RETIRED_AGENT_IDS.has(agentId) ? null : agentId;
}
