// @vitest-environment jsdom

// Local-only resource UI keeps workspace authority while hiding team controls.

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesignSystemSummary, WorkspaceCollabContext } from '@open-design/contracts';

import { DesignSystemsTab } from '../../src/components/DesignSystemsTab';
import { I18nProvider } from '../../src/i18n';
import { resetCoalescedGet } from '../../src/lib/coalesced-get';
import { workspaceContextFixture } from '../helpers/workspace-context';

const workspaceInvalidationHarness = vi.hoisted(() => ({
  handlers: [] as Array<Record<string, (payload: any) => void>>,
  onActive: [] as Array<() => void>,
  autoActivate: true,
}));

vi.mock('../../src/collab/workspace-events', () => ({
  useWorkspaceInvalidation: vi.fn((
    handlers: Record<string, (payload: any) => void>,
    options?: { onActive?: () => void; enabled?: boolean; workspaceContext?: unknown },
  ) => {
    workspaceInvalidationHarness.handlers.push(handlers);
    if (options?.onActive) workspaceInvalidationHarness.onActive.push(options.onActive);
    const identity = JSON.stringify(options?.workspaceContext ?? null);
    React.useEffect(() => {
      if (workspaceInvalidationHarness.autoActivate && options?.enabled !== false && options?.workspaceContext) {
        options.onActive?.();
      }
    }, [identity, options?.enabled]);
    return { connected: false };
  }),
}));

vi.mock('../../src/analytics/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/analytics/provider')>();
  return { ...actual, useAnalytics: () => ({ track: vi.fn() }) };
});

vi.mock('../../src/providers/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/providers/registry')>();
  return {
    ...actual,
    fetchDesignSystem: vi.fn(async (id: string) => ({
      id,
      title: 'My Design System',
      summary: 'Owned by me.',
      category: 'Custom',
      body: `# ${id}\n\n## Colors\n- Primary #111111`,
    })),
    updateDesignSystemDraft: vi.fn(async () => null),
    deleteDesignSystemDraft: vi.fn(async () => true),
  };
});

const TEAM_CONTEXT = workspaceContextFixture({
  workspaceId: 'ws-team',
  teamId: 'ws-team',
  workspaceType: 'team',
  workspaceMemberId: 'mem-owner',
  billingState: 'free',
  planId: null,
  permissions: {
    canManageMembers: false,
    canManageBilling: false,
    canInviteMembers: false,
    canManageAutoRecharge: false,
    canShareProjects: true,
    canWriteSyncedFiles: true,
    canViewWorkspaceSettings: false,
    canManageSharedResources: true,
  },
});

const SECOND_TEAM_CONTEXT = workspaceContextFixture({
  ...TEAM_CONTEXT,
  workspaceId: 'ws-second',
  teamId: 'ws-second',
  workspaceMemberId: 'mem-second',
});

let workspaceContext: WorkspaceCollabContext | null = TEAM_CONTEXT;

vi.mock('../../src/collab/useWorkspaceContext', () => ({
  useWorkspaceContext: () => ({ context: workspaceContext, loading: false, refresh: vi.fn() }),
  useWorkspaceBilling: () => ({ membershipTier: '' }),
}));

// The sharer's OWN copy: `teamSynced` is never stamped on it (only on a
// teammate's pulled copy — see `syncSharedTeamDesignSystem`'s `markTeamSynced`
// in server.ts, which returns early `if (isOwnedByCurrentMember)`). The Team
// index is therefore the authority that moves this summary out of Personal.
const MY_SHARED_SYSTEM: DesignSystemSummary = {
  id: 'user:my-ds',
  title: 'My Design System',
  category: 'Custom',
  summary: 'Owned by me.',
  surface: 'web',
  source: 'user',
  status: 'draft',
  isEditable: true,
  updatedAt: '2026-07-24T00:00:00.000Z',
};

