// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceCollabContext } from '@open-design/contracts';
import { InlineModelSwitcher } from '../../src/components/InlineModelSwitcher';
import {
  AMR_LOGIN_POLL_INTERVAL_MS,
  AMR_LOGIN_TIMEOUT_MS,
} from '../../src/components/amrLoginPolling';
import { fetchProviderModels } from '../../src/providers/provider-models';
import { providerModelsCacheKey } from '../../src/components/providerModelsCache';
import { resetWorkspaceContextCache } from '../../src/collab/useWorkspaceContext';
import type { AgentInfo, AppConfig, ProviderModelOption } from '../../src/types';
import { workspaceDirectoryFixture } from '../helpers/workspace-context';

const analyticsMocks = vi.hoisted(() => ({ track: vi.fn() }));

vi.mock('../../src/analytics/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/analytics/provider')>();
  return {
    ...actual,
    useAnalytics: () => ({
      track: analyticsMocks.track,
      setConsent: vi.fn(),
      setIdentity: vi.fn(),
      setConfigureGlobals: vi.fn(),
      setUserId: vi.fn(),
      anonymousId: 'test-anonymous-id',
      sessionId: 'test-session-id',
      newRequestId: () => 'test-request-id',
    }),
  };
});

function optionNames(container: HTMLElement): string[] {
  return within(container).getAllByRole('option').map((option) => {
    const labelledBy = option.getAttribute('aria-labelledby');
    if (!labelledBy) return option.textContent?.trim() ?? '';
    return labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
      .filter(Boolean)
      .join(' ');
  });
}

vi.mock('../../src/providers/provider-models', () => ({
  fetchProviderModels: vi.fn(),
}));

const baseConfig: AppConfig = {
  mode: 'daemon',
  apiKey: '',
  apiProtocol: 'anthropic',
  apiVersion: '',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-sonnet-4-5',
  apiProviderBaseUrl: 'https://api.anthropic.com',
  apiProtocolConfigs: {},
  agentId: 'amr',
  skillId: null,
  designSystemId: null,
  onboardingCompleted: true,
  mediaProviders: {},
  agentModels: {},
  agentCliEnv: {},
};

const amrAgent: AgentInfo = {
  id: 'amr',
  name: 'AMR (vela)',
  bin: 'amr',
  available: true,
  version: '1.0.0',
  models: [
    { id: 'default', label: 'Default' },
    { id: 'amr-cloud-latest', label: 'AMR Cloud Latest' },
  ],
};

const codexAgent: AgentInfo = {
  id: 'codex',
  name: 'Codex CLI',
  bin: 'codex',
  available: true,
  version: '0.133.0-alpha.1',
  models: [{ id: 'default', label: 'Default' }],
};

function renderSwitcher(
  config: Partial<AppConfig> = {},
  agents: AgentInfo[] = [amrAgent],
  providerModelsCache: Record<string, ProviderModelOption[]> = {},
  options: { compact?: boolean } = {},
) {
  const onAgentModelChange = vi.fn();
  const view = render(
    <InlineModelSwitcher
      config={{ ...baseConfig, ...config }}
      agents={agents}
      providerModelsCache={providerModelsCache}
      compact={options.compact}
      daemonLive={true}
      onModeChange={vi.fn()}
      onAgentChange={vi.fn()}
      onAgentModelChange={onAgentModelChange}
      onApiProtocolChange={vi.fn()}
      onApiModelChange={vi.fn()}
      onOpenSettings={vi.fn()}
    />,
  );
  return { ...view, onAgentModelChange };
}

// recvqfYKutwWlQ: the AMR upgrade entry point must only render for a caller who
// can actually act on it (`permissions.canManageBilling`), never just a
// caller whose plan tier happens to be upgradeable. Personal workspaces
// resolve `canManageBilling` true because the user is always their own owner
// there (`buildWorkspacePermissions`: `canManageBilling: readable && isOwner`),
// so this fixture doubles as the "personal identity keeps the upgrade entry"
// control case.
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

