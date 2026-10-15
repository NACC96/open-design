// @vitest-environment jsdom
//
// recvpZCr4MAqNQ: a project's name stayed "未命名" forever, even after its
// first prompt ran and produced real content. Root cause: the Drafts / All-
// projects empty-state "New project" CTA (`EntryShell.startBlankProjectFromRail`)
// created a project with the literal placeholder name and NO `nameSource`
// metadata at all. `canAutoRenameProjectFromPrompt` (utils/projectName.ts)
// only re-engages for `nameSource: 'generated' | 'prompt'` — a project
// missing the field entirely fails closed forever, unlike every other blank/
// no-name create path (`handleCreateProjectFromDesignSystem`, the New Project
// panel's blank pick), which already tag `nameSource: 'generated'`.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  buildWorkspacePermissions,
  buildWorkspaceSeatSummary,
  type WorkspaceCollabContext,
} from '@open-design/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EntryShell } from '../../src/components/EntryShell';
import { I18nProvider } from '../../src/i18n';
import type { AgentInfo, AppConfig } from '../../src/types';
import {
  notifyWorkspaceContextRefresh,
  resetTeamProjectsCache,
  resetWorkspaceContextCache,
} from '../../src/collab/useWorkspaceContext';
import { workspaceDirectoryFixture } from '../helpers/workspace-context';
import {
  fetchProjectFiles,
  invalidateProjectFilesCache,
} from '../../src/providers/registry';


const originalFetch = globalThis.fetch;
const originalResizeObserver = globalThis.ResizeObserver;

class ResizeObserverMock {
  observe() {}
  disconnect() {}
  unobserve() {}
}

type EventSourceListener = (event: unknown) => void;
class MockWorkspaceEventSource {
  static instances: MockWorkspaceEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, Set<EventSourceListener>>();

  constructor(readonly url: string) {
    MockWorkspaceEventSource.instances.push(this);
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// All-projects is a workspace-only view: EntryShell redirects it back to Home
// once the workspace-context read resolves with nothing (Drafts stays, as the
// local project list, since OPEND-3140). Give
// every test a resolved team context up front — the real bug reproduces
// inside a team workspace ("OD Feature Team" in the live acceptance check) —
// so the empty-state CTA renders deterministically instead of racing a
// same-tick redirect.
function teamContext(
  overrides: Partial<WorkspaceCollabContext> = {},
): WorkspaceCollabContext {
  const role = 'member' as const;
  const lifecycleState = 'active' as const;
  return {
    workspaceId: 'ws-1',
    workspaceType: 'team',
    workspaceMemberId: 'wm-1',
    role,
    memberStatus: 'active',
    lifecycleState,
    billingState: 'active',
    planId: null,
    providerMode: 'platform_credits',
    seatSummary: buildWorkspaceSeatSummary({ seatLimit: 5, usedSeats: 1 }),
    permissions: buildWorkspacePermissions({ role, lifecycleState }),
    displayName: 'Ma Shu',
    ...overrides,
  };
}

function installFetchMock() {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const pathname = new URL(String(input), 'http://d.local').pathname;
    if (pathname.endsWith('/workspace/directory')) {
      return jsonResponse(workspaceDirectoryFixture([teamContext()]));
    }
    if (pathname.endsWith('/workspace/context')) {
      return jsonResponse({ context: teamContext() });
    }
    if (pathname.endsWith('/workspace/projects/team')) {
      return jsonResponse({ projects: [] });
    }
    return jsonResponse({});
  }) as typeof fetch;
}

function cliAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: 'claude-code',
    name: 'Claude Code',
    bin: 'claude',
    available: true,
    version: '1.0.0',
    models: [{ id: 'sonnet', label: 'Sonnet' }],
    ...overrides,
  };
}

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    mode: 'daemon',
    agentId: 'claude-code',
    agentModels: { 'claude-code': { model: 'sonnet' } },
    apiProtocol: 'anthropic',
    apiProtocolConfigs: {},
    apiKey: '',
    baseUrl: '',
    model: '',
    theme: 'system',
    ...overrides,
  } as AppConfig;
}

