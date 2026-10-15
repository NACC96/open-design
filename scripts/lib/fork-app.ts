// Pure planning logic for the fork-only `scripts/fork-app.ts` tool, which
// manages two side-by-side packaged macOS apps on Noah's fork:
//
// - Stable ("Open Design Fork", channel `fork`, namespace `model-picker"): the
//   day-to-day app, replaced only by an explicit `promote` or `rollback`.
// - Dev ("Open Design Dev", channel `dev`, namespace `fork-dev`): a disposable
//   app that test builds are installed into.
//
// Everything here is side-effect free so e2e/tests/scripts/fork-app.test.ts can
// pin the version and plan rules. The CLI entry owns git, filesystem, and
// process effects. See docs/fork-app-instances.md.

import path from "node:path";

export type ForkInstance = "stable" | "dev";

export const FORK_INSTANCES: readonly ForkInstance[] = ["stable", "dev"];

export type ForkInstanceIdentity = {
  appBundleName: string;
  bundleId: string;
  /** Release channel, carried by the `x.y.z-<channel>.N` version suffix. */
  channel: string;
  instance: ForkInstance;
  label: string;
  namespace: string;
  productName: string;
};

function identityFor(instance: ForkInstance, channel: string, namespace: string, label: string): ForkInstanceIdentity {
  // Mirrors releaseChannelDescriptor() in packages/release: the version's
  // channel decides the bundle identity tools-pack builds.
  const productName = `Open Design ${channel[0]!.toUpperCase()}${channel.slice(1)}`;
  return {
    appBundleName: `${productName}.app`,
    bundleId: `io.open-design.desktop.${channel}`,
    channel,
    instance,
    label,
    namespace,
    productName,
  };
}

const IDENTITIES: Record<ForkInstance, ForkInstanceIdentity> = {
  dev: identityFor("dev", "dev", "fork-dev", "Dev"),
  stable: identityFor("stable", "fork", "model-picker", "Stable"),
};

export function forkInstanceIdentity(instance: ForkInstance): ForkInstanceIdentity {
  return IDENTITIES[instance];
}

export const DEFAULT_PROMOTE_REF = "origin/custom";
export const KEPT_STABLE_COPIES = 3;
export const LAUNCH_TIMEOUT_MS = 120_000;

/** Launch-environment variables that would break the separation between the two apps. */
export const LAUNCH_ENV_OVERRIDES = [
  "ELECTRON_RUN_AS_NODE",
  "OD_DATA_DIR",
  "OD_LEGACY_DATA_DIR",
  "OD_PACKAGED_CONFIG_PATH",
  "OD_PACKAGED_NAMESPACE",
  "OD_PACKAGED_NAMESPACE_BASE_ROOT",
  "OD_UPDATE_ENABLED",
] as const;

/** Variables stripped from every child command (inherited agent/terminal state). */
export const CHILD_ENV_UNSET = ["ELECTRON_RUN_AS_NODE"] as const;

/** Variables stripped from the tools-pack build so nothing machine-local is baked. */
export const BUILD_ENV_UNSET = [
  ...CHILD_ENV_UNSET,
  "OD_DATA_DIR",
  "OD_LEGACY_DATA_DIR",
  "OD_PACKAGED_CONFIG_PATH",
  "OD_PACKAGED_NAMESPACE",
  "OD_PACKAGED_NAMESPACE_BASE_ROOT",
  "OD_UPDATE_METADATA_URL",
] as const;

// ---------------------------------------------------------------------------
// Paths

export type ForkAppsPaths = {
  applicationsDir: string;
  buildWorktree: string;
  home: string;
  keptRoot: string;
  lockPath: string;
  stateDir: string;
  statePath: string;
};

export function resolveForkAppsPaths(home: string): ForkAppsPaths {
  const stateDir = path.join(home, "Library", "Application Support", "open-design-fork-apps");
  return {
    applicationsDir: path.join(home, "Applications"),
    // Outside any repository checkout so Node/TypeScript resolution inside the
    // build cannot walk up into another checkout's node_modules.
    buildWorktree: path.join(home, "Library", "Caches", "open-design-fork-apps", "build-worktree"),
    home,
    keptRoot: path.join(stateDir, "stable-kept"),
    lockPath: path.join(stateDir, "fork-app.lock"),
    stateDir,
    statePath: path.join(stateDir, "state.json"),
  };
}

export function instanceAppPath(paths: ForkAppsPaths, identity: ForkInstanceIdentity): string {
  return path.join(paths.applicationsDir, identity.appBundleName);
}

/** Where the packaged runtime puts namespaces when the config bakes no root (a `--portable` build). */
export function defaultNamespaceBaseRoot(home: string, identity: ForkInstanceIdentity): string {
  return path.join(home, "Library", "Application Support", identity.productName, "namespaces");
}