function workspaceDirectoryResponse(context: WorkspaceCollabContext) {
  return new Response(JSON.stringify(workspaceDirectoryFixture([context])), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function expectVelaLoginWithAttribution(
  fetchMock: ReturnType<typeof vi.fn>,
  sourceDetail: string,
) {
  const loginCall = fetchMock.mock.calls.find(([input, init]) => (
    input.toString() === '/api/integrations/vela/login'
    && (init as RequestInit | undefined)?.method === 'POST'
  ));
  expect(loginCall).toBeDefined();
  const init = loginCall?.[1] as RequestInit | undefined;
  expect(init).toEqual(expect.objectContaining({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: expect.any(String),
  }));
  const body = JSON.parse(String(init?.body)) as {
    attribution?: {
      entryId?: string;
      sourceProduct?: string;
      sourceDetail?: string;
      occurredAt?: string;
    };
  };
  expect(body.attribution).toEqual(expect.objectContaining({
    entryId: expect.stringMatching(/^od-amr-/u),
    sourceProduct: 'open_design',
    sourceDetail,
  }));
  expect(Number.isFinite(Date.parse(body.attribution?.occurredAt ?? ''))).toBe(true);
}

describe('InlineModelSwitcher Local AI', () => {
  it('hides Cloud and BYOK controls even when a stale catalog and config include them', () => {
    renderSwitcher({ mode: 'api', agentId: 'amr' }, [codexAgent, amrAgent, { ...amrAgent, id: 'byok-opencode' }]);
    fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));
    expect(screen.getByTestId('inline-model-switcher-popover')).toBeTruthy();
    expect(screen.queryByRole('tab', { name: /API|BYOK/i })).toBeNull();
    expect(screen.queryByText('OpenDesign')).toBeNull();
    expect(screen.queryByText(/Sign in|Upgrade|API Key/i)).toBeNull();
    expect(vi.mocked(fetchProviderModels)).not.toHaveBeenCalled();
  });

  afterEach(() => {
    cleanup();
    vi.mocked(fetchProviderModels).mockReset();
    analyticsMocks.track.mockReset();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    try {
      window.localStorage.clear();
    } catch {
      // jsdom normally exposes localStorage; keep cleanup tolerant.
    }
    resetWorkspaceContextCache();
  });

  it.each([false, true])('exposes model-specific effort in the chat picker (compact=%s)', (compact) => {
    const claude: AgentInfo = {
      id: 'claude', name: 'Claude Code', bin: 'claude', available: true,
      models: [{
        id: 'claude-haiku-5-5', label: 'Haiku 5.5',
        reasoningOptions: [
          { id: 'default', label: 'CLI default', default: true },
          { id: 'medium', label: 'Medium' },
          { id: 'max', label: 'Max' },
        ],
      }],
    };
    const view = renderSwitcher({
      agentId: 'claude',
      agentModels: { claude: { model: 'claude-haiku-5-5', reasoning: 'max' } },
    }, [claude], {}, { compact });
    fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));
    const picker = screen.getByRole('combobox', { name: 'Reasoning effort' });
    expect((picker as HTMLSelectElement).value).toBe('max');
    fireEvent.change(picker, { target: { value: 'medium' } });
    expect(view.onAgentModelChange).toHaveBeenLastCalledWith('claude', { reasoning: 'medium' });
  });

  it('hides chat effort when the selected model declares no effort support', () => {
    const claude: AgentInfo = {
      id: 'claude', name: 'Claude Code', bin: 'claude', available: true,
      models: [{ id: 'claude-haiku-4-5', label: 'Haiku 4.5', reasoningOptions: [] }],
      reasoningOptions: [{ id: 'high', label: 'High' }],
    };
    renderSwitcher({ agentId: 'claude', agentModels: { claude: { model: 'claude-haiku-4-5' } } }, [claude]);
    fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));
    expect(screen.queryByRole('combobox', { name: 'Reasoning effort' })).toBeNull();
  });

  it('offers effort to a non-Claude agent with its own labels and tracks the change', () => {
    analyticsMocks.track.mockClear();
    const codex: AgentInfo = {
      ...codexAgent,
      models: [{ id: 'default', label: 'Default' }, { id: 'gpt-5.5', label: 'gpt-5.5' }],
      reasoningOptions: [
        { id: 'default', label: 'Default' },
        { id: 'low', label: 'Low' },
        { id: 'high', label: 'High' },
      ],
    };
    const view = renderSwitcher({
      agentId: 'codex',
      agentModels: { codex: { model: 'gpt-5.5' } },
    }, [codex], {}, { compact: true });
    fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));
    const picker = screen.getByRole('combobox', { name: 'Reasoning effort' }) as HTMLSelectElement;
    // The agent's own option labels, exactly as Settings and the avatar menu
    // render them — not the model picker's "CLI default" wording.
    expect(Array.from(picker.options).map((option) => option.textContent)).toEqual([
      'Default', 'Low', 'High',
    ]);
    expect(picker.value).toBe('default');

    fireEvent.change(picker, { target: { value: 'high' } });

    expect(view.onAgentModelChange).toHaveBeenLastCalledWith('codex', { reasoning: 'high' });
    const [eventName, props] = analyticsMocks.track.mock.calls.at(-1)!;
    expect(eventName).toBe('ui_click');
    expect(props).toMatchObject({
      page_name: 'home',
      area: 'execution_settings_popover',
      element: 'reasoning_dropdown',
      execution_mode: 'local_cli',
      cli_provider_id: 'codex_cli',
      model_id: 'gpt-5.5',
      reasoning_effort: 'high',
    });
  });

  it('clears a saved effort the next model does not offer when the model changes', () => {
    const effort = (ids: string[]) => ids.map((id) => ({ id, label: id }));
    const claude: AgentInfo = {
      id: 'claude', name: 'Claude Code', bin: 'claude', available: true,
      models: [
        { id: 'claude-opus-4-8', label: 'Opus 4.8', reasoningOptions: effort(['default', 'high', 'xhigh']) },
        { id: 'claude-opus-4-7', label: 'Opus 4.7', reasoningOptions: effort(['default', 'high', 'xhigh']) },
        { id: 'claude-opus-4-6', label: 'Opus 4.6', reasoningOptions: effort(['default', 'high']) },
      ],
    };
    const view = renderSwitcher({
      agentId: 'claude',
      agentModels: { claude: { model: 'claude-opus-4-8', reasoning: 'xhigh' } },
    }, [claude], {}, { compact: true });

    fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));
    fireEvent.click(screen.getByTestId('inline-model-switcher-compact-model-claude-opus-4-6'));

    const cleared = view.onAgentModelChange.mock.calls.at(-1)!;
    expect(cleared[0]).toBe('claude');
    expect(cleared[1]).toEqual({ model: 'claude-opus-4-6', reasoning: undefined });
    // The own `undefined` key is what tells `mergeAgentModelChoice` to delete
    // the saved level instead of keeping it.
    expect(Object.prototype.hasOwnProperty.call(cleared[1], 'reasoning')).toBe(true);

    // A model that still lists the saved level keeps it.
    fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));
    fireEvent.click(screen.getByTestId('inline-model-switcher-compact-model-claude-opus-4-7'));
    const kept = view.onAgentModelChange.mock.calls.at(-1)!;
    expect(kept[1]).toEqual({ model: 'claude-opus-4-7' });
    expect(Object.prototype.hasOwnProperty.call(kept[1], 'reasoning')).toBe(false);
  });

  it('can render the compact home-hero chip variant', () => {
    renderSwitcher({}, [amrAgent, codexAgent], {}, { compact: true });

    expect(screen.getByTestId('inline-model-switcher').className).toContain(
      'inline-switcher--compact',
    );
  });
});
