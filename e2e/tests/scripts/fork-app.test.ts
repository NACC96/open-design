import { describe, expect, test } from "vitest";

import {
  isReleaseChannel,
  releaseChannelFromNamespace,
  releaseChannelFromVersion,
  releaseInstallIdentity,
} from "@open-design/release";

import { compareLauncherVersions } from "../../../packages/launcher-proto/src/index.ts";
import {
  assertDevPlanIsolated,
  assertForkVersion,
  buildInstallPlan,
  buildRollbackPlan,
  builtAppPath,
  compareVersions,
  computeNextVersion,
  emptyState,
  findInstallRecord,
  findInstanceProcesses,
  forkInstanceIdentity,
  hasLaunched,
  instanceAppPath,
  isAllowedMutationTarget,
  keptCopiesToPrune,
  launcherRuntimePath,
  mutationTargets,
  namespaceRootFor,
  normalizeState,
  parseForkArgs,
  parsePsOutput,
  resolveForkAppsPaths,
  selectRollbackTarget,
  stableTagName,
  utcBuildStamp,
  withInstallRecord,
  type BuildPlanInput,
  type InstalledApp,
  type KeptCopy,
  type PlanStep,
  type RunStep,
} from "../../../scripts/lib/fork-app.ts";

const HOME = "/Users/tester";
const paths = resolveForkAppsPaths(HOME);
const stable = forkInstanceIdentity("stable");
const dev = forkInstanceIdentity("dev");
const NOW = new Date(Date.UTC(2026, 9, 14, 21, 30, 45));
const STAMP = "202610142130";
const BAKED_ROOT = "/Users/tester/Library/Application Support/Open Design/namespaces";

function runSteps(plan: readonly PlanStep[]): RunStep[] {
  return plan.filter((step): step is RunStep => step.kind === "run");
}

function indexOfStep(plan: readonly PlanStep[], predicate: (step: PlanStep) => boolean): number {
  const index = plan.findIndex(predicate);
  expect(index, "expected plan step").toBeGreaterThanOrEqual(0);
  return index;
}

function isRun(step: PlanStep, ...prefix: string[]): boolean {
  return step.kind === "run" && prefix.every((part, index) => step.argv[index] === part);
}

function isInternal(step: PlanStep, type: string): boolean {
  return step.kind === "internal" && step.action.type === type;
}

function planInput(overrides: Partial<BuildPlanInput> = {}): BuildPlanInput {
  return {
    arch: "arm64",
    commit: "6522ffd8c0a2e6a9aa1a5d0829459d6cfbe02838",
    identity: dev,
    installed: null,
    installedCommit: null,
    keptVersions: [],
    launch: true,
    paths,
    quitRunning: false,
    ref: "origin/custom",
    repoRoot: "/Users/tester/Projects/open-design",
    restoreInviteHandler: true,
    running: false,
    version: `0.24.1-dev.${STAMP}`,
    worktreeExists: false,
    ...overrides,
  };
}

const installedStable: InstalledApp = {
  bundleId: stable.bundleId,
  namespace: stable.namespace,
  namespaceBaseRoot: BAKED_ROOT,
  updateEnabled: false,
  version: "0.24.1-fork.1",
};

