// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenDesignHostUpdaterStatusSnapshot } from '@open-design/host';
import { installMockOpenDesignHost } from '@open-design/host/testing';
import type { WorkspaceCollabContext } from '@open-design/contracts';
import { en } from '../../src/i18n/locales/en';

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

const {
  playSoundMock,
  requestNotificationPermissionMock,
  showCompletionNotificationMock,
  notificationPermissionMock,
  fetchCodexPetsMock,
  syncCommunityPetsMock,
  fetchSkillsMock,
  fetchDesignSystemsMock,
  fetchSkillMock,
  fetchDesignSystemMock,
  importLocalDesignSystemMock,
  importGitHubDesignSystemMock,
  fetchProviderModelsMock,
  fetchLatestGithubReleaseInfoMock,
  openExternalUrlMock,
  analyticsTrackMock,
} = vi.hoisted(() => ({
  playSoundMock: vi.fn(),
  requestNotificationPermissionMock: vi.fn(),
  showCompletionNotificationMock: vi.fn(),
  notificationPermissionMock: vi.fn(),
  fetchCodexPetsMock: vi.fn(),
  syncCommunityPetsMock: vi.fn(),
  fetchSkillsMock: vi.fn(),
  fetchDesignSystemsMock: vi.fn(),
  fetchSkillMock: vi.fn(),
  fetchDesignSystemMock: vi.fn(),
  importLocalDesignSystemMock: vi.fn(),
  importGitHubDesignSystemMock: vi.fn(),
  fetchProviderModelsMock: vi.fn(),
  fetchLatestGithubReleaseInfoMock: vi.fn(),
  openExternalUrlMock: vi.fn(),
  analyticsTrackMock: vi.fn(),
}));

vi.mock('../../src/utils/notifications', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/notifications')>(
    '../../src/utils/notifications',
  );
  return {
    ...actual,
    playSound: playSoundMock,
    requestNotificationPermission: requestNotificationPermissionMock,
    showCompletionNotification: showCompletionNotificationMock,
    notificationPermission: notificationPermissionMock,
  };
});

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    fetchCodexPets: fetchCodexPetsMock,
    syncCommunityPets: syncCommunityPetsMock,
    fetchSkills: fetchSkillsMock,
    fetchDesignSystems: fetchDesignSystemsMock,
    fetchSkill: fetchSkillMock,
    fetchDesignSystem: fetchDesignSystemMock,
    importLocalDesignSystem: importLocalDesignSystemMock,
    importGitHubDesignSystem: importGitHubDesignSystemMock,
    fetchLatestGithubReleaseInfo: fetchLatestGithubReleaseInfoMock,
    openExternalUrl: openExternalUrlMock,
    codexPetSpritesheetUrl: (pet: { spritesheetUrl: string }) => pet.spritesheetUrl,
  };
});

vi.mock('../../src/providers/provider-models', () => ({
  fetchProviderModels: fetchProviderModelsMock,
}));

vi.mock('../../src/analytics/provider', () => ({
  useAnalytics: () => ({
    track: analyticsTrackMock,
    setConsent: () => undefined,
    setIdentity: () => undefined,
    setConfigureGlobals: () => undefined,
    anonymousId: 'test-anonymous',
    sessionId: 'test-session',
    newRequestId: () => 'test-request',
  }),
}));

import { SettingsDialog } from '../../src/components/SettingsDialog';
import { IntegrationsView } from '../../src/components/IntegrationsView';
import type { AgentRefreshOptions, SettingsSection } from '../../src/components/SettingsDialog';
import { reconcileAmrModelChoice } from '../../src/components/SettingsDialog';
import { reconcileAmrProfileEnv } from '../../src/components/SettingsDialog';
import { providerModelsCacheKey } from '../../src/components/providerModelsCache';
import { I18nProvider } from '../../src/i18n';
import { LOCALES } from '../../src/i18n/types';
import { MAX_MAX_TOKENS, MIN_MAX_TOKENS } from '../../src/state/maxTokens';
import { workspaceDirectoryFixture } from '../helpers/workspace-context';
import type {
  AgentInfo,
  AppConfig,
  AppVersionInfo,
  ProviderModelOption,
} from '../../src/types';

const baseConfig: AppConfig = {
  mode: 'api',
  apiKey: '',
  apiProtocol: 'anthropic',
  apiVersion: '',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-sonnet-4-5',
  apiProviderBaseUrl: 'https://api.anthropic.com',
  apiProtocolConfigs: {},
  agentId: null,
  skillId: null,
  designSystemId: null,
  onboardingCompleted: true,
  mediaProviders: {},
  agentModels: {},
  agentCliEnv: {},
};

const availableAgents: AgentInfo[] = [
  {
    id: 'codex',
    name: 'Codex CLI',
    bin: 'codex',
    available: true,
    version: '0.80.0',
    models: [{ id: 'default', label: 'Default' }],
  },
];

const amrAgent: AgentInfo = {
  id: 'amr',
  name: 'AMR (vela)',
  bin: 'amr',
  available: true,
  version: '1.0.0',
  models: [{ id: 'default', label: 'Default' }],
  supportsCustomModel: false,
};

// recvqfYKutwWlQ: the AMR upgrade entry point must only render for a caller
// who can actually act on it (`permissions.canManageBilling`), never just a
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

function workspaceDirectoryResponse(
  context: WorkspaceCollabContext | null,
): Response {
  return new Response(
    JSON.stringify(workspaceDirectoryFixture(context ? [context] : [])),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  );
}

const inFlightAuthAttemptId = '936da01f-9abd-4d9d-80c7-02af85c822a8';

type OnRefreshAgents = (
  options?: AgentRefreshOptions,
) => void | AgentInfo[] | Promise<void | AgentInfo[]>;

const sampleBundledPets = [
  {
    id: 'dario',
    displayName: 'Dario',
    description: 'A tiny frustrated companion.',
    spritesheetUrl: '/api/codex-pets/dario.webp',
    spritesheetExt: 'webp',
    hatchedAt: 1710000000000,
    bundled: true,
  },
  {
    id: 'nyako',
    displayName: 'Nyako',
    description: 'A warm companion.',
    spritesheetUrl: '/api/codex-pets/nyako.webp',
    spritesheetExt: 'webp',
    hatchedAt: 1710000001000,
    bundled: true,
  },
];

const sampleCommunityPets = [
  {
    id: 'jade',
    displayName: 'Jade',
    description: 'A cheerful explorer.',
    spritesheetUrl: '/api/codex-pets/jade.webp',
    spritesheetExt: 'webp',
    hatchedAt: 1710000010000,
  },
  {
    id: 'voidling',
    displayName: 'Voidling',
    description: 'A tiny grim companion.',
    spritesheetUrl: '/api/codex-pets/voidling.webp',
    spritesheetExt: 'webp',
    hatchedAt: 1710000020000,
  },
];

const sampleSkills = [
  {
    id: 'blog-post',
    name: 'blog-post',
    description: 'A long-form article / blog post.',
    mode: 'prototype',
    previewType: 'HTML',
  },
  {
    id: 'dashboard',
    name: 'dashboard',
    description: 'Admin / analytics dashboard.',
    mode: 'prototype',
    previewType: 'HTML',
  },
  {
    id: 'sales-deck',
    name: 'sales-deck',
    description: 'A narrative sales presentation.',
    mode: 'deck',
    previewType: 'PPTX',
  },
];

const sampleDesignSystems = [
  {
    id: 'neutral-modern',
    title: 'Neutral Modern',
    summary: 'Calm editorial neutrals.',
    category: 'Default',
    swatches: ['#111827', '#f5f5f4'],
  },
  {
    id: 'signal-green',
    title: 'Signal Green',
    summary: 'Brighter utility system.',
    category: 'Experimental',
    swatches: ['#14532d', '#86efac'],
  },
];

let restoreOpenDesignHost: (() => void) | null = null;

function updateStatus(
  overrides: Partial<OpenDesignHostUpdaterStatusSnapshot> = {},
): OpenDesignHostUpdaterStatusSnapshot {
  return {
    arch: 'arm64',
    capabilities: {
      canApplyInPlace: false,
      canDownload: true,
      canOpenInstaller: true,
      requiresManualInstall: true,
    },
    channel: 'beta',
    currentVersion: '1.2.3-beta.3',
    enabled: true,
    mode: 'package-launcher',
    platform: 'darwin',
    state: 'idle',
    supported: true,
    ...overrides,
  };
}

function renderSettingsDialog(
  initial: Partial<AppConfig> = {},
  options: {
    agents?: AgentInfo[];
    daemonLive?: boolean;
    onRefreshAgents?: OnRefreshAgents;
    initialSection?: SettingsSection;
    locale?: Parameters<typeof I18nProvider>[0]['initial'];
    appVersionInfo?: AppVersionInfo | null;
    providerModelsCache?: Record<string, ProviderModelOption[]>;
    welcome?: boolean;
    onSilentUpdatePreferenceChange?: (allowSilentUpdates: boolean) => Promise<void>;
    onResetOnboarding?: (next: AppConfig) => void;
  } = {},
) {
  const onPersist = vi.fn();
  const onPersistComposioKey = vi.fn();
  const onSilentUpdatePreferenceChange: (allowSilentUpdates: boolean) => Promise<void> =
    options.onSilentUpdatePreferenceChange
    ?? (async () => undefined);
  const onClose = vi.fn();
  const onRefreshAgents = options.onRefreshAgents ?? vi.fn<OnRefreshAgents>();

  const dialog = (
    <SettingsDialog
      initial={{ ...baseConfig, ...initial }}
      agents={options.agents ?? availableAgents}
      daemonLive={options.daemonLive ?? true}
      appVersionInfo={options.appVersionInfo ?? null}
      initialSection={options.initialSection ?? 'execution'}
      providerModelsCache={options.providerModelsCache}
      welcome={options.welcome}
      onPersist={onPersist}
      onSilentUpdatePreferenceChange={onSilentUpdatePreferenceChange}
      onPersistComposioKey={onPersistComposioKey}
      onClose={onClose}
      onResetOnboarding={options.onResetOnboarding}
      onRefreshAgents={onRefreshAgents}
    />
  );
  const view = render(
    options.locale
      ? <I18nProvider initial={options.locale}>{dialog}</I18nProvider>
      : dialog,
  );

  return {
    onPersist,
    onSilentUpdatePreferenceChange,
    onPersistComposioKey,
    onClose,
    onRefreshAgents,
    ...view,
  };
}

function renderIntegrationsView(
  initial: Partial<AppConfig> = {},
  options: {
    initialTab?: 'mcp' | 'connectors' | 'skills' | 'use-everywhere';
  } = {},
) {
  const onConfigPersist = vi.fn();
  const onPersistComposioKey = vi.fn();
  const view = render(
    <IntegrationsView
      config={{ ...baseConfig, ...initial }}
      initialTab={options.initialTab ?? 'mcp'}
      onConfigPersist={onConfigPersist}
      onPersistComposioKey={onPersistComposioKey}
    />,
  );

  return { onConfigPersist, onPersistComposioKey, ...view };
}

function renderLanguageSettingsDialog(initialLocale: Parameters<typeof I18nProvider>[0]['initial'] = 'en') {
  const onPersist = vi.fn();
  const onClose = vi.fn();

  render(
    <I18nProvider initial={initialLocale}>
      <SettingsDialog
        initial={baseConfig}
        agents={availableAgents}
        daemonLive={true}
        appVersionInfo={null}
        initialSection="language"
        onPersist={onPersist}
        onPersistComposioKey={vi.fn()}
        onClose={onClose}
        onRefreshAgents={vi.fn()}
      />
    </I18nProvider>,
  );

  return { onPersist, onClose };
}

