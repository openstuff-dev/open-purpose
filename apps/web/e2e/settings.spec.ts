import { expect, type Locator, type Page, test } from '@playwright/test';
import { adminToken } from '../playwright.config';

const unique = (name: string): string => `${name} ${Date.now()}-${test.info().parallelIndex}`;

test.beforeEach(async ({ context, baseURL }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL });
  await context.addInitScript((token) => {
    localStorage.setItem('openpurpose.token', token);
  }, adminToken);
});

const secretDialog = (page: Page): Locator => page.locator('os-secret-dialog dialog');

async function closeSecret(page: Page): Promise<string> {
  const dialog = secretDialog(page);
  const secret = await dialog.locator('code').innerText();
  await dialog.getByRole('button', { name: /copied it/ }).click();
  await expect(dialog).toBeHidden();
  return secret;
}

async function openPersonalToken(page: Page): Promise<void> {
  await page.goto('/settings/account');
  await page.getByLabel('Token label').fill(unique('e2e'));
  await page.getByRole('button', { name: 'Create token' }).click();
  await expect(secretDialog(page)).toBeVisible();
}

async function addAgent(page: Page): Promise<string> {
  const name = unique('Agent');
  await page.goto('/settings/people');
  await page.locator('form input[name=name]').fill(name);
  await page.getByRole('button', { name: /Add and create token/ }).click();
  await expect(secretDialog(page)).toBeVisible();
  await closeSecret(page);
  return name;
}

/** Scrolls down to the last row's New token button, as someone far down the list would. */
async function lastRowTokenButton(page: Page): Promise<Locator> {
  const button = page.getByRole('button', { name: 'New token' }).last();
  await button.scrollIntoViewIfNeeded();
  return button;
}

async function issueFromRow(page: Page, button: Locator): Promise<void> {
  await button.click();
  await page.locator('dialog[open]').getByRole('button', { name: 'Create token' }).click();
  await expect(secretDialog(page)).toBeVisible();
}

test.describe('A one-time secret', () => {
  test('UC-2/S1 a personal token opens in a dialog I can see', async ({ page }) => {
    await openPersonalToken(page);
    const dialog = secretDialog(page);
    await expect(dialog).toBeInViewport();
    const secret = await dialog.locator('code').innerText();
    expect(secret.length).toBeGreaterThan(10);
    await expect(dialog.locator('p').first()).not.toBeEmpty();
    await dialog.getByRole('button', { name: /^Copy/ }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(secret);
  });

  test('UC-2/S2 a token from a row far down the list opens the same dialog', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 420 });
    await addAgent(page);
    const button = await lastRowTokenButton(page);
    expect(await page.evaluate(() => scrollY + (document.querySelector('.os-shell-content')?.scrollTop ?? 0)))
      .toBeGreaterThan(0);
    await issueFromRow(page, button);
    await expect(secretDialog(page)).toBeInViewport();
    await expect(secretDialog(page).locator('code')).not.toBeEmpty();
  });

  test('UC-2/S3 a token for a new workspace admin opens the same dialog', async ({ page }) => {
    await page.goto('/settings/server');
    await page.locator('input[name=name]').fill(unique('Workspace'));
    await page.locator('input[name=admin]').fill('Pat');
    await page.getByRole('button', { name: 'Create workspace' }).click();
    await expect(secretDialog(page)).toBeInViewport();
    await expect(secretDialog(page).locator('code')).not.toBeEmpty();
  });

  test('UC-2/S4 the dialog stays until I confirm', async ({ page }) => {
    await openPersonalToken(page);
    const dialog = secretDialog(page);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await page.mouse.click(4, 4);
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /copied it/ }).click();
    await expect(dialog).toBeHidden();
  });

  test('UC-2/S5 the secret is gone afterwards and focus is back', async ({ page }) => {
    await addAgent(page);
    const button = await lastRowTokenButton(page);
    await issueFromRow(page, button);
    const secret = await closeSecret(page);
    await expect(page.locator('body')).not.toContainText(secret);
    await expect(button).toBeFocused();
  });
});