describe("fork-app identities", () => {
  test("Stable keeps the installed fork identity and Dev gets a disjoint one", () => {
    expect(stable).toMatchObject({
      appBundleName: "Open Design Fork.app",
      bundleId: "io.open-design.desktop.fork",
      channel: "fork",
      namespace: "model-picker",
      productName: "Open Design Fork",
    });
    expect(dev).toMatchObject({
      appBundleName: "Open Design Dev.app",
      bundleId: "io.open-design.desktop.dev",
      channel: "dev",
      namespace: "fork-dev",
      productName: "Open Design Dev",
    });
    for (const key of ["appBundleName", "bundleId", "channel", "namespace", "productName"] as const) {
      expect(dev[key]).not.toBe(stable[key]);
    }
    expect(instanceAppPath(paths, dev)).not.toBe(instanceAppPath(paths, stable));
  });

  test("identities match what tools-pack derives from the version channel", () => {
    for (const identity of [stable, dev]) {
      expect(isReleaseChannel(identity.channel)).toBe(true);
      const release = releaseInstallIdentity(identity.channel);
      expect(release.appId).toBe(identity.bundleId);
      expect(release.productName).toBe(identity.productName);
      expect(release.executableName).toBe(identity.productName);
      expect(releaseChannelFromVersion(`0.24.1-${identity.channel}.${STAMP}`)).toBe(identity.channel);
    }
  });

  test("the namespaces are not official release namespaces, so the updater opt-out can be baked", () => {
    expect(releaseChannelFromNamespace(dev.namespace, "default")).toBeNull();
    expect(releaseChannelFromNamespace(stable.namespace, "default")).toBeNull();
  });

  test("namespace and launcher paths follow the packaged runtime layout", () => {
    expect(namespaceRootFor(HOME, stable, BAKED_ROOT)).toBe(`${BAKED_ROOT}/model-picker`);
    expect(launcherRuntimePath(HOME, stable, BAKED_ROOT)).toBe(
      "/Users/tester/Library/Application Support/Open Design/launcher/channels/fork/namespaces/model-picker/runtime.json",
    );
    // A portable Dev build resolves under Dev's own Electron userData root.
    expect(namespaceRootFor(HOME, dev, null)).toBe("/Users/tester/Library/Application Support/Open Design Dev/namespaces/fork-dev");
    expect(launcherRuntimePath(HOME, dev, null)).toBe(
      "/Users/tester/Library/Application Support/Open Design Dev/launcher/channels/dev/namespaces/fork-dev/runtime.json",
    );
    expect(builtAppPath(paths.buildWorktree, dev, "arm64")).toBe(
      `${paths.buildWorktree}/.tmp/tools-pack/out/mac/namespaces/fork-dev/builder/mac-arm64/Open Design Dev.app`,
    );
  });
});

describe("fork-app versions", () => {
  test("compareVersions orders exactly like the packaged launcher", () => {
    const versions = [
      "0.23.1",
      "0.24.1",
      "0.24.1-fork.1",
      "0.24.1-fork.2",
      "0.24.1-fork.10",
      `0.24.1-fork.${STAMP}`,
      `0.24.1-dev.${STAMP}`,
      "0.24.2-fork.1",
      "0.25.0-beta.3",
      "0.24.1.nightly.4",
      "v0.24.1+build",
    ];
    for (const left of versions) {
      for (const right of versions) {
        expect(Math.sign(compareVersions(left, right)), `${left} vs ${right}`).toBe(
          Math.sign(compareLauncherVersions(left, right)),
        );
      }
    }
  });

  test("utcBuildStamp is a zero-padded UTC YYYYMMDDHHmm", () => {
    expect(utcBuildStamp(NOW)).toBe(STAMP);
    expect(utcBuildStamp(new Date(Date.UTC(2027, 0, 2, 3, 4)))).toBe("202701020304");
  });

  test("the repo base is raised to the installed base so a 0.23 repo never sorts below an installed 0.24.1", () => {
    const next = computeNextVersion({
      channel: "fork",
      floorVersions: [],
      knownVersions: ["0.24.1-fork.1"],
      now: NOW,
      repoVersion: "0.23.1",
    });
    expect(next.version).toBe(`0.24.1-fork.${STAMP}`);
    expect(compareLauncherVersions(next.version, "0.24.1-fork.1")).toBe(1);
  });

  test("Dev takes its base floor from the other installed app", () => {
    const next = computeNextVersion({
      channel: "dev",
      floorVersions: ["0.24.1-fork.1"],
      knownVersions: [],
      now: NOW,
      repoVersion: "0.23.1",
    });
    expect(next.version).toBe(`0.24.1-dev.${STAMP}`);
  });

  test("a repo ahead of the installed base wins", () => {
    expect(computeNextVersion({
      channel: "fork",
      floorVersions: [],
      knownVersions: ["0.24.1-fork.1"],
      now: NOW,
      repoVersion: "0.25.0",
    }).version).toBe(`0.25.0-fork.${STAMP}`);
  });

  test("two builds in the same minute, or a clock behind the last build, still move forward", () => {
    expect(computeNextVersion({
      channel: "fork",
      floorVersions: [],
      knownVersions: [`0.24.1-fork.${STAMP}`],
      now: NOW,
      repoVersion: "0.23.1",
    }).version).toBe("0.24.1-fork.202610142131");
    expect(computeNextVersion({
      channel: "fork",
      floorVersions: [],
      knownVersions: ["0.24.1-fork.202612010000"],
      now: NOW,
      repoVersion: "0.24.1",
    }).version).toBe("0.24.1-fork.202612010001");
  });

  test("a namespace that ran a plain release of the base gets the next patch base", () => {
    const next = computeNextVersion({
      channel: "fork",
      floorVersions: [],
      knownVersions: ["0.24.1"],
      now: NOW,
      repoVersion: "0.24.1",
    });
    expect(next.version).toBe(`0.24.2-fork.${STAMP}`);
    expect(compareLauncherVersions(next.version, "0.24.1")).toBe(1);
  });

  test("the result is newer than every known version", () => {
    const known = ["0.24.1-fork.1", "0.24.1-fork.202610150000", "0.23.9", "0.24.0"];
    const next = computeNextVersion({ channel: "fork", floorVersions: [], knownVersions: known, now: NOW, repoVersion: "0.23.1" });
    for (const version of known) expect(compareLauncherVersions(next.version, version)).toBe(1);
  });

  test("version shape is validated", () => {
    expect(() => computeNextVersion({ channel: "dev", floorVersions: [], knownVersions: [], now: NOW, repoVersion: "next" }))
      .toThrow(/x.y.z base/);
    expect(() => assertForkVersion("0.24.1-dev.0", "dev")).toThrow();
    expect(() => assertForkVersion("0.24.1-fork.1", "dev")).toThrow();
    expect(() => assertForkVersion("0.24.1-dev.12345678901234567", "dev")).toThrow();
    expect(() => assertForkVersion(`0.24.1-dev.${STAMP}`, "dev")).not.toThrow();
  });

  test("stable tags are named after the promoted version", () => {
    expect(stableTagName(`0.24.1-fork.${STAMP}`)).toBe(`fork-stable-0.24.1-fork.${STAMP}`);
  });
});