async function waitForPersist(
  onPersist: ReturnType<typeof vi.fn>,
  expectedConfig: unknown,
  expectedOptions: { forceMediaProviderSync?: boolean } = { forceMediaProviderSync: false },
) {
  await waitFor(() => {
    expect(onPersist).toHaveBeenCalledWith(
      expectedConfig,
      expect.objectContaining(expectedOptions),
    );
  });
}

function openGatewayPresetPopover() {
  fireEvent.click(screen.getByRole('combobox', { name: 'Provider preset' }));
  return screen.getByTestId('settings-byok-provider-preset-popover');
}

function selectGatewayPreset(label: string) {
  const popover = openGatewayPresetPopover();
  fireEvent.click(within(popover).getByRole('option', { name: label }));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  playSoundMock.mockReset();
  requestNotificationPermissionMock.mockReset();
  showCompletionNotificationMock.mockReset();
  notificationPermissionMock.mockReset();
  fetchCodexPetsMock.mockReset();
  syncCommunityPetsMock.mockReset();
  fetchSkillsMock.mockReset();
  fetchDesignSystemsMock.mockReset();
  fetchSkillMock.mockReset();
  fetchDesignSystemMock.mockReset();
  importLocalDesignSystemMock.mockReset();
  importGitHubDesignSystemMock.mockReset();
  fetchProviderModelsMock.mockReset();
  openExternalUrlMock.mockReset();
  analyticsTrackMock.mockReset();
  notificationPermissionMock.mockReturnValue('default');
  requestNotificationPermissionMock.mockResolvedValue('granted');
  showCompletionNotificationMock.mockResolvedValue('shown');
  fetchCodexPetsMock.mockResolvedValue({
    pets: [],
    rootDir: '/Users/test/.codex/pets',
  });
  syncCommunityPetsMock.mockResolvedValue({
    wrote: 0,
    skipped: 0,
    failed: 0,
    total: 0,
    rootDir: '/Users/test/.codex/pets',
    errors: [],
  });
  fetchSkillsMock.mockResolvedValue(sampleSkills);
  fetchDesignSystemsMock.mockResolvedValue(sampleDesignSystems);
  fetchSkillMock.mockImplementation(async (id: string) => ({
    id,
    body: `skill body for ${id}`,
  }));
  fetchDesignSystemMock.mockImplementation(async (id: string) => ({
    id,
    body: `design system body for ${id}`,
  }));
  fetchLatestGithubReleaseInfoMock.mockReset();
  fetchLatestGithubReleaseInfoMock.mockResolvedValue(null);
  openExternalUrlMock.mockResolvedValue(true);
  importLocalDesignSystemMock.mockResolvedValue({
    designSystem: {
      id: 'imported-system',
      title: 'Imported System',
      summary: 'A newly imported system.',
      category: 'Imported',
      swatches: ['#0f766e', '#ccfbf1'],
    },
  });
  importGitHubDesignSystemMock.mockResolvedValue({
    designSystem: {
      id: 'github-system',
      title: 'GitHub System',
      summary: 'A GitHub imported system.',
      category: 'Imported',
      swatches: ['#1d4ed8', '#bfdbfe'],
    },
  });
  fetchProviderModelsMock.mockResolvedValue({
    ok: true,
    kind: 'success',
    latencyMs: 1,
    models: [],
  });
});

afterEach(() => {
  restoreOpenDesignHost?.();
  restoreOpenDesignHost = null;
});

describe('SettingsDialog privacy settings interactions', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('preserves a pending privacy choice when an unrelated parent config update arrives', async () => {
    const randomUUID = vi.fn(() => 'inst-new');
    vi.stubGlobal('crypto', { randomUUID });
    const initial: AppConfig = {
      ...baseConfig,
      mode: 'daemon',
      agentId: null,
      installationId: null,
      // Undecided: the consent card (and its Share button) only renders before
      // a choice exists — deciding swaps it for the toggles it just set.
      telemetry: { metrics: false, content: false, artifactManifest: true },
    };
    const view = renderSettingsDialog(initial, { initialSection: 'privacy' });

    fireEvent.click(screen.getByRole('button', { name: 'Share' }));

    await waitFor(() => {
      expect((screen.getByLabelText('Anonymous ID') as HTMLInputElement).value).toBe('inst-new');
    });

    view.rerender(
      <SettingsDialog
        initial={{ ...initial, agentId: 'codex' }}
        agents={availableAgents}
        daemonLive={true}
        appVersionInfo={null}
        initialSection="privacy"
        onPersist={view.onPersist}
        onPersistComposioKey={view.onPersistComposioKey}
        onClose={view.onClose}
        onRefreshAgents={view.onRefreshAgents}
      />,
    );

    // The pending choice survives the unrelated parent update: the card is
    // gone (a decision exists now) and the toggles it set are still on.
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull();
    expect((screen.getByLabelText('Anonymous ID') as HTMLInputElement).value).toBe('inst-new');
    expect(screen.getByRole('button', { name: /Anonymous metrics/ }).getAttribute('aria-pressed'))
      .toBe('true');
    expect(screen.getByRole('button', { name: /Conversation and tool content/ }).getAttribute('aria-pressed'))
      .toBe('true');
  });
});

