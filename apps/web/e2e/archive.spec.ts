import { expect, test, type Browser } from '@playwright/test';
import { loginViaCaseLink } from './helpers.ts';

const CCS = process.env.E2E_CCS_URL ?? 'http://localhost:8080';
const RIS_TOKEN = process.env.E2E_RIS_TOKEN ?? 'dev-only-ris-token-0123456789abcdef';
const SHOTS = process.env.E2E_SCREENSHOTS;

// Окружение разработчика (playwright.config.ts) отправляет закрытый случай в архив сразу. На стенде по умолчанию — через
// 14 дней: тест включается переменной E2E_ARCHIVE=1, если стенд запущен с ARCHIVE_AFTER_DAYS=0.
test.skip(!!process.env.STAND_URL && !process.env.E2E_ARCHIVE, 'на стенде архив наступает через ARCHIVE_AFTER_DAYS');

// Сервис контекста ищет чаты для архива раз в секунду в окружении разработчика и раз в минуту на стенде.
const ARCHIVE_WAIT = process.env.STAND_URL ? 90_000 : 15_000;

async function userPage(browser: Browser) {
  return (await browser.newContext()).newPage();
}

/** Снимок случая из РИС (уровень 1: права — из события). */
async function upsert(caseId: string, version: number, status: 'open' | 'closed') {
  const res = await fetch(`${CCS}/integration/v1/events`, {
    method: 'POST',
    headers: { authorization: `Bearer ${RIS_TOKEN}`, 'content-type': 'application/cloudevents+json' },
    body: JSON.stringify({
      specversion: '1.0',
      id: `e2e-${caseId}-v${version}`,
      source: 'ris',
      type: 'ru.vendor.case.upserted',
      data: {
        case_id: caseId,
        version,
        status,
        title: 'КТ органов грудной клетки',
        patient: { ref: `pseudo:${caseId}`, masked: 'К*** В. С.', age: 58, sex: 'M' },
        participants: [
          { user: { login: 'orlov' }, role: 'radiologist' },
          { user: { login: 'melnikova' }, role: 'on_duty' },
        ],
        updated_at: new Date().toISOString(),
      },
    }),
  });
  expect(((await res.json()) as { results: Array<{ status: string }> }).results[0]?.status).toBe('accepted');
}

test('архив: закрытый случай уходит в архив, участники выведены; возврат из папки «Архив» — только чтение с полной историей', async ({ browser }) => {
  test.setTimeout(90_000 + ARCHIVE_WAIT);
  const caseId = `A26-E2E-${Date.now() % 1_000_000}`;
  const text = 'Очаговых изменений не выявлено, заключение в РИС';
  await upsert(caseId, 1, 'open');

  const doctor = await userPage(browser);
  const onDuty = await userPage(browser);
  await loginViaCaseLink(doctor, 'orlov', 'ris', caseId);
  await doctor.getByLabel('Сообщение').fill(text);
  await doctor.getByLabel('Сообщение').press('Enter');
  await loginViaCaseLink(onDuty, 'melnikova', 'ris', caseId);
  await expect(onDuty.locator('.msg').filter({ hasText: text })).toBeVisible();

  await test.step('РИС закрывает случай — чат уходит в архив и пропадает из списков', async () => {
    await upsert(caseId, 2, 'closed');
    for (const page of [doctor, onDuty]) {
      await expect(page.getByRole('status').filter({ hasText: 'Чат перенесён в архив' })).toBeVisible({ timeout: ARCHIVE_WAIT });
      await expect(page.getByRole('listbox', { name: 'Чаты' }).getByText(caseId)).toHaveCount(0);
    }
  });

  await test.step('папка «Архив»: случай есть, поиск по номеру', async () => {
    await doctor.getByRole('navigation', { name: 'Папки' }).getByRole('button', { name: /^Архив/ }).click();
    const archive = doctor.getByRole('listbox', { name: 'Архив' });
    await doctor.getByLabel('Поиск в архиве').fill(caseId.toLowerCase());
    await expect(archive.getByRole('option')).toHaveCount(1);
    await expect(archive.getByRole('option')).toContainText(caseId);
    await expect(archive.getByRole('option')).toContainText(/в архиве с/);
  });

  await test.step('возврат: история целиком, чат только для чтения (цель ≤ 1 с)', async () => {
    const t0 = Date.now();
    await doctor.getByRole('listbox', { name: 'Архив' }).getByRole('option').click();
    await expect(doctor.locator('.msg').filter({ hasText: text })).toBeVisible();
    await expect(doctor.getByRole('status').filter({ hasText: 'Случай в архиве — чат только для чтения' })).toBeVisible();
    const ms = Date.now() - t0;
    test.info().annotations.push({ type: 'Возврат в архивный чат, мс', description: String(ms) });
    console.log(`Возврат в архивный чат (клик → история на экране): ${ms} мс`);
    expect(ms).toBeLessThan(3000);
    await expect(doctor.getByLabel('Карточка случая')).toContainText('Архив');
    await expect(doctor.getByRole('textbox', { name: 'Сообщение' })).toHaveCount(0);
    await expect(doctor.getByRole('button', { name: 'Аудиозвонок' })).toHaveCount(0);
    await expect(doctor.getByRole('button', { name: 'Отметить сообщение' })).toHaveCount(0);
    if (SHOTS) await doctor.screenshot({ path: `${SHOTS}/archive-return.png` });
  });

  await test.step('«Убрать из списка» — чат снова только в архиве', async () => {
    await doctor.getByRole('navigation', { name: 'Папки' }).getByRole('button', { name: /^Все/ }).click();
    await expect(doctor.getByRole('listbox', { name: 'Чаты' }).getByRole('option').filter({ hasText: caseId })).toContainText('Архив');
    await doctor.getByRole('button', { name: 'Убрать из списка' }).click();
    await expect(doctor.getByRole('listbox', { name: 'Чаты' }).getByText(caseId)).toHaveCount(0);
  });

  await test.step('случай снова открыт в РИС — чат вернулся из архива, писать можно', async () => {
    await upsert(caseId, 3, 'open');
    const row = onDuty.getByRole('listbox', { name: 'Чаты' }).getByRole('option').filter({ hasText: caseId });
    await row.click();
    await expect(onDuty.locator('.notice').filter({ hasText: 'чат вернулся из архива' })).toBeVisible();
    await expect(onDuty.getByRole('textbox', { name: 'Сообщение' })).toBeVisible();
  });
});
