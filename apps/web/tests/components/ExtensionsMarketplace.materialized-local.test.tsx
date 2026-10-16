// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExtensionsMarketplace } from '../../src/components/PluginsView';
import { I18nProvider } from '../../src/i18n';
import { workspaceContextFixture } from '../helpers/workspace-context';
import { resetCoalescedGet } from '../../src/lib/coalesced-get';

const events = vi.hoisted(() => ({ handlers: {} as Record<string, (event: unknown) => void> }));
vi.mock('../../src/analytics/provider', async (original) => ({
  ...await original<typeof import('../../src/analytics/provider')>(),
  useAnalytics: () => ({ track: vi.fn() }),
}));
let context = workspaceContextFixture({ workspaceId: 'ws-a', teamId: 'ws-a', workspaceMemberId: 'viewer' });
vi.mock('../../src/collab/useWorkspaceContext', async (original) => ({
  ...await original<typeof import('../../src/collab/useWorkspaceContext')>(),
  useWorkspaceContext: () => ({ context, loading: false, refresh: vi.fn() }),
}));
vi.mock('../../src/collab/workspace-events', () => ({
  useWorkspaceInvalidation: (handlers: typeof events.handlers, options: { onActive?: () => void; enabled?: boolean; workspaceContext?: unknown }) => {
    events.handlers = handlers;
    const identity = JSON.stringify(options.workspaceContext);
    React.useEffect(() => { if (options.enabled && options.workspaceContext) options.onActive?.(); }, [identity, options.enabled]);
    return { connected: false };
  },
}));

let authorized = true;
let deniedStatus = 0;
let deferredA: Promise<Response> | null = null;
const usePlugin = vi.fn();
const useSkill = vi.fn();
const plugin = (workspace: string, shared: boolean) => ({
  id: shared ? `shared-plugin-${workspace}` : 'personal-plugin',
  title: shared ? `Shared plugin ${workspace}` : 'Personal plugin', version: '1.0.0', sourceKind: 'local',
  source: shared ? `team:plugin:${workspace}:shared-plugin-${workspace}` : '/local/personal',
  trust: 'restricted', manifest: { name: 'fixture', title: 'Fixture' }, capabilitiesGranted: [],
  fsPath: '/fixture', installedAt: 1, updatedAt: 1,
});
const skill = (workspace: string, shared: boolean) => ({
  id: shared ? `shared-skill-${workspace}` : 'personal-skill',
  name: shared ? `Shared skill ${workspace}` : 'Personal skill', description: 'Fixture',
  source: 'user', teamSynced: shared, triggers: [], mode: 'prototype',
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  resetCoalescedGet();
  context = workspaceContextFixture({ workspaceId: 'ws-a', teamId: 'ws-a', workspaceMemberId: 'viewer' });
  authorized = true; deniedStatus = 0; deferredA = null;
  usePlugin.mockClear(); useSkill.mockClear();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const workspace = new Headers(init?.headers).get('x-od-workspace-id') ?? context.workspaceId;
    if (url === '/api/plugins') return json({ plugins: [plugin(workspace, true), plugin(workspace, false)] });
    if (url === '/api/skills') return json({ skills: [skill(workspace, true), skill(workspace, false)] });
    if (url.startsWith('/api/skills/')) return json({ ...skill(workspace, true), body: '# Shared skill' });
    if (url.includes('/marketplaces')) return json({ marketplaces: [] });
    if (url.endsWith('/team')) {
      if (workspace === 'ws-a' && deferredA) return deferredA;
      if (deniedStatus) return json({}, deniedStatus);
      const id = url.includes('/plugins/') ? `shared-plugin-${workspace}` : `shared-skill-${workspace}`;
      return json({
        ids: authorized ? [id, 'remote-only'] : [],
        resources: authorized ? [
          { id, ownerMemberId: 'another-member', canUnshare: true },
          { id: 'remote-only', title: 'No local copy', ownerMemberId: 'another-member' },
        ] : [],
      });
    }
    return json({});
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); resetCoalescedGet(); });
function mount() { return render(<I18nProvider initial="en"><ExtensionsMarketplace onUsePlugin={usePlugin} onUseSkill={useSkill} /></I18nProvider>); }
async function localScope(kind: 'plugin' | 'skill') {
  await screen.findByRole('button', { name: 'Personal' });
  if (kind === 'skill') fireEvent.click(screen.getByRole('button', { name: 'Skills' }));
  fireEvent.click(screen.getByRole('button', { name: 'Personal' }));
}
async function refresh(kind: 'plugin' | 'skill') {
  await act(async () => { events.handlers['team-resources-changed']?.({ type: 'team-resources-changed', resourceKind: kind }); });
}

