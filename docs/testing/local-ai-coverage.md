# Local AI regression coverage

This fork exposes local CLI execution and opens Home directly. Cloud sign-in,
Cloud/BYOK onboarding, wallet and plan controls, team navigation, invite actions,
and switching a failed turn to Cloud are retired surfaces. Persisted history,
local project creation, local CLI detection/settings, local Retry, and existing
authority checks remain supported.

The table accounts for all 27 test files removed by the Local AI change against
`6522ffd8c0a2e6a9aa1a5d0829459d6cfbe02838`. Removed web paths are relative to
`apps/web/tests/`. A retired interaction does not require retaining its old UI
fixture; mixed suites transfer the still-supported behavior to the checks named
below. These are coverage locations, not a claim that every old assertion has
an identical replacement.

| Removed suite | Retirement or retained coverage |
| --- | --- |
| `apps/daemon/tests/amr-login-cli.test.ts` | Cloud login command retired; daemon `cli-startup.test.ts` checks command registration. |
| `apps/daemon/tests/collab-cli.test.ts` | Collaboration CLI retired; daemon `cli-startup.test.ts` checks registration; existing project authority tests remain. |
| `components/App.amr-plan-tier.test.tsx` | Cloud plan/upsell gating retired. |
| `components/App.amr-polling.test.tsx` | Cloud catalog/auth polling retired; local focus rescan restored in App first-run tests. |
| `components/App.onboarding-agent-autoselect.test.tsx` | Onboarding gate retired; local default, fallback and empty-agent selection live in App first-run tests. |
| `components/App.onboarding-amr-e2e.test.tsx` | Login/onboarding hosts retired; Home-first routing covered by App first-run and onboarding-completion persistence tests. |
| `components/App.switch-cloud-persistence.test.tsx` | Switching to Cloud retired; retained local configuration persistence is covered by `state/config.test.ts` and Settings execution tests. |
| `components/ChatPane.amr-auth-inline.test.tsx` | Cloud authorization handoff retired; local failure/retry actions covered by ChatPane error-card and run-error-actions parity tests. |
| `components/EntryShell.amr-balance-branches.test.tsx` | Wallet gating retired; local submit lifecycle covered by EntryShell local project and App creation-race tests. |
| `components/EntryShell.amr-pending-handoff.test.tsx` | Cloud balance precheck retired; local optimistic create, failure recovery and pending-submit coverage remain. |
| `components/EntryShell.amr-workspace-race.test.tsx` | Cloud account/billing recovery retired; local create ordering remains in App creation-race tests; daemon authority checks are retained. |
| `components/EntryShell.onboarding-dropdown.test.tsx` | Onboarding-only dropdown retired. Local model picker behavior is covered by InlineModelSwitcher tests. |
| `components/EntryShell.onboarding.test.tsx` | Onboarding flow retired. Local scroll reset and pending Home submit restored; local project/rail/naming tests and Settings connection/rescan tests remain. |
| `components/EntryShell.workspace-plan-badge-scope.test.tsx` | Workspace billing badges retired. |
| `components/InlineModelSwitcher.byok-chip-label.test.tsx` | BYOK chip retired; local agent/model labeling remains in InlineModelSwitcher tests. |
| `components/ProjectView.amr-balance-branches.test.tsx` | Cloud wallet/upgrade destinations retired. |
| `components/ProjectView.amr-balance-card.test.tsx` | Cloud balance cards retired. |
| `components/ProjectView.amr-retry-authority.test.tsx` | Cloud-switch retries retired; local Retry and approved-access error behavior remain covered. |
| `components/ProjectView.switch-cloud-current-failure.test.tsx` | Switching a failed turn to Cloud retired; local failure actions and historical question continuation remain covered. |
| `components/ProjectView.switch-cloud-in-place.test.tsx` | In-place Cloud switching retired; local Retry behavior covered by run-error-actions parity tests. |
| `components/RecentProjectsStrip.invite-target.test.tsx` | Team invitation/seat expansion entry retired; local list and project mutations remain covered. |
| `components/RecentProjectsStrip.move-owner-conflict.test.tsx` | Move-to-team UI action retired; local rename/delete/duplicate behavior remains covered by RecentProjectsStrip and App tests. |
| `components/SettingsDialog.team-plan-badge.test.tsx` | Team plan badge retired. |
| `components/SettingsDialog.top-tier-upgrade.test.tsx` | Upgrade affordances retired. |
| `components/chat/cloud-cta-handoff-presence.test.tsx` | Cloud CTA/handoff retired; local card actions covered by ChatPane and run-error-actions parity tests. |
| `components/chat/opend-2772-one-card-one-cta.test.tsx` | Cloud CTA composition retired; retained error-card behavior covered by ChatPane error-card suites. |
| `styles/onboarding-cli-chip-alignment.test.tsx` | Onboarding CLI chips retired; local provider controls remain covered in Settings execution tests. |

## Retained local behavior

- [App first-run tests](../../apps/web/tests/components/App.local-ai-only-first-run.test.tsx)
  cover direct Home entry, local default/fallback/no-agent behavior, retired
  configuration migration, and focus-triggered rescanning after external CLI
  installation or login. The focus check waits for the initial detection to
  finish before advancing the refresh throttle.
- [EntryShell local project tests](../../apps/web/tests/components/EntryShell.blank-project-naming.test.tsx)
  cover rail listing/rename, local project navigation, naming, shared-scroll
  reset in both directions, and a Home submit remaining pending until creation
  finishes.
- [App creation-race tests](../../apps/web/tests/components/App.project-create-race.test.tsx)
  retain optimistic creation, attachment failures, draft recovery, stale rescan
  ordering and local project mutation checks.
- [Settings execution tests](../../apps/web/tests/components/SettingsDialog.execution.test.tsx)
  retain local provider selection, test/rescan success and failure, CLI env
  autosave, pending autosave rejection on unmount, and concurrent settings-save
  ordering. These cases remain in the existing suite rather than restoring
  onboarding-only fixtures.
- [Run error action tests](../../apps/web/tests/components/chat/run-error-actions-parity.test.tsx)
  and [historical question continuation](../../apps/web/tests/runtime/strategy-question-continuation.test.ts)
  cover retained local recovery behavior.
- [Project request authority](../../apps/daemon/tests/collab/project-request-authority.test.ts)
  retains the distinction between local personal writes and team authority.

Run the owning web/daemon Vitest suites on Node ~24, together with `pnpm guard`
and `pnpm typecheck`. Browser/packaged checks and live provider acceptance are
separate evidence; static screenshots and helper-only probes do not establish
them.