describe("fork-app arguments", () => {
  test("defaults and flags", () => {
    expect(parseForkArgs([])).toMatchObject({ command: "help" });
    expect(parseForkArgs(["dev"]).options).toMatchObject({ dryRun: false, fetch: true, launch: true, ref: null });
    expect(parseForkArgs(["dev", "--ref", "origin/custom", "--dry-run", "--no-launch"]).options)
      .toMatchObject({ claimInviteLinks: false, dryRun: true, launch: false, ref: "origin/custom" });
    expect(parseForkArgs(["dev", "--claim-invite-links"]).options.claimInviteLinks).toBe(true);
    expect(parseForkArgs(["promote", "--ref=feat/x", "--yes", "--quit-running", "--no-fetch"]).options)
      .toMatchObject({ fetch: false, quitRunning: true, ref: "feat/x", yes: true });
    expect(parseForkArgs(["rollback", "--to", "0.24.1-fork.1", "--yes"]).options).toMatchObject({ to: "0.24.1-fork.1", yes: true });
    expect(parseForkArgs(["status", "--json"]).options.json).toBe(true);
  });

  test("flags are scoped to the commands that use them", () => {
    expect(() => parseForkArgs(["dev", "--yes"])).toThrow(/does not accept/);
    expect(() => parseForkArgs(["dev", "--quit-running"])).toThrow(/does not accept/);
    expect(() => parseForkArgs(["promote", "--claim-invite-links"])).toThrow(/does not accept/);
    expect(() => parseForkArgs(["status", "--ref", "x"])).toThrow(/does not accept/);
    expect(() => parseForkArgs(["rollback", "--ref", "x"])).toThrow(/does not accept/);
    expect(() => parseForkArgs(["deploy"])).toThrow(/unknown command/);
    expect(() => parseForkArgs(["dev", "--ref"])).toThrow(/requires a value/);
    expect(() => parseForkArgs(["dev", "--ref", "--dry-run"])).toThrow(/requires a value/);
  });
});

