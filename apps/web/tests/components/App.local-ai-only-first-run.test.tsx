// @vitest-environment jsdom

// Fork (Local AI only): a fresh install never meets first-run onboarding. It
// lands on Home, and the App picks a local agent itself — Claude Code when it
// is installed, otherwise the first installed agent in registry order. A
// daemon copy that still names a retired Cloud / API-key runtime is cleared so
// the same auto-pick runs.

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/App';
import type { AgentInfo, AppConfig } from '../../src/types';
import {
  DEFAULT_CONFIG,
  fetchDaemonConfig,
  loadConfig,
  syncConfigToDaemon,
} from '../../src/state/config';
import {
  daemonIsLive,
  fetchAgentsStream,
  fetchAppVersionInfo,
  fetchDesignSystems,
  fetchPromptTemplates,
  fetchSkills,
} from '../../src/providers/registry';
import { listProjects, listTemplates } from '../../src/state/projects';
import { navigate } from '../../src/router';

vi.mock('../../src/router', () => ({
  navigate: vi.fn(),
  useRoute: () => ({ kind: 'home' as const, view: 'home' as const }),
}));

vi.mock('../../src/components/EntryView', () => ({
  EntryView: ({ config }: { config: AppConfig }) => (
    <>
      <div data-testid="home-entry">home</div>
      <div data-testid="agent-id">{config.agentId ?? 'none'}</div>
      <div data-testid="mode">{config.mode}</div>
      <div data-testid="onboarding-completed">{String(config.onboardingCompleted)}</div>
    </>
  ),
}));

vi.mock('../../src/components/ProjectView', () => ({
  ProjectView: () => <div>Project view</div>,
}));

vi.mock('../../src/components/pet/PetOverlay', () => ({
  PetOverlay: () => null,
}));

vi.mock('../../src/components/pet/pets', () => ({
  migrateCustomPetAtlas: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/components/SettingsDialog', () => ({
  SettingsDialog: () => null,
}));

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    daemonIsLive: vi.fn(),
    fetchAgentsStream: vi.fn(),
    fetchAppVersionInfo: vi.fn(),
    fetchDesignSystems: vi.fn(),
    fetchPromptTemplates: vi.fn(),
    fetchSkills: vi.fn(),
  };
});

vi.mock('../../src/state/projects', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/projects')>(
    '../../src/state/projects',
  );
  return {
    ...actual,
    listProjects: vi.fn(),
    listTemplates: vi.fn(),
  };
});

vi.mock('../../src/state/config', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/config')>(
    '../../src/state/config',
  );
  return {
    ...actual,
    fetchComposioConfigFromDaemon: vi.fn().mockResolvedValue(null),
    loadConfig: vi.fn(),
    // The real merge, so a daemon copy naming a retired runtime is normalized
    // exactly as in production.
    mergeDaemonConfig: vi.fn(actual.mergeDaemonConfig),
    saveConfig: vi.fn(),
    fetchDaemonConfig: vi.fn(),
    fetchMediaProvidersFromDaemon: vi.fn().mockResolvedValue({
      status: 'ok',
      providers: null,
    }),
    syncComposioConfigToDaemon: vi.fn().mockResolvedValue(true),
    syncConfigToDaemon: vi.fn().mockResolvedValue(undefined),
    syncMediaProvidersToDaemon: vi.fn().mockResolvedValue(undefined),
  };
});

const mockedDaemonIsLive = vi.mocked(daemonIsLive);
const mockedFetchAgentsStream = vi.mocked(fetchAgentsStream);
const mockedLoadConfig = vi.mocked(loadConfig);
const mockedFetchDaemonConfig = vi.mocked(fetchDaemonConfig);
const mockedSyncConfigToDaemon = vi.mocked(syncConfigToDaemon);
const mockedNavigate = vi.mocked(navigate);

function agent(id: string, available: boolean): AgentInfo {
  return {
    id,
    name: id,
    bin: id,
    available,
    version: available ? '1.0.0' : null,
    models: [{ id: 'default', label: 'Default' }],
  } as AgentInfo;
}