describe('SettingsDialog execution settings Local CLI interactions', () => {
  it('exposes only Local CLI controls for a migrated API/Cloud configuration', () => {
    renderSettingsDialog(
      { mode: 'api', agentId: 'amr', onboardingCompleted: false },
      { agents: [...availableAgents, amrAgent, { ...amrAgent, id: 'byok-opencode' }] },
    );
    expect(screen.getByRole('tab', { name: /Local CLI/i })).toBeTruthy();
    expect(screen.getByTestId('settings-agent-card-codex')).toBeTruthy();
    expect(screen.queryByTestId('settings-agent-card-amr')).toBeNull();
    expect(screen.queryByTestId('settings-agent-card-byok-opencode')).toBeNull();
    expect(screen.queryByRole('tab', { name: /API providers/i })).toBeNull();
    expect(screen.queryByText('Use OpenDesign Cloud')).toBeNull();
    expect(screen.queryByLabelText(/^API key$/i)).toBeNull();
    fireEvent.click(screen.getByText('About', { selector: 'strong' }));
    expect(screen.queryByText('Run setup again')).toBeNull();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lets users switch to Local CLI, select an installed agent, and autosave', async () => {
    const installed = availableAgents[0]!;
    const unavailable: AgentInfo = {
      id: 'kimi',
      name: 'Kimi CLI',
      bin: 'kimi',
      available: false,
      version: null,
      models: [],
      installUrl: 'https://github.com/MoonshotAI/kimi-cli',
      docsUrl: 'https://www.kimi.com/code/docs/en/kimi-cli/guides/getting-started.html?aff=open-design',
    };
    const { onPersist } = renderSettingsDialog(
      { mode: 'daemon', agentId: null },
      { agents: [installed, unavailable] },
    );

    const localCliTab = screen.getByRole('tab', { name: /Local CLI.*1 installed/i });
    fireEvent.click(localCliTab);

    expect(screen.getByText('Installed CLIs (1)')).toBeTruthy();
    const installGroupSummary = screen.getByText('Available CLIs (1)');
    expect(installGroupSummary.closest('details')?.hasAttribute('open')).toBe(false);
    const codexCard = screen.getByRole('button', { name: /Codex CLI/i }) as HTMLButtonElement;
    fireEvent.click(installGroupSummary);
    const kimiGroup = screen.getByRole('group', { name: /Kimi CLI/i });
    expect(within(kimiGroup).getByText('Moonshot Kimi CLI')).toBeTruthy();
    expect(
      (within(kimiGroup).getByRole('link', { name: en['settings.agentInstall.install'] }) as HTMLAnchorElement).getAttribute('href'),
    ).toBe(
      'https://github.com/MoonshotAI/kimi-cli',
    );
    expect(
      screen.getByText(en['settings.agentInstall.stepAuth']),
    ).toBeTruthy();
    expect(
      screen.getByText(en['settings.agentInstall.stepSelect']),
    ).toBeTruthy();
    expect(screen.getByText(en['settings.agentInstall.pathHint'])).toBeTruthy();

    fireEvent.click(codexCard);
    const selectedCard = codexCard.closest('.agent-card') as HTMLElement;
    const selectedModelPicker = within(selectedCard).getByRole('combobox', {
      name: en['settings.modelPicker'],
    });
    expect(selectedModelPicker.textContent).toContain('CLI default');
    expect(
      selectedCard.compareDocumentPosition(installGroupSummary) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await waitForPersist(
      onPersist,
      expect.objectContaining({
        mode: 'daemon',
        agentId: 'codex',
      }),
      {},
    );
  });

  it('filters long Local CLI model lists in Settings without hiding the current selection', () => {
    renderSettingsDialog(
      { mode: 'daemon', agentId: 'codex', agentModels: { codex: { model: 'gpt-4.1-mini' } } },
      {
        agents: [
          {
            ...availableAgents[0]!,
            modelsSource: 'live',
            models: [
              { id: 'default', label: 'Default' },
              { id: 'gpt-4.1-mini', label: 'gpt-4.1-mini' },
              { id: 'gpt-4.1', label: 'gpt-4.1' },
              { id: 'gpt-5.5', label: 'gpt-5.5' },
              { id: 'o4-mini', label: 'o4-mini' },
              { id: 'o3', label: 'o3' },
              { id: 'o1', label: 'o1' },
              { id: 'gpt-4o', label: 'gpt-4o' },
              { id: 'gpt-4o-mini', label: 'gpt-4o-mini' },
            ],
          },
        ],
      },
    );

    fireEvent.click(screen.getByRole('tab', { name: /Local CLI/i }));
    const codexCard = screen.getByRole('button', { name: /Codex CLI/i });
    fireEvent.click(codexCard);

    const modelPicker = screen.getByRole('combobox', {
      name: en['settings.modelPicker'],
    });
    fireEvent.click(modelPicker);

    const searchInput = screen.getByTestId('settings-agent-model-search-codex') as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: '5.5' } });

    const modelPopover = screen.getByTestId('settings-agent-model-popover-codex');
    expect(optionNames(modelPopover)).toEqual(['gpt-4.1-mini', 'gpt-5.5', 'Custom (type below)…']);
  });

  it('keeps the Local CLI custom model input clearable when default is the fallback model', () => {
    renderSettingsDialog(
      { mode: 'daemon', agentId: 'codex' },
      {
        agents: [
          {
            ...availableAgents[0]!,
            models: [{ id: 'default', label: 'Default' }],
          },
        ],
      },
    );

    fireEvent.click(screen.getByRole('tab', { name: /Local CLI/i }));
    fireEvent.click(screen.getByRole('combobox', {
      name: en['settings.modelPicker'],
    }));
    const modelPopover = screen.getByTestId('settings-agent-model-popover-codex');
    fireEvent.click(within(modelPopover).getByRole('option', {
      name: en['settings.modelCustom'],
    }));

    const customModelInput = screen.getByLabelText(
      en['settings.modelCustomLabel'],
    ) as HTMLInputElement;
    expect(customModelInput.value).toBe('');

    fireEvent.change(customModelInput, { target: { value: 'default' } });
    expect(customModelInput.value).toBe('default');

    fireEvent.change(customModelInput, { target: { value: '' } });
    expect(customModelInput.value).toBe('');
  });

  it('drops a saved effort the next model does not offer, so switching back does not revive it', () => {
    const effort = (ids: string[]) => ids.map((id) => ({ id, label: id }));
    renderSettingsDialog(
      {
        mode: 'daemon',
        agentId: 'claude',
        agentModels: { claude: { model: 'claude-opus-4-8', reasoning: 'xhigh' } },
      },
      {
        agents: [
          {
            id: 'claude',
            name: 'Claude Code',
            bin: 'claude',
            available: true,
            version: '2.1.299',
            models: [
              { id: 'claude-opus-4-8', label: 'Opus 4.8', reasoningOptions: effort(['default', 'high', 'xhigh']) },
              { id: 'claude-opus-4-6', label: 'Opus 4.6', reasoningOptions: effort(['default', 'high']) },
            ],
          },
        ],
      },
    );

    fireEvent.click(screen.getByRole('tab', { name: /Local CLI/i }));
    const reasoning = () =>
      screen.getByLabelText(en['settings.reasoningPicker']) as HTMLSelectElement;
    const pickModel = (name: RegExp) => {
      fireEvent.click(screen.getByRole('combobox', { name: en['settings.modelPicker'] }));
      const popover = screen.getByTestId('settings-agent-model-popover-claude');
      fireEvent.click(within(popover).getByRole('option', { name }));
    };
    expect(reasoning().value).toBe('xhigh');

    pickModel(/Opus 4\.6/);
    expect(reasoning().value).toBe('default');

    // Before the fix the stored choice still held `xhigh`, and this switch
    // silently re-applied a level the user had not picked again.
    pickModel(/Opus 4\.8/);
    expect(reasoning().value).toBe('default');
  });

  it('labels live CLI model metadata in the model picker', () => {
    renderSettingsDialog(
      { mode: 'daemon', agentId: 'codex' },
      {
        agents: [
          {
            ...availableAgents[0]!,
            modelsSource: 'live',
            models: [
              { id: 'default', label: 'Default' },
              { id: 'gpt-6-codex', label: 'GPT-6 Codex' },
            ],
          },
        ],
      },
    );

    fireEvent.click(screen.getByRole('tab', { name: /Local CLI/i }));
    expect(screen.getByText('Synced from CLI')).toBeTruthy();
    // The badge is the only source label; the explanatory hint under the
    // picker was removed.
    expect(screen.queryByText(/Model list comes from this CLI/i)).toBeNull();
  });

  it('labels fallback CLI model metadata in the model picker', () => {
    renderSettingsDialog(
      { mode: 'daemon', agentId: 'codex' },
      {
        agents: [
          {
            ...availableAgents[0]!,
            modelsSource: 'fallback',
          },
        ],
      },
    );

    fireEvent.click(screen.getByRole('tab', { name: /Local CLI/i }));
    expect(screen.getByText('Built-in list')).toBeTruthy();
    // The badge is the only source label; the explanatory hint under the
    // picker was removed.
    expect(screen.queryByText(/Showing built-in defaults/i)).toBeNull();
  });

  it('shows an empty state when no local CLI agents are detected', () => {
    renderSettingsDialog(
      { mode: 'daemon', agentId: null },
      { agents: [] },
    );

    fireEvent.click(screen.getByRole('tab', { name: /Local CLI.*0 installed/i }));
    expect(screen.getByText(/No agents detected yet/i)).toBeTruthy();
  });

  it('labels the memory model default with the selected Local CLI', async () => {
    const agents: AgentInfo[] = [
      ...availableAgents,
      {
        id: 'claude',
        name: 'Claude Code',
        bin: 'claude',
        available: true,
        version: '1.2.3',
        models: [{ id: 'default', label: 'Default (CLI config)' }],
      },
    ];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === '/api/workspace/context') {
        return new Response(JSON.stringify({ context: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === '/api/memory') {
        return new Response(
          JSON.stringify({ enabled: true, memories: [], extraction: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }));

    renderSettingsDialog(
      { mode: 'daemon', agentId: 'claude' },
      { agents },
    );

    fireEvent.click(screen.getByRole('tab', { name: /Local CLI.*2 installed/i }));

    const memoryModel = await screen.findByRole('combobox', { name: 'Memory model' });
    expect(memoryModel.textContent).toBe('Same as chat (Claude Code)');
    expect(screen.getByText(/anthropic is only the fallback provider family/i)).toBeTruthy();
  });

  it('shows rescan loading, avoids duplicate rescans, and renders the success notice', async () => {
    const nextAgents: AgentInfo[] = [
      availableAgents[0]!,
      {
        id: 'claude',
        name: 'Claude Code',
        bin: 'claude',
        available: true,
        version: '1.2.3',
        models: [{ id: 'default', label: 'Default' }],
      },
    ];
    const pending = deferred<AgentInfo[]>();
    const onRefreshAgents = vi.fn(() => pending.promise);

    renderSettingsDialog(
      { mode: 'daemon', agentId: 'codex' },
      { agents: availableAgents, onRefreshAgents },
    );

    fireEvent.click(screen.getByRole('tab', { name: /Local CLI.*1 installed/i }));
    const rescanButton = screen.getByRole('button', { name: /Rescan|Scanning/i }) as HTMLButtonElement;

    fireEvent.click(rescanButton);
    expect(onRefreshAgents).toHaveBeenCalledTimes(1);
    expect(onRefreshAgents).toHaveBeenCalledWith({
      throwOnError: true,
      agentCliEnv: {},
    });
    expect(rescanButton.disabled).toBe(true);
    expect(screen.getByText('Scanning...')).toBeTruthy();

    fireEvent.click(rescanButton);
    expect(onRefreshAgents).toHaveBeenCalledTimes(1);

    pending.resolve(nextAgents);

    await waitFor(() => {
      expect(screen.getByText('Scan complete. 2 available.')).toBeTruthy();
      expect((screen.getByRole('button', { name: /Rescan/i }) as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it('renders an error notice when rescan fails', async () => {
    const onRefreshAgents = vi.fn(async () => {
      throw new Error('boom');
    });

    renderSettingsDialog(
      { mode: 'daemon', agentId: 'codex' },
      { agents: availableAgents, onRefreshAgents },
    );

    fireEvent.click(screen.getByRole('tab', { name: /Local CLI.*1 installed/i }));
    fireEvent.click(screen.getByRole('button', { name: /Rescan/i }));

    await waitFor(() => {
      expect(screen.getByText('Scan failed. Check the daemon and try again.')).toBeTruthy();
    });
  });

  it('renders diagnostics and fix actions on installed agents with auth failures', async () => {
    const docsUrl = 'https://docs.example.com/codex-auth';
    const authMissingAgent: AgentInfo = {
      ...availableAgents[0]!,
      authStatus: 'missing',
      authMessage: 'Codex CLI is installed but not authenticated.',
      docsUrl,
      diagnostics: [
        {
          reason: 'auth-missing',
          severity: 'error',
          message: 'Codex CLI is installed but not authenticated.',
          fixActions: [{ kind: 'openDocs' }, { kind: 'rescan' }],
        },
      ],
    };
    const onRefreshAgents = vi.fn(async () => [authMissingAgent]);

    renderSettingsDialog(
      { mode: 'daemon', agentId: 'codex' },
      { agents: [authMissingAgent], onRefreshAgents },
    );

    fireEvent.click(screen.getByRole('tab', { name: /Local CLI.*1 installed/i }));
    const codexCard = screen.getByRole('button', { name: /Codex CLI/i })
      .closest('.agent-card') as HTMLElement;

    expect(
      within(codexCard).getByText('Codex CLI is installed but not authenticated.'),
    ).toBeTruthy();

    fireEvent.click(within(codexCard).getByRole('button', {
      name: en['settings.agentInstall.docs'],
    }));
    expect(openExternalUrlMock).toHaveBeenCalledWith(docsUrl);

    fireEvent.click(within(codexCard).getByRole('button', {
      name: en['settings.rescan'],
    }));
    await waitFor(() => {
      expect(onRefreshAgents).toHaveBeenCalledWith({
        throwOnError: true,
        agentCliEnv: {},
      });
    });
  });

  it('rescans automatically when returning after opening an install link', async () => {
    const unavailable: AgentInfo = {
      id: 'kimi',
      name: 'Kimi CLI',
      bin: 'kimi',
      available: false,
      version: null,
      models: [],
      installUrl: 'https://github.com/MoonshotAI/kimi-cli',
    };
    const onRefreshAgents = vi.fn(async () => availableAgents);

    renderSettingsDialog(
      { mode: 'daemon', agentId: 'codex' },
      { agents: [availableAgents[0]!, unavailable], onRefreshAgents },
    );

    fireEvent.click(screen.getByRole('tab', { name: /Local CLI.*1 installed/i }));
    fireEvent.click(screen.getByText('Available CLIs (1)'));
    fireEvent.click(screen.getByRole('link', { name: en['settings.agentInstall.install'] }));
    expect(onRefreshAgents).not.toHaveBeenCalled();

    document.dispatchEvent(new Event('visibilitychange'));

    await waitFor(() => {
      expect(onRefreshAgents).toHaveBeenCalledWith({
        throwOnError: true,
        agentCliEnv: {},
      });
    });
  });

  it('autosaves CLI env overrides from the execution form', async () => {
    const { onPersist } = renderSettingsDialog(
      { mode: 'daemon', agentId: 'codex' },
      { agents: availableAgents },
    );

    expect(
      screen.getByLabelText('Codex/OpenAI CLI API key (CODEX_API_KEY)'),
    ).toBeTruthy();
    expect(
      screen.getByLabelText('Codex/OpenAI CLI API key (OPENAI_API_KEY)'),
    ).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Codex home'), {
      target: { value: ' ~/.codex-team ' },
    });

    await waitForPersist(
      onPersist,
      expect.objectContaining({
        mode: 'daemon',
        agentId: 'codex',
        agentCliEnv: {
          codex: { CODEX_HOME: '~/.codex-team' },
        },
      }),
      {},
    );
  });

  it('disables Local CLI mode when the daemon is offline', () => {
    renderSettingsDialog(
      { mode: 'api' },
      { agents: availableAgents, daemonLive: false },
    );

    const localCliTab = screen.getByRole('tab', { name: /Local CLI.*daemon offline/i }) as HTMLButtonElement;
    expect(localCliTab.disabled).toBe(true);
    expect(localCliTab.getAttribute('title')).toBe('Daemon is not running');
    expect(screen.queryByRole('tab', { name: /API providers/i })).toBeNull();
  });

  it('renders a Local CLI connection test for selected installed agents', () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === '/api/workspace/context') {
        return new Response(JSON.stringify({ context: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === '/api/memory') {
        return new Response(
          JSON.stringify({ enabled: true, memories: [], extraction: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderSettingsDialog(
      { mode: 'daemon', agentId: 'codex' },
      { agents: availableAgents },
    );

    fireEvent.click(screen.getByRole('tab', { name: /Local CLI.*1 installed/i }));

    expect(screen.getByRole('button', { name: /Codex CLI/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Test' })).toBeTruthy();
  });

  it('shows the concrete model reported by a Local CLI connection test', async () => {
    const claudeAgent: AgentInfo = {
      id: 'claude',
      name: 'Claude Code',
      bin: 'claude',
      available: true,
      version: '2.1.220',
      models: [
        { id: 'default', label: 'Default' },
        { id: 'opus', label: 'Opus (alias)' },
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === '/api/memory') {
        return new Response(
          JSON.stringify({ enabled: true, memories: [], extraction: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url === '/api/test/connection') {
        return new Response(
          JSON.stringify({
            ok: true,
            kind: 'success',
            latencyMs: 42,
            model: 'opus',
            resolvedModel: 'claude-opus-5',
            agentName: 'Claude Code',
            sample: 'ok',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    renderSettingsDialog(
      {
        mode: 'daemon',
        agentId: 'claude',
        agentModels: { claude: { model: 'opus' } },
      },
      { agents: [claudeAgent] },
    );

    fireEvent.click(screen.getByRole('tab', { name: /Local CLI.*1 installed/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));

    expect(
      await screen.findByText(/Claude Code replied in 42 ms.*Model: claude-opus-5/i),
    ).toBeTruthy();
  });
});

describe('SettingsDialog media providers interactions', () => {
  afterEach(() => {
    cleanup();
  });

  it('sorts configured providers ahead of unconfigured ones and shows configured badges', () => {
    renderSettingsDialog(
      {
        mode: 'daemon',
        agentId: 'codex',
        mediaProviders: {
          openai: { apiKey: 'sk-media', baseUrl: 'https://custom.openai.example/v1' },
          minimax: { apiKey: 'mini-key', baseUrl: 'https://api.minimaxi.chat/v1' },
        },
      },
      { initialSection: 'media' },
    );

    // #5517 layout: providers render as selector pills (configured first),
    // each carrying a status dot; the pill title encodes label + state.
    const pills = Array.from(
      document.querySelectorAll('.media-provider-tabs .protocol-chip'),
    );
    const titles = pills.map((pill) => pill.getAttribute('title'));
    expect(titles.slice(0, 2)).toEqual(['MiniMax · Configured', 'OpenAI · Configured']);
    expect(pills[0]?.querySelector('.media-provider-chip-status.is-connected')).toBeTruthy();
    expect(pills[1]?.querySelector('.media-provider-chip-status.is-connected')).toBeTruthy();
    expect(pills[2]?.querySelector('.media-provider-chip-status.is-connected')).toBeFalsy();
  });

  it('renders non-integrated providers in the coming-soon section without input fields', () => {
    renderSettingsDialog(
      { mode: 'daemon', agentId: 'codex' },
      { initialSection: 'media' },
    );

    // Non-integrated providers (e.g. Fal.ai, Black Forest Labs) are shown in
    // a separate "Coming soon" disclosure without editable inputs.
    expect(screen.queryByLabelText('Black Forest Labs API key')).toBeNull();
    expect(screen.queryByLabelText('Black Forest Labs Base URL')).toBeNull();
    expect(document.querySelector('.media-provider-coming-soon')).toBeTruthy();
    expect(screen.getByText('ComfyUI')).toBeTruthy();
  });

  it('renders ElevenLabs as an integrated media provider with enabled inputs', () => {
    renderSettingsDialog(
      { mode: 'daemon', agentId: 'codex' },
      { initialSection: 'media' },
    );

    // #5517 layout: one detail card at a time — select the provider pill
    // before asserting on its fields.
    fireEvent.click(screen.getByRole('tab', { name: /ElevenLabs/ }));

    const apiKeyInput = screen.getByLabelText('ElevenLabs API key') as HTMLInputElement;
    const baseUrlInput = screen.getByLabelText('ElevenLabs Base URL') as HTMLInputElement;
    expect(apiKeyInput.disabled).toBe(false);
    expect(baseUrlInput.disabled).toBe(false);
  });

  it('clears an existing provider config and removes it from the persisted payload', async () => {
    const { onPersist } = renderSettingsDialog(
      {
        mode: 'daemon',
        agentId: 'codex',
        mediaProviders: {
          openai: { apiKey: 'sk-media', baseUrl: 'https://custom.openai.example/v1' },
        },
      },
      { initialSection: 'media' },
    );

    // Issue #737 added a window.confirm guard on the Clear button so a
    // stray click cannot wipe a saved API key. Auto-accept the prompt
    // here so the test still exercises the cleared-payload path.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    const clearButtons = screen.getAllByRole('button', { name: 'Clear configuration' });
    fireEvent.click(clearButtons[0]!);

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText('OpenAI API key') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('OpenAI Base URL') as HTMLInputElement).value).toBe('');

    await waitForPersist(
      onPersist,
      expect.objectContaining({
        mediaProviders: {},
      }),
      { forceMediaProviderSync: true },
    );

    confirmSpy.mockRestore();
  });

  it('cancels Clear when the confirmation is dismissed (issue #737)', () => {
    const { onPersist } = renderSettingsDialog(
      {
        mode: 'daemon',
        agentId: 'codex',
        mediaProviders: {
          openai: { apiKey: 'sk-media', baseUrl: 'https://custom.openai.example/v1' },
        },
      },
      { initialSection: 'media' },
    );

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const clearButtons = screen.getAllByRole('button', { name: 'Clear configuration' });
    fireEvent.click(clearButtons[0]!);

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    // Saved key + base URL must stay intact when the user dismisses
    // the confirmation; without this guard a fat-fingered click on
    // Clear would silently wipe the key. Autosave should never fire
    // because nothing changed.
    expect((screen.getByLabelText('OpenAI API key') as HTMLInputElement).value).toBe('sk-media');
    expect((screen.getByLabelText('OpenAI Base URL') as HTMLInputElement).value).toBe(
      'https://custom.openai.example/v1',
    );
    expect(onPersist).not.toHaveBeenCalled();

    confirmSpy.mockRestore();
  });

  it('supports persisting provider API key and base URL edits', async () => {
    const { onPersist } = renderSettingsDialog(
      { mode: 'daemon', agentId: 'codex' },
      { initialSection: 'media' },
    );

    // #5517 layout: one detail card at a time — select the provider pill
    // before editing its fields.
    fireEvent.click(screen.getByRole('tab', { name: /FishAudio/ }));

    fireEvent.change(screen.getByLabelText('FishAudio API key'), {
      target: { value: 'fish-key' },
    });
    fireEvent.change(screen.getByLabelText('FishAudio Base URL'), {
      target: { value: 'https://fish.example.com' },
    });

    await waitForPersist(
      onPersist,
      expect.objectContaining({
        mediaProviders: expect.objectContaining({
          fishaudio: {
            apiKey: 'fish-key',
            baseUrl: 'https://fish.example.com',
            model: '',
          },
        }),
      }),
      { forceMediaProviderSync: true },
    );
  });

  it('re-masks a replacement media provider API key until reveal is used again', () => {
    renderSettingsDialog(
      {
        mode: 'daemon',
        agentId: 'codex',
        mediaProviders: {
          openai: { apiKey: 'sk-media', baseUrl: 'https://api.openai.com/v1' },
        },
      },
      { initialSection: 'media' },
    );

    const apiKeyInput = screen.getByLabelText('OpenAI API key') as HTMLInputElement;
    expect(apiKeyInput.type).toBe('password');

    fireEvent.click(screen.getByRole('button', { name: 'OpenAI Show key' }));
    expect(apiKeyInput.type).toBe('text');

    // Issue #737 added a window.confirm guard on Clear; jsdom's
    // unimplemented confirm() returns undefined, which would cancel
    // the clear and leave this test asserting the wrong reveal state.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear configuration' })[0]!);
    expect(apiKeyInput.type).toBe('password');

    fireEvent.change(apiKeyInput, { target: { value: 'sk-replacement' } });
    expect(apiKeyInput.type).toBe('password');

    fireEvent.click(screen.getByRole('button', { name: 'OpenAI Show key' }));
    expect(apiKeyInput.type).toBe('text');

    confirmSpy.mockRestore();
  });

  it('supports providers with a custom model override field', async () => {
    const { onPersist } = renderSettingsDialog(
      { mode: 'daemon', agentId: 'codex' },
      { initialSection: 'media' },
    );

    // #5517 layout: one detail card at a time — select the provider pill
    // before editing its fields. The model override renders as a labeled
    // "Model" field in the detail card.
    fireEvent.click(screen.getByRole('tab', { name: /Nano Banana/ }));

    fireEvent.change(screen.getByLabelText('Nano Banana API key'), {
      target: { value: 'banana-key' },
    });
    fireEvent.change(screen.getByLabelText('Nano Banana Base URL'), {
      target: { value: 'https://gateway.example.com' },
    });
    fireEvent.change(screen.getByLabelText('Nano Banana Model'), {
      target: { value: 'gemini-3.1-flash-image-preview' },
    });

    await waitForPersist(
      onPersist,
      expect.objectContaining({
        mediaProviders: expect.objectContaining({
          nanobanana: {
            apiKey: 'banana-key',
            baseUrl: 'https://gateway.example.com',
            model: 'gemini-3.1-flash-image-preview',
          },
        }),
      }),
      { forceMediaProviderSync: true },
    );
  });

  it('catches unmount flush failures for pending media-provider autosaves', async () => {
    const rejection = new Error('daemon unavailable');
    const handleUnhandledRejection = vi.fn((event: PromiseRejectionEvent) => {
      event.preventDefault();
    });
    window.addEventListener('unhandledrejection', handleUnhandledRejection);

    try {
      const { onPersist, unmount } = renderSettingsDialog(
        { mode: 'daemon', agentId: 'codex' },
        { initialSection: 'media' },
      );
      onPersist.mockRejectedValueOnce(rejection);

      // #5517 layout: select the OpenAI pill first — nothing is configured
      // here, so the default detail card is the first alphabetical provider.
      fireEvent.click(screen.getByRole('tab', { name: /OpenAI/ }));
      fireEvent.change(screen.getByLabelText('OpenAI API key'), {
        target: { value: 'sk-unmount-media' },
      });

      await waitFor(() => {
        expect(screen.getByText('Saving…')).toBeTruthy();
      });
      unmount();
      await Promise.resolve();
      await Promise.resolve();

      expect(onPersist).toHaveBeenCalledWith(
        expect.objectContaining({
          mediaProviders: expect.objectContaining({
            openai: expect.objectContaining({ apiKey: 'sk-unmount-media' }),
          }),
        }),
        expect.objectContaining({ forceMediaProviderSync: true }),
      );
      expect(handleUnhandledRejection).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
    }
  });

  it('closes media settings via the close button or backdrop', () => {
    const first = renderSettingsDialog(
      { mode: 'daemon', agentId: 'codex' },
      { initialSection: 'media' },
    );

    // #5517 layout: select the OpenAI pill before editing its detail card.
    fireEvent.click(screen.getByRole('tab', { name: /OpenAI/ }));
    fireEvent.change(screen.getByLabelText('OpenAI API key'), {
      target: { value: 'sk-unsaved-media' },
    });
    fireEvent.click(first.container.querySelector('.settings-close') as HTMLElement);
    expect(first.onClose).toHaveBeenCalledTimes(1);

    cleanup();

    const second = renderSettingsDialog(
      { mode: 'daemon', agentId: 'codex' },
      { initialSection: 'media' },
    );
    fireEvent.click(screen.getByRole('tab', { name: /OpenAI/ }));
    fireEvent.change(screen.getByLabelText('OpenAI API key'), {
      target: { value: 'sk-unsaved-media-2' },
    });
    fireEvent.click(document.querySelector('.modal-backdrop') as HTMLElement);
    expect(second.onClose).toHaveBeenCalledTimes(1);
  });
});

describe('SettingsDialog connectors interactions', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders a saved Composio key state with masked tail and replacement guidance', () => {
    renderSettingsDialog(
      {
        mode: 'daemon',
        agentId: 'codex',
        composio: {
          apiKey: '',
          apiKeyConfigured: true,
          apiKeyTail: 'uQEg',
        },
      },
      { initialSection: 'composio' },
    );

    expect(screen.getAllByRole('heading', { name: 'Connectors' }).length).toBeGreaterThan(0);
    expect(screen.getByText('Saved · ••••uQEg')).toBeTruthy();
    expect((screen.getByPlaceholderText('Enter a new key to replace the saved key') as HTMLInputElement).value).toBe('');
    expect(screen.getByText(/your key is saved in the local daemon/i)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Clear' }) as HTMLButtonElement).disabled).toBe(false);

    const getApiKeyLink = screen.getByRole('link', { name: /Get API Key/i }) as HTMLAnchorElement;
    expect(getApiKeyLink.href).toBe('https://app.composio.dev/');
  });

  it('supports replacing a saved Composio key and saving the pending edit', async () => {
    const { onPersistComposioKey } = renderSettingsDialog(
      {
        mode: 'daemon',
        agentId: 'codex',
        composio: {
          apiKey: '',
          apiKeyConfigured: true,
          apiKeyTail: 'uQEg',
        },
      },
      { initialSection: 'composio' },
    );

    fireEvent.change(screen.getByPlaceholderText('Enter a new key to replace the saved key'), {
      target: { value: 'cmp_replacement_secret' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save key' }));
    await waitFor(() => {
      expect(onPersistComposioKey).toHaveBeenCalledWith({
        apiKey: 'cmp_replacement_secret',
        apiKeyConfigured: true,
        apiKeyTail: 'uQEg',
      });
    });
  });

  it('clears a saved Composio key from the payload', async () => {
    const { onPersistComposioKey } = renderSettingsDialog(
      {
        mode: 'daemon',
        agentId: 'codex',
        composio: {
          apiKey: '',
          apiKeyConfigured: true,
          apiKeyTail: 'uQEg',
        },
      },
      { initialSection: 'composio' },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => {
      expect((screen.getByRole('button', { name: /hold on|disconnect/i }) as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(screen.getByRole('button', { name: /hold on|disconnect/i }));

    await waitFor(() => {
      expect(onPersistComposioKey).toHaveBeenCalledWith({
        apiKey: '',
        apiKeyConfigured: false,
        apiKeyTail: '',
      });
    });
    expect(screen.getByText(/keys are stored locally and never shared/i)).toBeTruthy();
  });

  it('closes Composio settings via the close button or backdrop', () => {
    const first = renderSettingsDialog(
      {
        mode: 'daemon',
        agentId: 'codex',
        composio: {
          apiKey: '',
          apiKeyConfigured: true,
          apiKeyTail: 'uQEg',
        },
      },
      { initialSection: 'composio' },
    );

    fireEvent.change(screen.getByPlaceholderText('Enter a new key to replace the saved key'), {
      target: { value: 'cmp_unsaved_secret' },
    });
    fireEvent.click(first.container.querySelector('.settings-close') as HTMLElement);
    expect(first.onClose).toHaveBeenCalledTimes(1);

    cleanup();

    const second = renderSettingsDialog(
      {
        mode: 'daemon',
        agentId: 'codex',
        composio: {
          apiKey: '',
          apiKeyConfigured: true,
          apiKeyTail: 'uQEg',
        },
      },
      { initialSection: 'composio' },
    );
    fireEvent.change(screen.getByPlaceholderText('Enter a new key to replace the saved key'), {
      target: { value: 'cmp_unsaved_secret_2' },
    });
    fireEvent.click(document.querySelector('.modal-backdrop') as HTMLElement);
    expect(second.onClose).toHaveBeenCalledTimes(1);
  });
});

describe('SettingsDialog MCP server interactions', () => {
  const installInfo = {
    command: '/Applications/Open Design.app/Contents/Resources/open-design/bin/node',
    args: [
      '/Applications/Open Design.app/Contents/Resources/app/node_modules/@open-design/daemon/dist/cli.js',
      'mcp',
      '--daemon-url',
      'http://127.0.0.1:51706',
    ],
    daemonUrl: 'http://127.0.0.1:51706',
    platform: 'darwin',
    cliExists: true,
    nodeExists: true,
    buildHint: null,
  };

  let fetchMock: ReturnType<typeof vi.fn>;
  let writeTextMock: ReturnType<typeof vi.fn>;
  let originalClipboard: PropertyDescriptor | undefined;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => installInfo,
    });
    vi.stubGlobal('fetch', fetchMock);

    originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: writeTextMock,
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    if (originalClipboard) {
      Object.defineProperty(navigator, 'clipboard', originalClipboard);
    } else {
      delete (navigator as { clipboard?: Clipboard }).clipboard;
    }
    vi.clearAllMocks();
  });

  it('renders the default Claude Code install snippet after fetching daemon install info', async () => {
    renderSettingsDialog(
      { mode: 'daemon', agentId: 'codex' },
      { initialSection: 'integrations' },
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/mcp/install-info');
    });
    expect(screen.getByRole('heading', { name: /Connect OpenDesign to your coding agent/i })).toBeTruthy();
    expect(screen.queryByText(/Run this command in your terminal/i)).toBeNull();
    await waitFor(() => {
      expect(screen.getByText(/claude mcp add-json --scope user open-design/i)).toBeTruthy();
    });
    expect(screen.getByText(/Keep OpenDesign running\. Restart your coding agent after setup\./i)).toBeTruthy();
    expect(screen.getByText(/What your agent can do/i)).toBeTruthy();
  });

  it('switches client instructions and snippet content when a different MCP client is selected', async () => {
    renderSettingsDialog(
      { mode: 'daemon', agentId: 'codex' },
      { initialSection: 'integrations' },
    );

    await waitFor(() => {
      expect(screen.getByText(/claude mcp add-json --scope user open-design/i)).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: /Claude Code/i }));
    fireEvent.click(screen.getByRole('option', { name: /Codex/i }));

    await waitFor(() => {
      expect(screen.getByText(/Append this table to ~\/\.codex\/config\.toml/i)).toBeTruthy();
    });
    expect(screen.getByText(/\[mcp_servers\.open-design\]/i)).toBeTruthy();

    // Scope to the picker trigger ("Codex" + the TOML method chip) so
    // we don't collide with the new one-click "Install in Codex" /
    // "Remove from Codex" button on the same panel.
    fireEvent.click(screen.getByRole('button', { name: /Codex.*TOML/i }));
    fireEvent.click(screen.getByRole('option', { name: /Cursor/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Install in Cursor/i })).toBeTruthy();
    });
    expect(screen.getByText(/merge this JSON into ~\/\.cursor\/mcp\.json/i)).toBeTruthy();
    expect(screen.getByText(/"mcpServers"/i)).toBeTruthy();
  });

  it('copies the currently selected MCP snippet to the clipboard', async () => {
    renderSettingsDialog(
      { mode: 'daemon', agentId: 'codex' },
      { initialSection: 'integrations' },
    );

    await waitFor(() => {
      expect(screen.getByText(/claude mcp add-json --scope user open-design/i)).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Copy setup command' }));

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith(
        expect.stringContaining("claude mcp add-json --scope user open-design"),
      );
    });
    expect(screen.getByText('Copied')).toBeTruthy();
  });

  it('shows a daemon error state when install paths cannot be resolved', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));

    renderSettingsDialog(
      { mode: 'daemon', agentId: 'codex' },
      { initialSection: 'integrations' },
    );

    await waitFor(() => {
      const errorCard = document.querySelector('.empty-card');
      expect(errorCard?.textContent).toContain('reach the local daemon to resolve install paths');
    });
    expect(screen.getByText(/# resolving paths failed, see the error above/i)).toBeTruthy();
  });
});

describe('SettingsDialog language interactions', () => {
  afterEach(() => {
    cleanup();
    window.localStorage.removeItem('open-design:locale');
    document.documentElement.removeAttribute('lang');
    document.documentElement.removeAttribute('dir');
  });

  // #5517 replaced the 4×N locale tile grid with one compact select. The
  // capability is unchanged — every locale is still offered — so these specs
  // now drive the <select> instead of clicking radio tiles.
  it('offers every locale in the language select and shows the current one', async () => {
    renderLanguageSettingsDialog('en');

    const select = (await screen.findByLabelText('Language')) as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect(within(select).getAllByRole('option')).toHaveLength(LOCALES.length);
    expect(select.value).toBe('en');
    expect(within(select).getByRole('option', { name: /简体中文/i })).toBeTruthy();
  });

  it('switches locale immediately and updates localStorage', async () => {
    renderLanguageSettingsDialog('en');

    const select = screen.getByLabelText('Language') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'zh-CN' } });

    expect((screen.getByLabelText('界面语言') as HTMLSelectElement).value).toBe('zh-CN');
    expect(window.localStorage.getItem('open-design:locale')).toBe('zh-CN');
    expect(document.documentElement.getAttribute('lang')).toBe('zh-CN');
    expect(document.documentElement.getAttribute('dir')).toBe('ltr');
  });

  it('sets rtl direction for rtl locales', async () => {
    renderLanguageSettingsDialog('en');

    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'fa' } });

    expect(window.localStorage.getItem('open-design:locale')).toBe('fa');
    expect(document.documentElement.getAttribute('lang')).toBe('fa');
    expect(document.documentElement.getAttribute('dir')).toBe('rtl');
  });

  it('does not route language changes through autosave and closing does not revert an applied locale', async () => {
    const { onPersist, onClose } = renderLanguageSettingsDialog('en');

    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'de' } });

    expect(window.localStorage.getItem('open-design:locale')).toBe('de');
    expect(document.documentElement.getAttribute('lang')).toBe('de');

    fireEvent.click(screen.getByTitle(/close|schließen/i));
    expect(onPersist).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem('open-design:locale')).toBe('de');
    expect(document.documentElement.getAttribute('lang')).toBe('de');
    expect(document.documentElement.getAttribute('dir')).toBe('ltr');
  });
});

describe('SettingsDialog notifications interactions', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders notifications active by default and keeps the sound choices available', () => {
    renderSettingsDialog(
      { mode: 'daemon', agentId: 'codex' },
      { initialSection: 'notifications' },
    );

    expect(screen.getByRole('group', { name: 'Completion sound' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'active' })[0]?.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getAllByRole('button', { name: 'active' })[1]?.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getAllByRole('button', { name: 'inactive' })[0]?.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getAllByRole('button', { name: 'inactive' })[1]?.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('group', { name: 'Success sound' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Failure sound' })).toBeTruthy();
  });

  it('updates completion success and failure sounds and autosaves the edited notification config', async () => {
    const { onPersist } = renderSettingsDialog(
      {
        mode: 'daemon',
        agentId: 'codex',
        notifications: {
          soundEnabled: true,
          successSoundId: 'chime',
          failureSoundId: 'two-tone-down',
          desktopEnabled: false,
        },
      },
      { initialSection: 'notifications' },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Pluck' }));
    fireEvent.click(screen.getByRole('button', { name: 'Thud' }));

    expect(playSoundMock).toHaveBeenNthCalledWith(1, 'pluck');
    expect(playSoundMock).toHaveBeenNthCalledWith(2, 'thud');

    await waitForPersist(
      onPersist,
      expect.objectContaining({
        notifications: {
          soundEnabled: true,
          successSoundId: 'pluck',
          failureSoundId: 'thud',
          desktopEnabled: false,
        },
      }),
      {},
    );
  });

  it('enables desktop notifications after permission is granted and sends a test notification', async () => {
    notificationPermissionMock.mockReturnValueOnce('default').mockReturnValue('granted');
    requestNotificationPermissionMock.mockResolvedValue('granted');
    showCompletionNotificationMock.mockResolvedValue('shown');

    renderSettingsDialog(
      {
        mode: 'daemon',
        agentId: 'codex',
        notifications: {
          soundEnabled: true,
          successSoundId: 'ding',
          failureSoundId: 'buzz',
          desktopEnabled: false,
        },
      },
      { initialSection: 'notifications' },
    );

    // Row 0 is Completion sound, row 1 is Desktop notifications — each a
    // 使用中/未使用 pill pair; "active" (使用中) at index 1 is desktop's on-toggle.
    const desktopToggle = screen.getAllByRole('button', { name: 'active' })[1] as HTMLButtonElement;
    fireEvent.click(desktopToggle);

    await waitFor(() => {
      expect(requestNotificationPermissionMock).toHaveBeenCalledTimes(1);
    });
    expect(screen.getAllByRole('button', { name: 'active' })[1]?.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Send test' }));
    await waitFor(() => {
      expect(showCompletionNotificationMock).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'succeeded' }),
      );
    });
    expect(screen.getByText(/Test notification sent/i)).toBeTruthy();
  });

  it('shows a blocked hint and keeps desktop notifications disabled when permission is denied', async () => {
    notificationPermissionMock.mockReturnValueOnce('default').mockReturnValue('denied');
    requestNotificationPermissionMock.mockResolvedValue('denied');

    renderSettingsDialog(
      {
        mode: 'daemon',
        agentId: 'codex',
        notifications: {
          soundEnabled: true,
          successSoundId: 'ding',
          failureSoundId: 'buzz',
          desktopEnabled: false,
        },
      },
      { initialSection: 'notifications' },
    );

    const desktopToggle = screen.getAllByRole('button', { name: 'active' })[1] as HTMLButtonElement;
    fireEvent.click(desktopToggle);

    await waitFor(() => {
      expect(requestNotificationPermissionMock).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByText(/Notifications blocked by the browser/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send test' })).toBeNull();
  });

  it('closes notification settings via the close button or backdrop', () => {
    const first = renderSettingsDialog(
      { mode: 'daemon', agentId: 'codex' },
      { initialSection: 'notifications' },
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'active' })[0] as HTMLButtonElement);
    fireEvent.click(first.container.querySelector('.settings-close') as HTMLElement);
    expect(first.onClose).toHaveBeenCalledTimes(1);

    cleanup();

    const second = renderSettingsDialog(
      { mode: 'daemon', agentId: 'codex' },
      { initialSection: 'notifications' },
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'active' })[0] as HTMLButtonElement);
    fireEvent.click(document.querySelector('.modal-backdrop') as HTMLElement);
    expect(second.onClose).toHaveBeenCalledTimes(1);
  });
});

// Was 'SettingsDialog appearance interactions'. The eight theme/accent cases
// this block opened with are retired: the product removed theme selection
// outright ("主题设置不要了，因为 workspace 功能不支持暗色主题，要干掉"), which
// also formally overturns the NON-ALIGNMENT #9 note that had argued for keeping
// the segmented control as the last "follow system" entry point. The document
// theme/accent teardown went with them — nothing here writes those any more.
// What survives is the AMR draft-reconciliation coverage that merely happened
// to live in this block.
describe('SettingsDialog draft reconciliation', () => {
  afterEach(() => {
    cleanup();
  });

  it('reconciles the open settings draft when the parent agent CLI env changes', async () => {
    const view = renderSettingsDialog(
      {
        mode: 'daemon',
        agentId: 'amr',
        // Seeded on so the one click below is a real state change: the
        // completion-sound pills are no-ops when clicked in their current state.
        notifications: {
          soundEnabled: true,
          successSoundId: 'chime',
          failureSoundId: 'two-tone-down',
          desktopEnabled: false,
        },
        agentModels: {
          amr: {
            model: 'prod-only-model',
            reasoning: 'default',
          },
        },
        agentCliEnv: {
          codex: { CODEX_BIN: '/tmp/codex-dev' },
          amr: {
            OPEN_DESIGN_AMR_PROFILE: 'prod',
            AMR_API_BASE_URL: 'https://draft.example.test',
          },
        },
      },
      { initialSection: 'notifications', agents: [amrAgent, ...availableAgents] },
    );

    view.rerender(
      <SettingsDialog
        initial={{
          ...baseConfig,
          mode: 'daemon',
          agentId: 'amr',
          notifications: {
            soundEnabled: true,
            successSoundId: 'chime',
            failureSoundId: 'two-tone-down',
            desktopEnabled: false,
          },
          agentCliEnv: {
            amr: {
              OPEN_DESIGN_AMR_PROFILE: 'local',
              AMR_API_BASE_URL: 'https://daemon.example.test',
            },
          },
        }}
        agents={[amrAgent, ...availableAgents]}
        daemonLive={true}
        appVersionInfo={null}
        initialSection="notifications"
        onPersist={view.onPersist}
        onPersistComposioKey={view.onPersistComposioKey}
        onClose={view.onClose}
        onRefreshAgents={view.onRefreshAgents}
      />,
    );

    // Any committed edit will do — this test is about what the draft carries
    // when it autosaves, not about which control fired it. It used to ride the
    // Appearance theme control; with theme selection removed, the notifications
    // completion-sound toggle is the equivalent one-click persisted edit.
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Completion sound' })).getByRole('button', {
        name: 'inactive',
      }),
    );

    await waitForPersist(
      view.onPersist,
      expect.objectContaining({
        notifications: expect.objectContaining({ soundEnabled: false }),
        agentModels: {},
        agentCliEnv: {
          codex: { CODEX_BIN: '/tmp/codex-dev' },
          amr: {
            OPEN_DESIGN_AMR_PROFILE: 'local',
            AMR_API_BASE_URL: 'https://draft.example.test',
          },
        },
      }),
      {},
    );
  });
});

describe('SettingsDialog pets interactions', () => {
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard');

  afterEach(() => {
    if (clipboardDescriptor) {
      Object.defineProperty(window.navigator, 'clipboard', clipboardDescriptor);
    } else {
      Reflect.deleteProperty(window.navigator, 'clipboard');
    }
    cleanup();
  });

  // #5517 folded the pet picker into General and the nav rail dropped its
  // standalone "Pets" item. The composer's pet-settings entry point still
  // deep-links with `initialSection: 'pet'`, so that token must resolve to
  // General — otherwise the entry point opens a section with no nav item and
  // nothing rendered.
  it('lands a pet deep link on the General section with the General nav item active', () => {
    const { container } = renderSettingsDialog(
      { mode: 'daemon', agentId: 'codex' },
      { initialSection: 'pet' },
    );

    expect(container.querySelector('.settings-general-section')).toBeTruthy();
    const active = container.querySelector('.settings-nav-item.active');
    expect(active?.textContent).toContain('General');
    // The pet block renders inside General, not as its own page.
    expect(container.querySelector('.settings-general-section .pet-tabs, .settings-general-section [role="tab"]')).toBeTruthy();
  });

  it('renders bundled pets by default and exposes community pets in a separate tab', async () => {
    fetchCodexPetsMock.mockResolvedValue({
      pets: [...sampleBundledPets, ...sampleCommunityPets],
      rootDir: '/Users/test/.codex/pets',
    });

    renderSettingsDialog(
      { mode: 'daemon', agentId: 'codex' },
      { initialSection: 'pet' },
    );

    expect((screen.getByRole('button', { name: 'Show pet' }) as HTMLButtonElement).disabled).toBe(false);

    await waitFor(() => {
      expect(screen.getByText('Dario')).toBeTruthy();
      expect(screen.getByText('Nyako')).toBeTruthy();
    });
    expect(screen.queryByText('Jade')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Community' }));
    expect(screen.getByText('Recently hatched')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download community pets' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
    expect(screen.getByText('Jade')).toBeTruthy();
    expect(screen.getByText('Voidling')).toBeTruthy();
  });

  it('supports editing and persisting a custom pet', async () => {
    const { onPersist } = renderSettingsDialog(
      { mode: 'daemon', agentId: 'codex' },
      { initialSection: 'pet' },
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Custom' }));

    fireEvent.change(screen.getByDisplayValue('Buddy'), {
      target: { value: 'Scout' },
    });
    fireEvent.change(screen.getByDisplayValue('🦄'), {
      target: { value: '🤖' },
    });
    fireEvent.change(screen.getByDisplayValue('Hi! I am here whenever you need me.'), {
      target: { value: 'Hi there, builder.' },
    });
    fireEvent.click(document.querySelector('.pet-swatch[title="#2348b8"]') as HTMLElement);

    expect(screen.getAllByText('Scout').length).toBeGreaterThan(0);
    expect(screen.getByText('Hi there, builder.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Use my pet' }));

    await waitForPersist(
      onPersist,
      expect.objectContaining({
        pet: expect.objectContaining({
          adopted: true,
          enabled: true,
          petId: 'custom',
          custom: expect.objectContaining({
            name: 'Scout',
            glyph: '🤖',
            greeting: 'Hi there, builder.',
            accent: '#2348b8',
          }),
        }),
      }),
      {},
    );
  });

  it('toggles an adopted pet between tucked and awake states', async () => {
    const { onPersist } = renderSettingsDialog(
      {
        mode: 'daemon',
        agentId: 'codex',
        pet: {
          adopted: true,
          enabled: true,
          petId: 'custom',
          custom: {
            name: 'Buddy',
            glyph: '🦄',
            accent: '#c96442',
            greeting: 'Hi! I am here whenever you need me.',
          },
        },
      },
      { initialSection: 'pet' },
    );

    const toggle = screen.getByRole('button', { name: 'Hide pet' });
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Show pet' })).toBeTruthy();
    expect(screen.getByText('Hide pet')).toBeTruthy();

    await waitForPersist(
      onPersist,
      expect.objectContaining({
        pet: expect.objectContaining({
          adopted: true,
          enabled: false,
        }),
      }),
      {},
    );
  });

  it('refreshes and syncs community pets with inline status feedback', async () => {
    fetchCodexPetsMock.mockResolvedValue({
      pets: sampleCommunityPets,
      rootDir: '/Users/test/.codex/pets',
    });
    syncCommunityPetsMock.mockResolvedValue({
      wrote: 2,
      skipped: 1,
      failed: 0,
      total: 5,
      rootDir: '/Users/test/.codex/pets',
      errors: [],
    });

    renderSettingsDialog(
      { mode: 'daemon', agentId: 'codex' },
      { initialSection: 'pet' },
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Community' }));
    await waitFor(() => {
      expect(fetchCodexPetsMock).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => {
      expect(fetchCodexPetsMock).toHaveBeenCalledTimes(2);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Download community pets' }));
    await waitFor(() => {
      expect(syncCommunityPetsMock).toHaveBeenCalledTimes(1);
      expect(fetchCodexPetsMock).toHaveBeenCalledTimes(3);
      expect(screen.getByText('Synced 2 new pets (5 total).')).toBeTruthy();
    });
  });

  it('copies the hatch prompt with the current concept', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    renderSettingsDialog(
      { mode: 'daemon', agentId: 'codex' },
      { initialSection: 'pet' },
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Community' }));
    fireEvent.change(screen.getByLabelText('Pet concept (optional)'), {
      target: { value: 'a tiny pixel-art bee in a cozy sweater' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        expect.stringContaining('Concept: a tiny pixel-art bee in a cozy sweater.'),
      );
      expect(writeText).toHaveBeenCalledWith(
        expect.stringContaining('Use the @hatch-pet skill end-to-end:'),
      );
      expect(screen.getByRole('button', { name: 'Copied!' })).toBeTruthy();
    });
  });
});

describe('IntegrationsView skills tab', () => {
  beforeEach(() => {
    // SkillsSection deliberately waits for an authoritative Workspace answer
    // before reading a catalog. These filter tests exercise the legal
    // signed-out/headerless path, so terminate that boundary explicitly rather
    // than letting jsdom's relative fetch fail into `unavailable` (which must
    // remain fail-closed).
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/workspace/directory')) {
        return workspaceDirectoryResponse(null);
      }
      throw new Error(`Unexpected IntegrationsView request: ${url}`);
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lists functional skills and filters them by mode + search', async () => {
    renderIntegrationsView(
      { mode: 'daemon', agentId: 'codex' },
      { initialTab: 'skills' },
    );

    await waitFor(() => {
      expect(screen.getByText('blog-post')).toBeTruthy();
      expect(screen.getByText('sales-deck')).toBeTruthy();
    });

    fireEvent.change(screen.getByRole('combobox', { name: 'Type' }), {
      target: { value: 'deck' },
    });
    expect(screen.queryByText('blog-post')).toBeNull();
    expect(screen.getByText('sales-deck')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('Search...'), {
      target: { value: 'sales' },
    });
    expect(screen.getByText('sales-deck')).toBeTruthy();
    expect(screen.queryByText('dashboard')).toBeNull();
  });

  it('updates skill filter counts from the current filter context', async () => {
    fetchSkillsMock.mockResolvedValue([
      {
        id: 'product-image',
        name: 'product-image',
        description: 'Product image generation.',
        mode: 'image',
        category: 'marketing',
        previewType: 'PNG',
        source: 'built-in',
      },
      {
        id: 'document-brief',
        name: 'document-brief',
        description: 'Document brief.',
        mode: 'deck',
        category: 'documents',
        previewType: 'HTML',
        source: 'built-in',
      },
      {
        id: 'landing-page',
        name: 'landing-page',
        description: 'Landing page.',
        mode: 'prototype',
        category: 'marketing',
        previewType: 'HTML',
        source: 'built-in',
      },
    ]);

    renderIntegrationsView(
      { mode: 'daemon', agentId: 'codex' },
      { initialTab: 'skills' },
    );

    await waitFor(() => {
      expect(screen.getByText('product-image')).toBeTruthy();
      expect(screen.getByText('document-brief')).toBeTruthy();
    });

    fireEvent.change(screen.getByRole('combobox', { name: 'Type' }), {
      target: { value: 'image' },
    });

    const categorySelect = screen.getByRole('combobox', { name: 'Category' });
    expect(
      within(categorySelect).getByRole('option', { name: 'Documents (0)' }),
    ).toBeTruthy();
    expect(
      within(categorySelect).getByRole('option', { name: 'Marketing (1)' }),
    ).toBeTruthy();

    fireEvent.change(categorySelect, {
      target: { value: 'documents' },
    });

    expect(screen.getByText('No items match your search.')).toBeTruthy();
    expect(
      within(screen.getByRole('combobox', { name: 'Category' })).getByRole(
        'option',
        { name: 'Documents (0)' },
      ),
    ).toBeTruthy();
    expect(
      within(screen.getByRole('combobox', { name: 'Type' })).getByRole('option', {
        name: 'image (0)',
      }),
    ).toBeTruthy();
  });

  it('opens a skill detail panel and persists disabled skills from toggle switches', async () => {
    const { onConfigPersist } = renderIntegrationsView(
      { mode: 'daemon', agentId: 'codex' },
      { initialTab: 'skills' },
    );

    await waitFor(() => {
      expect(screen.getByText('blog-post')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('blog-post'));
    await waitFor(() => {
      expect(fetchSkillMock).toHaveBeenCalledWith('blog-post', null);
      expect(screen.getByText('skill body for blog-post')).toBeTruthy();
    });

    const toggles = screen.getAllByTitle('Toggle');
    fireEvent.click(toggles[0] as HTMLElement);

    await waitFor(() => {
      expect(onConfigPersist).toHaveBeenCalledWith(
        expect.objectContaining({
          disabledSkills: ['blog-post'],
        }),
      );
    });
  });

  it('shows an empty state when search matches nothing', async () => {
    renderIntegrationsView(
      { mode: 'daemon', agentId: 'codex' },
      { initialTab: 'skills' },
    );

    await waitFor(() => {
      expect(screen.getByText('blog-post')).toBeTruthy();
    });

    fireEvent.change(screen.getByPlaceholderText('Search...'), {
      target: { value: 'zzz-no-match' },
    });
    expect(screen.getByText('No items match your search.')).toBeTruthy();
  });
});

describe('SettingsDialog design systems section', () => {
  afterEach(() => {
    cleanup();
  });

  it('lists design systems and persists disabled selections from toggle switches', async () => {
    const { onPersist } = renderSettingsDialog(
      { mode: 'daemon', agentId: 'codex' },
      { initialSection: 'designSystems' },
    );

    await waitFor(() => {
      expect(screen.getByText('Neutral Modern')).toBeTruthy();
      expect(screen.getByText('Signal Green')).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText('Category'), {
      target: { value: 'Experimental' },
    });
    expect(screen.queryByText('Neutral Modern')).toBeNull();
    expect(screen.getByText('Signal Green')).toBeTruthy();

    fireEvent.click(screen.getByText('Signal Green'));
    await waitFor(() => {
      expect(fetchDesignSystemMock).toHaveBeenCalledWith('signal-green', null);
      expect(screen.getByText('design system body for signal-green')).toBeTruthy();
    });

    fireEvent.click(screen.getAllByLabelText('Show in home gallery')[0] as HTMLElement);

    await waitForPersist(
      onPersist,
      expect.objectContaining({
        disabledDesignSystems: ['signal-green'],
      }),
      {},
    );
  });

  it('shows an imported design system from the hidden-only import CTA', async () => {
    renderSettingsDialog(
      {
        mode: 'daemon',
        agentId: 'codex',
        disabledDesignSystems: ['neutral-modern'],
      },
      { initialSection: 'designSystems' },
    );

    await waitFor(() => {
      expect(screen.getByText('Neutral Modern')).toBeTruthy();
      expect(screen.getByText('Signal Green')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Show hidden' }));
    expect(screen.getByText('Neutral Modern')).toBeTruthy();
    expect(screen.queryByText('Signal Green')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Add design system' }));
    fireEvent.change(screen.getByPlaceholderText('/path/to/project'), {
      target: { value: '/tmp/imported-system' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Import from project' }));

    await waitFor(() => {
      expect(importLocalDesignSystemMock).toHaveBeenCalledWith({
        baseDir: '/tmp/imported-system',
        importMode: 'hybrid',
        craftApplies: [],
      });
      expect(screen.getByText('Imported Imported System')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'View imported design system' }));

    await waitFor(() => {
      expect(screen.getByText('Imported System')).toBeTruthy();
    });
    expect(screen.queryByText('No items match your search.')).toBeNull();
  });
});

describe('SettingsDialog about interactions', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('renders app version and runtime details when version info is available', () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    renderSettingsDialog(
      { mode: 'daemon', agentId: 'codex' },
      {
        initialSection: 'about',
        appVersionInfo: {
          version: '0.4.1',
          channel: 'beta',
          packaged: true,
          platform: 'darwin',
          arch: 'arm64',
        },
      },
    );

    expect(screen.getByText('Version')).toBeTruthy();
    expect(screen.getByText('0.4.1')).toBeTruthy();
    expect(screen.getByText('Channel')).toBeTruthy();
    expect(screen.getByText('beta')).toBeTruthy();
    expect(screen.getByText('Runtime')).toBeTruthy();
    expect(screen.getByText('Packaged app')).toBeTruthy();
    expect(screen.getByText('Platform')).toBeTruthy();
    expect(screen.getByText('darwin')).toBeTruthy();
    expect(screen.getByText('Architecture')).toBeTruthy();
    expect(screen.getByText('arm64')).toBeTruthy();
    // OD Next routing is product-owned and invisible to end users. About must
    // not expose the daemon's internal rollout control.
    expect(screen.queryByTestId('od-next-rollout-control')).toBeNull();
    expect(fetchMock.mock.calls.some(([input]) => (
      String(input).includes('/api/strategies/od-next/rollout')
    ))).toBe(false);
  });

  it('renders the unavailable fallback when app version info is missing', () => {
    renderSettingsDialog(
      { mode: 'daemon', agentId: 'codex' },
      { initialSection: 'about', appVersionInfo: null },
    );

    expect(
      screen.getByText(/Version details are unavailable while the daemon is offline\./i),
    ).toBeTruthy();
  });

  it('does not create dirty state on the about page', () => {
    const first = renderSettingsDialog(
      { mode: 'daemon', agentId: 'codex' },
      {
        initialSection: 'about',
        appVersionInfo: {
          version: '0.4.1',
          channel: 'beta',
          packaged: false,
          platform: 'linux',
          arch: 'x64',
        },
      },
    );

    fireEvent.click(first.container.querySelector('.settings-close') as HTMLElement);
    expect(first.onClose).toHaveBeenCalledTimes(1);

    cleanup();

    const second = renderSettingsDialog(
      { mode: 'daemon', agentId: 'codex' },
      {
        initialSection: 'about',
        appVersionInfo: {
          version: '0.4.1',
          channel: 'beta',
          packaged: false,
          platform: 'linux',
          arch: 'x64',
        },
      },
    );

    fireEvent.click(document.querySelector('.modal-backdrop') as HTMLElement);
    expect(second.onClose).toHaveBeenCalledTimes(1);
  });

  it('shows development builds as unsupported for in-app updates', () => {
    renderSettingsDialog(
      { mode: 'daemon', agentId: 'codex' },
      {
        initialSection: 'about',
        appVersionInfo: {
          version: '0.4.1',
          channel: 'beta',
          packaged: false,
          platform: 'darwin',
          arch: 'arm64',
        },
      },
    );

    expect(screen.getByText(en['settings.updateStatusDevelopment'])).toBeTruthy();
    expect(screen.queryByRole('button', { name: en['settings.installLatest'] })).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: en['settings.updateViewReleases'] }));

    expect(openExternalUrlMock).toHaveBeenCalledWith('https://github.com/nexu-io/open-design/releases');
  });

  it('downloads an available packaged update from the about page', async () => {
    const available = updateStatus({
      availableVersion: '1.2.3-beta.4',
      state: 'available',
    });
    const downloaded = updateStatus({
      artifact: {
        name: 'Open Design Beta.dmg',
        platformKey: 'macAppleSilicon',
        type: 'dmg',
        url: 'https://fixture.test/Open Design Beta.dmg',
      },
      availableVersion: '1.2.3-beta.4',
      downloadPath: '/tmp/open-design-updater/Open Design Beta.dmg',
      state: 'downloaded',
    });
    const download = vi.fn(async () => downloaded);
    restoreOpenDesignHost = installMockOpenDesignHost({
      host: {
        updater: {
          download,
          status: vi.fn(async () => available),
        },
      },
    });

    renderSettingsDialog(
      { mode: 'daemon', agentId: 'codex' },
      {
        initialSection: 'about',
        appVersionInfo: {
          version: '1.2.3-beta.3',
          channel: 'beta',
          packaged: true,
          platform: 'darwin',
          arch: 'arm64',
        },
      },
    );

    expect(
      await screen.findByText('New version 1.2.3-beta.4 found. Preparing download.'),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: en['updater.download'] }));

    await waitFor(() => {
      expect(download).toHaveBeenCalledWith({ payload: { source: 'settings-about' } });
    });
    expect(screen.getByText('Version 1.2.3-beta.4 is ready to install.')).toBeTruthy();
  });

  it('clears the updater cache from the about page after inline confirmation', async () => {
    const cleared = updateStatus({ state: 'idle' });
    const clearCache = vi.fn(async () => cleared);
    restoreOpenDesignHost = installMockOpenDesignHost({
      host: {
        updater: {
          'clear-cache': clearCache,
          status: vi.fn(async () => updateStatus()),
        },
      },
    });

    renderSettingsDialog(
      { mode: 'daemon', agentId: 'codex' },
      {
        initialSection: 'about',
        appVersionInfo: {
          version: '1.2.3-beta.3',
          channel: 'beta',
          packaged: true,
          platform: 'darwin',
          arch: 'arm64',
        },
      },
    );

    // Two-stage inline confirm: the first click only arms the action.
    const trigger = await screen.findByTestId('settings-clear-updater-cache');
    fireEvent.click(trigger);
    expect(clearCache).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('settings-clear-updater-cache-confirm'));

    await waitFor(() => {
      expect(clearCache).toHaveBeenCalled();
    });
    expect(await screen.findByText(en['settings.clearUpdaterCacheSuccess'])).toBeTruthy();
  });

  it('hides updater cache recovery when packaged updates are unsupported', async () => {
    restoreOpenDesignHost = installMockOpenDesignHost({
      host: {
        updater: {
          status: vi.fn(async () => updateStatus({
            platform: 'linux',
            state: 'unsupported',
            supported: false,
          })),
        },
      },
    });

    renderSettingsDialog(
      { mode: 'daemon', agentId: 'codex' },
      {
        initialSection: 'about',
        appVersionInfo: {
          version: '1.2.3-beta.3',
          channel: 'beta',
          packaged: true,
          platform: 'linux',
          arch: 'x64',
        },
      },
    );

    await screen.findByText(en['settings.updateStatusUnsupported']);
    expect(screen.queryByTestId('settings-clear-updater-cache')).toBeNull();
  });

  it('installs a downloaded payload update from the about page', async () => {
    const payloadReady = updateStatus({
      artifact: {
        name: 'open-design-1.2.3-beta.4-mac-arm64-payload.zip',
        platformKey: 'mac',
        type: 'payload',
        url: 'https://fixture.test/open-design-1.2.3-beta.4-mac-arm64-payload.zip',
      },
      availableVersion: '1.2.3-beta.4',
      capabilities: {
        canApplyInPlace: true,
        canDownload: true,
        canOpenInstaller: false,
        requiresManualInstall: false,
      },
      downloadPath: '/tmp/open-design-updater/open-design-1.2.3-beta.4-mac-arm64-payload.zip',
      state: 'downloaded',
    });
    const installing = updateStatus({
      ...payloadReady,
      state: 'installing',
    });
    const install = vi.fn(async () => installing);
    const quit = vi.fn(async () => ({ ok: true as const }));
    restoreOpenDesignHost = installMockOpenDesignHost({
      host: {
        updater: {
          install,
          quit,
          status: vi.fn(async () => payloadReady),
        },
      },
    });

    renderSettingsDialog(
      { mode: 'daemon', agentId: 'codex' },
      {
        initialSection: 'about',
        appVersionInfo: {
          version: '1.2.3-beta.3',
          channel: 'beta',
          packaged: true,
          platform: 'darwin',
          arch: 'arm64',
        },
      },
    );

    expect(await screen.findByText('Version 1.2.3-beta.4 is ready to install.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: en['updater.installRestart'] }));

    await waitFor(() => {
      expect(install).toHaveBeenCalledWith({ payload: { source: 'settings-about' } });
    });
    await waitFor(() => {
      expect(quit).toHaveBeenCalledWith({ payload: { source: 'settings-about' } });
    });
  });

  it('keeps a quit retry action when update install succeeds but quit throws or fails', async () => {
    const payloadReady = updateStatus({
      artifact: {
        name: 'open-design-1.2.3-beta.4-mac-arm64-payload.zip',
        platformKey: 'mac',
        type: 'payload',
        url: 'https://fixture.test/open-design-1.2.3-beta.4-mac-arm64-payload.zip',
      },
      availableVersion: '1.2.3-beta.4',
      capabilities: {
        canApplyInPlace: true,
        canDownload: true,
        canOpenInstaller: false,
        requiresManualInstall: false,
      },
      downloadPath: '/tmp/open-design-updater/open-design-1.2.3-beta.4-mac-arm64-payload.zip',
      state: 'downloaded',
    });
    const installed = updateStatus({
      ...payloadReady,
      installResult: {
        dryRun: true,
        openedAt: '2026-05-19T00:00:00.000Z',
        path: '/tmp/open-design-updater/open-design-1.2.3-beta.4-mac-arm64-payload.zip',
      },
    });
    const install = vi.fn(async () => installed);
    const quit = vi.fn()
      .mockRejectedValueOnce(new Error('desktop quit failed'))
      .mockResolvedValue({
        ok: false as const,
        reason: 'desktop quit is not available',
      });
    restoreOpenDesignHost = installMockOpenDesignHost({
      host: {
        updater: {
          install,
          quit,
          status: vi.fn(async () => payloadReady),
        },
      },
    });

    renderSettingsDialog(
      { mode: 'daemon', agentId: 'codex' },
      {
        initialSection: 'about',
        appVersionInfo: {
          version: '1.2.3-beta.3',
          channel: 'beta',
          packaged: true,
          platform: 'darwin',
          arch: 'arm64',
        },
      },
    );

    fireEvent.click(await screen.findByRole('button', { name: en['updater.installRestart'] }));

    await waitFor(() => {
      expect(install).toHaveBeenCalledWith({ payload: { source: 'settings-about' } });
    });
    await waitFor(() => {
      expect(quit).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByRole('button', { name: en['updater.quitButton'] })).toBeTruthy();
    expect(screen.getAllByText(en['updater.quitFailedTitle']).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: en['updater.quitButton'] }));

    await waitFor(() => {
      expect(quit).toHaveBeenCalledTimes(2);
    });
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('toggles allowSilentUpdates via the non-optimistic Settings path without crashing', async () => {
    const onSilentUpdatePreferenceChange = vi.fn(async () => undefined);
    const { onPersist } = renderSettingsDialog(
      { mode: 'daemon', agentId: 'codex', allowSilentUpdates: false },
      {
        initialSection: 'about',
        appVersionInfo: {
          version: '0.14.1',
          channel: 'beta',
          packaged: true,
          platform: 'darwin',
          arch: 'arm64',
        },
        onSilentUpdatePreferenceChange,
      },
    );

    const checkbox = screen.getByTestId('settings-allow-silent-updates') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
    await waitFor(() => expect(onSilentUpdatePreferenceChange).toHaveBeenCalledWith(true));
    // Must not go through optimistic handleConfigPersist autosave.
    expect(onPersist).not.toHaveBeenCalled();

    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);
    await waitFor(() => expect(onSilentUpdatePreferenceChange).toHaveBeenCalledWith(false));
  });

  it('reverts the Settings silent-update toggle when the non-optimistic save fails', async () => {
    let appConfigSilent: boolean | undefined = false;
    const onSilentUpdatePreferenceChange = vi.fn(async (value: boolean) => {
      throw new Error('daemon offline');
      appConfigSilent = value;
    });
    renderSettingsDialog(
      { mode: 'daemon', agentId: 'codex', allowSilentUpdates: false },
      {
        initialSection: 'about',
        appVersionInfo: {
          version: '0.14.1',
          channel: 'beta',
          packaged: true,
          platform: 'darwin',
          arch: 'arm64',
        },
        onSilentUpdatePreferenceChange,
      },
    );

    const checkbox = screen.getByTestId('settings-allow-silent-updates') as HTMLInputElement;
    fireEvent.click(checkbox);
    await waitFor(() => expect(onSilentUpdatePreferenceChange).toHaveBeenCalledWith(true));
    await waitFor(() => {
      expect((screen.getByTestId('settings-allow-silent-updates') as HTMLInputElement).checked).toBe(false);
    });
    // App-wide preference must not keep the rejected value.
    expect(appConfigSilent).toBe(false);
  });

  it('disables the Settings silent-update checkbox while a save is in flight', async () => {
    let resolveSave: (() => void) | null = null;
    const onSilentUpdatePreferenceChange = vi.fn(
      () => new Promise<void>((resolve) => {
        resolveSave = resolve;
      }),
    );
    renderSettingsDialog(
      { mode: 'daemon', agentId: 'codex', allowSilentUpdates: false },
      {
        initialSection: 'about',
        appVersionInfo: {
          version: '0.14.1',
          channel: 'beta',
          packaged: true,
          platform: 'darwin',
          arch: 'arm64',
        },
        onSilentUpdatePreferenceChange,
      },
    );

    const checkbox = screen.getByTestId('settings-allow-silent-updates') as HTMLInputElement;
    fireEvent.click(checkbox);
    await waitFor(() => expect(onSilentUpdatePreferenceChange).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(checkbox.disabled).toBe(true));

    await act(async () => {
      resolveSave?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(checkbox.disabled).toBe(false));
    expect(onSilentUpdatePreferenceChange).toHaveBeenCalledTimes(1);
  });

  it('still autosaves an unrelated edit that lands during a silent-update save', async () => {
    // Regression: success must only advance autosaveLastSavedRef for
    // allowSilentUpdates. Spreading the whole latest draft would mark a
    // concurrent unrelated change as already saved and skip onPersist.
    let resolveSave: (() => void) | null = null;
    const onSilentUpdatePreferenceChange = vi.fn(
      () => new Promise<void>((resolve) => {
        resolveSave = resolve;
      }),
    );
    const { onPersist } = renderSettingsDialog(
      {
        mode: 'daemon',
        agentId: 'codex',
        allowSilentUpdates: false,
        // Seeded on so the concurrent click below is a real state change.
        notifications: {
          soundEnabled: true,
          successSoundId: 'chime',
          failureSoundId: 'two-tone-down',
          desktopEnabled: false,
        },
      },
      {
        initialSection: 'about',
        appVersionInfo: {
          version: '0.14.1',
          channel: 'beta',
          packaged: true,
          platform: 'darwin',
          arch: 'arm64',
        },
        onSilentUpdatePreferenceChange,
      },
    );

    fireEvent.click(screen.getByTestId('settings-allow-silent-updates'));
    await waitFor(() => expect(onSilentUpdatePreferenceChange).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(
        (screen.getByTestId('settings-allow-silent-updates') as HTMLInputElement).disabled,
      ).toBe(true);
    });
    expect(onPersist).not.toHaveBeenCalled();

    // Concurrent persisted edit while the silent-update request is in flight.
    // The invariant under test is the autosave bookkeeping, not the field that
    // carries it — theme selection was the old vehicle and is gone, so this
    // reaches for the notifications completion-sound toggle instead.
    fireEvent.click(screen.getByRole('button', { name: /General/i }));
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Completion sound' })).getByRole('button', {
        name: 'inactive',
      }),
    );

    // Resolve silent-update AFTER the concurrent edit is in draft. The success
    // path must not stamp this edit into autosaveLastSavedRef.
    await act(async () => {
      resolveSave?.();
      await Promise.resolve();
    });

    await waitForPersist(
      onPersist,
      expect.objectContaining({
        notifications: expect.objectContaining({ soundEnabled: false }),
      }),
      {},
    );
  });

  it('does not read event.currentTarget inside the silent-updates setCfg updater', async () => {
    // Source invariant: functional updaters must not close over event.currentTarget
    // (null after the native/React event handler returns under pending lanes).
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const source = await readFile(
      join(process.cwd(), 'src/components/SettingsDialog.tsx'),
      'utf8',
    );
    const silentToggleBlock = source.match(
      /data-testid="settings-allow-silent-updates"[\s\S]*?<\/label>/,
    )?.[0];
    expect(silentToggleBlock).toBeTruthy();
    expect(silentToggleBlock).not.toMatch(
      /setCfg\(\s*\(\s*current\s*\)\s*=>\s*\(\{[\s\S]*?event\.currentTarget\.checked/,
    );
    expect(silentToggleBlock).toMatch(/const allowSilentUpdates = event\.currentTarget\.checked/);
  });
});
