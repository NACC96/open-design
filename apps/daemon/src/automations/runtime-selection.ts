import type { AppConfigPrefs } from '@open-design/contracts';
import { RETIRED_AGENT_IDS } from '../runtimes/local-ai-policy.js';
import type { Routine } from '../routines.js';
import type { DetectedAgent } from '../runtimes/types.js';

type DetectLocalAgents = (
  env: NonNullable<AppConfigPrefs['agentCliEnv']>,
) => Promise<ReadonlyArray<Pick<DetectedAgent, 'id' | 'available'>>>;

/** Resolve execution without rewriting the saved routine or its history. */
export async function resolveRoutineExecution(
  routine: Pick<Routine, 'agentId'>,
  appConfig: Pick<AppConfigPrefs, 'agentId' | 'agentModels' | 'agentCliEnv'>,
  detectAgents: DetectLocalAgents,
) {
  const appAgentId = typeof appConfig.agentId === 'string' && appConfig.agentId
    ? appConfig.agentId
    : null;
  let agentId = routine.agentId || appAgentId;
  if (!agentId || RETIRED_AGENT_IDS.has(agentId)) {
    const agents = await detectAgents(appConfig.agentCliEnv ?? {}).catch(() => []);
    const available = agents.filter((agent) => agent.available && !RETIRED_AGENT_IDS.has(agent.id));
    agentId = available.find((agent) => agent.id === appAgentId)?.id
      ?? available.find((agent) => agent.id === 'claude')?.id
      ?? available[0]?.id
      ?? null;
  }
  if (!agentId) {
    throw new Error('No available agent is configured. Choose an agent in Settings first.');
  }
  // Model, effort, and tier belong to the resolved agent, never the retired selection.
  const prefs = appConfig.agentModels?.[agentId];
  return {
    agentId,
    model: prefs?.model ?? null,
    reasoning: prefs?.reasoning ?? null,
    serviceTier: prefs?.serviceTier ?? null,
  };
}
