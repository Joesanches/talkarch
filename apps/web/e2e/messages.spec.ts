import { crc32, deflateSync } from 'node:zlib';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { loginViaCaseLink } from './helpers.ts';

const SHOTS = process.env.E2E_SCREENSHOTS;
const CASE = 'Г26-04512';

async function userPage(browser: Browser) {
  return (await browser.newContext()).newPage();
}

/** PNG 64×48 — вымышленный «снимок препарата» (розовый фон, как окраска гематоксилином-эозином). */
function tinyPng(): Buffer {
  const [w, h] = [64, 48];
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([220, 120 + ((x + y) % 40), 180], y * (w * 3 + 1) + 1 + x * 3);
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8 бит, RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const message = (page: Page, text: string) => page.locator('.msg').filter({ hasText: text }).last();

test('ответ с цитатой, вложения и поиск по сообщениям в чате случая', async ({ browser }) => {
  test.setTimeout(90_000);
  const mark = `маркер${Date.now() % 100000}`;
  const question = `Ставим ИГХ на HER2 по блоку 1А? (${mark})`;
  const doctor = await userPage(browser);
  const attending = await userPage(browser);
  await loginViaCaseLink(doctor, 'smirnova', 'lis', CASE);
  await loginViaCaseLink(attending, 'kolesnikov', 'lis', CASE);

  await test.step('патоморфолог спрашивает, лечащий врач отвечает с цитатой', async () => {
    await doctor.getByRole('textbox', { name: 'Сообщение' }).fill(question);
    await doctor.getByRole('textbox', { name: 'Сообщение' }).press('Enter');
    const original = message(attending, question);
    await original.hover();
    await original.getByRole('button', { name: 'Ответить' }).click();
    await expect(attending.getByLabel('Ответ на сообщение')).toContainText(question);
    await attending.getByRole('textbox', { name: 'Сообщение' }).fill('Да, ставим — и Ki-67');
    await attending.getByRole('textbox', { name: 'Сообщение' }).press('Enter');
    await expect(attending.getByLabel('Ответ на сообщение')).toHaveCount(0);

    for (const page of [doctor, attending]) {
      const answer = message(page, 'Да, ставим — и Ki-67');
      await expect(answer.locator('.quote')).toContainText('Смирнова');
      await expect(answer.locator('.quote')).toContainText(question);
    }
    // Цитата ведёт к исходному сообщению.
    await message(doctor, 'Да, ставим — и Ki-67').locator('.quote').click();
    await expect(doctor.locator('.msg.highlight')).toContainText(question);
  });

  await test.step('изображение и документ: превью у собеседника, просмотр и скачивание', async () => {
    await doctor.getByLabel('Файлы для отправки').setInputFiles([
      { name: 'препарат-1А.png', mimeType: 'image/png', buffer: tinyPng() },
      { name: 'заключение.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% вымышленный документ\n%%EOF\n') },
    ]);
    const image = attending.getByRole('button', { name: 'Изображение препарат-1А.png' });
    await expect(image.locator('img')).toBeVisible({ timeout: 15_000 });
    await image.click();
    await expect(attending.getByRole('dialog', { name: 'препарат-1А.png' }).locator('img')).toBeVisible();
    if (SHOTS) await attending.screenshot({ path: `${SHOTS}/attachment-image.png` });
    await attending.keyboard.press('Escape');
    await expect(attending.getByRole('dialog')).toHaveCount(0);

    const file = attending.getByLabel('Файл заключение.pdf');
    await expect(file).toContainText(/\d+ Б/);
    const [download] = await Promise.all([attending.waitForEvent('download'), file.getByRole('button', { name: 'Скачать' }).click()]);
    expect(download.suggestedFilename()).toBe('заключение.pdf');
  });

  await test.step('исполняемый файл не отправляется', async () => {
    await doctor.getByLabel('Файлы для отправки').setInputFiles({ name: 'viewer.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ') });
    await expect(doctor.getByLabel('Загрузка файлов').getByRole('alert')).toContainText('исполняемые файлы');
    await expect(message(attending, 'viewer.exe')).toHaveCount(0);
  });

  await test.step('поиск по сообщениям: результат с подсветкой, переход к сообщению', async () => {
    await attending.getByLabel('Поиск чатов').fill(mark);
    const hit = attending.locator('.search-hit').filter({ hasText: mark });
    await expect(hit).toHaveCount(1, { timeout: 15_000 });
    await expect(hit.locator('mark')).toContainText(mark);
    if (SHOTS) await attending.screenshot({ path: `${SHOTS}/search.png` });
    await hit.click();
    await expect(attending.locator('.msg.highlight')).toContainText(question);
  });
});
