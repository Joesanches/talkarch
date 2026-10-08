import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { loginViaCaseLink } from './helpers.ts';

/**
 * ИИ-«Секретарь» целиком: два врача в звонке говорят (синтезированная речь вместо микрофона), стенограмма
 * распознаётся по дорожкам, черновик протокола готовит LLM в контуре. Нужен профиль ai из infra/:
 *   cd infra && docker compose --profile ai up -d && cd .. && E2E_AI=1 pnpm e2e secretary
 */
test.skip(!process.env.E2E_AI, 'нужен профиль ai (docker compose --profile ai up -d) и E2E_AI=1');
// Речь идёт в реальном времени, черновик на процессоре — до пары минут.
test.setTimeout(360_000);

const CASE = 'Г26-04512';
const SHOTS = process.env.E2E_SCREENSHOTS;
const speech = (name: string) => fileURLToPath(new URL(`./fixtures/${name}.wav`, import.meta.url));

test('стенограмма звонка и черновик протокола: индикатор у всех, реплики по говорящим, ссылки на стенограмму, принятие', async ({
  browser: base,
  launchOptions,
  baseURL,
}) => {
  const browsers: Browser[] = [];
  // У каждого участника свой браузер: тестовый микрофон Chromium читает свой файл с речью (по кругу).
  async function participant(user: string, voice: string): Promise<Page> {
    const browser = await base.browserType().launch({
      ...launchOptions,
      args: [...(launchOptions.args ?? []), `--use-file-for-fake-audio-capture=${speech(voice)}`],
    });
    browsers.push(browser);
    const ctx = await browser.newContext({ baseURL, locale: 'ru-RU', viewport: { width: 1360, height: 860 }, permissions: ['microphone', 'camera'] });
    const page = await ctx.newPage();
    await loginViaCaseLink(page, user, 'lis', CASE);
    return page;
  }

  try {
    const doctor = await participant('smirnova', 'speech-pathologist');
    const attending = await participant('kolesnikov', 'speech-attending');

    await test.step('оба в аудиозвонке', async () => {
      await doctor.getByRole('button', { name: 'Аудиозвонок' }).click();
      await expect(doctor.getByRole('region', { name: 'Звонок' }).locator('.call-status')).toContainText('1 участник', { timeout: 20_000 });
      await attending.getByRole('button', { name: 'Присоединиться' }).click();
      await expect(attending.getByRole('region', { name: 'Звонок' }).locator('.call-status')).toContainText('2 участника', { timeout: 20_000 });
    });

    await test.step('патоморфолог включает стенограмму — индикатор и уведомление у всех, агент не занимает плитку', async () => {
      const call = doctor.getByRole('region', { name: 'Звонок' });
      await call.getByRole('button', { name: 'Включить стенограмму (ИИ)' }).click();
      for (const page of [doctor, attending]) {
        await expect(page.getByRole('region', { name: 'Звонок' }).locator('.rec')).toHaveText('Стенограмма (ИИ)', { timeout: 20_000 });
        await expect(page.locator('.notice').filter({ hasText: 'Включена стенограмма звонка' }).last()).toBeVisible();
      }
      await expect(call.getByRole('button', { name: 'Остановить стенограмму' })).toBeVisible();
      await expect(call.locator('.call-status')).toContainText('2 участника');
      if (SHOTS) await doctor.screenshot({ path: `${SHOTS}/web-call-transcript.png` });
    });

    await test.step('разговор (каждая реплика звучит минимум дважды), затем «Остановить»', async () => {
      await doctor.waitForTimeout(25_000);
      await doctor.getByRole('button', { name: 'Остановить стенограмму' }).click();
      await expect(doctor.getByRole('region', { name: 'Звонок' }).getByRole('status').filter({ hasText: 'Стенограмма остановлена' })).toBeVisible();
      // Дальше работаем с лентой: звонок сворачивается в полосу и продолжается.
      for (const page of [doctor, attending]) await page.getByRole('button', { name: 'Свернуть звонок' }).click();
    });

    const transcript = doctor.getByLabel('Стенограмма звонка').last();
    await test.step('стенограмма в чате: реплики с именами говорящих, индикатор снят', async () => {
      await expect(transcript).toBeVisible({ timeout: 60_000 });
      const more = transcript.getByRole('button', { name: /Показать полностью/ });
      if (await more.count()) await more.click();
      await expect(transcript).toContainText('Смирнова А. В.');
      await expect(transcript).toContainText('рецепторы эстрогена положительные');
      await expect(transcript).toContainText('Колесников Д. А.');
      await expect(transcript).toContainText('гормональную терапию');
      await expect(doctor.getByRole('region', { name: 'Идущий звонок' }).locator('.rec')).toHaveCount(0, { timeout: 20_000 });
    });

    const draft = doctor.getByLabel('Черновик протокола').last();
    await test.step('черновик протокола: случай и состав из систем, ФИО скрыто, утверждения со ссылками на стенограмму', async () => {
      await expect(draft).toBeVisible({ timeout: 240_000 });
      await expect(draft).toContainText(CASE);
      await expect(draft).toContainText('Н*** О. В.');
      await expect(draft).not.toContainText('Нестерова');
      await expect(draft).toContainText('Смирнова А. В. (патоморфолог)');
      await expect(draft).toContainText('Колесников Д. А. (лечащий врач)');
      const ref = draft.locator('.ref').first();
      await ref.click();
      await expect(draft.locator('blockquote').first()).toContainText(/Смирнова А\. В\.|Колесников Д\. А\./);
      if (SHOTS) {
        await draft.scrollIntoViewIfNeeded();
        await doctor.screenshot({ path: `${SHOTS}/web-protocol-draft.png` });
      }
    });

    await test.step('лечащий врач принимает черновик — решение видят все', async () => {
      const theirs = attending.getByLabel('Черновик протокола').last();
      await theirs.getByRole('button', { name: 'Принять в протокол' }).click();
      for (const card of [theirs, draft]) {
        await expect(card.getByRole('status')).toContainText('Принят в протокол · Колесников Д. А.');
        await expect(card.getByRole('button', { name: 'Принять в протокол' })).toHaveCount(0);
      }
    });

    await test.step('звонок завершается', async () => {
      await attending.getByRole('region', { name: 'Идущий звонок' }).getByRole('button', { name: 'Завершить' }).click();
      await expect(doctor.getByRole('region', { name: 'Идущий звонок' })).toContainText('1 уч.', { timeout: 20_000 });
      await doctor.getByRole('region', { name: 'Идущий звонок' }).getByRole('button', { name: 'Завершить' }).click();
      await expect(doctor.locator('.system-line').filter({ hasText: 'Звонок завершён' }).last()).toBeVisible();
    });
  } finally {
    await Promise.all(browsers.map((b) => b.close()));
  }
});
