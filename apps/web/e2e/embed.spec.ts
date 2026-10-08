import { expect, test } from '@playwright/test';
import { DEV_PASSWORD } from '@konsilium/host-mock/users';
import { loginViaCaseLink } from './helpers.ts';

// Демо-страница РИС из песочницы — другой origin (порт 8090), чат подключён через /embed/v1/embed.js.
const RIS = process.env.E2E_RIS_DEMO_URL ?? 'http://localhost:8090/demo/ris';
const SHOTS = process.env.E2E_SCREENSHOTS;

test('встраивание в РИС: панель чата, ключевой снимок, ссылка во вьюер, бейджи рабочего списка', async ({ browser }) => {
  const ris = await (await browser.newContext()).newPage();
  await ris.goto(RIS);
  const chat = ris.frameLocator('iframe[title="Чат исследования"]');

  await test.step('вход во фрейме — чат открытого исследования', async () => {
    await chat.getByLabel('Логин').fill('orlov');
    await chat.getByLabel('Пароль').fill(DEV_PASSWORD);
    await chat.getByRole('button', { name: 'Войти' }).click();
    await expect(chat.getByLabel('Карточка случая')).toContainText('A26-118734');
    await expect(chat.getByLabel('Карточка случая')).toContainText('С*** В. П.');
  });

  await test.step('«В чат исследования»: ключевой снимок с миниатюрой', async () => {
    await ris.getByRole('button', { name: 'В чат исследования' }).click();
    await expect(ris.getByRole('status')).toHaveText('Снимок отправлен в чат исследования');
    const card = chat.getByLabel('Ключевой снимок').last();
    await expect(card).toContainText('Ключевой снимок: кадр 42');
    await expect(card).toContainText('Ш/У 700/100');
    await expect(card.locator('img')).toBeVisible();
  });

  await test.step('«Открыть во вьюере» в чате — тот же кадр во вьюере РИС', async () => {
    await ris.locator('#frame').fill('7');
    await chat.getByLabel('Ключевой снимок').last().getByRole('button', { name: 'Открыть во вьюере' }).click();
    await expect(ris.getByRole('status')).toHaveText('Открыт ключевой снимок из чата: кадр 42');
    await expect(ris.locator('#frame-n')).toHaveText('42');
  });

  await test.step('смена исследования в списке — смена чата', async () => {
    await ris.locator('tr[data-case="A26-118737"]').click();
    await expect(chat.getByLabel('Карточка случая')).toContainText('A26-118737');
  });

  await test.step('сообщение лаборанта в другом исследовании — бейдж в рабочем списке', async () => {
    const tech = await (await browser.newContext()).newPage();
    await loginViaCaseLink(tech, 'safonova', 'ris', 'A26-118735');
    await tech.getByLabel('Сообщение', { exact: true }).fill('Исследование выполнено, серии в PACS');
    await tech.keyboard.press('Enter');
    await expect(ris.locator('tr[data-case="A26-118735"] .badge')).toHaveText(/^[1-9]\d*$/, { timeout: 20_000 });
    if (SHOTS) await ris.screenshot({ path: `${SHOTS}/ris-embed.png` });
  });
});

test('чужой сайт не может встроить чат', async ({ page, baseURL }) => {
  await page.goto('/');
  await page.setContent(`<iframe title="x" src="${baseURL}/embed?mode=panel&host=https%3A%2F%2Fevil.example"></iframe>`);
  await expect(page.frameLocator('iframe').getByText('не разрешено')).toBeVisible();
});
