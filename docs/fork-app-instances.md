# Fork app instances: Stable and Dev

This is fork-only tooling for `NACC96/open-design`. It manages two packaged
macOS apps that run side by side:

| | Stable | Dev |
| --- | --- | --- |
| App | `~/Applications/Open Design Fork.app` | `~/Applications/Open Design Dev.app` |
| Bundle id | `io.open-design.desktop.fork` | `io.open-design.desktop.dev` |
| Release channel | `fork` | `dev` |
| Namespace | `model-picker` | `fork-dev` |
| Updated | only by an explicit `promote` or `rollback` | whenever you run `dev` |
| Updater | off (`updateEnabled: false`) | off (`updateEnabled: false`) |

Stable is the app you use every day. Dev is for trying a PR branch or the
current `custom` before it reaches Stable.

Everything goes through one script, `scripts/fork-app.ts`. Run it with Node 24
(`nvm use` picks it up from `.nvmrc`) from any checkout of the fork:

```sh
node scripts/fork-app.ts status
```

There is no `package.json` alias, which follows the root command boundary in
`AGENTS.md`.

## Workflows

| Goal | Command |
| --- | --- |
| See both apps | `node scripts/fork-app.ts status` |
| Test today's `custom` on Dev | `node scripts/fork-app.ts dev --ref origin/custom` |
| Test a PR branch on Dev | `node scripts/fork-app.ts dev --ref origin/<branch>` |
| Test the current checkout on Dev | `node scripts/fork-app.ts dev` |
| Promote `custom` to Stable | `node scripts/fork-app.ts promote --yes` |
| Promote another ref to Stable | `node scripts/fork-app.ts promote --ref <ref> --yes` |
| Roll Stable back | `node scripts/fork-app.ts rollback --yes` |
| Preview any of the above | add `--dry-run` |

For a PR from another repository, fetch its head first, for example
`git fetch origin pull/<n>/head:pr-<n>`, then pass `--ref pr-<n>`. `dev` with
no `--ref` builds the committed `HEAD` of the checkout the script lives in.
Uncommitted changes are not included, and the script says so.

Options:

- `--dry-run` resolves the ref, computes the version, and prints every step
  and command. It builds, installs, and tags nothing, and it does not fetch
  either, so refs resolve against what you already have.
- `--no-fetch` skips `git fetch origin`. Every other build fetches first, so
  `origin/custom` means today's `custom`.
