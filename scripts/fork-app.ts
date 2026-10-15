// Fork-only: build, install, and inspect the two side-by-side packaged macOS
// apps on Noah's fork. "Open Design Fork" (Stable) is replaced only by an
// explicit `promote` or `rollback`; "Open Design Dev" takes test builds.
//
//   node scripts/fork-app.ts status [--json]
//   node scripts/fork-app.ts dev [--ref <git-ref>] [--no-fetch] [--no-launch] [--dry-run]
//   node scripts/fork-app.ts promote [--ref <git-ref>] [--yes] [--quit-running] [--no-fetch] [--no-launch] [--dry-run]
//   node scripts/fork-app.ts rollback [--to <version>] [--yes] [--quit-running] [--no-launch] [--dry-run]
//
// See docs/fork-app-instances.md. Pure planning rules live in
// scripts/lib/fork-app.ts and are covered by e2e/tests/scripts/fork-app.test.ts.

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from "node:url";

import {
  assertDevPlanIsolated,
  CHILD_ENV_UNSET,
  computeNextVersion,
  compareVersions,
  DEFAULT_PROMOTE_REF,
  defaultNamespaceBaseRoot,
  emptyState,
  findInstallRecord,
  findInstanceProcesses,
  forkInstanceIdentity,
  FORK_INSTANCES,
  formatCommand,
  formatEnv,
  hasLaunched,
  instanceAppPath,
  isAllowedMutationTarget,
  isPathInside,
  KEPT_STABLE_COPIES,
  keptCopiesToPrune,
  LAUNCH_ENV_OVERRIDES,
  LAUNCH_TIMEOUT_MS,
  launcherRuntimePath,
  mutationTargets,
  namespaceRootFor,
  normalizeState,
  parseForkArgs,
  parsePsOutput,
  resolveForkAppsPaths,
  selectRollbackTarget,
  stableTagName,
  withInstallRecord,
  buildInstallPlan,
  buildRollbackPlan,
} from "./lib/fork-app.ts";
import type {
  ExpectedApp,
  ForkAppsPaths,
  ForkAppsState,
  ForkInstanceIdentity,
  ForkOptions,
  InstalledApp,
  InstanceProcess,
  InternalAction,
  KeptCopy,
  PlanStep,
  RunStep,
} from "./lib/fork-app.ts";

class ForkAppError extends Error {}

export { readState, writeState, withLock, executePlan, runInternal };

/**
 * The home directory every app, state, and namespace path derives from.
 * FORK_APP_HOME points it at a throwaway fixture so `rollback --dry-run` and
 * friends can be rehearsed without the real apps; leave it unset otherwise.
 */
