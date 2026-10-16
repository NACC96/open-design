// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type {
  InstalledPluginRecord,
  SkillSummary,
  WorkspaceCollabContext,
} from '@open-design/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PluginsView } from '../../src/components/PluginsView';
import {
  notifyWorkspaceContextRefresh,
  resetWorkspaceContextCache,
} from '../../src/collab/useWorkspaceContext';
import { I18nProvider } from '../../src/i18n';
import { fetchSkills } from '../../src/providers/registry';
import { listPluginMarketplaces, listPlugins } from '../../src/state/projects';

vi.mock('../../src/analytics/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/analytics/provider')>();
  return { ...actual, useAnalytics: () => ({ track: vi.fn() }) };
});

vi.mock('../../src/collab/useWorkspaceContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/collab/useWorkspaceContext')>()),
  useWorkspaceContext: () => ({
    context: currentWorkspaceContext,
    loading: currentWorkspaceLoading,
    identityChangePending: currentIdentityChangePending,
    failure: currentWorkspaceFailure,
    refresh: vi.fn(),
  }),
}));

vi.mock('../../src/providers/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/providers/registry')>()),
  fetchSkills: vi.fn(),
}));

vi.mock('../../src/state/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/state/projects')>()),
  listPluginMarketplaces: vi.fn(),
  listPlugins: vi.fn(),
}));

function workspaceContext(workspaceId: string): WorkspaceCollabContext {
  return {
    workspaceId,
    workspaceType: 'team',
    workspaceMemberId: `member-${workspaceId}`,
    role: 'owner',
    memberStatus: 'active',
    lifecycleState: 'active',
    billingState: 'active',
    planId: null,
    providerMode: 'platform_credits',
    seatSummary: { seatLimit: 5, usedSeats: 1, availableSeats: 4, isSeatFull: false },
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
    displayName: workspaceId,
  };
}

function skill(id: string): SkillSummary {
  return {
    id,
    name: id,
    description: id,
    triggers: [],
    mode: 'prototype',
    source: 'user',
  } as unknown as SkillSummary;
}

function plugin(id: string): InstalledPluginRecord {
  return {
    id,
    title: id,
    version: '1.0.0',
    sourceKind: 'local',
    source: `/local/${id}`,
    trust: 'restricted',
    capabilitiesGranted: [],
    manifest: { name: id, title: id, version: '1.0.0' },
    fsPath: `/local/${id}`,
    installedAt: 0,
    updatedAt: 0,
  } as InstalledPluginRecord;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

let currentWorkspaceContext: WorkspaceCollabContext | null = workspaceContext('ws-a');
let currentWorkspaceLoading = false;
let currentIdentityChangePending = false;
let currentWorkspaceFailure: 'unsupported' | 'unavailable' | undefined;

function renderPluginsView() {
  return render(
    <I18nProvider initial="en">
      <PluginsView />
    </I18nProvider>,
  );
}

describe('PluginsView Team panel workspace scope', () => {
  it('never mounts the legacy Team panel for a saved team workspace', async () => {
    vi.mocked(listPlugins).mockResolvedValue([plugin('local-plugin')]);
    renderPluginsView();
    await screen.findAllByText('local-plugin');
    expect(screen.queryByRole('tab', { name: /Team/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Share to team|Sync to team/i })).toBeNull();
    expect(vi.mocked(fetchSkills)).not.toHaveBeenCalled();
    expect(vi.mocked(listPlugins)).toHaveBeenCalledWith(expect.objectContaining({ workspaceContext: currentWorkspaceContext }));
  });

  beforeEach(() => {
    resetWorkspaceContextCache();
    currentWorkspaceContext = workspaceContext('ws-a');
    currentWorkspaceLoading = false;
    currentIdentityChangePending = false;
    currentWorkspaceFailure = undefined;
    vi.mocked(listPlugins).mockResolvedValue([]);
    vi.mocked(listPluginMarketplaces).mockResolvedValue([]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/team')) return jsonResponse({ ids: [] });
        return jsonResponse({});
      }),
    );
  });

  it('hides installed rows across an account boundary and does not query with the retired identity while pending', async () => {
    vi.mocked(fetchSkills).mockResolvedValue([]);
    let successorReadsFail = false;
    vi.mocked(listPlugins).mockImplementation(async (options = {}) => {
      if (successorReadsFail) throw new Error('successor account plugin catalog unavailable');
      if (options.workspaceContext?.workspaceId === 'ws-a') return [plugin('plugin-from-account-a')];
      return [];
    });

    const view = renderPluginsView();
    expect((await screen.findAllByText('plugin-from-account-a')).length).toBeGreaterThan(0);
    expect(vi.mocked(listPlugins)).toHaveBeenCalledTimes(2);

    act(() => {
      notifyWorkspaceContextRefresh();
      currentWorkspaceLoading = true;
      currentIdentityChangePending = true;
      view.rerender(
        <I18nProvider initial="en">
          <PluginsView />
        </I18nProvider>,
      );
    });

    expect(screen.queryAllByText('plugin-from-account-a')).toHaveLength(0);
    await act(async () => Promise.resolve());
    expect(vi.mocked(listPlugins)).toHaveBeenCalledTimes(2);

    // The successor account can legitimately expose the same Workspace/member
    // field values. Account generation, not those reusable strings, is the
    // boundary. Its failed read must still produce a safe empty catalog.
    successorReadsFail = true;
    currentWorkspaceLoading = false;
    currentIdentityChangePending = false;
    view.rerender(
      <I18nProvider initial="en">
        <PluginsView />
      </I18nProvider>,
    );
    await waitFor(() => expect(vi.mocked(listPlugins)).toHaveBeenCalledTimes(4));
    expect(screen.queryAllByText('plugin-from-account-a')).toHaveLength(0);

    currentWorkspaceContext = null;
    currentWorkspaceFailure = 'unavailable';
    view.rerender(
      <I18nProvider initial="en">
        <PluginsView />
      </I18nProvider>,
    );

    expect(screen.queryAllByText('plugin-from-account-a')).toHaveLength(0);
    await act(async () => Promise.resolve());
    expect(vi.mocked(listPlugins)).toHaveBeenCalledTimes(4);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps the event-refreshed plugin rows when a same-identity read resolves late', async () => {
    const initialRead = deferred<InstalledPluginRecord[]>();
    const eventRead = deferred<InstalledPluginRecord[]>();
    vi.mocked(fetchSkills).mockResolvedValue([]);
    vi.mocked(listPlugins).mockImplementation(() => (
      vi.mocked(listPlugins).mock.calls.length <= 2
        ? initialRead.promise
        : eventRead.promise
    ));

    renderPluginsView();
    await waitFor(() => expect(vi.mocked(listPlugins)).toHaveBeenCalledTimes(2));
    act(() => window.dispatchEvent(new CustomEvent('open-design:plugins-changed')));
    await waitFor(() => expect(vi.mocked(listPlugins)).toHaveBeenCalledTimes(4));

    await act(async () => {
      eventRead.resolve([plugin('fresh-plugin')]);
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getAllByText('fresh-plugin').length).toBeGreaterThan(0));

    await act(async () => {
      initialRead.resolve([plugin('stale-plugin')]);
      await Promise.resolve();
    });
    expect(screen.getAllByText('fresh-plugin').length).toBeGreaterThan(0);
    expect(screen.queryAllByText('stale-plugin')).toHaveLength(0);
  });
});
