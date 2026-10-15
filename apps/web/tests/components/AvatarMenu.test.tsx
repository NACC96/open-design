// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildWorkspacePermissions,
  type WorkspaceBillingResponse,
  type WorkspaceCollabContext,
} from '@open-design/contracts';

import { workspaceBillingSummaryForContext } from '../../src/collab/useWorkspaceContext';
import { AvatarMenu } from '../../src/components/AvatarMenu';
import { providerModelsCacheKey } from '../../src/components/providerModelsCache';
import type { ProjectWorkspaceScopeState } from '../../src/collab/useProjectWorkspaceScope';
import type { AgentInfo, AppConfig, ExecMode } from '../../src/types';

const { openExternalUrlMock } = vi.hoisted(() => ({
  openExternalUrlMock: vi.fn<(url: string) => Promise<boolean>>(),
}));

vi.mock('../../src/i18n', () => ({
  useT: () => (key: string) => key,
}));

vi.mock('../../src/providers/registry', () => ({
  openExternalUrl: openExternalUrlMock,
}));


function personalWorkspaceContext(
  overrides: Partial<WorkspaceCollabContext> = {},
): WorkspaceCollabContext {
  return {
    workspaceId: 'ws-personal',
    workspaceType: 'personal',
    workspaceMemberId: 'wm-1',
    role: 'owner',
    memberStatus: 'active',
    lifecycleState: 'active',
    billingState: 'active',
    planId: null,
    providerMode: 'personal_byok',
    seatSummary: { seatLimit: 1, usedSeats: 1, availableSeats: 0, isSeatFull: false },
    permissions: {
      canManageMembers: true,
      canManageBilling: true,
      canInviteMembers: true,
      canManageAutoRecharge: true,
      canShareProjects: true,
      canWriteSyncedFiles: true,
      canViewWorkspaceSettings: true,
      canManageSharedResources: true,
    },
    ...overrides,
  } as WorkspaceCollabContext;
}

// A team MEMBER (not owner/admin) — `canManageBilling` folds in role, so this
// is the "cannot act on billing" case the upgrade entry must hide for.
function teamMemberWorkspaceContext(
  overrides: Partial<WorkspaceCollabContext> = {},
): WorkspaceCollabContext {
  return {
    ...personalWorkspaceContext(),
    workspaceId: 'ws-team',
    workspaceType: 'team',
    role: 'member',
    teamId: 'team-1',
    teamName: 'OD Feature Team',
    permissions: {
      canManageMembers: false,
      canManageBilling: false,
      canInviteMembers: false,
      canManageAutoRecharge: false,
      canShareProjects: true,
      canWriteSyncedFiles: true,
      canViewWorkspaceSettings: true,
      canManageSharedResources: false,
    },
    ...overrides,
  } as WorkspaceCollabContext;
}