describe("fork-app process matching", () => {
  const stableApp = instanceAppPath(paths, stable);
  const devApp = instanceAppPath(paths, dev);
  const stamp = (app: string, channel: string, namespace: string) =>
    `--od-stamp-channel=${channel} --od-stamp-namespace=${namespace} --od-stamp-source=packaged --od-stamp-mode=runtime --od-stamp-app=${app}`;
  const ps = [
    `  100     1 ${stableApp}/Contents/MacOS/Open Design Fork ${stableApp}/Contents/Resources/app/node_modules/@open-design/sidecar/dist/supervisor.mjs ${stamp("desktop", "fork", "model-picker")}`,
    `  101   100 ${stableApp}/Contents/MacOS/Open Design Fork`,
    `  102   101 ${stableApp}/Contents/MacOS/Open Design Fork ${stableApp}/Contents/Resources/app/node_modules/@open-design/sidecar/dist/supervisor.mjs ${stamp("daemon", "fork", "model-picker")}`,
    `  103   101 ${stableApp}/Contents/MacOS/Open Design Fork ${stableApp}/Contents/Resources/app/node_modules/@open-design/sidecar/dist/supervisor.mjs ${stamp("web", "fork", "model-picker")}`,
    "  104   103 next-server (v16.2.6)",
    `  105     1 ${stableApp}/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler --no-rate-limit`,
    `  200     1 ${devApp}/Contents/MacOS/Open Design Dev ${devApp}/Contents/Resources/app/node_modules/@open-design/sidecar/dist/supervisor.mjs ${stamp("desktop", "dev", "fork-dev")}`,
    `  201   200 ${devApp}/Contents/MacOS/Open Design Dev`,
    `  202   201 ${devApp}/Contents/MacOS/Open Design Dev x/supervisor.mjs ${stamp("daemon", "dev", "fork-dev")}`,
    "  300     1 /usr/bin/some-tool --od-stamp-channel=dev --od-stamp-namespace=other",
    "  301     1 /Users/tester/Library/Application Support/open-design-fork-apps/stable-kept/0.24.1-fork.1/Open Design Fork.app/Contents/MacOS/Open Design Fork",
  ].join("\n");
  const processes = parsePsOutput(ps);

  test("Stable matches its bundle, its stamps, and their descendants only", () => {
    const pids = findInstanceProcesses(processes, stable, stableApp).map((entry) => entry.pid);
    expect(pids).toEqual([100, 101, 102, 103, 104, 105]);
  });

  test("Dev matches only Dev processes", () => {
    const found = findInstanceProcesses(processes, dev, devApp);
    expect(found.map((entry) => entry.pid)).toEqual([200, 201, 202]);
    expect(hasLaunched(found)).toBe(false);
    expect(hasLaunched(findInstanceProcesses(processes, stable, stableApp))).toBe(true);
  });
});

