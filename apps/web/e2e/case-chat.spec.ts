import { expect, test } from '@playwright/test';
import { DEV_PASSWORD as PASSWORD } from '@konsilium/host-mock/users';

const CASE = 'Г26-04512';
// По умолчанию — окружение разработчика; для стенда адреса и токен задаёт playwright.stand.config.ts.
const CCS = process.env.E2E_CCS_URL ?? 'http://localhost:8080';
const LIS_TOKEN = process.env.E2E_LIS_TOKEN ?? 'dev-only-lis-token-0123456789abcdef';
const SHOTS = process.env.E2E_SCREENSHOTS;

test('врач открывает чат случая по ссылке из ЛИС, видит карточку, пишет, получает заявку и уведомление', async ({ page }) => {
  await test.step('вход по ссылке /c/lis/{номер}', async () => {
    await page.goto(`/c/lis/${encodeURIComponent(CASE)}`);
    await page.getByLabel('Логин').fill('smirnova');
    await page.getByLabel('Пароль').fill(PASSWORD);
    await page.getByRole('button', { name: 'Войти' }).click();
  });

  const bar = page.getByLabel('Карточка случая');
  await test.step('карточка случая из ЛИС, ФИО скрыто', async () => {
    await expect(bar).toContainText(CASE);
    await expect(bar).toContainText('Н*** О. В., Ж, 54 года');
    await expect(bar).toContainText('Срочно');
    await expect(bar).not.toContainText('Нестерова');
    await expect(page).toHaveURL('/');
    await expect(page.locator('.chat-subtitle')).toContainText('Чат случая · ЛИС');
  });

  await test.step('сообщение уходит и появляется справа', async () => {
    const text = `Коллеги, посмотрите блок 1А — нужна ИГХ`;
    await page.getByLabel('Сообщение').fill(text);
    await page.keyboard.press('Enter');
    await expect(page.locator('.msg.out').last()).toContainText(text);
    await expect(page.locator('.msg.out .meta').last()).not.toHaveText('отправка…');
  });

  await test.step('реакция-статус «Согласен»: ставится и снимается', async () => {
    const msg = page.locator('.msg.out').last();
    await msg.hover();
    await msg.getByRole('button', { name: 'Отметить сообщение' }).click();
    await msg.getByRole('menuitem', { name: 'Согласен' }).click();
    await expect(msg.locator('.reaction.mine')).toHaveText('Согласен 1');
    await msg.locator('.reaction.mine').click();
    await expect(msg.locator('.reactions')).toHaveCount(0);
  });

  await test.step('данные пациента — по запросу, с журналом в ЛИС, кнопка «Скрыть»', async () => {
    await bar.getByRole('button', { name: 'Показать' }).click();
    await expect(bar).toContainText('Нестерова Ольга Викторовна, 14.03.1972');
    await bar.getByRole('button', { name: 'Скрыть' }).click();
    await expect(bar).not.toContainText('Нестерова');
  });

  await test.step('заявка ИГХ из формы: карточка проходит этапы до «Готово»', async () => {
    await page.getByRole('button', { name: '+ Заявка в ЛИС' }).click();
    const form = page.getByRole('form', { name: 'Новая заявка' });
    await form.getByLabel('Блок').fill('1А');
    for (const m of ['ER', 'PR', 'HER2/neu', 'Ki-67']) await form.getByText(m, { exact: true }).click();
    await form.getByRole('radio', { name: 'Срочно' }).click();
    await form.getByRole('button', { name: 'Отправить в ЛИС' }).click();
    await expect(form).toBeHidden();
    const card = page.getByLabel('Заявка').last();
    await expect(card).toContainText('Запрос ИГХ: блок 1А — ER, PR, HER2/neu, Ki-67 (срочно)');
    await expect(card).toContainText(/ИГХ-\d+/);
    await expect(card.locator('.steps li.current')).toHaveText('Готово', { timeout: 30_000 });
  });

  await test.step('уведомление ЛИС с кнопкой', async () => {
    const res = await fetch(`${CCS}/integration/v1/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${LIS_TOKEN}`, 'content-type': 'application/cloudevents+json' },
      body: JSON.stringify({
        specversion: '1.0',
        id: `e2e-${Date.now()}`,
        source: 'lis',
        type: 'ru.vendor.notification.posted',
        data: {
          case_id: CASE,
          text: 'Стёкла ИГХ отсканированы, можно смотреть',
          category: 'ready',
          links: [{ label: 'Открыть во вьюере', url: 'https://wsi.clinic.local/case/G26-04512' }],
        },
      }),
    });
    expect(((await res.json()) as { results: Array<{ status: string }> }).results[0]?.status).toBe('accepted');
    const notice = page.locator('.notice.ready').last();
    await expect(notice).toContainText('Стёкла ИГХ отсканированы');
    await expect(notice.getByRole('link', { name: /Открыть во вьюере/ })).toHaveAttribute('href', 'https://wsi.clinic.local/case/G26-04512');
  });

  await test.step('чат в папке «Случаи»', async () => {
    await page.getByRole('button', { name: /Случаи/ }).click();
    await expect(page.getByRole('option').first()).toContainText(CASE);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/web-desktop.png` });
  });

  await test.step('узкий экран: только чат, кнопка «назад»', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('button', { name: 'К списку чатов' })).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/web-mobile.png` });
    await page.getByRole('button', { name: 'К списку чатов' }).click();
    await expect(page.getByRole('option').first()).toBeVisible();
  });
});

test('без прав в ЛИС чат не открывается', async ({ page }) => {
  await page.goto(`/c/lis/${encodeURIComponent('Г26-04530')}`);
  await page.getByLabel('Логин').fill('ershova');
  await page.getByLabel('Пароль').fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByRole('status')).toContainText('Нет доступа к случаю');
});
