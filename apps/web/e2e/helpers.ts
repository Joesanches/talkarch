import { expect, type Page } from '@playwright/test';
import { DEV_PASSWORD } from '@konsilium/host-mock/users';

/** Вход по ссылке из РИС/ЛИС: страница входа, затем открытие чата случая. */
export async function loginViaCaseLink(page: Page, user: string, connector: string, caseId: string) {
  await page.goto(`/c/${connector}/${encodeURIComponent(caseId)}`);
  await page.getByLabel('Логин').fill(user);
  await page.getByLabel('Пароль').fill(DEV_PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByLabel('Карточка случая')).toContainText(caseId);
}