describe("fork-app dev plan", () => {
  test("builds, stops only Dev, installs, verifies, and launches without touching Stable", () => {
    const plan = buildInstallPlan(planInput());
    expect(() => assertDevPlanIsolated(plan, paths)).not.toThrow();

    const build = runSteps(plan).find((step) => step.argv.includes("build") && step.argv.includes("mac"))!;
    expect(build.argv).toEqual([
      "pnpm", "tools-pack", "mac", "build",
      "--namespace", "fork-dev",
      "--app-version", `0.24.1-dev.${STAMP}`,
      "--portable",
      "--to", "app",
      "--json",
    ]);
    expect(build.env).toMatchObject({ ELECTRON_RUN_AS_NODE: null, OD_DATA_DIR: null, OD_UPDATE_ENABLED: "0" });
    expect(build.cwd).toBe(paths.buildWorktree);

    const stop = runSteps(plan).find((step) => step.argv.includes("stop"))!;
    expect(stop.argv).toEqual([
      "pnpm", "tools-pack", "mac", "stop", "--namespace", "fork-dev", "--app-version", `0.24.1-dev.${STAMP}`, "--json",
    ]);

    const buildIndex = plan.indexOf(build);
    const stopIndex = plan.indexOf(stop);
    const notRunning = indexOfStep(plan, (step) => isInternal(step, "assert-not-running"));
    const moveIntoPlace = indexOfStep(plan, (step) => isRun(step, "mv") && step.kind === "run" && step.argv[2] === instanceAppPath(paths, dev));
    const launch = indexOfStep(plan, (step) => isRun(step, "open"));
    expect(buildIndex).toBeLessThan(stopIndex);
    expect(stopIndex).toBeLessThan(notRunning);
    expect(notRunning).toBeLessThan(moveIntoPlace);
    expect(moveIntoPlace).toBeLessThan(launch);

    const verifyBuilt = plan.find((step) => isInternal(step, "verify-app"));
    expect(verifyBuilt?.kind === "internal" && verifyBuilt.action.type === "verify-app" && verifyBuilt.action.expect)
      .toEqual({ bundleId: dev.bundleId, namespace: "fork-dev", namespaceBaseRoot: null, updateEnabled: false, version: `0.24.1-dev.${STAMP}` });

    expect(plan.some((step) => isRun(step, "git", "tag"))).toBe(false);
    expect(plan.some((step) => isInternal(step, "bake-namespace-base-root"))).toBe(false);
    expect(plan.some((step) => isInternal(step, "write-kept-meta"))).toBe(false);

    for (const step of runSteps(plan)) {
      for (const target of mutationTargets(step.argv)) {
        expect(isAllowedMutationTarget(paths, dev, target), `${step.label}: ${target}`).toBe(true);
        expect(isAllowedMutationTarget(paths, stable, target), `${step.label}: ${target}`).toBe(false);
      }
    }
  });

  test("an existing build worktree is reset to the commit instead of re-created", () => {
    const fresh = runSteps(buildInstallPlan(planInput())).map((step) => step.argv.slice(0, 3).join(" "));
    expect(fresh).toContain("git worktree add");
    const reused = runSteps(buildInstallPlan(planInput({ worktreeExists: true }))).map((step) => step.argv.slice(0, 3).join(" "));
    expect(reused).toContain("git checkout --detach");
    expect(reused).toContain("git clean -fd");
    expect(reused).not.toContain("git worktree add");
  });

  test("--no-launch drops the launch steps", () => {
    const plan = buildInstallPlan(planInput({ launch: false }));
    expect(plan.some((step) => isRun(step, "open"))).toBe(false);
    expect(plan.some((step) => isInternal(step, "wait-for-launch"))).toBe(false);
    expect(plan.some((step) => isInternal(step, "restore-invite-handler"))).toBe(false);
  });

  test("launching Dev hands opendesign:// back afterwards unless --claim-invite-links", () => {
    const plan = buildInstallPlan(planInput());
    const remember = indexOfStep(plan, (step) => isInternal(step, "remember-invite-handler"));
    const launch = indexOfStep(plan, (step) => isRun(step, "open"));
    const waited = indexOfStep(plan, (step) => isInternal(step, "wait-for-launch"));
    const restore = indexOfStep(plan, (step) => isInternal(step, "restore-invite-handler"));
    expect(remember).toBeLessThan(launch);
    expect(waited).toBeLessThan(restore);
    const claimed = buildInstallPlan(planInput({ restoreInviteHandler: false }));
    expect(claimed.some((step) => isInternal(step, "remember-invite-handler"))).toBe(false);
    expect(claimed.some((step) => isInternal(step, "restore-invite-handler"))).toBe(false);
  });

  test("the isolation check rejects plans that reference Stable", () => {
    expect(() => assertDevPlanIsolated(buildInstallPlan(planInput({
      identity: stable,
      installed: installedStable,
      version: `0.24.1-fork.${STAMP}`,
    })), paths)).toThrow(/stable/);
    const tampered: PlanStep[] = [{
      argv: ["rm", "-rf", instanceAppPath(paths, stable)],
      cwd: HOME,
      kind: "run",
      label: "oops",
    }];
    expect(() => assertDevPlanIsolated(tampered, paths)).toThrow(/touches the stable app/);
  });
});