// A workspace-materialized Team copy: `teamSynced: true` is stamped on the
// pulled mirror, including an owner's fresh-device mirror. The author's exact
// local original remains Personal and does not receive this marker.
const TEAMMATE_PULLED_SYSTEM: DesignSystemSummary = {
  id: 'user:teammate-ds',
  title: 'Teammate Design System',
  category: 'Custom',
  summary: 'Shared by a teammate.',
  surface: 'web',
  source: 'user',
  status: 'draft',
  isEditable: true,
  teamSynced: true,
  updatedAt: '2026-05-13T03:19:00.000Z',
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

let shareCalls: string[] = [];
let teamReadHeaders: Headers[] = [];
let unshareCalls: Array<{ url: string; headers: Headers }> = [];

function mockFetch(
  canUnshare: boolean,
  sharedId = 'user:my-ds',
  initiallyShared = true,
) {
  let shared = initiallyShared;
  shareCalls = [];
  teamReadHeaders = [];
  unshareCalls = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/workspace/design-systems/team')) {
      teamReadHeaders.push(new Headers(init?.headers));
      return jsonResponse({
        ids: shared ? [sharedId] : [],
        resources: shared
          ? [{ id: sharedId, canUnshare, ownerMemberId: 'mem-owner' }]
          : [],
      });
    }
    if (url.includes('/share') && init?.method === 'POST') {
      shareCalls.push(url);
      shared = true;
      return jsonResponse({ shared: true, version: shareCalls.length });
    }
    if (url.includes('/share') && init?.method === 'DELETE') {
      unshareCalls.push({ url, headers: new Headers(init.headers) });
      shared = false;
      return jsonResponse({ unshared: true });
    }
    return jsonResponse({});
  }) as typeof fetch;
}

