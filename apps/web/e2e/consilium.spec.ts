import { expect, test, type Browser, type Page } from '@playwright/test';
import { DEV_PASSWORD } from '@konsilium/host-mock/users';

/**
 * Консилиум целиком: МИС (песочница) назначила «Онкоконсилиум» из трёх случаев ЛИС и РИС; председатель ведёт звонок
 * со стенограммой и переключает случаи; «Секретарь» (демо-агент песочницы — сценарий реплик вместо распознавания)
 * делит стенограмму; секретарь проверяет черновик рядом со стенограммой и принимает его в протокол МИС;
 * лечащий врач видит принятый протокол в чате случая.
 */
const HOST = process.env.E2E_HOST_MOCK_URL ?? 'http://localhost:8090';
// На стенде песочница снаружи — только страницы (GET): тесту нужен её внутренний адрес.
test.skip(!!process.env.STAND_URL && !process.env.E2E_HOST_MOCK_URL, 'на стенде нужен внутренний адрес песочницы: E2E_HOST_MOCK_URL');
// Песочница: назначить консилиум — с токеном подключения ЛИС, сценарий демо-агента — с токеном агента (окружение разработчика).
const LIS_TOKEN = process.env.E2E_LIS_TOKEN ?? 'dev-only-lis-token-0123456789abcdef';
const SECRETARY_TOKEN = process.env.E2E_SECRETARY_TOKEN ?? 'dev-only-secretary-token-0123456789';
const SHOTS = process.env.E2E_SCREENSHOTS;

/** Свой консилиум на каждый прогон: МИС песочницы назначает его с уникальным названием (повестка та же). */
const TITLE = `Онкоконсилиум · e2e ${Date.now().toString(36)}`;

async function login(browser: Browser, user: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/');
  await page.getByLabel('Логин').fill(user);
  await page.getByLabel('Пароль').fill(DEV_PASSWORD);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await page.getByRole('listbox', { name: 'Чаты' }).getByRole('option').filter({ hasText: TITLE }).click();
  await expect(page.getByRole('region', { name: 'Повестка консилиума' })).toBeVisible({ timeout: 20_000 });
  return page;
}

const agenda = (page: Page) => page.getByRole('region', { name: 'Повестка консилиума' });