describe("fork-app promote plan", () => {
  const promoteInput = (overrides: Partial<BuildPlanInput> = {}) => planInput({
    identity: stable,
    installed: installedStable,
    version: `0.24.1-fork.${STAMP}`,
    ...overrides,
  });

  test("carries the installed namespace root, keeps the old bundle, verifies, then tags", () => {
    const plan = buildInstallPlan(promoteInput());
    const build = runSteps(plan).find((step) => step.argv.includes("build") && step.argv.includes("mac"))!;
    expect(build.argv).toContain("model-picker");
    expect(build.argv).toContain("--portable");

    const bake = indexOfStep(plan, (step) => isInternal(step, "bake-namespace-base-root"));
    const bakeStep = plan[bake]!;
    expect(bakeStep.kind === "internal" && bakeStep.action.type === "bake-namespace-base-root" && bakeStep.action.namespaceBaseRoot)
      .toBe(BAKED_ROOT);
    const reseal = indexOfStep(plan, (step) => isRun(step, "codesign", "--force"));
    const verifySignature = indexOfStep(plan, (step) => isRun(step, "codesign", "--verify"));
    expect(bake).toBeLessThan(reseal);
    expect(reseal).toBeLessThan(verifySignature);

    const keep = indexOfStep(plan, (step) => isRun(step, "ditto") && step.kind === "run" && step.argv[1] === instanceAppPath(paths, stable));
    const keptTarget = (plan[keep] as RunStep).argv[2];
    expect(keptTarget).toBe(`${paths.keptRoot}/0.24.1-fork.1/Open Design Fork.app`);
    const moveAside = indexOfStep(plan, (step) => isRun(step, "mv") && step.kind === "run" && step.argv[1] === instanceAppPath(paths, stable));
    expect(keep).toBeLessThan(moveAside);

    const notRunning = indexOfStep(plan, (step) => isInternal(step, "assert-not-running"));
    expect(notRunning).toBeLessThan(keep);
    expect(plan.some((step) => isRun(step, "pnpm", "tools-pack") && step.kind === "run" && step.argv.includes("stop"))).toBe(false);

    const verifyIndexes = plan.flatMap((step, index) => (isInternal(step, "verify-app") ? [index] : []));
    const verifyInstalled = verifyIndexes[verifyIndexes.length - 1]!;
    const verifyStep = plan[verifyInstalled]!;
    expect(verifyStep.kind === "internal" && verifyStep.action.type === "verify-app" && verifyStep.action.expect.namespaceBaseRoot)
      .toBe(BAKED_ROOT);
    const tag = indexOfStep(plan, (step) => isRun(step, "git", "tag"));
    expect((plan[tag] as RunStep).argv).toEqual([
      "git", "tag", "-a", `fork-stable-0.24.1-fork.${STAMP}`, "-m",
      `Open Design Fork stable 0.24.1-fork.${STAMP} (from origin/custom)`, "6522ffd8c0a2e6a9aa1a5d0829459d6cfbe02838",
    ]);
    expect(verifyInstalled).toBeLessThan(tag);

    for (const step of runSteps(plan)) {
      for (const target of mutationTargets(step.argv)) {
        expect(isAllowedMutationTarget(paths, stable, target), `${step.label}: ${target}`).toBe(true);
      }
    }
  });

  test("a running Stable is stopped only with --quit-running", () => {
    const quit = buildInstallPlan(promoteInput({ quitRunning: true, running: true }));
    const stop = runSteps(quit).find((step) => step.argv.includes("stop"))!;
    expect(stop.argv).toEqual([
      "pnpm", "tools-pack", "mac", "stop", "--namespace", "model-picker", "--app-version", `0.24.1-fork.${STAMP}`, "--json",
    ]);
    const noQuit = buildInstallPlan(promoteInput({ quitRunning: false, running: true }));
    expect(runSteps(noQuit).some((step) => step.argv.includes("stop"))).toBe(false);
    expect(noQuit.some((step) => isInternal(step, "assert-not-running"))).toBe(true);
  });

  test("a version that is already kept is not copied again", () => {
    const plan = buildInstallPlan(promoteInput({ keptVersions: ["0.24.1-fork.1"] }));
    expect(plan.some((step) => isInternal(step, "write-kept-meta"))).toBe(false);
  });

  test("Stable claims opendesign:// on launch and keeps it", () => {
    const plan = buildInstallPlan(promoteInput());
    expect(plan.some((step) => isRun(step, "open"))).toBe(true);
    expect(plan.some((step) => isInternal(step, "restore-invite-handler"))).toBe(false);
  });

  test("a portable installed Stable stays portable", () => {
    const plan = buildInstallPlan(promoteInput({ installed: { ...installedStable, namespaceBaseRoot: null } }));
    expect(plan.some((step) => isInternal(step, "bake-namespace-base-root"))).toBe(false);
  });
});