describe('authorized materialized extensions in the local scope', () => {
  it.each(['plugin', 'skill'] as const)('shows a materialized %s read-only and keeps personal mutations', async (kind) => {
    mount(); await localScope(kind);
    const id = `shared-${kind}-ws-a`;
    const row = await screen.findByTestId(`plugins-card-${id}`);
    expect(screen.queryByTestId(`plugins-card-more-${id}`)).toBeNull();
    expect(screen.queryByTestId('plugins-card-remote-only')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Team' })).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: /Use|Try/i }));
    expect(kind === 'plugin' ? usePlugin : useSkill).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByTestId(`plugins-card-more-personal-${kind}`));
    expect(screen.getByTestId(`plugins-card-uninstall-personal-${kind}`)).toBeTruthy();
  });

  it.each(['plugin', 'skill'] as const)('removes a revoked materialized %s instead of reclassifying it as personal', async (kind) => {
    mount(); await localScope(kind);
    await screen.findByTestId(`plugins-card-shared-${kind}-ws-a`);
    authorized = false; await refresh(kind);
    await waitFor(() => expect(screen.queryByTestId(`plugins-card-shared-${kind}-ws-a`)).toBeNull());
    expect(screen.getByTestId(`plugins-card-personal-${kind}`)).toBeTruthy();
  });

  it.each([401, 403])('hides materialized rows and open skill detail after an authoritative %s', async (status) => {
    mount(); await localScope('skill');
    fireEvent.click(await screen.findByTestId('plugins-card-shared-skill-ws-a'));
    await screen.findByTestId('skill-detail-use');
    expect(screen.queryByText(/Provided by You/i)).toBeNull();
    deniedStatus = status; await refresh('skill');
    await waitFor(() => expect(screen.queryByTestId('skill-detail-use')).toBeNull());
    expect(screen.queryByTestId('plugins-card-shared-skill-ws-a')).toBeNull();
  });

  it.each([401, 403])('hides a materialized plugin after an authoritative %s', async (status) => {
    mount(); await localScope('plugin');
    await screen.findByTestId('plugins-card-shared-plugin-ws-a');
    deniedStatus = status; await refresh('plugin');
    await waitFor(() => expect(screen.queryByTestId('plugins-card-shared-plugin-ws-a')).toBeNull());
    expect(screen.getByTestId('plugins-card-personal-plugin')).toBeTruthy();
  });

  it.each(['plugin', 'skill'] as const)('retains same-workspace %s membership during a transient outage', async (kind) => {
    mount(); await localScope(kind);
    await screen.findByTestId(`plugins-card-shared-${kind}-ws-a`);
    deniedStatus = 503; await refresh(kind);
    expect(screen.getByTestId(`plugins-card-shared-${kind}-ws-a`)).toBeTruthy();
    expect(screen.queryByTestId(`plugins-card-more-shared-${kind}-ws-a`)).toBeNull();
  });

  it.each(['plugin', 'skill'] as const)('rejects a late old-workspace %s membership response after a scope change', async (kind) => {
    const view = mount(); await localScope(kind);
    await screen.findByTestId(`plugins-card-shared-${kind}-ws-a`);
    let release!: (response: Response) => void;
    deferredA = new Promise<Response>((resolve) => { release = resolve; });
    await refresh(kind);
    context = workspaceContextFixture({ workspaceId: 'ws-b', teamId: 'ws-b', workspaceMemberId: 'viewer-b' });
    view.rerender(<I18nProvider initial="en"><ExtensionsMarketplace onUsePlugin={usePlugin} onUseSkill={useSkill} /></I18nProvider>);
    expect(screen.queryByTestId(`plugins-card-shared-${kind}-ws-a`)).toBeNull();
    await screen.findByTestId(`plugins-card-shared-${kind}-ws-b`);
    await act(async () => release(json({ ids: [`shared-${kind}-ws-a`], resources: [] })));
    expect(screen.queryByTestId(`plugins-card-shared-${kind}-ws-a`)).toBeNull();
    expect(screen.getByTestId(`plugins-card-shared-${kind}-ws-b`)).toBeTruthy();
  });

  it('closes materialized skill detail on a workspace switch and does not reopen it on return', async () => {
    const view = mount(); await localScope('skill');
    fireEvent.click(await screen.findByTestId('plugins-card-shared-skill-ws-a'));
    await screen.findByTestId('skill-detail-use');
    const previousContext = context;
    context = workspaceContextFixture({ workspaceId: 'ws-b', teamId: 'ws-b', workspaceMemberId: 'viewer-b' });
    view.rerender(<I18nProvider initial="en"><ExtensionsMarketplace onUsePlugin={usePlugin} onUseSkill={useSkill} /></I18nProvider>);
    expect(screen.queryByTestId('skill-detail-use')).toBeNull();
    await screen.findByTestId('plugins-card-shared-skill-ws-b');
    context = previousContext;
    view.rerender(<I18nProvider initial="en"><ExtensionsMarketplace onUsePlugin={usePlugin} onUseSkill={useSkill} /></I18nProvider>);
    await screen.findByTestId('plugins-card-shared-skill-ws-a');
    expect(screen.queryByTestId('skill-detail-use')).toBeNull();
  });
});