- `--no-launch` installs without opening the app.
- `--claim-invite-links` (`dev` only) leaves Dev as the `opendesign://`
  handler after launch. See [Caveats](#caveats).
- `--quit-running` applies to `promote` and `rollback` only. It is explained
  under [Running apps](#running-apps).

The script prints each underlying command before running it, and it stops at
the first failure.

To rehearse a plan against a throwaway fixture instead of the real apps, set
`FORK_APP_HOME=<dir>`. Every app, state, and namespace path then derives from
that directory. The script accepts it only with `--dry-run` or `status`,
because process stamps are not tied to a home directory, so a real run could
still reach the real apps.

## How the data stays separate

Each app has its own namespace and its own app identity. Packaged daemon
storage follows only the
[Daemon data directory contract](../AGENTS.md#daemon-data-directory-contract).
This tool chooses the inputs to that contract and never relocates data:

- **Stable** keeps the namespace root its installed bundle already uses.
  `promote` reads `namespaceBaseRoot` from the installed Stable's
  `open-design-config.json` and writes the same value into the new bundle, so
  the existing library opens unchanged. If the installed Stable bakes no root,
  the new one bakes none either.
- **Dev** is built with `--portable`. The packaged runtime then derives Dev's
  namespace root from Dev's own app identity, which is disjoint from Stable's.
  Dev starts empty and never reads or writes Stable's data.

`status` prints the namespace root each app resolves to.

Several things stay outside the separation. Agent CLIs (Claude Code, Codex,
and others) are installed per user, so both apps share their logins and global
configuration. Dev's data survives rebuilds. To reset Dev, quit it and remove
the namespace root that `status` shows for Dev.

## Versions

The packaged launcher remembers the highest version each namespace has run
and moves that pointer only forward (`reconcileRuntimeWithBoundPackage` in
`apps/packaged/src/launcher-runtime.ts`). If a later launch carries a version
that is not newer, the pointer stays put, and a launcher payload at that
version would take over from the bundle you installed. Every install therefore
gets a strictly newer version:

```text
<base>-<channel>.<UTC YYYYMMDDHHmm>     e.g. 0.24.1-fork.202610142130
```

- **Channel.** `fork` for Stable, `dev` for Dev. `releaseChannelFromVersion`
  turns the suffix into the app identity in the table above.
- **Base.** The `apps/packaged` version at the ref you build. It never goes
  below the highest base that either app has installed, or that the
  namespace's launcher pointer has recorded. A repo still at `0.23.x`
  therefore still builds `0.24.1-…` while `0.24.1` is installed.
- **Build number.** The UTC minute of the build. A second build in the same
  minute, or a clock running behind the previous build, uses the previous
  number plus one. A namespace that once ran a plain `x.y.z` release gets the
  next patch as its base, because a prerelease sorts below its release.

The comparison matches `compareLauncherVersions` in
`packages/launcher-proto`, and a unit test holds the two in agreement. The
number has 12 digits, well inside semver's 16-digit identifier limit.
electron-builder writes the full version into both `CFBundleShortVersionString`
and `CFBundleVersion`, the same format the first fork build used.

## What each command does

`dev` and `promote` share one pipeline:

1. Fetch `origin` and resolve `--ref` to a commit.
2. Check out that commit in the persistent build worktree at
   `~/Library/Caches/open-design-fork-apps/build-worktree` (detached,
   `git clean -fd`). The worktree lives outside every checkout, so module
   resolution inside the build cannot fall through to another checkout's
   `node_modules`, and your working checkout is left alone. Ignored build
   caches remain between builds, which keeps rebuilds fast.
3. `pnpm install --frozen-lockfile`, build tools-pack, then
   `OD_UPDATE_ENABLED=0 pnpm tools-pack mac build --namespace <ns> --app-version <v> --portable --to app`.
4. Check the built bundle's bundle id, version, namespace,
   `updateEnabled: false`, and that no namespace root is baked.
5. Stable only: write the carried-over `namespaceBaseRoot` into the bundle's
   config, then re-seal the ad-hoc signature (`codesign --force --sign -`).
   Both apps then get `codesign --verify --deep --strict`.
6. Make sure the target app is not running. See [Running apps](#running-apps).
7. Stable only: copy the installed bundle to the kept copies (see below).
8. Copy the new bundle into a hidden staging folder in `~/Applications`, move
   the old bundle aside, move the new one into place, and register it with
   LaunchServices.
9. Check the installed bundle again, then record the version, commit, and ref.
10. Stable only: create the local annotated tag `fork-stable-<version>` on the
    built commit. The tag is not pushed. The script prints the
    `git push origin <tag>` command for you to run.
11. Launch the app with `open` and wait until its desktop, daemon, and web
    processes are up. After a Dev launch, the `opendesign://` handler goes back
    to whichever app held it before.

`promote` prints a **STABLE WILL BE REPLACED** banner and needs `--yes`, or
you type `promote` at the prompt. It refuses to run if the tag already exists.

`rollback` reinstalls the newest kept copy that differs from what is
installed, or the copy named with `--to <version>`. It keeps the current
bundle first, so a rollback can be undone, and it needs `--yes`. A rollback
restores the app but not the data. If the newer build migrated the database
schema, the older app may not open that library correctly.

Before replacing anything, rollback refuses if the namespace's launcher state
can select a cached payload newer than the kept app. Runtime pointers without
a payload manifest do not prevent a restore. The script leaves cached payloads
and launcher pointers unchanged. A legacy kept bundle without an updater opt-out
is accepted, then its staged
restore has updates disabled and is re-signed before installation. The kept
copy remains unchanged. If the installed bundle is missing, the kept bundle
supplies the namespace-root expectation.

## Tool state, kept copies, and tags

- `~/Library/Application Support/open-design-fork-apps/state.json` records
  each install's version, commit, ref, and time. `status` uses it to show
  "built from".
- `~/Library/Application Support/open-design-fork-apps/stable-kept/<version>/`
  holds one previous Stable bundle and its `kept.json`. The newest three are
  kept. Each copy takes about 1 GB.
- `~/Library/Caches/open-design-fork-apps/build-worktree` is the build
  worktree. It is safe to delete; the next build recreates it.

None of this lives inside daemon data. A lock file in the state folder stops
two runs from overlapping.

An existing lock is never reclaimed automatically, including an empty lock
whose creator has not written its PID yet. Inspect a stale lock and confirm
its run has ended before explicitly removing it. A run releases only its own
lock. After confirmation and lock acquisition, the script rechecks the
installation, kept copies, and planning inputs; changed inputs require a new
plan instead of executing an outdated one.

State writes replace the JSON file atomically and retain the last valid
version in `state.json.backup`. An incomplete current JSON file recovers from
that backup with a notice; without a valid backup, the command stops for
manual recovery rather than discarding the history.

## Running apps

- **Dev** is stopped after the build finishes, so you can keep using it while
  the build runs. The script calls `tools-pack mac stop` with Dev's namespace
  and a `dev` version. That command matches only processes that carry Dev's
  exact five-field sidecar stamp (channel, namespace, source, mode, app). It
  asks them to shut down gracefully, and force-stops only those same process
  trees if they do not exit. It never matches by app name or bundle id, so it
  cannot reach Stable.
- **Stable** is never stopped unless you ask. If it is running, `promote` and
  `rollback` refuse and ask you to quit it with Cmd-Q. With `--quit-running`
  they run the same exact-stamp stop for Stable's namespace right before
  installing, so the downtime is only the install itself. If a generation is
  still running, let it finish and quit Stable yourself instead.

Replacing a bundle while it runs would leave the old processes loading files
from the new bundle, so the script always confirms that the app has exited
before it moves anything.

## Caveats

- **Invite links.** Both bundles register the `opendesign://` URL scheme
  (`tools/pack/src/mac/builder.ts`), and each app claims it again on every
  launch (`apps/desktop/src/main/invite-deeplink.ts`). Only one app can own
  the scheme at a time. `dev` records the owner before it launches Dev and
  hands the scheme back afterwards, so Stable keeps receiving invite links.
  Restoration waits for Dev's actual startup claim. A launch failure or
  handled SIGINT/SIGTERM stops Dev before restoring the previous handler,
  preventing a delayed startup from claiming it again after recovery.
  Pass `--claim-invite-links` to test invites on Dev. Opening Dev yourself,
  from Finder or the Dock, still claims the scheme; relaunch Stable to take it
  back. `status` shows the current owner.
- **Why not `tools-pack mac install` and `start`.** `install` copies the DMG
  into tools-pack's own output folder, not `~/Applications`. `start` launches
  with a config that points the namespace at tools-pack's local runtime root
  instead of the app's real one, and it inherits the shell environment. For
  Stable that would open an empty library, and before that it would replace
  the running Stable, because it converges the same channel and namespace
  stamps. The script installs into `~/Applications` itself and launches
  through LaunchServices (`open`). That is the same path as Finder, using the
  baked config and launchd's environment.
- **Launch environment.** The script refuses to run if launchd's environment
  sets any of `OD_DATA_DIR`, `OD_LEGACY_DATA_DIR`, `OD_PACKAGED_NAMESPACE`,
  `OD_PACKAGED_NAMESPACE_BASE_ROOT`, `OD_PACKAGED_CONFIG_PATH`,
  `OD_UPDATE_ENABLED`, or `ELECTRON_RUN_AS_NODE`. Each of these would override
  the baked separation or the updater opt-out for apps opened from Finder.
  Child commands also drop `ELECTRON_RUN_AS_NODE`, which some agent terminals
  export.
- **Refs must carry the fork's updater opt-out.** Building a ref that
  predates `custom`'s macOS updater opt-out (`OD_UPDATE_ENABLED=0` baking
  `updateEnabled: false`) produces a bundle with the updater on. The bundle
  check catches it and the script stops before installing. Rebase such a
  branch onto `custom` first.
- **Unsigned builds.** These are local ad-hoc-signed builds without
  notarization. They run because nothing downloaded them, so they carry no
  quarantine attribute. Do not hand the bundles to other machines.
- **Rebuilding is on request only.** Nothing runs in the background or on a
  schedule.
