import { expect, test, type Page } from '@playwright/test';
import { DEV_PASSWORD } from '@konsilium/host-mock/users';

/** Единый вход через Keycloak (infra/keycloak): страница входа организации и возврат в «Консилиум». */
const RIS = process.env.E2E_RIS_DEMO_URL ?? 'http://localhost:8090/demo/ris';
const SSO_BUTTON = 'Войти через учётную запись организации';

async function keycloakLogin(page: Page, user: string) {
  await expect(page).toHaveURL(/\/realms\/konsilium\/protocol\/openid-connect\/auth/);
  await page.locator('#username').fill(user);
  await page.locator('#password').fill(DEV_PASSWORD);
  await page.locator('#kc-login').click();
}

test('вход через учётную запись организации по ссылке из ЛИС: случай открывается, повторный вход — без пароля', async ({ page }) => {
  await page.goto(`/c/lis/${encodeURIComponent('Г26-04512')}`);
  await page.getByRole('button', { name: SSO_BUTTON }).click();
  await keycloakLogin(page, 'smirnova');
  // Вернулись в «Консилиум» по ссылке на случай: одноразовый токен обменян и убран из адреса.
  await expect(page.getByLabel('Карточка случая')).toContainText('Г26-04512', { timeout: 20_000 });
  expect(page.url()).not.toContain('loginToken');

  await test.step('выход и снова вход — Keycloak помнит сессию, пароль не нужен', async () => {
    await page.getByRole('button', { name: 'Выйти' }).click();
    await page.getByRole('button', { name: SSO_BUTTON }).click();
    await expect(page.getByRole('option').first()).toBeVisible({ timeout: 20_000 });
  });
});

test('вход во фрейме РИС: страница организации — во всплывающем окне, чат открывается во фрейме', async ({ page }) => {
  await page.goto(RIS);
  const chat = page.frameLocator('iframe[title="Чат исследования"]');
  const popupPromise = page.waitForEvent('popup');
  await chat.getByRole('button', { name: SSO_BUTTON }).click();
  const popup = await popupPromise;
  await keycloakLogin(popup, 'orlov');
  await popup.waitForEvent('close', { timeout: 20_000 });
  await expect(chat.getByLabel('Карточка случая')).toContainText('A26-118734', { timeout: 20_000 });
});