describe("fork-app rollback", () => {
  const kept = (version: string, keptAt: string): KeptCopy => ({
    appPath: `${paths.keptRoot}/${version}/Open Design Fork.app`,
    commit: null,
    dir: `${paths.keptRoot}/${version}`,
    keptAt,
    version,
  });
  const copies = [
    kept("0.24.1-fork.1", "2026-10-14T21:00:00.000Z"),
    kept("0.24.1-fork.202610150900", "2026-10-15T09:00:00.000Z"),
    kept("0.24.1-fork.202610160900", "2026-10-16T09:00:00.000Z"),
    kept("0.24.1-fork.202610170900", "2026-10-17T09:00:00.000Z"),
  ];

  test("selects the newest kept copy that is not installed, or the requested one", () => {
    expect(selectRollbackTarget(copies, "0.24.1-fork.202610180900", null)?.version).toBe("0.24.1-fork.202610170900");
    expect(selectRollbackTarget(copies, "0.24.1-fork.202610170900", null)?.version).toBe("0.24.1-fork.202610160900");
    expect(selectRollbackTarget(copies, null, "0.24.1-fork.1")?.version).toBe("0.24.1-fork.1");
    expect(selectRollbackTarget(copies, null, "9.9.9-fork.1")).toBeNull();
    expect(selectRollbackTarget([], null, null)).toBeNull();
  });

  test("pruning keeps the newest copies and never the protected version", () => {
    expect(keptCopiesToPrune(copies, 3, []).map((copy) => copy.version)).toEqual(["0.24.1-fork.1"]);
    expect(keptCopiesToPrune(copies, 3, ["0.24.1-fork.1"])).toEqual([]);
  });

  test("the plan keeps the current bundle, installs the kept one, and protects it from pruning", () => {
    const target = copies[3]!;
    const plan = buildRollbackPlan({
      identity: stable,
      installed: { ...installedStable, version: "0.24.1-fork.202610180900" },
      installedCommit: "abc123",
      keptVersions: copies.map((copy) => copy.version),
      launch: true,
      paths,
      quitRunning: false,
      running: false,
      target,
      targetApp: { ...installedStable, version: target.version },
      toolsPackAvailable: false,
    });
    const keep = indexOfStep(plan, (step) => isRun(step, "ditto") && step.kind === "run" && step.argv[1] === instanceAppPath(paths, stable));
    const stage = indexOfStep(plan, (step) => isRun(step, "ditto") && step.kind === "run" && step.argv[1] === target.appPath);
    expect(keep).toBeLessThan(stage);
    const prune = plan.find((step) => isInternal(step, "prune-kept"));
    expect(prune?.kind === "internal" && prune.action.type === "prune-kept" && prune.action.protect).toEqual([target.version]);
    const record = plan.find((step) => isInternal(step, "record-state"));
    expect(record?.kind === "internal" && record.action.type === "record-state" && record.action.record)
      .toMatchObject({ source: "rollback", version: target.version });
    for (const step of runSteps(plan)) {
      for (const target of mutationTargets(step.argv)) {
        expect(isAllowedMutationTarget(paths, stable, target), `${step.label}: ${target}`).toBe(true);
      }
    }
  });

  test("rollback is Stable-only and --quit-running needs a built tools-pack", () => {
    const base = {
      installed: installedStable,
      installedCommit: null,
      keptVersions: [],
      launch: true,
      paths,
      quitRunning: true,
      running: true,
      target: copies[0]!,
      targetApp: installedStable,
      toolsPackAvailable: false,
    };
    expect(() => buildRollbackPlan({ ...base, identity: dev })).toThrow(/stable/);
    expect(() => buildRollbackPlan({ ...base, identity: stable })).toThrow(/tools-pack/);
    expect(runSteps(buildRollbackPlan({ ...base, identity: stable, toolsPackAvailable: true })).some((step) => step.argv.includes("stop")))
      .toBe(true);
  });

  test('admits a legacy kept bundle before disabling updates on the staged restore', () => {
    const target = copies[0]!;
    const plan = buildRollbackPlan({
      identity: stable, installed: installedStable, installedCommit: null,
      keptVersions: [], launch: false, paths, quitRunning: false, running: false,
      target, targetApp: { ...installedStable, version: target.version, updateEnabled: null },
      toolsPackAvailable: false,
    });
    const verifyKept = plan[0];
    expect(verifyKept?.kind === 'internal' && verifyKept.action.type === 'verify-app' && verifyKept.action.expect.updateEnabled).toBeNull();
    const disable = indexOfStep(plan, step => isInternal(step, 'disable-updates'));
    const stage = indexOfStep(plan, step => isRun(step, 'ditto') && step.kind === 'run' && step.argv[1] === target.appPath);
    const move = indexOfStep(plan, step => isRun(step, 'mv') && step.kind === 'run' && step.argv[2] === instanceAppPath(paths, stable));
    expect(stage).toBeLessThan(disable);
    expect(disable).toBeLessThan(move);
    expect(plan.slice(disable, move).some(step => isRun(step, 'codesign', '--force'))).toBe(true);
  });

  test('uses the kept bundle data root when the installed bundle is missing', () => {
    const target = copies[0]!;
    const plan = buildRollbackPlan({
      identity: stable, installed: null, installedCommit: null, keptVersions: [],
      launch: false, paths, quitRunning: false, running: false, target,
      targetApp: { ...installedStable, version: target.version }, toolsPackAvailable: false,
    });
    const verifications = plan.filter(step => isInternal(step, 'verify-app'));
    expect(verifications).toHaveLength(2);
    for (const step of verifications) {
      expect(step.kind === 'internal' && step.action.type === 'verify-app' && step.action.expect.namespaceBaseRoot).toBe(BAKED_ROOT);
    }
    expect(plan.some(step => isInternal(step, 'assert-launcher-version'))).toBe(true);
  });
});

