// This registered lane now proves that the retired API-provider UI stays absent.
import { expect, test } from '@/playwright/suite';
import { mockLocalAiInstall } from '@/playwright/local-ai';

test('[P0] @critical legacy API settings show only local agents and retain local model selection', async ({ page }) => {
  await mockLocalAiInstall(page, true);
  await page.goto('/settings');
  await page.getByTestId('settings-nav-execution').click();
  await expect(page.getByTestId('settings-agent-card-claude')).toBeVisible();
  await expect(page.getByRole('tab', { name: /API providers/i })).toHaveCount(0);
  await expect(page.getByTestId('settings-agent-card-amr')).toHaveCount(0);
  await expect(page.getByTestId('settings-agent-card-byok-opencode')).toHaveCount(0);
  await expect(page.getByText('Use OpenDesign Cloud')).toHaveCount(0);
  await expect(page.getByLabel('API key', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /Back to home/i }).click();
  await page.getByTestId('inline-model-switcher-chip').click();
  await expect(page.getByTestId('inline-model-switcher-popover')).toBeVisible();
  await expect(page.getByRole('tab', { name: /API|BYOK/i })).toHaveCount(0);
  await expect(page.getByText('Switch to OpenDesign Cloud')).toHaveCount(0);
});
