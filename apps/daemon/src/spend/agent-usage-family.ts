import { getAgentDef } from '../runtimes/registry.js';
import { usageFamilyOfDef } from './run-usage.js';

/** The usage family of an installed agent id, local profiles included. */
export function usageFamilyOfAgent(agentId: string | null): string | null {
  return agentId ? usageFamilyOfDef(getAgentDef(agentId), agentId) : null;
}
