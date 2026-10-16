// @vitest-environment jsdom

// Local-only resource UI keeps workspace authority while hiding team controls.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ExtensionsMarketplace } from '../../src/components/PluginsView';
import { I18nProvider } from '../../src/i18n';

vi.mock('../../src/analytics/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/analytics/provider')>();
  return { ...actual, useAnalytics: () => ({ track: vi.fn() }) };
});

const TEAM_CONTEXT = {
  workspaceId: 'ws-team',
  workspaceType: 'team',
  workspaceMemberId: 'mem-owner',
  role: 'member',
  memberStatus: 'active',
  lifecycleState: 'active',
  billingState: 'free',
  planId: null,
  teamId: 'ws-team',
  // `fetchSkills(workspaceContext)` (providers/registry.ts) attaches
  // `workspaceProjectHeaders(context)` (state/projects.ts), which reads
  // `context.permissions.canShareProjects` / `canWriteSyncedFiles` with no
  // optional chaining. Omitting `permissions` throws INSIDE `fetchSkills`'s
  // try/catch, which silently swallows it and resolves to `[]` — the skill
  // never reaches `/api/skills` at all (confirmed via a throwaway fetch-log
  // probe: `/api/skills` was simply never called). None of the fixture
  // contexts elsewhere in this file's siblings hit this path (they only
  // touch plugin listing, which never passes `workspaceContext` through),
  // so this is the first ExtensionsMarketplace test to need a complete one.
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
  seatSummary: { seatLimit: 5, usedSeats: 1, availableSeats: 4, isSeatFull: false },
  providerMode: 'cloud',
};

let workspaceContext: unknown = TEAM_CONTEXT;

// Spread the real module — see the note in ExtensionsMarketplace.team-scope.test.tsx.
vi.mock('../../src/collab/useWorkspaceContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/collab/useWorkspaceContext')>()),
  useWorkspaceContext: () => ({ context: workspaceContext, loading: false, refresh: vi.fn() }),
  useWorkspaceBilling: () => ({ membershipTier: '' }),
}));

const OWNED_PLUGIN = {
  id: 'my-plugin',
  title: 'My Plugin',
  version: '1.0.0',
  sourceKind: 'local',
  source: '/local/my-plugin',
  trust: 'user',
  capabilitiesGranted: [],
  manifest: { name: 'my-plugin', title: 'My Plugin' },
  fsPath: '/local/my-plugin',
  installedAt: 0,
  updatedAt: 0,
};

const USER_SKILL = {
  id: 'my-skill',
  name: 'my-skill',
  description: 'A personal skill.',
  triggers: [],
  mode: 'prototype',
  surface: 'web',
  source: 'user',
  category: null,
  examplePrompt: 'Do the thing',
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

let shareCalls: Array<{ url: string; init?: RequestInit }>;

function mockFetch(options: {
  plugins?: unknown[];
  skills?: unknown[];
  sharedPluginIds?: string[];
  sharedPluginCanUnshare?: boolean;
  sharedSkillIds?: string[];
  sharedSkillCanUnshare?: boolean;
}) {
  shareCalls = [];
  const {
    plugins = [],
    skills = [],
    sharedPluginIds = [],
    sharedPluginCanUnshare = true,
    sharedSkillIds = [],
    sharedSkillCanUnshare = true,
  } = options;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === '/api/skills') return jsonResponse({ skills });
    if (url.startsWith('/api/skills/')) return jsonResponse({}, );
    if (url.startsWith('/api/plugins')) return jsonResponse({ plugins });
    if (url.startsWith('/api/marketplaces')) return jsonResponse({ marketplaces: [] });
    if (url.includes('/api/workspace/plugins/team')) {
      return jsonResponse({
        ids: sharedPluginIds,
        resources: sharedPluginIds.map((id) => ({
          id,
          canUnshare: sharedPluginCanUnshare,
          ownerMemberId: sharedPluginCanUnshare ? 'mem-owner' : 'mem-someone-else',
        })),
      });
    }
    if (url.includes('/api/workspace/skills/team')) {
      return jsonResponse({
        ids: sharedSkillIds,
        resources: sharedSkillIds.map((id) => ({
          id,
          canUnshare: sharedSkillCanUnshare,
          ownerMemberId: sharedSkillCanUnshare ? 'mem-owner' : 'mem-someone-else',
        })),
      });
    }
    if (url.includes('/share') && init?.method === 'POST') {
      shareCalls.push({ url, init });
      return jsonResponse({ shared: true, version: shareCalls.length });
    }
    return jsonResponse({});
  }) as typeof fetch;
}