function freshInstallConfig(): AppConfig {
  return { ...DEFAULT_CONFIG, agentModels: {}, agentCliEnv: {}, agentCliEnvIntent: {} };
}

function expectNeverRoutedToOnboarding() {
  for (const [route] of mockedNavigate.mock.calls) {
    expect(route).not.toMatchObject({ view: 'onboarding' });
  }
}

describe('App first run (Local AI only)', () => {
  beforeEach(() => {
    mockedDaemonIsLive.mockResolvedValue(true);
    vi.mocked(fetchSkills).mockResolvedValue([]);
    vi.mocked(fetchDesignSystems).mockResolvedValue([]);
    vi.mocked(fetchPromptTemplates).mockResolvedValue([]);
    vi.mocked(fetchAppVersionInfo).mockResolvedValue(null);
    vi.mocked(listProjects).mockResolvedValue([]);
    vi.mocked(listTemplates).mockResolvedValue([]);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('ships with onboarding already complete', () => {
    expect(DEFAULT_CONFIG.onboardingCompleted).toBe(true);
    expect(DEFAULT_CONFIG.mode).toBe('daemon');
  });

  it('lands a fresh install on Home with Claude Code preselected', async () => {
    mockedLoadConfig.mockReturnValue(freshInstallConfig());
    mockedFetchDaemonConfig.mockResolvedValue({});
    // Codex resolves first in registry order; Claude must still win.
    mockedFetchAgentsStream.mockResolvedValue([
      agent('codex', true),
      agent('claude', true),
      agent('opencode', true),
    ]);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('agent-id').textContent).toBe('claude');
    });
    expect(screen.getByTestId('home-entry')).toBeTruthy();
    expect(screen.getByTestId('mode').textContent).toBe('daemon');
    expect(screen.getByTestId('onboarding-completed').textContent).toBe('true');
    expectNeverRoutedToOnboarding();
    // The completion fact and the pick both reach the daemon.
    expect(
      mockedSyncConfigToDaemon.mock.calls.some(
        ([cfg]) => cfg.agentId === 'claude' && cfg.onboardingCompleted === true,
      ),
    ).toBe(true);
  });

  it('falls back to the first installed local agent when Claude Code is missing', async () => {
    mockedLoadConfig.mockReturnValue(freshInstallConfig());
    mockedFetchDaemonConfig.mockResolvedValue({});
    mockedFetchAgentsStream.mockResolvedValue([
      agent('claude', false),
      agent('codex', false),
      agent('opencode', true),
      agent('antigravity', true),
    ]);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('agent-id').textContent).toBe('opencode');
    });
    expectNeverRoutedToOnboarding();
  });

  it('stays on Home with no agent when nothing is installed', async () => {
    mockedLoadConfig.mockReturnValue(freshInstallConfig());
    mockedFetchDaemonConfig.mockResolvedValue({});
    mockedFetchAgentsStream.mockResolvedValue([
      agent('claude', false),
      agent('codex', false),
    ]);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('home-entry')).toBeTruthy();
    });
    await waitFor(() => expect(mockedFetchAgentsStream).toHaveBeenCalled());
    expect(screen.getByTestId('agent-id').textContent).toBe('none');
    expectNeverRoutedToOnboarding();
  });

  it('clears a retired Cloud agent saved by the daemon and re-picks a local one', async () => {
    mockedLoadConfig.mockReturnValue({
      ...freshInstallConfig(),
      agentId: 'claude',
    });
    // An existing install whose daemon copy still points at OpenDesign Cloud,
    // with onboarding never finished on the daemon side.
    mockedFetchDaemonConfig.mockResolvedValue({
      agentId: 'amr',
      onboardingCompleted: false,
    });
    mockedFetchAgentsStream.mockResolvedValue([
      agent('claude', true),
      agent('codex', true),
    ]);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('agent-id').textContent).toBe('claude');
    });
    expect(screen.getByTestId('onboarding-completed').textContent).toBe('true');
    expectNeverRoutedToOnboarding();
    expect(
      mockedSyncConfigToDaemon.mock.calls.every(([cfg]) => cfg.agentId !== 'amr'),
    ).toBe(true);
  });
});