function forkHome(): string {
  const override = process.env.FORK_APP_HOME?.trim();
  return override != null && override.length > 0 ? path.resolve(override) : homedir();
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const childPath = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`;

const HELP = `fork-app — manage the fork's two packaged macOS apps

  Stable  "Open Design Fork"  namespace model-picker  (replaced only by promote/rollback)
  Dev     "Open Design Dev"   namespace fork-dev      (rebuilt on request for testing)

Commands
  status   [--json]                    show both apps: version, source commit, namespace, running state
  dev      [--ref <git-ref>]           build <ref> (default: this checkout's HEAD) into Dev, install, launch
  promote  [--ref <git-ref>] --yes     build <ref> (default: ${DEFAULT_PROMOTE_REF}) into Stable, keep the
                                       previous Stable for rollback, tag the commit locally, relaunch
  rollback [--to <version>] --yes      reinstall the most recent (or the given) kept Stable copy

Options
  --dry-run        print the plan and every command without building or installing
  --no-fetch       skip "git fetch origin" before resolving --ref
  --no-launch      install without launching
  --claim-invite-links
                   dev: leave Dev as the opendesign:// handler (default: hand it back afterwards)
  --quit-running   promote/rollback: stop a running Stable through tools-pack's exact-stamp stop
                   (default: refuse and ask you to quit it)

Run with Node 24 (see .nvmrc). Docs: docs/fork-app-instances.md`;

// ---------------------------------------------------------------------------
// Output and commands

function say(message = ""): void {
  process.stdout.write(`${message}\n`);
}

function echoCommand(argv: readonly string[], cwd: string, env?: Record<string, string | null>, prefix = "$"): void {
  const where = path.resolve(cwd) === repoRoot ? "" : `(cd ${formatCommand([cwd])}) `;
  const envText = formatEnv(env);
  process.stderr.write(`${prefix} ${where}${envText.length > 0 ? `${envText} ` : ""}${formatCommand(argv)}\n`);
}

function childEnv(overrides?: Record<string, string | null>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: childPath };
  for (const name of CHILD_ENV_UNSET) delete env[name];
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (value == null) delete env[name];
    else env[name] = value;
  }
  return env;
}

/** Runs a read-only probe and returns trimmed stdout. Echoed like every other command. */
function probe(argv: string[], cwd = repoRoot, options: { allowFailure?: boolean; quiet?: boolean } = {}): string | null {
  if (options.quiet !== true) echoCommand(argv, cwd);
  const result = spawnSync(argv[0]!, argv.slice(1), {
    cwd,
    encoding: "utf8",
    env: childEnv(),
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error != null) throw new ForkAppError(`${argv[0]} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    if (options.allowFailure === true) return null;
    throw new ForkAppError(`command failed (exit ${result.status}): ${formatCommand(argv)}\n${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

async function runCommand(argv: string[], cwd: string, env?: Record<string, string | null>, signal?: AbortSignal): Promise<void> {
  echoCommand(argv, cwd, env);
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env: childEnv(env), stdio: "inherit", signal });
    let failure: Error | undefined;
    child.once('error', (error) => { failure = error; });
    child.once('close', (code, exitSignal) => {
      if (failure) rejectRun(failure);
      else if (code === 0) resolveRun();
      else rejectRun(new ForkAppError(`command failed (${exitSignal ?? `exit ${code}`}): ${formatCommand(argv)}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Observation

function preflight(): void {
  if (process.platform !== "darwin") throw new ForkAppError("fork-app manages macOS apps; run it on macOS");
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 24) {
    throw new ForkAppError(`Node ${process.versions.node} is too old; use Node 24 (nvm use) so the build matches the repo engines`);
  }
  // `open` launches apps with launchd's environment. Any of these there would
  // override the baked namespace/data root or updater opt-out of both apps.
  const leaked = LAUNCH_ENV_OVERRIDES.filter((name) => (probe(["launchctl", "getenv", name], repoRoot, { allowFailure: true }) ?? "").length > 0);
  if (leaked.length > 0) {
    throw new ForkAppError(`launchd environment sets ${leaked.join(", ")}; unset it (launchctl unsetenv <name>) so the apps keep their own namespaces`);
  }
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}

function plistValue(appPath: string, key: string): string | null {
  return probe(["plutil", "-extract", key, "raw", "-o", "-", path.join(appPath, "Contents", "Info.plist")], repoRoot, {
    allowFailure: true,
  });
}

async function readInstalledApp(appPath: string): Promise<InstalledApp | null> {
  if (!existsSync(appPath)) return null;
  const configPath = path.join(appPath, "Contents", "Resources", "open-design-config.json");
  const config = existsSync(configPath) ? await readJson(configPath) as Record<string, unknown> : {};
  const text = (key: string) => (typeof config[key] === "string" ? config[key] as string : null);
  return {
    bundleId: plistValue(appPath, "CFBundleIdentifier"),
    namespace: text("namespace"),
    namespaceBaseRoot: text("namespaceBaseRoot"),
    updateEnabled: typeof config.updateEnabled === "boolean" ? config.updateEnabled : null,
    version: text("appVersion") ?? plistValue(appPath, "CFBundleShortVersionString"),
  };
}

function assertOwnedApp(identity: ForkInstanceIdentity, appPath: string, installed: InstalledApp | null): void {
  if (installed == null) return;
  if (installed.bundleId !== identity.bundleId) {
    throw new ForkAppError(`${appPath} has bundle id ${installed.bundleId ?? "(none)"}, expected ${identity.bundleId}; refusing to replace it`);
  }
  if (installed.namespace != null && installed.namespace !== identity.namespace) {
    throw new ForkAppError(`${appPath} runs namespace ${installed.namespace}, expected ${identity.namespace}; refusing to replace it`);
  }
}

async function readLauncherVersions(identity: ForkInstanceIdentity, installed: Pick<InstalledApp, 'namespaceBaseRoot'> | null, home = forkHome()): Promise<string[]> {
  const runtimePath = launcherRuntimePath(home, identity, installed?.namespaceBaseRoot ?? null);
  if (!existsSync(runtimePath)) return [];
  const runtime = await readJson(runtimePath) as Record<string, { version?: unknown } | undefined>;
  return [runtime.active?.version, runtime.lastSuccessful?.version].filter((value): value is string => typeof value === "string");
}

function instanceProcesses(identity: ForkInstanceIdentity, appPath: string, quiet = false): InstanceProcess[] {
  const output = probe(["ps", "-axww", "-o", "pid=,ppid=,command="], repoRoot, { quiet }) ?? "";
  return findInstanceProcesses(parsePsOutput(output), identity, appPath);
}

/** Processes that make an instance "running"; a lingering crash reporter is not one. */
function liveProcesses(processes: readonly InstanceProcess[]): InstanceProcess[] {
  return processes.filter((entry) => !entry.command.includes("chrome_crashpad_handler"));
}

async function readState(paths: ForkAppsPaths): Promise<ForkAppsState> {
  try {
    return existsSync(paths.statePath) ? normalizeState(await readJson(paths.statePath)) : emptyState();
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const backup = `${paths.statePath}.backup`;
    if (existsSync(backup)) {
      const restored = normalizeState(await readJson(backup));
      process.stderr.write(`fork-app: recovering install history from ${backup}; current state JSON is incomplete\n`);
      return restored;
    }
    throw new ForkAppError(`invalid JSON in ${paths.statePath}; inspect it and restore a valid state backup before continuing`);
  }
}

async function writeAtomicJson(file: string, text: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function writeState(paths: ForkAppsPaths, state: ForkAppsState): Promise<void> {
  await mkdir(paths.stateDir, { recursive: true });
  process.stderr.write(`$ write ${paths.statePath}\n`);
  let previous: string | undefined;
  try {
    previous = await readFile(paths.statePath, 'utf8');
    JSON.parse(previous);
  } catch (error) {
    if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    previous = undefined;
  }
  if (previous !== undefined) await writeAtomicJson(`${paths.statePath}.backup`, previous);
  await writeAtomicJson(paths.statePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function listKeptCopies(paths: ForkAppsPaths): Promise<KeptCopy[]> {
  if (!existsSync(paths.keptRoot)) return [];
  const stable = forkInstanceIdentity("stable");
  const copies: KeptCopy[] = [];
  for (const entry of await readdir(paths.keptRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(paths.keptRoot, entry.name);
    const appPath = path.join(dir, stable.appBundleName);
    if (!existsSync(appPath)) continue;
    const meta = existsSync(path.join(dir, "kept.json"))
      ? await readJson(path.join(dir, "kept.json")) as Partial<KeptCopy>
      : {};
    copies.push({
      appPath,
      commit: typeof meta.commit === "string" ? meta.commit : null,
      dir,
      keptAt: typeof meta.keptAt === "string" ? meta.keptAt : "",
      version: typeof meta.version === "string" ? meta.version : entry.name,
    });
  }
  return copies.sort((a, b) => b.keptAt.localeCompare(a.keptAt));
}

type WorktreeState = { exists: boolean; head: string | null };

function inspectBuildWorktree(paths: ForkAppsPaths): WorktreeState {
  if (!existsSync(paths.buildWorktree)) return { exists: false, head: null };
  const listed = (probe(["git", "worktree", "list", "--porcelain"]) ?? "")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
  const target = realpathSync(paths.buildWorktree);
  if (!listed.some((entry) => existsSync(entry) && realpathSync(entry) === target)) {
    throw new ForkAppError(`${paths.buildWorktree} exists but is not a worktree of ${repoRoot}; move it aside first`);
  }
  return { exists: true, head: probe(["git", "rev-parse", "HEAD"], paths.buildWorktree) };
}

function resolveCommit(ref: string): string {
  const commit = probe(["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repoRoot, { allowFailure: true });
  if (commit == null || commit.length === 0) throw new ForkAppError(`cannot resolve git ref ${ref}`);
  return commit;
}

async function repoVersionAt(commit: string): Promise<string> {
  const raw = probe(["git", "show", `${commit}:apps/packaged/package.json`]) ?? "";
  const version = (JSON.parse(raw) as { version?: unknown }).version;
  if (typeof version !== "string") throw new ForkAppError(`apps/packaged/package.json at ${commit} has no version`);
  return version;
}

async function fetchOrigin(options: ForkOptions): Promise<void> {
  if (!options.fetch) return;
  if (options.dryRun) {
    echoCommand(["git", "fetch", "origin"], repoRoot, undefined, "[dry-run] would run $");
    say("(dry run: refs resolve against what is already fetched)");
    return;
  }
  await runCommand(["git", "fetch", "origin"], repoRoot);
}

async function withLock<T>(
  paths: ForkAppsPaths,
  task: () => Promise<T>,
  inputs?: { expected: unknown; read: () => Promise<unknown> },
): Promise<T> {
  await mkdir(paths.stateDir, { recursive: true });
  let handle: FileHandle;
  try {
    handle = await open(paths.lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const holder = (await readFile(paths.lockPath, 'utf8').catch(() => '')).trim();
    throw new ForkAppError(`another fork-app run holds ${paths.lockPath} (owner ${holder || 'not yet published'}); inspect a stale lock before explicitly removing it`);
  }
  const owner = await handle.stat();
  try {
    await handle.writeFile(`${process.pid}\n`);
    if (inputs && JSON.stringify(await inputs.read()) !== JSON.stringify(inputs.expected)) {
      throw new ForkAppError('plan inputs changed while waiting for confirmation or the lock; re-run to review a fresh plan');
    }
    return await task();
  } finally {
    await handle.close();
    const current = await lstat(paths.lockPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (current?.dev === owner.dev && current.ino === owner.ino) await rm(paths.lockPath);
  }
}

// ---------------------------------------------------------------------------
// Plan execution

type ExecutionContext = {
  identity: ForkInstanceIdentity;
  paths: ForkAppsPaths;
  previousInviteHandler?: string | null;
  inviteRestorePending?: boolean;
  inviteLaunchStarted?: boolean;
  inviteLaunchStopped?: boolean;
  signal?: AbortSignal | undefined;
};

const INVITE_SCHEME = "opendesign";

/** The bundle id LaunchServices currently routes opendesign:// links to. */
function readInviteHandler(quiet = false): string | null {
  const script = `ObjC.import("CoreServices"); var h = $.LSCopyDefaultHandlerForURLScheme($(${JSON.stringify(INVITE_SCHEME)})); h ? ObjC.unwrap(ObjC.castRefToObject(h)) : ""`;
  const value = probe(["osascript", "-l", "JavaScript", "-e", script], repoRoot, { allowFailure: true, quiet });
  return value == null || value.length === 0 ? null : value;
}

async function setInviteHandler(bundleId: string): Promise<void> {
  await runCommand([
    "osascript", "-l", "JavaScript", "-e",
    `ObjC.import("CoreServices"); $.LSSetDefaultHandlerForURLScheme($(${JSON.stringify(INVITE_SCHEME)}), $(${JSON.stringify(bundleId)}))`,
  ], repoRoot);
}

const INTERNAL_TAGS: Record<InternalAction["type"], string> = {
  "assert-not-running": "check",
  "assert-worktree-head": "check",
  'assert-launcher-version': 'check',
  "bake-namespace-base-root": "edit config",
  'disable-updates': 'edit config',
  "prune-kept": "cleanup",
  "record-state": "write state",
  "verify-app": "check",
  "remember-invite-handler": "check",
  "restore-invite-handler": "launch services",
  "wait-for-launch": "check",
  "write-kept-meta": "write state",
};

function describeStep(step: PlanStep): string {
  return step.kind === "run" ? step.label : `${step.label} [${INTERNAL_TAGS[step.action.type]}]`;
}

function printPlan(plan: readonly PlanStep[]): void {
  say("Plan:");
  plan.forEach((step, index) => {
    say(`  ${String(index + 1).padStart(2)}. ${describeStep(step)}`);
    if (step.kind === "run") {
      const envText = formatEnv(step.env);
      say(`      $ ${path.resolve(step.cwd) === repoRoot ? "" : `(cd ${formatCommand([step.cwd])}) `}${envText.length > 0 ? `${envText} ` : ""}${formatCommand(step.argv)}`);
    }
  });
}

function assertMutationAllowed(context: ExecutionContext, step: RunStep): void {
  for (const target of mutationTargets(step.argv)) {
    if (!isAllowedMutationTarget(context.paths, context.identity, target)) {
      throw new ForkAppError(`refusing "${step.label}": ${target} is outside the ${context.identity.label} app's install/kept paths`);
    }
  }
}

async function verifyApp(appPath: string, expect: ExpectedApp): Promise<void> {
  const app = await readInstalledApp(appPath);
  if (app == null) throw new ForkAppError(`no bundle at ${appPath}`);
  const problems: string[] = [];
  if (app.bundleId !== expect.bundleId) problems.push(`bundle id ${app.bundleId} != ${expect.bundleId}`);
  if (app.version !== expect.version) problems.push(`appVersion ${app.version} != ${expect.version}`);
  const shortVersion = plistValue(appPath, "CFBundleShortVersionString");
  if (shortVersion !== expect.version) problems.push(`CFBundleShortVersionString ${shortVersion} != ${expect.version}`);
  if (app.namespace !== expect.namespace) problems.push(`namespace ${app.namespace} != ${expect.namespace}`);
  if (app.updateEnabled !== expect.updateEnabled) problems.push(`updateEnabled ${String(app.updateEnabled)} != ${String(expect.updateEnabled)}`);
  if (app.namespaceBaseRoot !== expect.namespaceBaseRoot) {
    problems.push(`namespaceBaseRoot ${app.namespaceBaseRoot ?? "(unset)"} != ${expect.namespaceBaseRoot ?? "(unset)"}`);
  }
  if (problems.length > 0) throw new ForkAppError(`${appPath} failed verification:\n  - ${problems.join("\n  - ")}`);
  say(`      ok: ${expect.bundleId} ${expect.version}, namespace ${expect.namespace}, updateEnabled ${String(expect.updateEnabled)}`);
}

async function waitForExit(context: ExecutionContext, timeoutMs: number): Promise<InstanceProcess[]> {
  const appPath = instanceAppPath(context.paths, context.identity);
  const deadline = Date.now() + timeoutMs;
  let live = liveProcesses(instanceProcesses(context.identity, appPath));
  while (live.length > 0 && Date.now() < deadline) {
    await delay(1000, undefined, { signal: context.signal });
    live = liveProcesses(instanceProcesses(context.identity, appPath, true));
  }
  return live;
}

async function runInternal(context: ExecutionContext, action: InternalAction): Promise<void> {
  const { identity, paths } = context;
  const appPath = instanceAppPath(paths, identity);
  switch (action.type) {
    case "assert-not-running": {
      const live = await waitForExit(context, 20_000);
      if (live.length > 0) {
        throw new ForkAppError(
          `${identity.productName} is still running (pids ${live.map((entry) => entry.pid).join(", ")}); quit it and re-run`,
        );
      }
      say(`      ok: ${identity.productName} is not running`);
      return;
    }
    case "assert-worktree-head": {
      const head = probe(["git", "rev-parse", "HEAD"], paths.buildWorktree);
      if (head !== action.commit) throw new ForkAppError(`build worktree is at ${head}, expected ${action.commit}`);
      say(`      ok: ${head}`);
      return;
    }
    case "verify-app":
      await verifyApp(action.appPath, action.expect);
      return;
    case 'assert-launcher-version': {
      const versions = await readLauncherVersions(identity, { namespaceBaseRoot: action.namespaceBaseRoot }, paths.home);
      const newer = versions.find(version => compareVersions(version, action.version) > 0);
      if (newer) throw new ForkAppError(`a newer launcher payload (${newer}) can override rollback ${action.version}; clear the update cache through the app before retrying`);
      return;
    }
    case 'disable-updates': {
      const configPath = path.join(action.appPath, 'Contents', 'Resources', 'open-design-config.json');
      const config = await readJson(configPath) as Record<string, unknown>;
      await writeFile(configPath, `${JSON.stringify({ ...config, updateEnabled: false }, null, 2)}\n`, 'utf8');
      return;
    }
    case "bake-namespace-base-root": {
      const configPath = path.join(action.appPath, "Contents", "Resources", "open-design-config.json");
      const config = await readJson(configPath) as Record<string, unknown>;
      process.stderr.write(`$ write ${configPath} (namespaceBaseRoot=${action.namespaceBaseRoot})\n`);
      await writeFile(configPath, `${JSON.stringify({ ...config, namespaceBaseRoot: action.namespaceBaseRoot }, null, 2)}\n`, "utf8");
      return;
    }
    case "write-kept-meta": {
      if (!isPathInside(paths.keptRoot, action.dir)) throw new ForkAppError(`kept copy dir ${action.dir} is outside ${paths.keptRoot}`);
      const file = path.join(action.dir, "kept.json");
      process.stderr.write(`$ write ${file}\n`);
      await writeFile(file, `${JSON.stringify({ ...action.meta, keptAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
      return;
    }
    case "record-state": {
      const state = await readState(paths);
      await writeState(paths, withInstallRecord(state, identity.instance, { ...action.record, installedAt: new Date().toISOString() }));
      return;
    }
    case "prune-kept": {
      for (const copy of keptCopiesToPrune(await listKeptCopies(paths), KEPT_STABLE_COPIES, action.protect)) {
        const argv = ["rm", "-rf", copy.dir];
        assertMutationAllowed(context, { argv, cwd: paths.home, kind: "run", label: "prune kept copy" });
        await runCommand(argv, paths.home);
      }
      return;
    }
    case "remember-invite-handler": {
      context.previousInviteHandler = readInviteHandler();
      context.inviteRestorePending = context.previousInviteHandler != null && context.previousInviteHandler !== identity.bundleId;
      say(`      opendesign:// -> ${context.previousInviteHandler ?? "(none)"}`);
      return;
    }
    case "restore-invite-handler": {
      const previous = context.previousInviteHandler ?? null;
      if (previous == null || previous === identity.bundleId) {
        say(`      ${identity.productName} keeps opendesign:// (it had no other owner)`);
        return;
      }
      if (!context.inviteLaunchStopped) {
        const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
        while (readInviteHandler(true) !== identity.bundleId) {
          context.signal?.throwIfAborted();
          if (Date.now() >= deadline) throw new ForkAppError(`${identity.productName} never completed its invite-scheme claim`);
          await delay(250, undefined, { signal: context.signal });
        }
      }
      await setInviteHandler(previous);
      if (readInviteHandler(true) !== previous) throw new ForkAppError(`could not restore opendesign:// to ${previous}`);
      context.inviteRestorePending = false;
      say(`      opendesign:// -> ${previous} again`);
      return;
    }
    case "wait-for-launch": {
      const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
      let processes = instanceProcesses(identity, appPath);
      while (!hasLaunched(processes) && Date.now() < deadline) {
        await delay(2000, undefined, { signal: context.signal });
        processes = instanceProcesses(identity, appPath, true);
      }
      if (!hasLaunched(processes)) {
        throw new ForkAppError(`${identity.productName} did not start desktop, daemon and web within ${LAUNCH_TIMEOUT_MS / 1000}s; see its desktop log`);
      }
      for (const entry of processes.filter((process) => process.role != null)) {
        say(`      ${entry.role}: pid ${entry.pid}`);
      }
      return;
    }
  }
}

async function executePlan(context: ExecutionContext, plan: readonly PlanStep[]): Promise<void> {
  let failure: unknown;
  try {
    for (const [index, step] of plan.entries()) {
      context.signal?.throwIfAborted();
      say(`==> [${index + 1}/${plan.length}] ${describeStep(step)}`);
      if (step.kind === "run") {
        if (step.argv[0] === 'open' && context.inviteRestorePending) context.inviteLaunchStarted = true;
        assertMutationAllowed(context, step);
        await runCommand(step.argv, step.cwd, step.env, context.signal);
      } else {
        await runInternal(context, step.action);
      }
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (context.inviteRestorePending) {
      try {
        const recovery = { ...context, signal: undefined, inviteLaunchStopped: true };
        if (context.inviteLaunchStarted) {
          const stop = plan.find((step): step is RunStep => step.kind === 'run' && step.argv[0] === 'pnpm'
            && step.argv.includes('tools-pack') && step.argv.includes('stop'));
          if (!stop) throw new ForkAppError('cannot safely restore invite ownership without the Dev stop step');
          await runCommand(stop.argv, stop.cwd, stop.env);
          if ((await waitForExit(recovery, 20_000)).length) throw new ForkAppError('Dev is still running; invite ownership recovery could not finish');
        }
        await runInternal(recovery, { type: 'restore-invite-handler' });
        context.inviteRestorePending = false;
      } catch (cleanupError) {
        if (failure) throw new AggregateError([failure, cleanupError], 'fork-app failed and invite ownership recovery also failed');
        throw cleanupError;
      }
    }
  }
}

async function withInterruptions<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const interrupt = () => controller.abort(new ForkAppError('interrupted; recovering temporary invite ownership'));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    return await task(controller.signal);
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

async function confirm(options: ForkOptions, banner: string, word: string): Promise<void> {
  say(banner);
  if (options.dryRun) {
    say(`(dry run: the real run requires --yes or typing "${word}")`);
    return;
  }
  if (options.yes) return;
  if (!process.stdin.isTTY) throw new ForkAppError(`refusing without confirmation; re-run with --yes`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`Type "${word}" to continue: `);
  rl.close();
  if (answer.trim() !== word) throw new ForkAppError("aborted");
}

// ---------------------------------------------------------------------------
// Commands

async function commandBuild(instance: "dev" | "stable", options: ForkOptions): Promise<void> {
  const paths = resolveForkAppsPaths(forkHome());
  const identity = forkInstanceIdentity(instance);
  const appPath = instanceAppPath(paths, identity);
  preflight();
  await fetchOrigin(options);

  const ref = options.ref ?? (instance === "dev" ? "HEAD" : DEFAULT_PROMOTE_REF);
  const commit = resolveCommit(ref);
  const subject = probe(["git", "log", "-1", "--format=%h %s", commit]) ?? commit;
  if (options.ref == null && instance === "dev" && (probe(["git", "status", "--porcelain"]) ?? "").length > 0) {
    say("note: this checkout has uncommitted changes; the build uses the committed HEAD only");
  }
  const repoVersion = await repoVersionAt(commit);

  const other = forkInstanceIdentity(instance === "dev" ? "stable" : "dev");
  const readInputs = async () => {
    const installed = await readInstalledApp(appPath);
    assertOwnedApp(identity, appPath, installed);
    return {
      installed,
      otherInstalled: await readInstalledApp(instanceAppPath(paths, other)),
      state: await readState(paths),
      launcherVersions: await readLauncherVersions(identity, installed),
      worktree: inspectBuildWorktree(paths),
      kept: await listKeptCopies(paths),
    };
  };
  const snapshot = await readInputs();
  const { installed, otherInstalled, state, launcherVersions, worktree, kept } = snapshot;
  const knownVersions = [
    ...(installed?.version == null ? [] : [installed.version]),
    ...launcherVersions,
    ...state.instances[instance].map((record) => record.version),
  ];
  const next = computeNextVersion({
    channel: identity.channel,
    floorVersions: otherInstalled?.version == null ? [] : [otherInstalled.version],
    knownVersions,
    now: new Date(),
    repoVersion,
  });

  if (instance === "stable") {
    const tag = stableTagName(next.version);
    if (probe(["git", "rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], repoRoot, { allowFailure: true }) != null) {
      throw new ForkAppError(`tag ${tag} already exists`);
    }
  }
  const running = liveProcesses(instanceProcesses(identity, appPath)).length > 0;
  if (instance === "stable" && running && !options.quitRunning) {
    const message = `${identity.productName} is running. Quit it (Cmd-Q) and re-run, or pass --quit-running to stop it gracefully right before install.`;
    if (!options.dryRun) throw new ForkAppError(message);
    say(`warning: ${message}`);
  }
  const plan = buildInstallPlan({
    arch: process.arch,
    commit,
    identity,
    installed,
    installedCommit: findInstallRecord(state, instance, installed?.version ?? null)?.commit ?? null,
    keptVersions: kept.map((copy) => copy.version),
    launch: options.launch,
    paths,
    quitRunning: options.quitRunning,
    ref,
    repoRoot,
    restoreInviteHandler: !options.claimInviteLinks,
    running,
    version: next.version,
    worktreeExists: worktree.exists,
  });
  if (instance === "dev") assertDevPlanIsolated(plan, paths);

  say(`${identity.label}: ${identity.productName} (${identity.bundleId}), namespace ${identity.namespace}`);
  say(`  ref:       ${ref} -> ${subject}`);
  say(`  installed: ${installed?.version ?? "(not installed)"} at ${appPath}`);
  say(`  new:       ${next.version}${next.notes.length > 0 ? ` (${next.notes.join("; ")})` : ""}`);
  say(`  build in:  ${paths.buildWorktree}${worktree.exists ? ` (currently ${worktree.head?.slice(0, 9)})` : " (will be created)"}`);
  if (instance === "stable") {
    say(`  data:      stays in namespace ${identity.namespace}; namespaceBaseRoot ${installed?.namespaceBaseRoot ?? "(portable default)"} is carried over`);
    say(`  tag:       ${stableTagName(next.version)} (local only)`);
  }
  printPlan(plan);

  if (instance === "stable") {
    await confirm(
      options,
      [
        "",
        "!!! STABLE WILL BE REPLACED !!!",
        `    ${identity.productName} ${installed?.version ?? "(none)"} -> ${next.version}`,
        `    built from ${commit} (${ref})`,
        installed?.version == null ? "" : `    the current bundle is kept under ${paths.keptRoot} for rollback`,
      ].filter((line) => line.length > 0).join("\n"),
      "promote",
    );
  }
  if (options.dryRun) {
    say("\nDry run: nothing was built, installed, or tagged.");
    return;
  }

  const startedAt = Date.now();
  await withLock(paths, () => withInterruptions(signal => executePlan({ identity, paths, signal }, plan)), {
    expected: snapshot, read: readInputs,
  });
  const minutes = ((Date.now() - startedAt) / 60_000).toFixed(1);
  say(`\nDone in ${minutes} min: ${identity.productName} ${next.version} from ${commit.slice(0, 9)} (${ref}).`);
  if (instance === "dev" && options.launch && options.claimInviteLinks) {
    say("Note: Dev now owns opendesign:// invite links. Relaunch Open Design Fork to take them back.");
  }
  if (instance === "stable") {
    say(`Push the tag when ready: git push origin ${stableTagName(next.version)}`);
  }
}

async function commandRollback(options: ForkOptions): Promise<void> {
  const paths = resolveForkAppsPaths(forkHome());
  const identity = forkInstanceIdentity("stable");
  const appPath = instanceAppPath(paths, identity);
  preflight();
  const readInputs = async () => {
    const installed = await readInstalledApp(appPath);
    assertOwnedApp(identity, appPath, installed);
    const kept = await listKeptCopies(paths);
    const target = selectRollbackTarget(kept, installed?.version ?? null, options.to);
    if (target == null) {
      throw new ForkAppError(options.to == null
        ? `no kept stable copy to roll back to under ${paths.keptRoot}`
        : `no kept stable copy for version ${options.to}; kept: ${kept.map((copy) => copy.version).join(", ") || "(none)"}`);
    }
    const targetApp = await readInstalledApp(target.appPath);
    if (!targetApp) throw new ForkAppError(`no kept bundle at ${target.appPath}`);
    assertOwnedApp(identity, target.appPath, targetApp);
    return { installed, kept, target, targetApp, state: await readState(paths) };
  };
  const snapshot = await readInputs();
  const { installed, kept, target, targetApp, state } = snapshot;
  const running = liveProcesses(instanceProcesses(identity, appPath)).length > 0;
  if (running && !options.quitRunning) {
    const message = `${identity.productName} is running. Quit it (Cmd-Q) and re-run, or pass --quit-running.`;
    if (!options.dryRun) throw new ForkAppError(message);
    say(`warning: ${message}`);
  }
  const plan = buildRollbackPlan({
    identity,
    installed,
    installedCommit: findInstallRecord(state, "stable", installed?.version ?? null)?.commit ?? null,
    keptVersions: kept.map((copy) => copy.version),
    launch: options.launch,
    paths,
    quitRunning: options.quitRunning,
    running,
    target,
    targetApp,
    toolsPackAvailable: existsSync(path.join(paths.buildWorktree, "tools", "pack", "dist")),
  });
  printPlan(plan);
  await confirm(
    options,
    [
      "",
      "!!! STABLE WILL BE ROLLED BACK !!!",
      `    ${identity.productName} ${installed?.version ?? "(none)"} -> ${target.version} (kept ${target.keptAt || "earlier"})`,
      "    the app is restored; data in the namespace is not (newer schema changes stay)",
    ].join("\n"),
    "rollback",
  );
  if (options.dryRun) {
    say("\nDry run: nothing was changed.");
    return;
  }
  await withLock(paths, () => withInterruptions(signal => executePlan({ identity, paths, signal }, plan)), {
    expected: snapshot, read: readInputs,
  });
  say(`\nRolled back ${identity.productName} to ${target.version}.`);
}

async function commandStatus(options: ForkOptions): Promise<void> {
  const paths = resolveForkAppsPaths(forkHome());
  const state = await readState(paths);
  const processes = parsePsOutput(probe(["ps", "-axww", "-o", "pid=,ppid=,command="]) ?? "");
  const kept = await listKeptCopies(paths);
  const inviteHandler = readInviteHandler();
  const worktree = existsSync(paths.buildWorktree)
    ? { head: probe(["git", "rev-parse", "HEAD"], paths.buildWorktree, { allowFailure: true }), path: paths.buildWorktree }
    : { head: null, path: paths.buildWorktree };

  const report = [];
  for (const instance of FORK_INSTANCES) {
    const identity = forkInstanceIdentity(instance);
    const appPath = instanceAppPath(paths, identity);
    const installed = await readInstalledApp(appPath);
    const record = findInstallRecord(state, instance, installed?.version ?? null);
    const instanceProcs = findInstanceProcesses(processes, identity, appPath);
    const live = liveProcesses(instanceProcs);
    const namespaceRoot = namespaceRootFor(forkHome(), identity, installed?.namespaceBaseRoot ?? null);
    report.push({
      app: appPath,
      bundleId: installed?.bundleId ?? identity.bundleId,
      builtFrom: record == null ? null : { commit: record.commit, installedAt: record.installedAt, ref: record.ref, source: record.source },
      installed: installed != null,
      instance,
      kept: instance === "stable" ? kept.map((copy) => ({ commit: copy.commit, keptAt: copy.keptAt, version: copy.version })) : undefined,
      launcherVersions: installed == null ? [] : await readLauncherVersions(identity, installed),
      namespace: installed?.namespace ?? identity.namespace,
      namespaceRoot,
      namespaceRootExists: existsSync(namespaceRoot),
      namespaceRootSource: installed?.namespaceBaseRoot == null
        ? `portable default (${defaultNamespaceBaseRoot(forkHome(), identity)})`
        : "baked namespaceBaseRoot",
      productName: identity.productName,
      running: live.length > 0,
      runningPids: Object.fromEntries(live.filter((entry) => entry.role != null).map((entry) => [entry.role, entry.pid])),
      updateEnabled: installed?.updateEnabled ?? null,
      version: installed?.version ?? null,
    });
  }

  if (options.json) {
    say(JSON.stringify({ buildWorktree: worktree, instances: report, inviteHandler, stateDir: paths.stateDir }, null, 2));
    return;
  }
  for (const entry of report) {
    const identity = forkInstanceIdentity(entry.instance);
    say(`${identity.label} — ${entry.productName} (${entry.bundleId})`);
    say(`  app:        ${entry.app}${entry.installed ? "" : " (not installed)"}`);
    if (entry.installed) {
      say(`  version:    ${entry.version}`);
      say(`  built from: ${entry.builtFrom == null
        ? "unknown (not installed by fork-app)"
        : `${entry.builtFrom.commit ?? "unknown commit"}${entry.builtFrom.ref == null ? "" : ` (${entry.builtFrom.ref})`}, ${entry.builtFrom.source} at ${entry.builtFrom.installedAt}`}`);
      say(`  namespace:  ${entry.namespace} (channel ${identity.channel})`);
      say(`  data root:  ${entry.namespaceRoot}${entry.namespaceRootExists ? "" : " (not created yet)"} — ${entry.namespaceRootSource}`);
      say(`  updater:    ${entry.updateEnabled === false ? "disabled (updateEnabled: false)" : `ENABLED or unset (${String(entry.updateEnabled)})`}`);
      say(`  launcher:   ${entry.launcherVersions.length > 0 ? [...new Set(entry.launcherVersions)].join(", ") : "(no runtime pointer yet)"}`);
    }
    say(`  running:    ${entry.running ? `yes — ${Object.entries(entry.runningPids).map(([role, pid]) => `${role} ${pid}`).join(", ")}` : "no"}`);
    if (entry.kept != null) {
      say(`  kept:       ${entry.kept.length > 0 ? entry.kept.map((copy) => copy.version).join(", ") : "(none yet)"}`);
    }
    say();
  }
  say(`Build worktree: ${worktree.path}${worktree.head == null ? " (not created)" : ` at ${worktree.head}`}`);
  say(`State:          ${paths.stateDir}`);
  say(`opendesign://:  ${inviteHandler ?? "(no explicit handler)"}`);
}

async function main(argv: readonly string[]): Promise<number> {
  const { command, options } = parseForkArgs(argv);
  if (forkHome() !== homedir() && command !== "help" && command !== "status" && !options.dryRun) {
    // Process stamps are not home-scoped, so a real run against a fixture home
    // could still stop or replace the real apps.
    throw new ForkAppError("FORK_APP_HOME is for --dry-run rehearsals and status only");
  }
  switch (command) {
    case "help":
      say(HELP);
      return 0;
    case "status":
      await commandStatus(options);
      return 0;
    case "dev":
      await commandBuild("dev", options);
      return 0;
    case "promote":
      await commandBuild("stable", options);
      return 0;
    case "rollback":
      await commandRollback(options);
      return 0;
  }
}

if (process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`fork-app: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