function workspaceContextResponse(context: WorkspaceCollabContext | null) {
  return new Response(JSON.stringify({ context }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function workspaceSnapshot(
  workspaceId: string,
  workspaceMemberId: string,
  planId: string,
  balanceUsd: string,
) {
  return {
    schemaVersion: 1,
    workspaceId,
    workspaceMemberId,
    billingScopeVersion: 2,
    billing: {
      billingState: 'active',
      planId,
    },
    wallet: {
      balanceUsd,
      expiresAt: null,
      updatedAt: '2026-07-27T00:00:00.000Z',
    },
    revisions: {
      billing: 'billing-1',
      wallet: 'wallet-1',
    },
  };
}

const codexAgent: AgentInfo = {
  id: 'codex',
  name: 'Codex CLI',
  bin: 'codex',
  available: true,
  version: '0.134.0',
  models: [{ id: 'default', label: 'Default (CLI config)' }],
  reasoningOptions: [
    { id: 'default', label: 'Default' },
    { id: 'high', label: 'High' },
  ],
};

const claudeAgent: AgentInfo = {
  id: 'claude',
  name: 'Claude Code',
  bin: 'claude',
  available: true,
  version: '2.1.131',
  models: [
    { id: 'default', label: 'Default (CLI config)' },
    { id: 'sonnet', label: 'Sonnet (alias)' },
  ],
};

const deepSeekHarnessAgent: AgentInfo = {
  id: 'deepseek-harness',
  name: 'DeepSeek Harness',
  bin: 'dsh',
  available: true,
  version: '0.1.0-rc.6',
  models: [
    {
      id: 'deepseek/deepseek-v4-flash',
      label: 'DeepSeek-V4-Flash · DeepSeek',
      reasoningOptions: [
        { id: 'off', label: 'Off' },
        { id: 'high', label: 'High', default: true },
        { id: 'max', label: 'Max' },
      ],
    },
  ],
};

const baseConfig: AppConfig = {
  mode: 'daemon',
  apiKey: '',
  apiProtocol: 'anthropic',
  apiVersion: '',
  baseUrl: 'https://api.anthropic.com',
  apiProviderBaseUrl: 'https://api.anthropic.com',
  apiProtocolConfigs: {},
  model: 'claude-sonnet-4-5',
  agentId: 'codex',
  skillId: null,
  designSystemId: null,
  onboardingCompleted: true,
  mediaProviders: {},
  agentModels: { codex: { model: 'default', reasoning: 'default' } },
  agentCliEnv: {},
};

type EventSourceListener = (event: unknown) => void;
class MockAvatarEventSource {
  static instances: MockAvatarEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, Set<EventSourceListener>>();

  constructor(readonly url: string) {
    MockAvatarEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: EventSourceListener): void {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(listener);
  }

  removeEventListener(name: string, listener: EventSourceListener): void {
    this.listeners.get(name)?.delete(listener);
  }

  dispatch(name: string, data: unknown): void {
    for (const listener of this.listeners.get(name) ?? []) {
      listener({ data: JSON.stringify(data) });
    }
  }

  close(): void {}
}

type ModeChangeHandler = (mode: ExecMode) => void;
type AgentChangeHandler = (id: string) => void;
type AgentModelChangeHandler = (
  id: string,
  choice: { model?: string; reasoning?: string },
) => void;
type VoidHandler = () => void;
type OpenSettingsHandler = (section?: 'execution') => void;

function renderMenu({
  config = baseConfig,
  agents = [codexAgent, claudeAgent],
  daemonLive = true,
  onModeChange = vi.fn<ModeChangeHandler>(),
  onAgentChange = vi.fn<AgentChangeHandler>(),
  onAgentModelChange = vi.fn<AgentModelChangeHandler>(),
  onOpenSettings = vi.fn<OpenSettingsHandler>(),
  onRefreshAgents = vi.fn<VoidHandler>(),
  projectWorkspaceScope,
}: {
  config?: AppConfig;
  agents?: AgentInfo[];
  daemonLive?: boolean;
  onModeChange?: ReturnType<typeof vi.fn<ModeChangeHandler>>;
  onAgentChange?: ReturnType<typeof vi.fn<AgentChangeHandler>>;
  onAgentModelChange?: ReturnType<typeof vi.fn<AgentModelChangeHandler>>;
  onOpenSettings?: ReturnType<typeof vi.fn<OpenSettingsHandler>>;
  onRefreshAgents?: ReturnType<typeof vi.fn<VoidHandler>>;
  projectWorkspaceScope?: ProjectWorkspaceScopeState;
} = {}) {
  render(
    <AvatarMenu
      config={config}
      agents={agents}
      daemonLive={daemonLive}
      onModeChange={onModeChange}
      onAgentChange={onAgentChange}
      onAgentModelChange={onAgentModelChange}
      onOpenSettings={onOpenSettings}
      onRefreshAgents={onRefreshAgents}
      projectWorkspaceScope={projectWorkspaceScope}
    />,
  );
  return {
    onModeChange,
    onAgentChange,
    onAgentModelChange,
    onOpenSettings,
    onRefreshAgents,
  };
}

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'avatar.title' }));
  return screen.getByRole('dialog', { name: 'avatar.title' });
}

