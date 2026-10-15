// Retain the CI-registered filename while replacing the retired onboarding flow.
import { expect, test } from '@/playwright/suite';
import { mockLocalAiInstall } from '@/playwright/local-ai';
import { waitForLoadingToClear } from '@/playwright/amr';

for (const legacy of [false, true]) {
  test(`[P0] @critical ${legacy ? 'legacy API/Cloud install' : 'fresh install'} opens Home with Local AI`, async ({ page }) => {
    const saved = await mockLocalAiInstall(page, legacy);
    await page.goto(legacy ? '/onboarding' : '/');
    await waitForLoadingToClear(page);
    await expect(page.getByTestId('home-hero-input')).toBeVisible();
    await expect(page.getByTestId('inline-model-switcher-chip')).toHaveAttribute('aria-label', /Claude Code/);
    await expect.poll(() => saved()).toMatchObject({ agentId: 'claude', onboardingCompleted: true });
    await expect(page.locator('.entry-shell--onboarding')).toHaveCount(0);
    await expect(page.getByText('Use OpenDesign Cloud')).toHaveCount(0);
    await expect(page.getByTestId('workspace-switcher')).toHaveCount(0);
  });
}
