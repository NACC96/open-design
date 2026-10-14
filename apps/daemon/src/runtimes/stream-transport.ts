import { ensureDetectedRuntimeCapabilities } from './detection.js';
import type { RuntimeAgentDef, RuntimeCapabilityMap } from './types.js';

/**
 * One transport decision per run for a def that declares a
 * `structuredStreamUpgrade`.
 *
 * Returns the registry def unchanged when the def declares no upgrade or the
 * capability is not advertised, so the run keeps the baseline transport.
 * Otherwise returns a per-run copy whose `streamFormat`, `eventParser`, and
 * `buildArgs` switch together: the copy's `buildArgs` passes
 * `structuredStream: true` to the def's own `buildArgs`, so the argv cannot
 * disagree with the parser even if the shared capability cache changes
 * before spawn (a `/api/agents` refresh, a `--help` timeout that writes `{}`).
 *
 * Mirrors `withCodexTransport`: callers hold the returned def for the whole
 * attempt and must not re-read the registry def for transport decisions.
 */
export function applyStructuredStreamUpgrade(
  def: RuntimeAgentDef,
  capabilities: RuntimeCapabilityMap | null | undefined,
): RuntimeAgentDef {
  const upgrade = def.structuredStreamUpgrade;
  if (!upgrade || capabilities?.[upgrade.capability] !== true) return def;
  return {
    ...def,
    streamFormat: upgrade.streamFormat,
    ...(upgrade.eventParser ? { eventParser: upgrade.eventParser } : {}),
    buildArgs: (prompt, imagePaths, extraAllowedDirs, options, runtimeContext) =>
      def.buildArgs(prompt, imagePaths, extraAllowedDirs, options, {
        ...(runtimeContext ?? {}),
        structuredStream: true,
      }),
  };
}

/**
 * Probe the installed CLI's advertised flags (the same bounded `--help` read
 * and cache full detection uses) and freeze this run's transport. Call it once,
 * right after selecting the def and before anything reads `def.streamFormat`:
 * prompt composition, the execution profile, the stream parser, and the argv.
 */
export async function resolveRuntimeStreamTransport(
  def: RuntimeAgentDef,
  configuredAgentEnv: Record<string, string> = {},
): Promise<RuntimeAgentDef> {
  if (!def.structuredStreamUpgrade) return def;
  let capabilities: RuntimeCapabilityMap | null = null;
  try {
    capabilities = await ensureDetectedRuntimeCapabilities(def.id, configuredAgentEnv);
  } catch {
    // An unanswerable probe keeps the baseline transport every build supports.
  }
  return applyStructuredStreamUpgrade(def, capabilities);
}