describe("fork-app mutation guard", () => {
  test("only ditto/mv/rm/mkdir targets are checked, and Dev may not write Stable paths", () => {
    expect(mutationTargets(["ditto", "/src.app", "/dst.app"])).toEqual(["/dst.app"]);
    expect(mutationTargets(["mv", "/a", "/b"])).toEqual(["/a", "/b"]);
    expect(mutationTargets(["rm", "-rf", "/a", "/b"])).toEqual(["/a", "/b"]);
    expect(mutationTargets(["git", "tag", "x"])).toEqual([]);
    expect(isAllowedMutationTarget(paths, dev, instanceAppPath(paths, stable))).toBe(false);
    expect(isAllowedMutationTarget(paths, dev, paths.keptRoot)).toBe(false);
    expect(isAllowedMutationTarget(paths, dev, `${HOME}/Applications`)).toBe(false);
    expect(isAllowedMutationTarget(paths, dev, `${instanceAppPath(paths, dev)}/../Open Design Fork.app`)).toBe(false);
    expect(isAllowedMutationTarget(paths, stable, `${paths.keptRoot}/0.24.1-fork.1`)).toBe(true);
  });
});

describe("fork-app state", () => {
  test("install history is newest-first, de-duplicated by version, and capped", () => {
    let state = emptyState();
    for (let index = 0; index < 30; index += 1) {
      state = withInstallRecord(state, "dev", {
        commit: `c${index}`,
        installedAt: `t${index}`,
        ref: "HEAD",
        source: "dev",
        version: `0.24.1-dev.${index + 1}`,
      });
    }
    state = withInstallRecord(state, "dev", { commit: "again", installedAt: "t", ref: null, source: "dev", version: "0.24.1-dev.30" });
    expect(state.instances.dev).toHaveLength(25);
    expect(state.instances.dev[0]?.commit).toBe("again");
    expect(state.instances.dev.filter((record) => record.version === "0.24.1-dev.30")).toHaveLength(1);
    expect(findInstallRecord(state, "dev", "0.24.1-dev.29")?.commit).toBe("c28");
    expect(findInstallRecord(state, "stable", "0.24.1-dev.29")).toBeNull();
  });

  test("malformed state files degrade to empty history", () => {
    expect(normalizeState(null)).toEqual(emptyState());
    expect(normalizeState({ instances: { dev: "nope", stable: [{ version: 1 }, { version: "0.24.1-fork.1" }] } }).instances)
      .toEqual({ dev: [], stable: [{ version: "0.24.1-fork.1" }] });
  });
});
