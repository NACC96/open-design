import type { ReasoningEffortOmittedDiagnostic } from '@open-design/contracts';
import { ensureDetectedRuntimeCapability } from './detection.js';
import type { RuntimeAgentDef } from './types.js';

type ProbeCapability = (
  agentId: string,
  capability: string,
  configuredAgentEnv: Record<string, string>,
) => Promise<boolean | undefined>;

/**
 * Decide whether a validated, non-default reasoning effort may reach the
 * installed CLI for an agent that gates it on an advertised flag
 * (`RuntimeAgentDef.reasoningCapability`).
 *
 * Only a positive `--help` answer lets the effort through. Both a CLI that
 * does not advertise the flag and one whose probe cannot answer (even after a
 * re-read) get the effort OMITTED rather than an argv that an older build
 * aborts on: effort is a preference, and losing it must never cost the user
 * the run. The returned diagnostic tells the caller what was dropped and why,
 * so the omission is reported instead of silent.
 *
 * Returns `null` when nothing is omitted.
 */
export async function confirmReasoningCapability(
  def: Pick<RuntimeAgentDef, 'id' | 'name' | 'reasoningCapability' | 'capabilityFlags'>,
  reasoning: string | null | undefined,
  configuredAgentEnv: Record<string, string>,
  probeCapability: ProbeCapability = ensureDetectedRuntimeCapability,
): Promise<ReasoningEffortOmittedDiagnostic | null> {
  const capability = def.reasoningCapability;
  if (!capability || !reasoning || reasoning === 'default') return null;
  const advertised = await probeCapability(def.id, capability, configuredAgentEnv);
  if (advertised === true) return null;
  const flag = Object.entries(def.capabilityFlags ?? {})
    .find(([, key]) => key === capability)?.[0] ?? capability;
  const reason = advertised === false ? 'unsupported' : 'unknown';
  const message = reason === 'unsupported'
    ? `Reasoning effort "${reasoning}" was not applied: this ${def.name} build does not advertise ${flag}. ` +
      `Update ${def.name} to use it. The run continues with the CLI's default effort.`
    : `Reasoning effort "${reasoning}" was not applied: could not confirm that this ${def.name} build supports ${flag} ` +
      '(its --help probe did not answer). The run continues with the CLI\'s default effort.';
  return {
    type: 'reasoning_effort_omitted',
    agentId: def.id,
    requested: reasoning,
    flag,
    reason,
    message,
  };
}
