import { expect, test } from '@playwright/test';
import { loginViaCaseLink } from './helpers.ts';

const CASE = 'Г26-04512';
const SHOTS = process.env.E2E_SCREENSHOTS;

test('видеозвонок в чате случая: патоморфолог звонит, лаборант присоединяется по баннеру', async ({ browser }) => {
  const doctor = await (await browser.newContext()).newPage();
  const tech = await (await browser.newContext()).newPage();

  await loginViaCaseLink(doctor, 'smirnova', 'lis', CASE);
  await loginViaCaseLink(tech, 'ershova', 'lis', CASE);

  await test.step('врач начинает видеозвонок', async () => {
    await doctor.getByRole('button', { name: 'Видеозвонок' }).click();
    const call = doctor.getByRole('region', { name: 'Звонок' });
    await expect(call.locator('.call-status')).toContainText(/\d+:\d{2} · 1 участник/, { timeout: 20_000 });
    await expect(call.locator('.tile video')).toHaveCount(1); // своя камера
  });

  await test.step('лаборант видит «Идёт звонок» и присоединяется', async () => {
    await expect(tech.getByRole('status').filter({ hasText: 'Идёт звонок' })).toContainText('Смирнова А. В.');
    await tech.getByRole('button', { name: 'Присоединиться' }).click();
    const call = tech.getByRole('region', { name: 'Звонок' });
    await expect(call.locator('.call-status')).toContainText('2 участника', { timeout: 20_000 });
    // Видео врача пришло к лаборанту.
    await expect(call.locator('.tile[data-identity^="@smirnova:"] video')).toBeVisible({ timeout: 20_000 });
    await expect(call.locator('.tile[data-identity^="@smirnova:"] .tile-name')).toHaveText('Смирнова А. В.');
  });

  await test.step('врач видит лаборанта', async () => {
    const call = doctor.getByRole('region', { name: 'Звонок' });
    await expect(call.locator('.call-status')).toContainText('2 участника');
    await expect(call.locator('.tile[data-identity^="@ershova:"] .tile-name')).toContainText('Ершова Т. Н.');
    await expect(call.locator('.call-status')).not.toContainText('0:00'); // таймер идёт
    if (SHOTS) await doctor.screenshot({ path: `${SHOTS}/web-call.png` });
  });

  await test.step('свернуть и вернуться — связь не рвётся', async () => {
    await doctor.getByRole('button', { name: 'Свернуть звонок' }).click();
    await expect(doctor.getByRole('region', { name: 'Идущий звонок' })).toContainText('2 уч.');
    await doctor.getByRole('button', { name: 'Вернуться' }).click();
    await expect(doctor.getByRole('region', { name: 'Звонок' }).locator('.call-status')).toContainText('2 участника');
  });

  await test.step('оба выходят — в ленте «Звонок завершён»', async () => {
    await tech.getByRole('button', { name: 'Выйти из звонка' }).click();
    await expect(doctor.getByRole('region', { name: 'Звонок' }).locator('.call-status')).toContainText('1 участник', { timeout: 20_000 });
    await doctor.getByRole('button', { name: 'Выйти из звонка' }).click();
    await expect(doctor.locator('.system-line').filter({ hasText: 'Звонок завершён' }).last()).toBeVisible();
    await expect(tech.locator('.system-line').filter({ hasText: 'Звонок завершён' }).last()).toBeVisible();
  });
});