test('консилиум: повестка и роли, стенограмма по случаям, проверка и принятие протокола в МИС, копия в чате случая', async ({ browser }) => {
  test.setTimeout(150_000);
  const created = await fetch(`${HOST}/demo/consilium`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${LIS_TOKEN}` }, body: JSON.stringify({ title: TITLE }) });
  expect(((await created.json()) as { results: Array<{ status: string }> }).results[0]?.status).toBe('accepted');
  const chair = await login(browser, 'belova');
  const secretary = await login(browser, 'petrov');
  const doctor = await login(browser, 'kolesnikov');

  await test.step('повестка из ЛИС и РИС, состав с ролями; переключать случаи могут только ведущие', async () => {
    for (const page of [chair, secretary, doctor]) {
      await expect(page.locator('.chat-subtitle')).toContainText('Консилиум · 3 случая');
      await expect(agenda(page).locator('.agenda-item')).toHaveCount(3);
      await expect(agenda(page).locator('.agenda-item').nth(1)).toContainText('A26-118737');
    }
    await expect(agenda(chair).locator('.agenda-item').first()).toHaveAttribute('aria-current', 'step');
    await expect(agenda(chair)).toContainText('вы ведёте');
    await expect(agenda(doctor).getByRole('button', { name: 'Следующий случай' })).toHaveCount(0);
    await agenda(doctor).getByText(/^Состав · 6/).click();
    await expect(agenda(doctor).locator('.roster')).toContainText('Белова Л. Р. — председатель, заведующая онкологическим отделением');
    await expect(agenda(doctor).locator('.roster')).toContainText('Гусев П. Р. — химиотерапевт, НМИЦ · дистанционно');
  });

  const lines: Array<{ login: string; name: string; text: string; at: string }> = [];
  const say = (login: string, name: string, text: string) => lines.push({ login, name, text, at: new Date().toISOString() });

  await test.step('звонок со стенограммой; председатель ведёт повестку — у всех текущий случай меняется', async () => {
    await chair.getByRole('button', { name: 'Аудиозвонок' }).click();
    const call = chair.getByRole('region', { name: 'Звонок' });
    await call.getByRole('button', { name: 'Включить стенограмму (ИИ)' }).click();
    await expect(call.getByRole('button', { name: 'Остановить стенограмму' })).toBeVisible({ timeout: 20_000 });
    await chair.waitForTimeout(300);

    say('kolesnikov', 'Колесников Д. А.', 'Пациентка пятидесяти четырёх лет, опухоль левой молочной железы около двух сантиметров.');
    say('smirnova', 'Смирнова А. В.', 'Инвазивная карцинома, HER2 три плюс.');
    say('belova', 'Белова Л. Р.', 'Решение: биопсия лимфоузла, затем неоадъювантная терапия.');
    await chair.waitForTimeout(300);
    // Во время звонка повестка — в панели звонка: ведущий переключает случай, не сворачивая видео.
    await expect(call.getByRole('group', { name: 'Текущий случай' })).toContainText('1/3');
    await call.getByRole('button', { name: 'Следующий случай' }).click();
    await expect(agenda(doctor).locator('.agenda-item').nth(1)).toHaveAttribute('aria-current', 'step');
    await expect(call.getByRole('group', { name: 'Текущий случай' })).toContainText('A26-118737');
    await chair.waitForTimeout(300);

    say('orlov', 'Орлов К. М.', 'На КТ брюшной полости очаг в печени девятнадцать миллиметров.');
    say('belova', 'Белова Л. Р.', 'Решение: МРТ печени с контрастом.');
    await chair.waitForTimeout(300);
    await call.getByRole('button', { name: 'Следующий случай' }).click();
    await expect(agenda(secretary).locator('.agenda-item').nth(2)).toHaveAttribute('aria-current', 'step');
    await expect(call.getByRole('button', { name: 'Следующий случай' })).toHaveCount(0); // последний случай
    await chair.waitForTimeout(300);

    say('smirnova', 'Смирнова А. В.', 'Аденокарцинома толстой кишки, метастазы в двух лимфоузлах.');
    // Сценарий для демо-агента: реплики с временем — «Секретарь» разложит их по отметкам текущего случая.
    const script = await fetch(`${HOST}/demo/secretary/script`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRETARY_TOKEN}` }, body: JSON.stringify({ lines }) });
    expect(script.ok).toBe(true);
    await call.getByRole('button', { name: 'Остановить стенограмму' }).click();
  });

  await test.step('черновик на каждый случай повестки; ведущим — «Проверить и принять», остальным — просмотр', async () => {
    const drafts = secretary.getByLabel('Черновик протокола');
    await expect(drafts).toHaveCount(3, { timeout: 30_000 });
    await expect(drafts.nth(0)).toContainText('Черновик протокола · случай 1 из 3');
    await expect(drafts.nth(1)).toContainText('A26-118737');
    await expect(doctor.getByLabel('Черновик протокола').first().getByRole('button', { name: 'Открыть протокол' })).toBeVisible();
    await expect(doctor.getByRole('button', { name: 'Проверить и принять' })).toHaveCount(0);
    if (SHOTS) await secretary.screenshot({ path: `${SHOTS}/consilium-room.png` });
  });

  await test.step('проверка рядом со стенограммой случая: без отметок «Проверено» принять нельзя', async () => {
    await secretary.getByLabel('Черновик протокола').first().getByRole('button', { name: 'Проверить и принять' }).click();
    const review = secretary.getByRole('dialog', { name: 'Протокол консилиума' });
    await expect(review).toContainText('Протокол консилиума · случай 1 из 3');
    await expect(review).toContainText('Проверено 0 из 5 разделов');
    const transcript = review.getByRole('complementary', { name: 'Стенограмма · случай 1' });
    await expect(transcript.locator('.transcript-lines li')).toHaveCount(3);
    await expect(transcript).toContainText('HER2 три плюс');
    await expect(transcript).not.toContainText('очаг в печени'); // реплика другого случая

    // Ссылка-время в утверждении показывает фрагмент стенограммы.
    await review.locator('.review-main .cite').first().click();
    await expect(transcript.locator('.transcript-lines li.on')).toHaveCount(1);
    await review.getByRole('button', { name: 'Принять в протокол МИС' }).click();
    await expect(review.getByRole('alert')).toContainText('Отметьте «Проверено» во всех разделах');

    for (const title of ['Цель', 'Клинические данные', 'Обсуждение', 'Решение', 'Особое мнение']) await review.getByLabel(`Проверено: ${title}`).check();
    await expect(review).toContainText('Проверено 5 из 5 разделов');
    if (SHOTS) await secretary.screenshot({ path: `${SHOTS}/consilium-review.png` });
    await review.getByRole('button', { name: 'Принять в протокол МИС' }).click();
    await expect(review.getByRole('status')).toContainText('Отправлено в МИС как черновик протокола · ожидает подписей 6 участников', { timeout: 20_000 });

    // Следующий случай — из повестки слева; у принятого — статус.
    await review.locator('.review-case').nth(1).click();
    await expect(review).toContainText('Протокол консилиума · случай 2 из 3');
    await expect(review.getByRole('complementary', { name: 'Стенограмма · случай 2' })).toContainText('очаг в печени');
    await expect(review.locator('.review-case').first()).toContainText('принят');
    await review.getByRole('button', { name: 'Закрыть' }).click();
    await expect(secretary.getByLabel('Черновик протокола').first()).toContainText('Принят');
  });

  await test.step('лечащий врач видит принятый протокол в чате случая', async () => {
    await doctor.goto(`/c/lis/${encodeURIComponent('Г26-04512')}`);
    const protocol = doctor.getByLabel('Протокол консилиума');
    await expect(protocol).toContainText('Протокол консилиума · принят', { timeout: 20_000 });
    await expect(protocol).toContainText('случай 1 из 3');
    await expect(protocol).toContainText('Принят: Петров С. В.');
  });

  await chair.getByRole('button', { name: 'Выйти из звонка' }).click();
});