function renderAt(path: string, overrides: Partial<React.ComponentProps<typeof EntryShell>> = {}) {
  window.history.replaceState(null, '', path);
  const props: React.ComponentProps<typeof EntryShell> = {
    skills: [],
    designTemplates: [],
    designSystems: [],
    projects: [],
    templates: [],
    promptTemplates: [],
    defaultDesignSystemId: null,
    connectors: [],
    connectorsLoading: false,
    config: baseConfig(),
    agents: [cliAgent()],
    daemonLive: true,
    onModeChange: vi.fn(),
    onAgentChange: vi.fn(),
    onAgentModelChange: vi.fn(),
    onApiProtocolChange: vi.fn(),
    onApiModelChange: vi.fn(),
    onConfigPersist: vi.fn(),
    onRefreshAgents: vi.fn(() => [cliAgent()]),
    onCreateProject: vi.fn(() => Promise.resolve(true)),
    onBeginProjectCreation: () => ({ projectId: 'optimistic-project', rollback: () => undefined }),
    onAmrBalanceGateBlockChange: () => undefined,
    onCreatePluginShareProject: vi.fn(),
    onImportClaudeDesign: vi.fn(),
    onOpenProject: vi.fn(),
    onOpenLiveArtifact: vi.fn(),
    onDeleteProject: vi.fn(),
    onRenameProject: vi.fn(),
    onChangeDefaultDesignSystem: vi.fn(),
    onPersistComposioKey: vi.fn(),
    onOpenSettings: vi.fn(),
    onCompleteOnboarding: vi.fn(),
    ...overrides,
  };

  render(
    <I18nProvider initial="en">
      <EntryShell {...props} />
    </I18nProvider>,
  );

  return props;
}

beforeEach(() => {
  globalThis.ResizeObserver = ResizeObserverMock as typeof ResizeObserver;
  resetWorkspaceContextCache();
  resetTeamProjectsCache();
  MockWorkspaceEventSource.instances = [];
  installFetchMock();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  globalThis.ResizeObserver = originalResizeObserver;
  resetWorkspaceContextCache();
  resetTeamProjectsCache();
  vi.unstubAllGlobals();
});

describe('EntryShell signed-out recent projects', () => {
  const localProject = {
    id: 'local-project', name: 'Local project', skillId: null,
    designSystemId: null, createdAt: 1, updatedAt: 1,
  };
  beforeEach(() => {
    // The rail is collapsed (aria-hidden) on a fresh profile; dock it open so
    // role queries can reach its rows.
    window.localStorage.setItem('od.entry.railOpen', 'true');
    globalThis.fetch = vi.fn(async () => jsonResponse({ context: null, projects: [], plugins: [] }));
  });
  afterEach(() => {
    window.localStorage.removeItem('od.entry.railOpen');
  });

  // OPEND-3140: the local shell lists its projects in the rail's 最近项目
  // section, not in a Home grid, and the rail row's menu drives the same
  // rename handler the grid used to.
  it('lists local projects in the rail, not on Home, and renames from the rail row', async () => {
    const props = renderAt('/', { projects: [localProject] });
    const home = screen.getByTestId('entry-view-home');
    const row = await screen.findByTestId('entry-nav-recent-item');
    expect(row.textContent).toContain('Local project');
    expect(home.querySelector('.recent-projects')).toBeNull();
    expect(screen.queryByTestId('recent-projects-strip')).toBeNull();

    fireEvent.click(screen.getByTestId('entry-nav-recent-more'));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'Rename' }) as HTMLInputElement;
    expect(input.value).toBe('Local project');
    await act(async () => {
      fireEvent.change(input, { target: { value: 'Renamed local project' } });
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(props.onRenameProject).toHaveBeenCalledWith('local-project', 'Renamed local project');
  });

  it('opens the 项目 page from the rail with the local catalogue', async () => {
    renderAt('/', { projects: [localProject] });
    await screen.findByTestId('entry-nav-recent-item');
    fireEvent.click(screen.getByTestId('entry-nav-drafts'));
    expect(window.location.pathname).toBe('/drafts');
    const strip = await screen.findByTestId('recent-projects-strip');
    expect(within(strip).getByText('Local project')).toBeTruthy();
  });

  // OPEND-2793 (product decision B): the community gallery browses without a
  // docked composer until phase three gives it a template-bound shape. The
  // `dock` variant of HomeView stays in the codebase; Community just no longer
  // mounts it, so the grid can use the full page height.
  it('renders the Community gallery without a docked composer', async () => {
    renderAt('/community', { projects: [localProject] });
    await screen.findByTestId('entry-view-home');
    expect(screen.queryByTestId('community-composer-dock')).toBeNull();
    // Home's own composer is still the single composer in the shell.
    expect(screen.getAllByTestId('home-hero-composer-card')).toHaveLength(1);
  });
});

describe('EntryShell blank-project creation tags nameSource', () => {
  it('tags the Drafts empty-state "New project" CTA as generated', async () => {
    const props = renderAt('/drafts');

    const cta = await screen.findByRole('button', { name: 'New project' });
    fireEvent.click(cta);

    expect(props.onCreateProject).toHaveBeenCalledTimes(1);
    expect(props.onCreateProject).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Untitled',
        metadata: expect.objectContaining({ nameSource: 'generated' }),
      }),
    );
  });
});
