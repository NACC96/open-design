// Per-project agent + model ("execution stamp").
//
// A project created with a CLI keeps it when the app-wide default (the Home
// picker's last pick, stored in app-config) says something else, and the
// project composer's CLI tabs change only that project — a PATCH to the
// project, never a PUT to app-config.
import { expect, test } from '@/playwright/suite';
import { T } from '@/timeouts';
import type { Page } from '@playwright/test';
import { dismissPrivacyDialog } from '../lib/playwright/amr.js';
import { routeAgents, routeSuccessfulRuns, suppressWhatsNew } from '../lib/playwright/mock-factory.js';

const STORAGE_KEY = 'open-design:config';

const AGENTS = [
  {
    id: 'codex',
    name: 'Codex CLI',
    bin: 'codex',
    available: true,
    version: '0.134.0',
    models: [
      { id: 'default', label: 'Default (CLI config)' },
      { id: 'gpt-5.5', label: 'GPT 5.5' },
    ],
  },
  {
    id: 'claude',
    name: 'Claude Code',
    bin: 'claude',
    available: true,
    version: '2.1.131',
    models: [
      { id: 'default', label: 'Default (CLI config)' },
      { id: 'opus', label: 'Opus (alias)' },
    ],
  },
];

// The app-wide default every spec here starts from: Codex.
const APP_CONFIG = {
  onboardingCompleted: true,
  privacyDecisionAt: 1,
  telemetry: { metrics: false, content: false, artifactManifest: false },
  mode: 'daemon',
  agentId: 'codex',
  skillId: null,
  designSystemId: null,
  agentModels: { codex: { model: 'default' } },
  agentCliEnv: {},
};

let appConfigWrites: Array<Record<string, unknown>> = [];

test.beforeEach(async ({ page }) => {
  await suppressWhatsNew(page);
  appConfigWrites = [];
  let appConfig: Record<string, unknown> = { ...APP_CONFIG };
  await page.addInitScript(
    ([key, config]) => {
      window.localStorage.setItem(
        key,
        JSON.stringify({ ...config, apiKey: '', baseUrl: 'https://api.anthropic.com', model: 'default' }),
      );
    },
    [STORAGE_KEY, APP_CONFIG] as const,
  );
  // App-config is the app-wide default; record every write so a spec can prove
  // an in-project pick never lands here.
  await page.route('**/api/app-config', async (route) => {
    if (route.request().method() === 'PUT') {
      const next = route.request().postDataJSON() as Record<string, unknown>;
      appConfigWrites.push(next);
      appConfig = { ...appConfig, ...next };
    }
    await route.fulfill({ json: { config: appConfig } });
  });
  await routeAgents(page, AGENTS);
});

async function openProject(
  page: Page,
  name: string,
  execution?: Record<string, unknown>,
): Promise<string> {
  const response = await page.request.post('/api/projects', {
    timeout: 15_000,
    data: {
      id: `project-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      skillId: null,
      designSystemId: null,
      metadata: { kind: 'prototype', nameSource: 'user' },
      ...(execution ? { execution } : {}),
    },
  });
  expect(response.ok(), `create project "${name}": ${await response.text()}`).toBeTruthy();
  const body = (await response.json()) as {
    project: { id: string; execution?: Record<string, unknown> };
    conversationId: string;
  };
  if (execution) expect(body.project.execution).toMatchObject(execution);
  await page.goto(`/projects/${body.project.id}/conversations/${body.conversationId}`);
  await expect(page).toHaveURL(/\/projects\//);
  await page.getByText('Loading OpenDesign…').waitFor({ state: 'hidden', timeout: T.long }).catch(() => {});
  await dismissPrivacyDialog(page);
  await expect(page.getByTestId('chat-composer-input')).toBeVisible();
  await expect(page.locator('.chat-loading-state')).toHaveCount(0, { timeout: T.medium });
  return body.project.id;
}

async function openComposerAgentMenu(page: Page) {
  const trigger = page.getByTestId('chat-composer').locator('.avatar-menu .avatar-agent-trigger');
  await expect(trigger).toBeVisible();
  await trigger.click();
  const menu = page.locator('.avatar-popover[role="dialog"]');
  await expect(menu).toBeVisible();
  return menu;
}

test('[P1] a project created on a CLI keeps it when the app-wide default differs', async ({ page }) => {
  test.setTimeout(60_000);
  const runBodies: Array<Record<string, unknown>> = [];
  await routeSuccessfulRuns(page, { bodies: runBodies, runIdPrefix: 'stamped-project-run' });

  await openProject(page, 'Stamped on Claude', { agentId: 'claude', model: 'opus' });

  const menu = await openComposerAgentMenu(page);
  await expect(menu.getByTestId('avatar-agent-tab-claude')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');

  await page.getByTestId('chat-composer-input').fill('Run on the project CLI.');
  await Promise.all([
    page.waitForRequest((request) => request.url().includes('/api/runs') && request.method() === 'POST'),
    page.getByTestId('chat-send').click(),
  ]);
  await expect.poll(() => runBodies.length).toBe(1);
  expect(runBodies[0]).toMatchObject({ agentId: 'claude', model: 'opus' });
});

test('[P1] the project composer CLI tabs change only that project', async ({ page }) => {
  test.setTimeout(60_000);
  const projectId = await openProject(page, 'Switch CLI in project');

  const menu = await openComposerAgentMenu(page);
  await expect(menu.getByTestId('avatar-agent-tab-codex')).toHaveAttribute('aria-checked', 'true');

  const patch = page.waitForRequest(
    (request) =>
      request.method() === 'PATCH'
      && request.url().endsWith(`/api/projects/${encodeURIComponent(projectId)}`),
  );
  await menu.getByTestId('avatar-agent-tab-claude').click();
  const patchBody = (await patch).postDataJSON() as { execution?: { agentId?: string } };
  expect(patchBody.execution?.agentId).toBe('claude');
  await expect(menu.getByTestId('avatar-agent-tab-claude')).toHaveAttribute('aria-checked', 'true');

  // The pick is the project's: it is on the project record…
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/projects/${encodeURIComponent(projectId)}`);
      const body = (await response.json()) as { project?: { execution?: { agentId?: string } } };
      return body.project?.execution?.agentId ?? null;
    })
    .toBe('claude');
  // …and never became the app-wide default.
  expect(appConfigWrites.some((write) => write.agentId === 'claude')).toBe(false);
});