describe('AvatarMenu', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    vi.clearAllMocks();
    MockAvatarEventSource.instances = [];
  });

  // The composer popover is a one-decision surface: pick the model for the
  // active agent. Execution mode, which CLI agent runs, PATH rescan, reasoning
  // effort and the BYOK model are configuration, and live in
  // Settings → Execution. Keeping them out is what makes the popover compact.
  it('keeps execution configuration out of the composer popover', () => {
    const onOpenSettings = vi.fn<OpenSettingsHandler>();
    const onRefreshAgents = vi.fn<VoidHandler>();
    renderMenu({ daemonLive: false, onOpenSettings, onRefreshAgents });

    openMenu();

    // The execution console itself is gone from this popover per #5517: no mode
    // switch, no CLI list, no PATH rescan.
    expect(screen.queryByRole('button', { name: /avatar.useLocal/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /avatar.useApi/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'avatar.rescan' })).toBeNull();
    expect(onRefreshAgents).not.toHaveBeenCalled();

    // …but the link OUT to it must stay. #5517 has no such entry, and it also
    // never moved CLI switching out of this popover — we did, so without this
    // the place switching moved TO is unreachable from where it used to be.
    const openSettings = screen.getByTestId('avatar-open-execution-settings');
    expect(openSettings).toBeTruthy();
    fireEvent.click(openSettings);
    expect(onOpenSettings).toHaveBeenCalledWith('execution');
  });

  it('changes reasoning effort from the composer popover', () => {
    const { onAgentModelChange } = renderMenu({
      config: {
        ...baseConfig,
        agentId: 'deepseek-harness',
        agentModels: {
          'deepseek-harness': {
            model: 'deepseek/deepseek-v4-flash',
            reasoning: 'high',
          },
        },
      },
      agents: [deepSeekHarnessAgent],
    });

    const menu = openMenu();
    const reasoningSelect = within(menu).getByLabelText(
      'avatar.reasoningLabel',
    );
    expect(reasoningSelect).toHaveValue('high');
    expect(
      within(reasoningSelect).getAllByRole('option').map((option) => option.textContent),
    ).toEqual(['Off', 'High', 'Max']);

    fireEvent.change(reasoningSelect, { target: { value: 'max' } });

    expect(onAgentModelChange).toHaveBeenCalledWith('deepseek-harness', {
      reasoning: 'max',
    });
  });

  it('selects a model from the inline list and dismisses the popover', () => {
    const { onAgentModelChange } = renderMenu({
      config: { ...baseConfig, agentId: 'claude' },
      agents: [codexAgent, claudeAgent],
    });

    openMenu();
    const list = screen.getByTestId('avatar-model-list');
    const options = within(list).getAllByRole('radio');
    expect(options.map((o) => o.textContent)).toEqual([
      'Default (CLI config)',
      'Sonnet (alias)',
    ]);

    fireEvent.click(options[1]!);

    expect(onAgentModelChange).toHaveBeenCalledWith('claude', { model: 'sonnet' });
    expect(screen.queryByRole('dialog', { name: 'avatar.title' })).toBeNull();
  });

  it('clears a saved effort the next model does not offer when the model changes', () => {
    const effort = (ids: string[]) => ids.map((id) => ({ id, label: id }));
    const claude: AgentInfo = {
      ...claudeAgent,
      models: [
        { id: 'claude-opus-4-8', label: 'Opus 4.8', reasoningOptions: effort(['default', 'xhigh']) },
        { id: 'claude-opus-4-7', label: 'Opus 4.7', reasoningOptions: effort(['default', 'xhigh']) },
        { id: 'claude-haiku-4-5', label: 'Haiku 4.5', reasoningOptions: [] },
      ],
    };
    const { onAgentModelChange } = renderMenu({
      config: {
        ...baseConfig,
        agentId: 'claude',
        agentModels: { claude: { model: 'claude-opus-4-8', reasoning: 'xhigh' } },
      },
      agents: [claude],
    });

    openMenu();
    fireEvent.click(screen.getByTestId('avatar-model-option-claude-haiku-4-5'));
    const cleared = onAgentModelChange.mock.calls.at(-1)!;
    expect(cleared[0]).toBe('claude');
    expect(Object.prototype.hasOwnProperty.call(cleared[1], 'reasoning')).toBe(true);
    expect(cleared[1].reasoning).toBeUndefined();

    openMenu();
    fireEvent.click(screen.getByTestId('avatar-model-option-claude-opus-4-7'));
    const kept = onAgentModelChange.mock.calls.at(-1)!;
    expect(kept[1]).toMatchObject({ model: 'claude-opus-4-7' });
    expect(Object.prototype.hasOwnProperty.call(kept[1], 'reasoning')).toBe(false);
  });

  it('keeps a custom saved model visible when it is not in the declared agent model list', () => {
    renderMenu({
      config: {
        ...baseConfig,
        agentModels: { codex: { model: 'custom-codex-model', reasoning: 'default' } },
      },
    });

    openMenu();
    // The model picker is an always-expanded radio list. A custom saved model
    // that isn't in the agent's declared list is appended as an extra option so
    // it stays visible and checked instead of silently dropping.
    const list = screen.getByTestId('avatar-model-list');
    const custom = within(list).getByRole('radio', { name: /custom-codex-model/i });
    expect(custom.getAttribute('aria-checked')).toBe('true');
  });

  /*
   * The daemon's project scope route (`GET /api/projects/:id/workspace-scope`)
   * has exactly one branch, and it hardcodes `role: 'member'` for every caller —
   * that placeholder IS the read-only implementation and it is deliberately
   * resolved without the membership directory. So a project-page context can
   * never carry the real role, and asking IT whether the viewer may reach a
   * billing entrance demotes a workspace owner to a member.
   *
   * Consequence for this surface: `openAmrUpgrade` returned early, so a
   * plan-gated model still rendered its "upgrade to use this" tooltip and did
   * absolutely nothing when clicked. Only owners/admins ever saw it.
   */
  function projectScopeContext(
    overrides: Partial<WorkspaceCollabContext> = {},
  ): WorkspaceCollabContext {
    return {
      ...teamMemberWorkspaceContext({
        workspaceId: 'workspace-a',
        workspaceMemberId: 'member-a',
      }),
      // Whatever the caller's real role is, this is what the daemon answers.
      role: 'member',
      permissions: buildWorkspacePermissions({
        role: 'member',
        lifecycleState: 'active',
        memberStatus: 'active',
      }),
      ...overrides,
    } as WorkspaceCollabContext;
  }

  function stubLockedModelFetch(options: {
    ambientContext?: WorkspaceCollabContext | null;
    workspaceId: string;
    personalMembershipTier?: string;
  }) {
    const billingUrl = `/api/workspace/billing?scope=workspace&workspaceId=${options.workspaceId}${options.personalMembershipTier ? '&includePreflight=1' : ''}`;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === '/api/integrations/vela/status') {
        return new Response(JSON.stringify({
          loggedIn: true,
          loginInFlight: false,
          profile: 'feature-test',
          user: { id: 'u1', email: 'a@b.c' },
          account: { plan: 'max', balanceUsd: '9.12' },
          configPath: '/Users/test/.amr/config.json',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/workspace/directory') {
        // The ambient context is only resolved for a workspace this account is
        // actually a member of, so the directory has to name it first.
        const ambient = options.ambientContext;
        return new Response(JSON.stringify({
          items: ambient
            ? [{
                workspaceId: ambient.workspaceId,
                workspaceName: ambient.workspaceId,
                workspaceType: ambient.workspaceType,
                workspaceMemberId: ambient.workspaceMemberId,
                role: ambient.role,
                memberStatus: ambient.memberStatus,
                lifecycleState: ambient.lifecycleState,
              }]
            : [],
          activeWorkspaceId: ambient?.workspaceId ?? null,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/workspace/context') {
        return workspaceContextResponse(options.ambientContext ?? null);
      }
      if (url === billingUrl) {
        return new Response(JSON.stringify({
          summary: options.personalMembershipTier
            ? { membershipTier: options.personalMembershipTier }
            : null,
          workspaceBalance: {
            billingScopeVersion: 2,
            workspaceId: options.workspaceId,
            workspaceMemberId: 'member-a',
            balanceUsd: '9.12',
            expiresAt: null,
            updatedAt: '2026-07-27T00:00:00.000Z',
          },
          workspaceSnapshot: options.personalMembershipTier
            ? null
            : workspaceSnapshot(options.workspaceId, 'member-a', 'team_pro', '9.12'),
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 202 });
    }));
  }

  function renderLockedModelMenu(scopeContext: WorkspaceCollabContext) {
    return renderMenu({
      config: {
        ...baseConfig,
        agentId: 'amr',
        agentCliEnv: { amr: { OPEN_DESIGN_AMR_PROFILE: 'feature-test' } },
      },
      projectWorkspaceScope: {
        loading: false,
        scope: {
          kind: scopeContext.workspaceType === 'team' ? 'team' : 'personal',
          projectId: 'project-a',
          workspaceId: scopeContext.workspaceId,
          visibility: 'personal',
          context: scopeContext,
        } as ProjectWorkspaceScopeState['scope'],
      },
      agents: [{
        id: 'amr',
        name: 'OpenDesign AMR',
        bin: 'vela',
        available: true,
        models: [{ id: 'paid-model', label: 'Paid model', enabled: false }],
      }],
    });
  }

  /*
   * A team workspace whose exact billing SNAPSHOT is missing.
   *
   * The daemon spreads `workspaceSnapshot` into the response only when it can
   * authorize one for the requested workspace + member
   * (`apps/daemon/src/routes/collab-context.ts`), so production omits the KEY —
   * it never sends `workspaceSnapshot: null`. Three real paths reach that shape:
   * A answering 409 `billing_workspace_snapshot_unsupported` while
   * `/wallet/balance` still answers 200; a rolling deploy leaving an old API pod
   * that 404/405s the snapshot route; and a local vela CLI old enough to reject
   * `--workspace-id`. Fixtures that hand this surface a snapshot cannot see any
   * of them, which is why this one omits the key.
   */
  function teamBillingResponseBody(options: {
    workspaceId: string;
    accountMembershipTier: string;
    /**
     * Omit to model the missing-snapshot shape. `planId: null` +
     * `billingState: 'free'` is how B reports a team workspace nobody has
     * subscribed yet.
     */
    snapshot?: { planId: string | null; billingState: 'active' | 'free' };
  }) {
    return {
      // ACCOUNT-scoped read: the contract pins its workspaceId to null.
      summary: { membershipTier: options.accountMembershipTier },
      workspaceBalance: {
        billingScopeVersion: 2,
        workspaceId: options.workspaceId,
        workspaceMemberId: 'member-a',
        balanceUsd: '9.12',
        expiresAt: null,
        updatedAt: '2026-07-27T00:00:00.000Z',
      },
      ...(options.snapshot
        ? {
            workspaceSnapshot: {
              ...workspaceSnapshot(
                options.workspaceId,
                'member-a',
                options.snapshot.planId ?? '',
                '9.12',
              ),
              billing: options.snapshot,
            },
          }
        : {}),
    };
  }

  function stubTeamPlanFetch(options: {
    workspaceId: string;
    ambientContext: WorkspaceCollabContext;
    accountMembershipTier: string;
    snapshot?: { planId: string | null; billingState: 'active' | 'free' };
  }) {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      urls.push(url);
      if (url === '/api/integrations/vela/status') {
        return new Response(JSON.stringify({
          loggedIn: true,
          loginInFlight: false,
          profile: 'feature-test',
          user: { id: 'u1', email: 'a@b.c' },
          account: { plan: 'max', balanceUsd: '9.12' },
          configPath: '/Users/test/.amr/config.json',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/workspace/directory') {
        const ambient = options.ambientContext;
        return new Response(JSON.stringify({
          items: [{
            workspaceId: ambient.workspaceId,
            workspaceName: ambient.workspaceId,
            workspaceType: ambient.workspaceType,
            workspaceMemberId: ambient.workspaceMemberId,
            role: ambient.role,
            memberStatus: ambient.memberStatus,
            lifecycleState: ambient.lifecycleState,
          }],
          activeWorkspaceId: ambient.workspaceId,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === '/api/workspace/context') {
        return workspaceContextResponse(options.ambientContext);
      }
      if (url === `/api/workspace/billing?scope=workspace&workspaceId=${options.workspaceId}`) {
        return new Response(JSON.stringify(teamBillingResponseBody(options)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 202 });
    });
    vi.stubGlobal('fetch', fetchMock);
    return { fetchMock, urls };
  }

  function teamOwnerAmbientContext() {
    return teamMemberWorkspaceContext({
      workspaceId: 'workspace-a',
      workspaceMemberId: 'member-a',
      role: 'owner',
      permissions: buildWorkspacePermissions({
        role: 'owner',
        lifecycleState: 'active',
        memberStatus: 'active',
      }),
    });
  }

});