export function namespaceRootFor(
  home: string,
  identity: ForkInstanceIdentity,
  namespaceBaseRoot: string | null,
): string {
  return path.join(namespaceBaseRoot ?? defaultNamespaceBaseRoot(home, identity), identity.namespace);
}

/** The packaged launcher's runtime pointer for a namespace (apps/packaged launcher-runtime.ts). */
export function launcherRuntimePath(
  home: string,
  identity: ForkInstanceIdentity,
  namespaceBaseRoot: string | null,
): string {
  const installationRoot = path.dirname(namespaceBaseRoot ?? defaultNamespaceBaseRoot(home, identity));
  return path.join(
    installationRoot,
    "launcher",
    "channels",
    identity.channel,
    "namespaces",
    identity.namespace,
    "runtime.json",
  );
}

export function builtAppPath(
  buildWorktree: string,
  identity: ForkInstanceIdentity,
  arch: string,
): string {
  // tools-pack: <dir>/out/mac/namespaces/<ns>/builder/<mac|mac-arm64>/<Product>.app
  return path.join(
    buildWorktree,
    ".tmp",
    "tools-pack",
    "out",
    "mac",
    "namespaces",
    identity.namespace,
    "builder",
    arch === "arm64" ? "mac-arm64" : "mac",
    identity.appBundleName,
  );
}

export function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

// ---------------------------------------------------------------------------
// Versions

type ComparableVersion = { nums: [number, number, number]; pre: string[] };

function numberPart(value: string | undefined): number {
  return value != null && /^[0-9]+$/.test(value) ? Number(value) : 0;
}

// Same parse as parseComparableLauncherVersion in packages/launcher-proto,
// which is what the packaged launcher uses to decide whether a bundle is newer.
function parseComparableVersion(value: string): ComparableVersion {
  const cleaned = value.trim().replace(/^v/i, "").split("+", 1)[0] ?? "";
  const nightly = /^(\d+)\.(\d+)\.(\d+)\.nightly\.(\d+)$/i.exec(cleaned);
  if (nightly?.[1] != null && nightly[2] != null && nightly[3] != null && nightly[4] != null) {
    return { nums: [Number(nightly[1]), Number(nightly[2]), Number(nightly[3])], pre: ["nightly", nightly[4]] };
  }
  const separator = cleaned.indexOf("-");
  const core = separator === -1 ? cleaned : cleaned.slice(0, separator);
  const prerelease = separator === -1 ? "" : cleaned.slice(separator + 1);
  const nums = core.split(".");
  return {
    nums: [numberPart(nums[0]), numberPart(nums[1]), numberPart(nums[2])],
    pre: prerelease.length === 0 ? [] : prerelease.split("."),
  };
}

function compareIdentifier(a: string, b: string): number {
  const aNum = /^[0-9]+$/.test(a) ? Number(a) : null;
  const bNum = /^[0-9]+$/.test(b) ? Number(b) : null;
  if (aNum != null && bNum != null) return Math.sign(aNum - bNum);
  if (aNum != null) return -1;
  if (bNum != null) return 1;
  return a.localeCompare(b);
}

/** Same ordering as compareLauncherVersions in packages/launcher-proto. */
export function compareVersions(a: string, b: string): number {
  const left = parseComparableVersion(a);
  const right = parseComparableVersion(b);
  for (let index = 0; index < 3; index += 1) {
    const delta = left.nums[index]! - right.nums[index]!;
    if (delta !== 0) return Math.sign(delta);
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0;
  if (left.pre.length === 0) return 1;
  if (right.pre.length === 0) return -1;
  const max = Math.max(left.pre.length, right.pre.length);
  for (let index = 0; index < max; index += 1) {
    const l = left.pre[index];
    const r = right.pre[index];
    if (l == null) return -1;
    if (r == null) return 1;
    const delta = compareIdentifier(l, r);
    if (delta !== 0) return delta;
  }
  return 0;
}

export function versionBase(version: string): string | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+.].*)?$/.exec(version.trim());
  return match == null ? null : `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`;
}

function bumpPatch(base: string): string {
  const [major, minor, patch] = base.split(".").map(Number);
  return `${major}.${minor}.${(patch ?? 0) + 1}`;
}

