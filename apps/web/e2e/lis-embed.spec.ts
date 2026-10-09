import { expect, test } from '@playwright/test';
import { DEV_PASSWORD } from '@konsilium/host-mock/users';
import { loginViaCaseLink } from './helpers.ts';

// Демо-страница ЛИС из песочницы — другой origin (порт 8090), чат — плавающее окно SDK (режим launcher).
const LIS = process.env.E2E_LIS_DEMO_URL ?? 'http://localhost:8090/demo/lis';
const SHOTS = process.env.E2E_SCREENSHOTS;
const CASE = 'Г26-04512';

test('встраивание в ЛИС: плавающий чат, непрочитанное, «печатает…», стекло в чат и обратно во вьюер ЛИС', async ({ browser }) => {
  test.setTimeout(90_000);
  const lis = await (await browser.newContext()).newPage();
  await lis.goto(LIS);
  const launcher = lis.getByRole('button', { name: 'Чат случая' });
  const badge = lis.locator('[data-konsilium-launcher] .badge');
  const chat = lis.frameLocator('iframe[title="Чат случая"]');

  await test.step('кнопка чата открывает окно, вход во фрейме — чат случая из формы ЛИС', async () => {
    await launcher.click();
    await expect(launcher).toHaveAttribute('aria-expanded', 'true');
    // Заведующий (доступ к случаю — по проверке прав в ЛИС). Не тот же пользователь, что в других тестах этого случая:
    // их открытые вкладки сразу прочитали бы новое сообщение — и непрочитанного бы не осталось.
    await chat.getByLabel('Логин').fill('gusev');
    await chat.getByLabel('Пароль').fill(DEV_PASSWORD);
    await chat.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(chat.locator('.chat-subtitle')).toContainText(CASE, { timeout: 20_000 });
    await expect(chat.locator('.chat-title')).toHaveText('Чат случая');
    // Узкое окно: без карточки случая — она уже на странице ЛИС.
    await expect(chat.getByLabel('Карточка случая')).toHaveCount(0);
    await chat.getByRole('button', { name: 'Свернуть чат' }).click();
    await expect(launcher).toHaveAttribute('aria-expanded', 'false');
  });

  const attending = await (await browser.newContext()).newPage();
  await loginViaCaseLink(attending, 'kolesnikov', 'lis', CASE);
  const question = `Ki-67 тоже ставим? (${Date.now() % 10000})`;

  await test.step('сообщение при свёрнутом окне — бейдж на кнопке; открыл — разделитель «Непрочитанные»', async () => {
    await attending.getByRole('textbox', { name: 'Сообщение' }).fill(question);
    await attending.getByRole('textbox', { name: 'Сообщение' }).press('Enter');
    await expect(badge).toHaveText(/^[1-9]\d*$/, { timeout: 20_000 });
    await launcher.click();
    const divider = chat.getByRole('separator').filter({ hasText: 'Непрочитанные сообщения' });
    await expect(divider).toBeVisible();
    // Разделитель — прямо перед новым сообщением.
    await expect(chat.locator('.unread-divider + .msg, .unread-divider + .day + .msg').first()).toContainText(question);
    await expect(badge).toBeHidden({ timeout: 15_000 });
  });

  await test.step('собеседник набирает текст — «печатает…»', async () => {
    await attending.getByRole('textbox', { name: 'Сообщение' }).fill('Да, и');
    await expect(chat.locator('.typing')).toHaveText('Колесников Д. А. печатает…', { timeout: 15_000 });
    await attending.getByRole('textbox', { name: 'Сообщение' }).fill('');
    await expect(chat.locator('.typing')).toHaveCount(0, { timeout: 15_000 });
  });

  await test.step('«В чат» у стекла — карточка препарата у собеседника, окно чата открывается само', async () => {
    // Окно чата лежит поверх формы — врач сворачивает его, работая со списком стёкол.
    await chat.getByRole('button', { name: 'Свернуть чат' }).click();
    await lis.getByRole('button', { name: 'Стекло 2 в чат' }).click();
    await expect(lis.getByRole('status')).toHaveText('Стекло 2 отправлено в чат случая');
    await expect(launcher).toHaveAttribute('aria-expanded', 'true');
    const card = attending.getByLabel('Препарат').last();
    await expect(card).toContainText('Стекло 2 · блок 1Б');
    await expect(card).toContainText('H&E · ×20 · область');
    await expect(card.locator('img')).toBeVisible();
    if (SHOTS) await lis.screenshot({ path: `${SHOTS}/lis-embed.png` });
  });

  await test.step('«Открыть во вьюере» в чате — стекло открывается в ЛИС', async () => {
    await chat.getByLabel('Препарат').last().getByRole('button', { name: 'Открыть во вьюере' }).click();
    await expect(lis.getByRole('status')).toContainText('Открыто стекло 2 (H&E, ×20');
    await expect(lis.locator('tr.on')).toHaveAttribute('data-slide', '2');
  });
});