test.describe('Choosing a theme', () => {
  /** The radio's circle is hidden, so people click the option around it. */
  const choose = (page: Page, name: string): Promise<void> =>
    page.locator('.os-theme-option', { hasText: name }).click();
  const theme = (page: Page): Promise<string | null> =>
    page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  const background = (page: Page): Promise<string> =>
    page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  test('UC-3/S1 my choice applies at once and stays', async ({ page }) => {
    await page.goto('/settings/appearance');
    await choose(page, 'Dark');
    await expect.poll(() => theme(page)).toBe('dark');
    await page.reload();
    await expect(page.getByRole('radio', { name: 'Dark' })).toBeChecked();
    expect(await theme(page)).toBe('dark');
  });

  test('UC-3/S2 system follows my device', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/settings/appearance');
    await choose(page, 'System');
    expect(await theme(page)).toBeNull();
    const light = await background(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => background(page)).not.toBe(light);
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => background(page)).toBe(light);
  });

  test('UC-3/S3 the choice stays in this browser and this app', async ({ page, browser, baseURL }) => {
    await page.goto('/settings/appearance');
    await choose(page, 'Dark');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('openpurpose.theme'))).toBe('dark');

    const other = await browser.newContext({ baseURL });
    const otherPage = await other.newPage();
    await otherPage.goto('/');
    expect(await theme(otherPage)).toBeNull();
    await other.close();

    // Another app on the same address has its own key, and this app doesn't read it.
    const sameAddress = await browser.newContext({ baseURL });
    await sameAddress.addInitScript(() => {
      localStorage.setItem('openrelay.theme', 'dark');
    });
    const sameAddressPage = await sameAddress.newPage();
    await sameAddressPage.goto('/');
    expect(await theme(sameAddressPage)).toBeNull();
    await sameAddress.close();
  });

  test('UC-3/S4 I can choose with the keyboard', async ({ page }) => {
    await page.goto('/settings/appearance');
    const system = page.getByRole('radio', { name: 'System' });
    await choose(page, 'System');
    await system.focus();
    await page.keyboard.press('ArrowRight');
    const light = page.getByRole('radio', { name: 'Light' });
    await expect(light).toBeFocused();
    await expect(light).toBeChecked();
    await expect.poll(() => theme(page)).toBe('light');
    await page.keyboard.press('ArrowRight');
    const dark = page.getByRole('radio', { name: 'Dark' });
    await expect(dark).toBeFocused();
    await expect(dark).toBeChecked();
    await expect.poll(() => theme(page)).toBe('dark');
    await page.keyboard.press('ArrowLeft');
    await expect(light).toBeFocused();
    await expect(light).toBeChecked();
  });
});

test.describe('Settings on a phone', () => {
  test.use({ viewport: { width: 360, height: 800 } });

  test('UC-1/S8 settings fits a phone', async ({ page }) => {
    await page.goto('/settings/account');
    const nav = page.locator('nav.os-settings-nav');
    await expect(nav).toBeVisible();
    await expect(page.getByLabel('Token label')).toBeVisible();
    const layout = await page.evaluate(() => {
      const menu = document.querySelector('nav.os-settings-nav');
      const tab = document.querySelector('.settings-tab');
      if (!menu || !tab) throw new Error('Settings has no menu or tab.');
      const clipped = [...tab.querySelectorAll('*')].filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && (box.left < -1 || box.right > innerWidth + 1);
      });
      return {
        pageOverflow: document.documentElement.scrollWidth - innerWidth,
        menuScrolls: menu.scrollWidth > menu.clientWidth,
        menuBottom: menu.getBoundingClientRect().bottom,
        tabTop: tab.getBoundingClientRect().top,
        clipped: clipped.length,
      };
    });
    expect(layout.pageOverflow).toBeLessThanOrEqual(0);
    expect(layout.menuScrolls).toBe(true);
    expect(layout.menuBottom).toBeLessThanOrEqual(layout.tabTop);
    expect(layout.clipped).toBe(0);
  });
});