/** UTC `YYYYMMDDHHmm`. */
export function utcBuildStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}`;
}

/**
 * Accepts only versions this tool can ship: `x.y.z-<channel>.N`, where
 * `releaseChannelFromVersion` (packages/release) maps the suffix back to the
 * same channel and N stays within semver's 16-digit numeric identifier limit.
 */
export function assertForkVersion(version: string, channel: string): void {
  const match = /^(\d+)\.(\d+)\.(\d+)-([a-z0-9]{1,12})\.([1-9][0-9]{0,15})$/.exec(version);
  if (match == null || match[4] !== channel) {
    throw new Error(`fork app version must be x.y.z-${channel}.N with N a positive integer: ${version}`);
  }
  if (!Number.isSafeInteger(Number(match[5]))) {
    throw new Error(`fork app build number exceeds a safe integer: ${version}`);
  }
}

export type NextVersionInput = {
  channel: string;
  /** Versions already installed or run anywhere by the fork apps; they only raise the base. */
  floorVersions: readonly string[];
  /** Versions this instance's namespace has installed or run; the result must be newer than all. */
  knownVersions: readonly string[];
  now: Date;
  /** `apps/packaged/package.json` version at the ref being built. */
  repoVersion: string;
};

export type NextVersion = {
  base: string;
  buildNumber: number;
  notes: string[];
  version: string;
};

/**
 * The next version for an instance: `<base>-<channel>.<UTC YYYYMMDDHHmm>`.
 *
 * The packaged launcher only moves a namespace's runtime pointer forward
 * (reconcileRuntimeWithBoundPackage in apps/packaged/src/launcher-runtime.ts),
 * so every install must be strictly newer than anything the namespace has
 * installed or run. The base is the repo's version, raised to the highest base
 * any fork app already uses, so a repo still at 0.23.x never produces a build
 * that sorts below an installed 0.24.1.
 */
export function computeNextVersion(input: NextVersionInput): NextVersion {
  const notes: string[] = [];
  const repoBase = versionBase(input.repoVersion);
  if (repoBase == null) throw new Error(`cannot read a x.y.z base from repo version ${input.repoVersion}`);

  let base = repoBase;
  for (const version of [...input.floorVersions, ...input.knownVersions]) {
    const candidate = versionBase(version);
    if (candidate != null && compareVersions(candidate, base) > 0) base = candidate;
  }
  if (base !== repoBase) notes.push(`base raised from repo ${repoBase} to ${base} (already installed or run)`);

  let buildNumber = Number(utcBuildStamp(input.now));
  let version = `${base}-${input.channel}.${buildNumber}`;
  const newestKnown = input.knownVersions.reduce<string | null>(
    (newest, current) => (newest == null || compareVersions(current, newest) > 0 ? current : newest),
    null,
  );

  if (newestKnown != null && compareVersions(version, newestKnown) <= 0) {
    const sameLine = new RegExp(`^${base.replaceAll(".", "\\.")}-${input.channel}\\.(\\d+)$`).exec(newestKnown);
    if (sameLine?.[1] != null) {
      buildNumber = Number(sameLine[1]) + 1;
      notes.push(`build number bumped past ${newestKnown}`);
    } else {
      base = bumpPatch(base);
      notes.push(`base bumped to ${base} to sort above ${newestKnown}`);
    }
    version = `${base}-${input.channel}.${buildNumber}`;
  }

  assertForkVersion(version, input.channel);
  if (newestKnown != null && compareVersions(version, newestKnown) <= 0) {
    throw new Error(`computed version ${version} is not newer than ${newestKnown}`);
  }
  return { base, buildNumber, notes, version };
}

export function stableTagName(version: string): string {
  return `fork-stable-${version}`;
}

// ---------------------------------------------------------------------------
// Arguments

export type ForkCommand = "dev" | "promote" | "rollback" | "status" | "help";

export type ForkOptions = {
  /** dev: leave Dev as the opendesign:// handler instead of handing it back. */
  claimInviteLinks: boolean;
  dryRun: boolean;
  fetch: boolean;
  json: boolean;
  launch: boolean;
  quitRunning: boolean;
  ref: string | null;
  to: string | null;
  yes: boolean;
};

export type ParsedArgs = { command: ForkCommand; options: ForkOptions };

const COMMAND_FLAGS: Record<Exclude<ForkCommand, "help">, readonly string[]> = {
  dev: ["--ref", "--no-fetch", "--no-launch", "--claim-invite-links", "--dry-run"],
  promote: ["--ref", "--yes", "--quit-running", "--no-fetch", "--no-launch", "--dry-run"],
  rollback: ["--to", "--yes", "--quit-running", "--no-launch", "--dry-run"],
  status: ["--json", "--dry-run"],
};

export function parseForkArgs(argv: readonly string[]): ParsedArgs {
  const options: ForkOptions = {
    claimInviteLinks: false,
    dryRun: false,
    fetch: true,
    json: false,
    launch: true,
    quitRunning: false,
    ref: null,
    to: null,
    yes: false,
  };
  const [first, ...rest] = argv;
  if (first == null || first === "help" || first === "--help" || first === "-h") {
    return { command: "help", options };
  }
  if (!(first in COMMAND_FLAGS)) throw new Error(`unknown command: ${first} (expected dev, promote, rollback, or status)`);
  const command = first as Exclude<ForkCommand, "help">;
  const allowed = COMMAND_FLAGS[command];

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (arg === "--help" || arg === "-h") return { command: "help", options };
    const [flag, inlineValue] = arg.startsWith("--") && arg.includes("=")
      ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
      : [arg, undefined];
    if (!allowed.includes(flag)) throw new Error(`${command} does not accept ${arg}`);
    const takeValue = (): string => {
      const value = inlineValue ?? rest[++index];
      if (value == null || value.length === 0 || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      return value;
    };
    switch (flag) {
      case "--ref": options.ref = takeValue(); break;
      case "--to": options.to = takeValue(); break;
      case "--yes": options.yes = true; break;
      case "--quit-running": options.quitRunning = true; break;
      case "--no-fetch": options.fetch = false; break;
      case "--no-launch": options.launch = false; break;
      case "--claim-invite-links": options.claimInviteLinks = true; break;
      case "--dry-run": options.dryRun = true; break;
      case "--json": options.json = true; break;
    }
  }
  return { command, options };
}

// ---------------------------------------------------------------------------
// Processes

export type ProcessEntry = { command: string; pid: number; ppid: number };

export type InstanceProcess = ProcessEntry & { role: string | null };

/** Parses `ps -axww -o pid=,ppid=,command=`. */
export function parsePsOutput(output: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match == null) continue;
    entries.push({ command: match[3]!, pid: Number(match[1]), ppid: Number(match[2]) });
  }
  return entries;
}

/**
 * Processes that belong to one installed app: anything executing from inside
 * its bundle, anything carrying its exact channel + namespace sidecar stamp,
 * and their descendants (for example the web sidecar's next-server child).
 */
export function findInstanceProcesses(
  processes: readonly ProcessEntry[],
  identity: ForkInstanceIdentity,
  appPath: string,
): InstanceProcess[] {
  const bundlePrefix = `${appPath}/Contents/`;
  const channelFlag = `--od-stamp-channel=${identity.channel}`;
  const namespaceFlag = `--od-stamp-namespace=${identity.namespace}`;
  const matched = new Set<number>();
  for (const entry of processes) {
    const args = entry.command.split(/\s+/);
    const stamped = args.includes(channelFlag) && args.includes(namespaceFlag);
    if (entry.command.startsWith(bundlePrefix) || stamped) matched.add(entry.pid);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const entry of processes) {
      if (!matched.has(entry.pid) && matched.has(entry.ppid)) {
        matched.add(entry.pid);
        grew = true;
      }
    }
  }
  return processes
    .filter((entry) => matched.has(entry.pid))
    .map((entry) => ({ ...entry, role: /--od-stamp-app=([a-z]+)/.exec(entry.command)?.[1] ?? null }));
}

export function hasLaunched(processes: readonly InstanceProcess[]): boolean {
  const roles = new Set(processes.map((entry) => entry.role));
  return roles.has("desktop") && roles.has("daemon") && roles.has("web");
}

// ---------------------------------------------------------------------------
// State

export type InstallRecord = {
  commit: string | null;
  installedAt: string;
  ref: string | null;
  source: "dev" | "promote" | "rollback";
  version: string;
};

export type ForkAppsState = {
  instances: Record<ForkInstance, InstallRecord[]>;
  schemaVersion: 1;
};

export function emptyState(): ForkAppsState {
  return { instances: { dev: [], stable: [] }, schemaVersion: 1 };
}

export function normalizeState(raw: unknown): ForkAppsState {
  if (raw == null || typeof raw !== "object") return emptyState();
  const instances = (raw as { instances?: Partial<Record<ForkInstance, unknown>> }).instances ?? {};
  const records = (value: unknown): InstallRecord[] =>
    Array.isArray(value)
      ? value.filter((entry): entry is InstallRecord =>
          entry != null && typeof entry === "object" && typeof (entry as InstallRecord).version === "string")
      : [];
  return { instances: { dev: records(instances.dev), stable: records(instances.stable) }, schemaVersion: 1 };
}

export function withInstallRecord(state: ForkAppsState, instance: ForkInstance, record: InstallRecord): ForkAppsState {
  const history = [record, ...state.instances[instance].filter((entry) => entry.version !== record.version)].slice(0, 25);
  return { ...state, instances: { ...state.instances, [instance]: history } };
}

export function findInstallRecord(state: ForkAppsState, instance: ForkInstance, version: string | null): InstallRecord | null {
  if (version == null) return null;
  return state.instances[instance].find((entry) => entry.version === version) ?? null;
}

export type KeptCopy = {
  appPath: string;
  commit: string | null;
  dir: string;
  keptAt: string;
  version: string;
};

/** The default rollback target: the most recently kept copy that is not the installed version. */
export function selectRollbackTarget(
  kept: readonly KeptCopy[],
  installedVersion: string | null,
  requested: string | null,
): KeptCopy | null {
  if (requested != null) return kept.find((entry) => entry.version === requested) ?? null;
  return [...kept]
    .filter((entry) => entry.version !== installedVersion)
    .sort((a, b) => b.keptAt.localeCompare(a.keptAt))[0] ?? null;
}

/** Kept copies beyond the newest `retain`, never including `protect` (the version just restored). */
export function keptCopiesToPrune(kept: readonly KeptCopy[], retain: number, protect: readonly string[]): KeptCopy[] {
  return [...kept]
    .sort((a, b) => b.keptAt.localeCompare(a.keptAt))
    .slice(retain)
    .filter((entry) => !protect.includes(entry.version));
}

// ---------------------------------------------------------------------------
// Plans

export type InstalledApp = {
  bundleId: string | null;
  namespace: string | null;
  namespaceBaseRoot: string | null;
  updateEnabled: boolean | null;
  version: string | null;
};

export type RunStep = {
  argv: string[];
  cwd: string;
  /** `null` unsets the variable for the child. */
  env?: Record<string, string | null>;
  kind: "run";
  label: string;
};

export type InternalAction =
  | { type: "assert-not-running" }
  | { type: "assert-worktree-head"; commit: string }
  | { appPath: string; expect: ExpectedApp; type: "verify-app" }
  | { appPath: string; namespaceBaseRoot: string; type: "bake-namespace-base-root" }
  | { appPath: string; type: 'disable-updates' }
  | { type: 'assert-launcher-version'; version: string; namespaceBaseRoot: string | null }
  | { dir: string; meta: Omit<KeptCopy, "appPath" | "dir">; type: "write-kept-meta" }
  | { record: InstallRecord; type: "record-state" }
  | { protect: string[]; type: "prune-kept" }
  | { type: "wait-for-launch" }
  | { type: "remember-invite-handler" }
  | { type: "restore-invite-handler" };

export type InternalStep = { action: InternalAction; kind: "internal"; label: string };

export type PlanStep = RunStep | InternalStep;

export type ExpectedApp = {
  bundleId: string;
  namespace: string;
  /** `null` asserts the config bakes no root (portable). */
  namespaceBaseRoot: string | null;
  updateEnabled: boolean | null;
  version: string;
};

export type BuildPlanInput = {
  arch: string;
  commit: string;
  identity: ForkInstanceIdentity;
  installed: InstalledApp | null;
  /** Commit recorded for the installed version, if this tool installed it. */
  installedCommit: string | null;
  /** Versions that already have a kept copy (stable only). */
  keptVersions: readonly string[];
  launch: boolean;
  paths: ForkAppsPaths;
  quitRunning: boolean;
  ref: string;
  repoRoot: string;
  /**
   * Dev only: hand the opendesign:// scheme back to whichever app owned it
   * before the launch, because every launch re-claims it.
   */
  restoreInviteHandler: boolean;
  running: boolean;
  version: string;
  worktreeExists: boolean;
};

const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

function run(label: string, cwd: string, argv: string[], env?: Record<string, string | null>): RunStep {
  return env == null ? { argv, cwd, kind: "run", label } : { argv, cwd, env, kind: "run", label };
}

function internal(label: string, action: InternalAction): InternalStep {
  return { action, kind: "internal", label };
}

function unsetEnv(names: readonly string[]): Record<string, null> {
  return Object.fromEntries(names.map((name) => [name, null]));
}

export function stagingDir(paths: ForkAppsPaths, identity: ForkInstanceIdentity): string {
  return path.join(paths.applicationsDir, `.fork-app-staging-${identity.instance}`);
}

export function replacedDir(paths: ForkAppsPaths, identity: ForkInstanceIdentity): string {
  return path.join(paths.applicationsDir, `.fork-app-replaced-${identity.instance}`);
}

function installSteps(
  paths: ForkAppsPaths,
  identity: ForkInstanceIdentity,
  sourceAppPath: string,
  hasInstalled: boolean,
  stagedSteps: readonly PlanStep[] = [],
): PlanStep[] {
  const appPath = instanceAppPath(paths, identity);
  const staging = stagingDir(paths, identity);
  const replaced = replacedDir(paths, identity);
  const stagedApp = path.join(staging, identity.appBundleName);
  return [
    run("clear leftover staging", paths.home, ["rm", "-rf", staging, replaced]),
    run("stage the new bundle next to the install location", paths.home, ["ditto", sourceAppPath, stagedApp]),
    ...stagedSteps,
    ...(hasInstalled
      ? [run("move the installed bundle aside", paths.home, ["mkdir", "-p", replaced]),
        run("move the installed bundle aside", paths.home, ["mv", appPath, path.join(replaced, identity.appBundleName)])]
      : []),
    run("move the staged bundle into place", paths.home, ["mv", stagedApp, appPath]),
    run("remove staging leftovers", paths.home, ["rm", "-rf", staging, replaced]),
    run("register the bundle with LaunchServices", paths.home, [LSREGISTER, "-f", appPath]),
  ];
}

function keepSteps(
  paths: ForkAppsPaths,
  identity: ForkInstanceIdentity,
  installedVersion: string,
  installedCommit: string | null,
  keptVersions: readonly string[],
  why: string,
): PlanStep[] {
  // A version is only ever built once, so an existing kept copy of it is the
  // same bundle; copying it again would only cost a gigabyte of I/O.
  if (keptVersions.includes(installedVersion)) return [];
  const keepDir = path.join(paths.keptRoot, installedVersion);
  return [
    run(`keep the current stable ${installedVersion} ${why}`, paths.home, ["mkdir", "-p", keepDir]),
    run(`keep the current stable ${installedVersion} ${why}`, paths.home, [
      "ditto", instanceAppPath(paths, identity), path.join(keepDir, identity.appBundleName),
    ]),
    internal("record the kept copy", {
      dir: keepDir,
      meta: { commit: installedCommit, keptAt: "", version: installedVersion },
      type: "write-kept-meta",
    }),
  ];
}

function quitSteps(input: BuildPlanInput, worktree: string): PlanStep[] {
  const { identity } = input;
  // Dev is disposable and always stopped. Stable is only stopped on an explicit
  // --quit-running; otherwise the plan asserts the user already quit it.
  const stop = identity.instance === "dev" || (input.running && input.quitRunning);
  return [
    ...(stop
      ? [run(
        `stop running ${identity.productName} (exact channel=${identity.channel} namespace=${identity.namespace} stamps)`,
        worktree,
        ["pnpm", "tools-pack", "mac", "stop", "--namespace", identity.namespace, "--app-version", input.version, "--json"],
        unsetEnv(CHILD_ENV_UNSET),
      )]
      : []),
    internal(`confirm ${identity.productName} is not running`, { type: "assert-not-running" }),
  ];
}

/** The ordered build + install plan shared by `dev` and `promote`. */
export function buildInstallPlan(input: BuildPlanInput): PlanStep[] {
  const { identity, paths } = input;
  const worktree = paths.buildWorktree;
  const appPath = instanceAppPath(paths, identity);
  const builtApp = builtAppPath(worktree, identity, input.arch);
  const stable = identity.instance === "stable";
  // Stable keeps the namespace root its installed bundle already uses, so the
  // existing library keeps working. Dev is portable: the packaged runtime
  // derives its root from Dev's own app identity.
  const carriedBaseRoot = stable ? input.installed?.namespaceBaseRoot ?? null : null;
  const expect: ExpectedApp = {
    bundleId: identity.bundleId,
    namespace: identity.namespace,
    namespaceBaseRoot: carriedBaseRoot,
    updateEnabled: false,
    version: input.version,
  };
  const steps: PlanStep[] = [];

  if (input.worktreeExists) {
    steps.push(
      run("check out the requested commit in the build worktree", worktree, ["git", "checkout", "--detach", "--force", input.commit]),
      run("drop untracked files (ignored build caches stay)", worktree, ["git", "clean", "-fd"]),
    );
  } else {
    steps.push(
      run("forget build worktrees whose directory is gone", input.repoRoot, ["git", "worktree", "prune"]),
      run("create the persistent build worktree", input.repoRoot, ["git", "worktree", "add", "--detach", worktree, input.commit]),
    );
  }
  steps.push(
    internal(`confirm the build worktree is at ${input.commit}`, { commit: input.commit, type: "assert-worktree-head" }),
    run("install dependencies", worktree, ["pnpm", "install", "--frozen-lockfile", "--config.confirmModulesPurge=false"], unsetEnv(CHILD_ENV_UNSET)),
    run("build tools-pack", worktree, ["pnpm", "--filter", "@open-design/tools-pack", "build"], unsetEnv(CHILD_ENV_UNSET)),
    run(
      `build ${identity.productName} ${input.version}`,
      worktree,
      [
        "pnpm", "tools-pack", "mac", "build",
        "--namespace", identity.namespace,
        "--app-version", input.version,
        "--portable",
        "--to", "app",
        "--json",
      ],
      { ...unsetEnv(BUILD_ENV_UNSET), OD_UPDATE_ENABLED: "0" },
    ),
    internal("verify the built bundle", {
      appPath: builtApp,
      expect: { ...expect, namespaceBaseRoot: null },
      type: "verify-app",
    }),
  );
  if (carriedBaseRoot != null) {
    steps.push(
      internal(`bake namespaceBaseRoot=${carriedBaseRoot} (carried over from the installed app)`, {
        appPath: builtApp,
        namespaceBaseRoot: carriedBaseRoot,
        type: "bake-namespace-base-root",
      }),
      run("re-seal the ad-hoc signature after the config change", worktree, [
        "codesign", "--force", "--sign", "-", "--timestamp=none", builtApp,
      ]),
    );
  }
  steps.push(
    run("verify the bundle signature", worktree, ["codesign", "--verify", "--deep", "--strict", builtApp]),
    ...quitSteps(input, worktree),
  );

  const installedVersion = input.installed?.version ?? null;
  if (stable && installedVersion != null) {
    steps.push(...keepSteps(paths, identity, installedVersion, input.installedCommit, input.keptVersions, "for rollback"));
  }

  steps.push(
    ...installSteps(paths, identity, builtApp, input.installed != null),
    internal("verify the installed bundle", { appPath, expect, type: "verify-app" }),
    internal("record the install", {
      record: {
        commit: input.commit,
        installedAt: "",
        ref: input.ref,
        source: stable ? "promote" : "dev",
        version: input.version,
      },
      type: "record-state",
    }),
  );
  if (stable) {
    steps.push(
      run("tag the promoted commit (local only)", input.repoRoot, [
        "git", "tag", "-a", stableTagName(input.version), "-m",
        `Open Design Fork stable ${input.version} (from ${input.ref})`, input.commit,
      ]),
      internal(`prune kept stable copies beyond the newest ${KEPT_STABLE_COPIES}`, { protect: [], type: "prune-kept" }),
    );
  }
  if (input.launch) {
    const restore = !stable && input.restoreInviteHandler;
    steps.push(
      ...(restore ? [internal("remember the current opendesign:// handler", { type: "remember-invite-handler" })] : []),
      run(`launch ${identity.productName}`, paths.home, ["open", appPath]),
      internal(`wait for desktop, daemon and web (up to ${LAUNCH_TIMEOUT_MS / 1000}s)`, { type: "wait-for-launch" }),
      ...(restore ? [internal("hand opendesign:// back to the previous handler", { type: "restore-invite-handler" })] : []),
    );
  }
  return steps;
}

export type RollbackPlanInput = {
  identity: ForkInstanceIdentity;
  installed: InstalledApp | null;
  installedCommit: string | null;
  keptVersions: readonly string[];
  launch: boolean;
  paths: ForkAppsPaths;
  quitRunning: boolean;
  running: boolean;
  target: KeptCopy;
  targetApp: InstalledApp;
  toolsPackAvailable: boolean;
};

export function buildRollbackPlan(input: RollbackPlanInput): PlanStep[] {
  const { identity, paths, target } = input;
  if (identity.instance !== "stable") throw new Error("rollback only applies to the stable app");
  const appPath = instanceAppPath(paths, identity);
  const installedVersion = input.installed?.version ?? null;
  const namespaceBaseRoot = input.installed != null
    ? input.installed.namespaceBaseRoot
    : input.targetApp.namespaceBaseRoot;
  const expect = {
    bundleId: identity.bundleId,
    namespace: identity.namespace,
    namespaceBaseRoot,
    version: target.version,
  };
  const steps: PlanStep[] = [
    internal("verify the kept copy", {
      appPath: target.appPath,
      expect: {
        ...expect,
        updateEnabled: input.targetApp.updateEnabled,
      },
      type: "verify-app",
    }),
  ];
  if (input.running && input.quitRunning) {
    if (!input.toolsPackAvailable) {
      throw new Error("--quit-running needs the build worktree's tools-pack; quit Open Design Fork manually instead");
    }
    steps.push(run(
      `stop running ${identity.productName} (exact channel=${identity.channel} namespace=${identity.namespace} stamps)`,
      paths.buildWorktree,
      ["pnpm", "tools-pack", "mac", "stop", "--namespace", identity.namespace, "--app-version", target.version, "--json"],
      unsetEnv(CHILD_ENV_UNSET),
    ));
  }
  steps.push(internal(`confirm ${identity.productName} is not running`, { type: "assert-not-running" }));
  steps.push(internal('refuse rollback if a newer launcher payload would override it', {
    type: 'assert-launcher-version', version: target.version, namespaceBaseRoot,
  }));
  if (installedVersion != null) {
    steps.push(...keepSteps(
      paths,
      identity,
      installedVersion,
      input.installedCommit,
      input.keptVersions,
      "so the rollback can be undone",
    ));
  }
  steps.push(
    ...installSteps(paths, identity, target.appPath, input.installed != null,
      input.targetApp.updateEnabled === false ? [] : [
        internal('disable updates on the staged restore without changing the kept copy', {
          type: 'disable-updates', appPath: path.join(stagingDir(paths, identity), identity.appBundleName),
        }),
        run('re-seal the staged restore after disabling updates', paths.home, [
          'codesign', '--force', '--sign', '-', '--timestamp=none', path.join(stagingDir(paths, identity), identity.appBundleName),
        ]),
        run('verify the staged restore signature', paths.home, [
          'codesign', '--verify', '--deep', '--strict', path.join(stagingDir(paths, identity), identity.appBundleName),
        ]),
      ]),
    internal("verify the installed bundle", {
      appPath,
      expect: {
        ...expect,
        updateEnabled: false,
      },
      type: "verify-app",
    }),
    internal("record the rollback", {
      record: { commit: target.commit, installedAt: "", ref: null, source: "rollback", version: target.version },
      type: "record-state",
    }),
    internal(`prune kept stable copies beyond the newest ${KEPT_STABLE_COPIES}`, {
      protect: [target.version],
      type: "prune-kept",
    }),
  );
  if (input.launch) {
    steps.push(
      run(`launch ${identity.productName}`, paths.home, ["open", appPath]),
      internal(`wait for desktop, daemon and web (up to ${LAUNCH_TIMEOUT_MS / 1000}s)`, { type: "wait-for-launch" }),
    );
  }
  return steps;
}

/**
 * Paths a plan may delete or overwrite. The CLI refuses to run any `rm`, `mv`
 * or `ditto` whose target is outside these roots.
 */
export function mutableRoots(paths: ForkAppsPaths, identity: ForkInstanceIdentity): string[] {
  return [
    stagingDir(paths, identity),
    replacedDir(paths, identity),
    instanceAppPath(paths, identity),
    ...(identity.instance === "stable" ? [paths.keptRoot] : []),
  ];
}

/** Paths a filesystem command deletes or writes; a `ditto`/`cp` source is only read. */
export function mutationTargets(argv: readonly string[]): string[] {
  const [command, ...args] = argv;
  const operands = args.filter((arg) => !arg.startsWith("-"));
  switch (command) {
    case "rm":
    case "mv":
    case "mkdir":
      return operands;
    case "ditto":
      return operands.slice(-1);
    default:
      return [];
  }
}

/**
 * Throws when a Dev plan would touch anything that belongs to Stable: its
 * bundle, its namespace, its kept copies, or its tag namespace.
 */
export function assertDevPlanIsolated(plan: readonly PlanStep[], paths: ForkAppsPaths): void {
  const stable = forkInstanceIdentity("stable");
  const stableApp = instanceAppPath(paths, stable);
  for (const step of plan) {
    const values = step.kind === "run"
      ? step.argv
      : Object.values(step.action).filter((value): value is string => typeof value === "string");
    for (const value of values) {
      if (value === stableApp || isPathInside(stableApp, value) || value === paths.keptRoot || isPathInside(paths.keptRoot, value)) {
        throw new Error(`dev plan step "${step.label}" touches the stable app: ${value}`);
      }
      if (value === stable.namespace || value.startsWith("fork-stable-")) {
        throw new Error(`dev plan step "${step.label}" references stable identity: ${value}`);
      }
    }
    if (step.kind === "internal" && step.action.type === "verify-app" && step.action.expect.namespace !== forkInstanceIdentity("dev").namespace) {
      throw new Error(`dev plan verifies a non-dev namespace: ${step.action.expect.namespace}`);
    }
  }
}

export function isAllowedMutationTarget(paths: ForkAppsPaths, identity: ForkInstanceIdentity, target: string): boolean {
  const resolved = path.resolve(target);
  return mutableRoots(paths, identity).some((root) => resolved === path.resolve(root) || isPathInside(root, resolved));
}

export function formatCommand(argv: readonly string[]): string {
  return argv.map((part) => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`)).join(" ");
}

export function formatEnv(env: Record<string, string | null> | undefined): string {
  if (env == null) return "";
  const entries = Object.entries(env);
  const unset = entries.filter(([, value]) => value == null).map(([name]) => `-u ${name}`);
  const set = entries.filter(([, value]) => value != null).map(([name, value]) => `${name}=${formatCommand([value!])}`);
  return [...(unset.length > 0 ? ["env", ...unset] : []), ...set].join(" ");
}
