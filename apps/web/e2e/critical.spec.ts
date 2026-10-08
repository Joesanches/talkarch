import { expect, test, type Browser, type Page } from '@playwright/test';
import { loginViaCaseLink } from './helpers.ts';

const CCS = process.env.E2E_CCS_URL ?? 'http://localhost:8080';
const RIS_TOKEN = process.env.E2E_RIS_TOKEN ?? 'dev-only-ris-token-0123456789abcdef';
const SHOTS = process.env.E2E_SCREENSHOTS;

async function userPage(browser: Browser) {
  return (await browser.newContext()).newPage();
}

test('критическая находка из чата: адресат видит закреплённую полосу и подтверждает, отправитель видит итог', async ({ browser }) => {
  const doctor = await userPage(browser);
  const attending = await userPage(browser);
  await loginViaCaseLink(doctor, 'smirnova', 'lis', 'Г26-04512');
  await loginViaCaseLink(attending, 'kolesnikov', 'lis', 'Г26-04512');
  const finding = `Метастаз в подмышечном лимфоузле — нужна консультация онколога (${Date.now() % 10000})`;

  await test.step('патоморфолог отправляет находку лечащему врачу со сроком 10 минут', async () => {
    await doctor.getByRole('button', { name: '! Критическая находка' }).click();
    const form = doctor.getByRole('form', { name: 'Критическая находка' });
    await form.getByLabel('Находка').fill(finding);
    await expect(form.getByRole('radio', { name: 'лечащий врач' })).toHaveAttribute('aria-checked', 'true');
    await form.getByRole('radio', { name: '10 мин' }).click();
    await form.getByRole('button', { name: 'Отправить находку' }).click();
    const card = doctor.getByLabel('Критическая находка').filter({ hasText: finding });
    await expect(card.getByRole('status')).toContainText('Ждёт подтверждения');
    await expect(card.getByRole('status')).toContainText(/осталось [89]:\d\d/);
    await expect(card).toContainText('Кому: Колесников Д. А.');
    await expect(card.getByRole('button', { name: 'Подтверждаю получение' })).toHaveCount(0); // отправитель не подтверждает
  });

  await test.step('у лечащего врача — полоса над лентой, отметка в списке; подтверждение', async () => {
    const bar = attending.getByRole('alert', { name: 'Критическая находка ждёт подтверждения' });
    await expect(bar).toContainText(finding);
    await expect(attending.getByRole('option').first().locator('.badge-critical')).toBeVisible();
    if (SHOTS) await attending.screenshot({ path: `${SHOTS}/web-critical.png` });
    await bar.getByRole('button', { name: 'Подтверждаю получение' }).click();
    await expect(bar).toBeHidden();
  });

  await test.step('оба видят «Подтверждено» с временем', async () => {
    for (const page of [doctor, attending]) {
      const card = page.getByLabel('Критическая находка').filter({ hasText: finding });
      await expect(card.getByRole('status')).toContainText(/Подтверждено: Колесников Д\. А\., через \d+ с/);
    }
    await expect(doctor.locator('.notice').filter({ hasText: 'Получение критической находки подтверждено' }).last()).toContainText('Колесников Д. А.');
  });
});

test('критическая находка из РИС: нет подтверждения — звонок на пост, затем подключается заведующий и подтверждает', async ({ browser }) => {
  test.setTimeout(90_000);
  const onDuty = await userPage(browser);
  await loginViaCaseLink(onDuty, 'melnikova', 'ris', 'A26-118734');
  const findingId = `КН-E2E-${Date.now()}`;

  await test.step('РИС отправляет находку дежурному врачу: срок 8 с, затем пост и заведующий', async () => {
    const res = await fetch(`${CCS}/integration/v1/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${RIS_TOKEN}`, 'content-type': 'application/cloudevents+json' },
      body: JSON.stringify({
        specversion: '1.0',
        id: `e2e-${findingId}`,
        source: 'ris',
        type: 'ru.vendor.critical.raised',
        data: {
          case_id: 'A26-118734',
          finding_id: findingId,
          finding: 'Двусторонняя ТЭЛА: долевые и сегментарные ветви',
          reported_by: { login: 'orlov' },
          recipient: { role: 'on_duty' },
          ack_deadline: 'PT8S',
          escalation: [
            { after: 'PT8S', action: 'call', target: 'Пост приёмного отделения' },
            { after: 'PT14S', action: 'notify', target: 'head', users: [{ login: 'gusev' }] },
          ],
        },
      }),
    });
    expect(((await res.json()) as { results: Array<{ status: string }> }).results[0]?.status).toBe('accepted');
  });

  const card = onDuty.getByLabel('Критическая находка').filter({ hasText: 'Двусторонняя ТЭЛА' }).last();
  await test.step('дежурный видит находку от РИС с автором; срок истекает — звонок на пост, затем заведующий', async () => {
    await expect(card).toContainText('Сообщил: Орлов К. М.');
    await expect(card.getByLabel('Эскалации')).toContainText('звонок на «Пост приёмного отделения» (вручную)', { timeout: 20_000 });
    await expect(card.locator('.critical-timer')).toContainText('просрочено');
    await expect(card.getByLabel('Эскалации')).toContainText('подключён Гусев П. Р.', { timeout: 20_000 });
  });

  await test.step('заведующий открывает чат по ссылке из РИС (доступ дала эскалация) и подтверждает', async () => {
    const head = await userPage(browser);
    await loginViaCaseLink(head, 'gusev', 'ris', 'A26-118734');
    await expect(head.getByRole('option', { selected: true }).locator('.badge-critical')).toBeVisible();
    const bar = head.getByRole('alert', { name: 'Критическая находка ждёт подтверждения' });
    await expect(bar).toContainText('Двусторонняя ТЭЛА');
    await bar.getByRole('button', { name: 'Подтверждаю получение' }).click();
    await expect(bar).toBeHidden();
  });

  await test.step('итог у дежурного и в отчёте для РИС', async () => {
    await expect(card.getByRole('status')).toContainText(/Подтверждено: Гусев П\. Р\., через \d+ с \(позже срока\)/);
    const report = await fetch(`${CCS}/integration/v1/critical-findings`, { headers: { authorization: `Bearer ${RIS_TOKEN}` } });
    const found = ((await report.json()) as { findings: Array<{ host_finding_id?: string; status: string; overdue: boolean; escalations: unknown[] }> }).findings.find(
      (f) => f.host_finding_id === findingId,
    );
    expect(found).toMatchObject({ status: 'acknowledged', overdue: true });
    expect(found?.escalations).toHaveLength(2);
  });
});

export type { Page };