beforeEach(() => {
  workspaceContext = TEAM_CONTEXT;
  shareCalls = [];
  teamReadHeaders = [];
  unshareCalls = [];
  workspaceInvalidationHarness.handlers.length = 0;
  workspaceInvalidationHarness.onActive.length = 0;
  workspaceInvalidationHarness.autoActivate = true;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function renderTab(
  systems: DesignSystemSummary[],
  options: {
    isActive?: boolean;
    onSystemsRefresh?: (refreshOptions?: {
      materializedTeamIds?: readonly string[];
    }) => void | Promise<void>;
  } = {},
) {
  return render(
    <I18nProvider initial="en">
      <DesignSystemsTab
        isActive={options.isActive}
        loading={false}
        systems={systems}
        selectedId={null}
        onSelect={() => {}}
        onCreate={() => {}}
        onOpenSystem={() => {}}
        onSystemsRefresh={options.onSystemsRefresh}
      />
    </I18nProvider>,
  );
}

async function openLocalCopy(id = 'user:teammate-ds') {
  await waitFor(() => expect(screen.getByRole('tab', { name: 'Your systems' })).toBeTruthy());
  fireEvent.click(screen.getByRole('tab', { name: 'Your systems' }));
  await screen.findByTestId(`design-kit-view-${id}`);
}

describe('DesignSystemsTab local resource actions and authority', () => {
  it('keeps a locally available shared design system but hides all team menu actions', async () => {
    mockFetch(true, MY_SHARED_SYSTEM.id);
    renderTab([MY_SHARED_SYSTEM]);
    await screen.findByTestId(`design-kit-view-${MY_SHARED_SYSTEM.id}`);
    fireEvent.click(screen.getByTestId('design-kit-more-actions'));
    expect(screen.queryByRole('menuitem', { name: /Share to team|Sync to team|Remove from team/i })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Team' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: /Download design system/i })).toBeTruthy();
  });

  it('refreshes a missing parent catalog entry from the same materialized Team snapshot', async () => {
    workspaceInvalidationHarness.autoActivate = false;
    mockFetch(true, TEAMMATE_PULLED_SYSTEM.id);
    const refreshOptions: Array<{ materializedTeamIds?: readonly string[] } | undefined> = [];

    function CatalogHarness() {
      const [catalog, setCatalog] = React.useState<DesignSystemSummary[]>([]);
      return (
        <I18nProvider initial="en">
          <DesignSystemsTab
            loading={false}
            systems={catalog}
            selectedId={null}
            onSelect={() => {}}
            onCreate={() => {}}
            onOpenSystem={() => {}}
            onSystemsRefresh={(options) => {
              refreshOptions.push(options);
              setCatalog([TEAMMATE_PULLED_SYSTEM]);
            }}
          />
        </I18nProvider>
      );
    }

    render(<CatalogHarness />);

    await waitFor(() => expect(teamReadHeaders).toHaveLength(1));
    const teamTab = screen.getByRole('tab', { name: 'Your systems' });
    await waitFor(() => expect(teamTab.textContent).toContain('1'));
    fireEvent.click(teamTab);
    expect(await screen.findByTestId('design-kit-view-user:teammate-ds')).toBeTruthy();
    expect(refreshOptions).toEqual([{
      materializedTeamIds: [TEAMMATE_PULLED_SYSTEM.id],
    }]);
  });

  it('starts one exact Team-index read on first active mount without waiting for SSE or the poll timer', async () => {
    vi.useFakeTimers();
    workspaceInvalidationHarness.autoActivate = false;
    mockFetch(true);

    renderTab([MY_SHARED_SYSTEM]);

    await act(async () => Promise.resolve());
    expect(teamReadHeaders).toHaveLength(1);
    expect(teamReadHeaders[0]?.get('x-od-workspace-id')).toBe('ws-team');
    expect(teamReadHeaders[0]?.get('x-od-workspace-member-id')).toBe('mem-owner');
    await act(async () => vi.advanceTimersByTimeAsync(249));
    expect(teamReadHeaders).toHaveLength(1);
  });

  it('does not issue a Team-index request for a Personal workspace', async () => {
    workspaceInvalidationHarness.autoActivate = false;
    workspaceContext = {
      ...TEAM_CONTEXT,
      workspaceId: 'ws-personal',
      teamId: undefined,
      workspaceType: 'personal',
      workspaceMemberId: 'mem-personal',
    };
    mockFetch(true);

    renderTab([MY_SHARED_SYSTEM]);
    await act(async () => Promise.resolve());

    expect(teamReadHeaders).toHaveLength(0);
    expect(screen.queryByRole('tab', { name: /Team/i })).toBeNull();
  });

  it('does not commit an older Workspace A Team index after switching to B', async () => {
    workspaceInvalidationHarness.autoActivate = false;
    const workspaceA = deferred<Response>();
    const workspaceB = deferred<Response>();
    globalThis.fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      teamReadHeaders.push(headers);
      return headers.get('x-od-workspace-id') === 'ws-team'
        ? workspaceA.promise
        : workspaceB.promise;
    }) as typeof fetch;
    const view = renderTab([TEAMMATE_PULLED_SYSTEM]);
    await waitFor(() => expect(teamReadHeaders).toHaveLength(1));

    workspaceContext = SECOND_TEAM_CONTEXT;
    view.rerender(
      <I18nProvider initial="en">
        <DesignSystemsTab
          loading={false}
          systems={[TEAMMATE_PULLED_SYSTEM]}
          selectedId={null}
          onSelect={() => {}}
          onCreate={() => {}}
          onOpenSystem={() => {}}
        />
      </I18nProvider>,
    );
    await waitFor(() => expect(teamReadHeaders).toHaveLength(2));
    workspaceB.resolve(jsonResponse({ ids: [], resources: [] }));
    await act(async () => Promise.resolve());
    workspaceA.resolve(jsonResponse({
      ids: [TEAMMATE_PULLED_SYSTEM.id],
      resources: [{ id: TEAMMATE_PULLED_SYSTEM.id, canUnshare: true }],
    }));
    await act(async () => Promise.resolve());

    fireEvent.click(screen.getByRole('tab', { name: 'Your systems' }));
    expect(screen.queryByTestId('design-kit-view-user:teammate-ds')).toBeNull();
    expect(teamReadHeaders.map((headers) => headers.get('x-od-workspace-id')))
      .toEqual(['ws-team', 'ws-second']);
  });

  it('parks hidden invalidations and performs one exact Team-index catch-up when active', async () => {
    mockFetch(true);
    const onSystemsRefresh = vi.fn();
    const view = renderTab([MY_SHARED_SYSTEM], { isActive: false, onSystemsRefresh });
    await act(async () => Promise.resolve());
    expect(teamReadHeaders).toHaveLength(0);

    const handler = workspaceInvalidationHarness.handlers
      .map((handlers) => handlers['team-resources-changed'])
      .find((candidate) => typeof candidate === 'function');
    expect(handler).toBeTypeOf('function');
    act(() => handler?.({
      type: 'team-resources-changed',
      resourceKind: 'design_system',
      resourceId: MY_SHARED_SYSTEM.id,
    }));
    await act(async () => Promise.resolve());
    expect(teamReadHeaders).toHaveLength(0);

    view.rerender(
      <I18nProvider initial="en">
        <DesignSystemsTab
          isActive
          loading={false}
          systems={[MY_SHARED_SYSTEM]}
          selectedId={null}
          onSelect={() => {}}
          onCreate={() => {}}
          onOpenSystem={() => {}}
          onSystemsRefresh={onSystemsRefresh}
        />
      </I18nProvider>,
    );
    await waitFor(() => expect(teamReadHeaders).toHaveLength(1));
    expect(onSystemsRefresh).not.toHaveBeenCalled();
    resetCoalescedGet();
    teamReadHeaders = [];
    onSystemsRefresh.mockClear();

    const onActive = workspaceInvalidationHarness.onActive.at(-1);
    expect(onActive).toBeTypeOf('function');
    act(() => onActive?.());
    await waitFor(() => expect(teamReadHeaders).toHaveLength(1));
    expect(onSystemsRefresh).not.toHaveBeenCalled();
  });

  it('keeps an owner-shared local copy in Your systems without a Team destination', async () => {
    mockFetch(true);
    const view = renderTab([MY_SHARED_SYSTEM]);
    await waitFor(() => expect(teamReadHeaders).toHaveLength(1));
    expect(screen.getAllByTestId('design-kit-view-user:my-ds')).toHaveLength(1);
    expect(screen.queryByRole('tab', { name: 'Team' })).toBeNull();
    view.unmount();
    renderTab([MY_SHARED_SYSTEM]);
    expect(await screen.findByTestId('design-kit-view-user:my-ds')).toBeTruthy();
  });

  it('applies a remote Team index event immediately and ignores the older in-flight snapshot', async () => {
    const initial = deferred<Response>();
    const refreshed = deferred<Response>();
    let reads = 0;
    globalThis.fetch = vi.fn(() => {
      reads += 1;
      return reads === 1 ? initial.promise : refreshed.promise;
    }) as typeof fetch;
    renderTab([MY_SHARED_SYSTEM]);
    await waitFor(() => expect(reads).toBe(1));

    const handler = workspaceInvalidationHarness.handlers
      .map((handlers) => handlers['team-resources-changed'])
      .find((candidate) => typeof candidate === 'function');
    expect(handler).toBeTypeOf('function');
    act(() => handler!({
      type: 'team-resources-changed',
      resourceKind: 'design_system',
      resourceId: MY_SHARED_SYSTEM.id,
    }));
    await waitFor(() => expect(reads).toBe(2));

    refreshed.resolve(jsonResponse({
      ids: [MY_SHARED_SYSTEM.id],
      resources: [{ id: MY_SHARED_SYSTEM.id, canUnshare: true }],
    }));
    fireEvent.click(screen.getByRole('tab', { name: 'Your systems' }));
    expect(await screen.findByTestId('design-kit-view-user:my-ds')).toBeTruthy();

    initial.resolve(jsonResponse({ ids: [], resources: [] }));
    await waitFor(() => expect(reads).toBe(2));
    expect(screen.getByTestId('design-kit-view-user:my-ds')).toBeTruthy();
  });

  it('hides both "share" and "sync" for a teammate-pulled copy the caller may not manage', async () => {
    // `canUnshare: false` mirrors a plain member viewing a system someone
    // else shared — the same shape `DesignSystemsTab.team-permissions.test.tsx`
    // already covers for edit/publish/delete. The un-hide fix here must not
    // let a non-managing member overwrite the real owner's shared copy.
    mockFetch(false, 'user:teammate-ds');
    renderTab([TEAMMATE_PULLED_SYSTEM]);
    await openLocalCopy();

    fireEvent.click(screen.getByRole('tab', { name: /Your systems/i }));
    expect(await screen.findByTestId('design-kit-view-user:teammate-ds')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Your systems' }));
    await screen.findByTestId('design-kit-view-user:teammate-ds');
    fireEvent.click(await screen.findByTestId('design-kit-more-actions'));
    expect(screen.queryByRole('menuitem', { name: 'Sync to team' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Share to team' })).toBeNull();
  });

  it('partitions the Team index immediately when switching Workspaces', async () => {
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      teamReadHeaders.push(headers);
      const workspaceId = headers.get('x-od-workspace-id');
      const shared = workspaceId === 'ws-team';
      return jsonResponse({
        ids: shared ? ['user:teammate-ds'] : [],
        resources: shared
          ? [{ id: 'user:teammate-ds', canUnshare: true, ownerMemberId: 'mem-owner' }]
          : [],
      });
    }) as typeof fetch;
    const view = renderTab([TEAMMATE_PULLED_SYSTEM]);

    await screen.findByTestId('design-kit-view-user:teammate-ds');
    await openLocalCopy('user:teammate-ds');

    workspaceContext = SECOND_TEAM_CONTEXT;
    view.rerender(
      <I18nProvider initial="en">
        <DesignSystemsTab
          loading={false}
          systems={[TEAMMATE_PULLED_SYSTEM]}
          selectedId={null}
          onSelect={() => {}}
          onCreate={() => {}}
          onOpenSystem={() => {}}
        />
      </I18nProvider>,
    );

    expect(screen.queryByTestId('design-kit-view-user:teammate-ds')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /Your systems/i }));
    expect(screen.queryByTestId('design-kit-view-user:teammate-ds')).toBeNull();
    await waitFor(() => {
      expect(teamReadHeaders.some((headers) => (
        headers.get('x-od-workspace-id') === 'ws-second'
      ))).toBe(true);
    });
  });
});