beforeEach(() => {
  workspaceContext = TEAM_CONTEXT;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderMarketplace() {
  return render(
    <I18nProvider initial="en">
      <ExtensionsMarketplace onCreatePlugin={vi.fn()} />
    </I18nProvider>,
  );
}

/** The catalog lands on 官方 / 官方预设 by default — switch to 个人的. */
async function showPersonalScope(container: HTMLElement) {
  await waitFor(() => {
    const filters = container.querySelectorAll('.plugin-marketplace__filters button');
    expect(filters.length).toBeGreaterThan(0);
  });
  const filters = [...container.querySelectorAll('.plugin-marketplace__filters button')];
  const personal = filters.find((button) => /personal|mine|个人/i.test(button.textContent ?? ''));
  if (personal) fireEvent.click(personal);
}

/** Switches the catalog to 技能, then 个人的, mirroring the card-actions test helper. */
async function showPersonalSkills(container: HTMLElement) {
  const modeButtons = container.querySelectorAll('.plugin-marketplace__switch button');
  fireEvent.click(modeButtons[modeButtons.length - 1]!);
  await showPersonalScope(container);
}

describe('ExtensionsMarketplace local-only resource actions', () => {
  it.each([['plugins', false], ['plugins', true], ['skills', false], ['skills', true]] as const)('hides team actions for %s with shared=%s', async (mode, shared) => {
    mockFetch({ plugins: [OWNED_PLUGIN], skills: [USER_SKILL], sharedPluginIds: shared ? ['my-plugin'] : [], sharedSkillIds: shared ? ['my-skill'] : [] });
    const { container } = renderMarketplace();
    if (mode === 'skills') await showPersonalSkills(container);
    else await showPersonalScope(container);
    await screen.findByText(mode === 'skills' ? 'my-skill' : 'My Plugin');
    expect(screen.queryByRole('button', { name: /Share (?:to|with) team|Sync to team|Remove from team/i })).toBeNull();
    const more = screen.queryByRole('button', { name: /More|Actions/i });
    if (more) fireEvent.click(more);
    expect(screen.queryByRole('menuitem', { name: /Share (?:to|with) team|Sync to team|Remove from team/i })).toBeNull();
    expect(shareCalls).toHaveLength(0);
  });

  it('plugin: a plugin shared by someone else never surfaces a share/sync action in Personal', async () => {
    // `sharedPluginCanUnshare: false` here models a plugin whose `ownerMemberId`
    // is someone else — the pre-existing "personal tab" ownership filter
    // (`sharedResourceIsMine`) already excludes it from Personal entirely (it
    // only ever shows in the Team scope, unshare-only). This pins that the
    // `canUnshare` gate added to `pluginRecordCard`'s `share` field does not
    // accidentally widen that — no leaked share/sync affordance anywhere.
    mockFetch({ plugins: [OWNED_PLUGIN], sharedPluginIds: ['my-plugin'], sharedPluginCanUnshare: false });
    const { container } = renderMarketplace();
    await showPersonalScope(container);

    await waitFor(() => {
      expect(container.querySelector('.plugin-marketplace__filters')).toBeTruthy();
    });
    expect(screen.queryByText('My Plugin')).toBeNull();
    expect(screen.queryByText('Sync to team')).toBeNull();
    expect(screen.queryByText('Share with team')).toBeNull();
  });
});
