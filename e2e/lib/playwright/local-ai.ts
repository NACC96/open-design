import type { Page } from '@playwright/test';
import { routeAgents, suppressWhatsNew } from './mock-factory.js';

/** Local-only boot fixture; each test owns its config and agent responses. */
export async function mockLocalAiInstall(page: Page, legacy = false) {
  let config: Record<string, unknown> = {
    agentId: legacy ? 'amr' : null,
    onboardingCompleted: false,
  };
  await suppressWhatsNew(page);
  await routeAgents(page, [
    { id: 'codex', name: 'Codex CLI', bin: 'codex', available: true, models: [{ id: 'default', label: 'Default' }] },
    { id: 'claude', name: 'Claude Code', bin: 'claude', available: true, models: [{ id: 'default', label: 'Default' }] },
  ]);
  await page.route('**/api/app-config', async (route) => {
    if (route.request().method() === 'PUT') config = { ...config, ...route.request().postDataJSON() };
    await route.fulfill({ json: { config } });
  });
  await page.route('**/api/workspace/directory', (route) => route.fulfill({ json: { items: [], activeWorkspaceId: null } }));
  await page.addInitScript(({ legacy }) => {
    localStorage.setItem('open-design:locale', 'en');
    localStorage.setItem('open-design:config', JSON.stringify({
      mode: legacy ? 'api' : 'daemon', agentId: legacy ? 'byok-opencode' : null,
      onboardingCompleted: false, privacyDecisionAt: 1, telemetry: { metrics: false, content: false },
      pet: { enabled: false }, agentModels: {}, mediaProviders: {},
    }));
  }, { legacy });
  return () => config;
}
