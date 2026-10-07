import { expect, test, type Page } from '@playwright/test';
import { MsgType } from '@konsilium/protocol';
import { PASSWORD } from './global-setup.ts';

const CASE = 'Г26-04512';
const HS = 'http://localhost:8008';
const CCS = 'http://localhost:8080';
const SHOTS = process.env.E2E_SCREENSHOTS;

async function session(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('konsilium.session') ?? 'null') as { accessToken: string });
}

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

  await test.step('заявка ИГХ: карточка проходит этапы до «Готово»', async () => {
    const { accessToken } = await session(page);
    const open = await fetch(`${CCS}/api/v1/cases/open`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ connector: 'lis', caseId: CASE }),
    });
    const { roomId } = (await open.json()) as { roomId: string };
    // Поле быстрых действий («Запрос ИГХ») — шаг 3; пока отправляем карточку заявки через API Matrix.
    const send = await fetch(`${HS}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/e2e-${Date.now()}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        msgtype: MsgType.Request,
        body: 'Запрос ИГХ: блок 1А — ER, PR, HER2/neu, Ki-67 (срочно)',
        [MsgType.Request]: { kind: 'ihc', block: '1А', items: ['ER', 'PR', 'HER2/neu', 'Ki-67'], priority: 'urgent' },
      }),
    });
    expect(send.ok).toBe(true);
    const card = page.getByLabel('Заявка').last();
    await expect(card).toContainText(/ИГХ-\d+/);
    await expect(card.locator('.steps li.current')).toHaveText('Готово', { timeout: 15_000 });
  });

  await test.step('уведомление ЛИС с кнопкой', async () => {
    const res = await fetch(`${CCS}/integration/v1/events`, {
      method: 'POST',
      headers: { authorization: 'Bearer dev-only-lis-token-0123456789abcdef', 'content-type': 'application/cloudevents+json' },
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
