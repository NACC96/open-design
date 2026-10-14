import {
  isReleaseChannelNamespace,
  releaseChannelFromNamespace,
  type ReleaseChannel,
} from "@open-design/release";
import { SIDECAR_DEFAULTS } from "@open-design/sidecar-proto";

import type { ToolPackConfig } from "../config/index.js";

export type BakedUpdaterPolicy = { updateEnabled: false };

/**
 * The release channel an explicit `release-<channel>[-<platform>]` namespace
 * belongs to, or null for any other namespace. Release workflows always build
 * with `releaseNamespace(channel, platform)`, so this is what identifies an
 * official release build. The plain default namespace is deliberately NOT a
 * release namespace here even though `releaseChannelFromNamespace` maps it to
 * stable for install identity: forks commonly build with it.
 */
export function officialReleaseChannelForNamespace(namespace: string): ReleaseChannel | null {
  const channel = releaseChannelFromNamespace(namespace, SIDECAR_DEFAULTS.namespace);
  return channel != null && isReleaseChannelNamespace(namespace, channel) ? channel : null;
}

/**
 * The updater policy a package bakes into open-design-config.json.
 *
 * Only an explicit opt-out is baked; `updateEnabled: true` and unset both
 * return null so the packaged default (updater on) stays byte-identical.
 *
 * The build switch shares its name with the runtime switch
 * (`OD_UPDATE_ENABLED`), so a job-level `OD_UPDATE_ENABLED=0` meant for a
 * smoke run could otherwise ship an official release that never updates.
 * Baking the opt-out into an official release namespace therefore throws.
 */
export function resolveBakedUpdaterPolicy(
  config: Pick<ToolPackConfig, "namespace" | "updateEnabled">,
): BakedUpdaterPolicy | null {
  if (config.updateEnabled !== false) return null;
  const releaseChannel = officialReleaseChannelForNamespace(config.namespace);
  if (releaseChannel != null) {
    throw new Error(
      `refusing to bake the updater opt-out (OD_UPDATE_ENABLED is 0/false/no) into official ${releaseChannel} ` +
        `release namespace "${config.namespace}"; release packages must keep the updater. Unset ` +
        `OD_UPDATE_ENABLED for this build, or build the fork under a non-release namespace.`,
    );
  }
  return { updateEnabled: false };
}
