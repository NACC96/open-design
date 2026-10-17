# Packaged updater opt-out

A fork or local build can bake an explicit updater opt-out into a macOS
package so the official updater never replaces it. Packages built without the
opt-out are unchanged and keep the existing updater behavior.

## Build switch

`tools-pack` reads `OD_UPDATE_ENABLED` while resolving its configuration and
accepts the same values as the packaged desktop runtime:

| Value | Effect on the package |
| --- | --- |
| `0`, `false`, `no` | `open-design-config.json` gets `updateEnabled: false`, and the build log prints an `updater opt-out` line. |
| `1`, `true`, `yes` | Nothing is baked; the package keeps the default (updater on). |
| unset or empty | Nothing is baked; the config is byte-identical to a build without the switch. |
| anything else | `tools-pack` fails before building. |

Values are case-sensitive and must not contain whitespace. Like the other
baked inputs, `tools-pack` validates the variable for every subcommand, so an
invalid value also fails `install` or `start`.

Only the macOS packer bakes the opt-out. Windows and Linux builds accept the
variable but do not persist any policy.

## Release namespaces are refused

`OD_UPDATE_ENABLED` is also the runtime switch, so a CI job that sets it at job
level for a smoke run could otherwise ship an official release that never
updates. `tools-pack mac build` therefore refuses to bake the opt-out when the
namespace is an official release namespace: `release-<channel>` or
`release-<channel>-<platform>`, as produced by `releaseNamespace()` in
`@open-design/release`, which every release workflow builds with. The check
runs before the first build phase.

The check is namespace-based on purpose. Any `x.y.z-<name>.N` version parses as
a release channel, so a version-based check would also refuse ordinary fork
versions such as `0.24.1-fork.1`. The plain default namespace is not treated
as a release namespace. Build forks under their own namespace, for example
`--namespace local-fork`.

## Launch behavior

The packaged entry applies the baked switch to its own environment right
after it reads `open-design-config.json`, before the sidecar bootstrap, any
launcher payload delegation, or any sidecar spawn. Every process that launch
hands off to inherits `OD_UPDATE_ENABLED`, including a delegated launcher
payload whose own config has no `updateEnabled` (an official payload, or a
fork payload built before the opt-out). A payload keeps a non-empty inherited
value, so the opt-out of the bundle the user launched wins over the payload's
own config. Launches from Finder, which have no shell environment, behave the
same way.

A non-empty `OD_UPDATE_ENABLED` in the launch environment overrides the baked
value. For example, launching from a shell with `OD_UPDATE_ENABLED=1` turns the
updater back on for that session.

The baked `updateMetadataUrl` works differently. It describes which feed a
build belongs to rather than the installation, so it is applied only after
delegation, from the config of the bundle that actually runs desktop main. A
delegated payload keeps the feed it was built for. A non-empty
`OD_UPDATE_METADATA_URL` in the launch environment still takes precedence.

### Namespace and version caveat

The launcher prefers the newest payload already active in a namespace. If that
namespace previously received a payload newer than the fork's
`--app-version` (for example, an earlier build without the opt-out that the
official updater upgraded), launching the fork delegates to that payload. The
opt-out still keeps the payload's updater off, but the fork's own code does not
run. Use a namespace that has never received an official payload, or a fork
version above any payload already active there.

## Build a macOS package with the opt-out

Use Node 24 and the repository's pinned pnpm version:

```sh
pnpm --filter @open-design/tools-pack build
OD_UPDATE_ENABLED=0 pnpm tools-pack mac build \
  --namespace local-fork --app-version 0.24.1-fork.1 --to dmg
pnpm tools-pack mac install --namespace local-fork --app-version 0.24.1-fork.1
pnpm tools-pack mac start --namespace local-fork --app-version 0.24.1-fork.1
```

Lifecycle commands must use the same namespace and app version as the build.

Packaged daemon storage follows the
[Daemon data directory contract](../AGENTS.md#daemon-data-directory-contract).
Packaged logs and Electron settings follow the existing namespace isolation in
[tools/pack](../tools/pack/README.md).
