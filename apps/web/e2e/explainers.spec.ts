import { expect, type Page, test } from '@playwright/test';
import { adminToken } from '../playwright.config';

const unique = (name: string): string => `${name} ${Date.now()}-${test.info().parallelIndex}`;

test.beforeEach(async ({ context }) => {
  await context.addInitScript((token) => {
    localStorage.setItem('openpurpose.token', token);
  }, adminToken);
});

/** Records whether a skeleton ever appeared, from before the app starts. */
async function watchForSkeleton(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen = (): void => {
      if (document.querySelector('os-skeleton')) (window as unknown as { sawSkeleton: boolean }).sawSkeleton = true;
    };
    new MutationObserver(seen).observe(document, { childList: true, subtree: true });
  });
}

const sawSkeleton = (page: Page): Promise<boolean> =>
  page.evaluate(() => Boolean((window as unknown as { sawSkeleton?: boolean }).sawSkeleton));

const dialog = (page: Page) => page.locator('os-confirm-dialog dialog');

test.describe('Every Settings tab says what it is for', () => {
  test('UC-4/S1 each tab explains itself', async ({ page }) => {
    await page.goto('/settings/account');
    const links = page.getByRole('navigation', { name: 'Settings' }).getByRole('link');
    await expect(links.first()).toBeVisible();
    const hrefs = await links.evaluateAll((all) => all.map((a) => a.getAttribute('href') ?? ''));
    expect(hrefs.length).toBeGreaterThanOrEqual(8);
    for (const href of hrefs) {
      await page.goto(href);
      const explainer = page.locator('header[os-section-header] p').first();
      await expect(explainer, href).toBeVisible();
      expect((await explainer.innerText()).split(' ').length, href).toBeGreaterThan(5);
    }
  });

  test('UC-4/S2 no personal tokens yet says what they are for', async ({ page }) => {
    // Signed in in a browser, you always have the token you signed in with, so the list comes
    // back empty here only as it would for someone signed in another way.
    await page.route('**/api/me/tokens', (route) =>
      route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.continue(),
    );
    await page.goto('/settings/account');
    const empty = page.locator('os-empty-state', { hasText: 'No personal tokens yet' });
    await expect(empty).toContainText('lets a script or an agent act as you');
    await empty.getByRole('button', { name: 'Create token' }).click();
    await expect(page.getByLabel('Token label')).toBeFocused();
  });

  test('UC-4/S4 a slow tab shows a placeholder, a fast one does not flash', async ({ page }) => {
    await watchForSkeleton(page);
    await page.goto('/settings/people');
    await expect(page.locator('.list-label', { hasText: 'People' })).toBeVisible();
    expect(await sawSkeleton(page)).toBe(false);

    await page.route('**/api/members', async (route) => {
      await new Promise((done) => setTimeout(done, 1500));
      await route.continue();
    });
    await page.reload();
    await expect(page.locator('os-skeleton')).toBeVisible();
    await expect(page.locator('.list-label', { hasText: 'People' })).toBeVisible();
    await expect(page.locator('os-skeleton')).toBeHidden();
  });

  test('UC-4/S5 a tab that cannot load says what failed', async ({ page }) => {
    await page.route(/\/api\/(members|me\/tokens)$/, (route) =>
      route.fulfill({ status: 503, json: { error: 'The server is down for a moment.' } }),
    );
    await page.goto('/settings/people');
    await expect(page.locator('os-callout[tone=danger]')).toContainText('The people and agents didn’t load');
    await page.goto('/settings/account');
    await expect(page.locator('os-callout[tone=danger]')).toContainText('Your tokens didn’t load');
  });

  test('UC-4/S6 revoking a token or removing a person says what stops and what stays', async ({ page }) => {
    const label = unique('spare');
    await page.goto('/settings/account');
    await page.getByLabel('Token label').fill(label);
    await page.getByRole('button', { name: 'Create token' }).click();
    const secret = page.locator('os-secret-dialog dialog');
    await secret.getByRole('button', { name: /copied it/ }).click();
    await page.locator('os-setting-item', { hasText: label }).getByRole('button', { name: 'Revoke' }).click();
    await expect(dialog(page)).toContainText('stops working immediately');
    await expect(dialog(page)).toContainText('Your other tokens keep working');
    await dialog(page).getByRole('button', { name: 'Cancel' }).click();

    const name = unique('Pat');
    await page.goto('/settings/people');
    await page.locator('form select[name=kind]').selectOption('human');
    await page.locator('form input[name=name]').fill(name);
    await page.getByRole('button', { name: 'Add and create token' }).click();
    await secret.getByRole('button', { name: /copied it/ }).click();
    await page.getByRole('button', { name: new RegExp(`^Remove ${name} from`) }).first().click();
    await expect(dialog(page)).toContainText('lose their role');
    await expect(dialog(page)).toContainText('what they wrote stay');
  });
});
