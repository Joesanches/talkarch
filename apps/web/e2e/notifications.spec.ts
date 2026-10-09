import { expect, test, type Browser, type Page } from '@playwright/test';
import { loginViaCaseLink } from './helpers.ts';

const CASE = 'Г26-04512';

type Note = { title: string; body: string; tag: string; requireInteraction: boolean; closed: boolean };

/**
 * Страница с подменённым Notification: уведомления записываются в window.__notes, разрешение — заданное.
 * Фокус вкладки — window.__focus (по умолчанию вкладка в фоне).
 */
async function pageWithNotifications(browser: Browser, permission: NotificationPermission): Promise<Page> {
  const context = await browser.newContext();
  await context.addInitScript((initial) => {
    const w = window as unknown as { __notes: unknown[]; __focus: boolean; Notification: unknown };
    w.__notes = [];
    w.__focus = false;
    class FakeNotification {
      static permission: NotificationPermission = initial;
      static async requestPermission() {
        FakeNotification.permission = 'granted';
        return 'granted' as const;
      }
      title: string;
      body?: string;
      tag?: string;
      requireInteraction: boolean;
      closed = false;
      onclick: (() => void) | null = null;
      constructor(title: string, opts?: NotificationOptions) {
        this.title = title;
        this.body = opts?.body;
        this.tag = opts?.tag;
        this.requireInteraction = !!opts?.requireInteraction;
        w.__notes.push(this);
      }
      close() {
        this.closed = true;
      }
    }
    w.Notification = FakeNotification;
    document.hasFocus = () => w.__focus;
  }, permission);
  return context.newPage();
}

const notes = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __notes: Note[] }).__notes.map(({ title, body, tag, requireInteraction, closed }) => ({ title, body, tag, requireInteraction, closed })),
  );
const setFocus = (page: Page, focus: boolean) => page.evaluate((f) => ((window as unknown as { __focus: boolean }).__focus = f), focus);

test('уведомления браузера: в фоне — сообщение без текста, критическая находка и звонок; в фокусе на этом чате — нет', async ({ browser }) => {
  test.setTimeout(90_000);
  const doctor = await (await browser.newContext()).newPage();
  const attending = await pageWithNotifications(browser, 'granted');
  await loginViaCaseLink(doctor, 'smirnova', 'lis', CASE);
  await loginViaCaseLink(attending, 'kolesnikov', 'lis', CASE);
  const tag = Date.now() % 100000;
  const say = async (text: string) => {
    await doctor.getByLabel('Сообщение', { exact: true }).fill(text);
    await doctor.keyboard.press('Enter');
    await expect(attending.locator('.msg').filter({ hasText: text })).toBeVisible();
  };

  await test.step('врач смотрит на этот чат — уведомления нет', async () => {
    await setFocus(attending, true);
    await say(`Видно в открытом чате ${tag}`);
    await attending.waitForTimeout(500);
    expect(await notes(attending)).toEqual([]);
  });

  await test.step('вкладка в фоне — «Новое сообщение», без названия чата, отправителя и текста', async () => {
    await setFocus(attending, false);
    await say(`Блок 1А готов, пациентка Н*** ${tag}`);
    await expect.poll(() => notes(attending)).toEqual([expect.objectContaining({ title: 'Консилиум', body: 'Новое сообщение', requireInteraction: false })]);
    expect(JSON.stringify(await notes(attending))).not.toMatch(/Блок|Н\*\*\*|Смирнова|Г26/);
  });

  await test.step('критическая находка лечащему врачу — уведомление, которое не исчезает само', async () => {
    await doctor.getByRole('button', { name: '! Критическая находка' }).click();
    const form = doctor.getByRole('form', { name: 'Критическая находка' });
    await form.getByLabel('Находка').fill(`Метастаз в лимфоузле (${tag})`);
    await form.getByRole('button', { name: 'Отправить находку' }).click();
    await expect
      .poll(async () => (await notes(attending)).filter((n) => n.body === 'Критическая находка — требуется подтверждение'))
      .toEqual([expect.objectContaining({ title: 'Консилиум', requireInteraction: true })]);
  });

  await test.step('звонок — «Входящий звонок»; щелчок по уведомлению открывает чат', async () => {
    await doctor.getByRole('button', { name: 'Аудиозвонок' }).click();
    await expect.poll(async () => (await notes(attending)).filter((n) => n.body === 'Входящий звонок')).toHaveLength(1);
    await attending.evaluate(() => {
      const list = (window as unknown as { __notes: Array<{ body: string; onclick: (() => void) | null }> }).__notes;
      list.find((n) => n.body === 'Входящий звонок')?.onclick?.();
    });
    expect((await notes(attending)).find((n) => n.body === 'Входящий звонок')?.closed).toBe(true);
    await expect(attending.getByLabel('Карточка случая')).toContainText(CASE);
    await doctor.getByRole('button', { name: 'Выйти из звонка' }).click();
  });

  // Порядок для следующих прогонов: находка подтверждена.
  await attending.getByRole('alert', { name: 'Критическая находка ждёт подтверждения' }).getByRole('button', { name: 'Подтверждаю получение' }).click();
});

test('приглашение включить уведомления: «Включить» спрашивает разрешение браузера, «Не сейчас» запоминается', async ({ browser }) => {
  const allow = await pageWithNotifications(browser, 'default');
  await loginViaCaseLink(allow, 'ershova', 'lis', CASE);
  const prompt = allow.getByRole('region', { name: 'Уведомления браузера' });
  await expect(prompt).toContainText('Включите уведомления');
  await prompt.getByRole('button', { name: 'Включить' }).click();
  await expect(prompt).toBeHidden();
  expect(await allow.evaluate(() => Notification.permission)).toBe('granted');

  const later = await pageWithNotifications(browser, 'default');
  await loginViaCaseLink(later, 'ershova', 'lis', CASE);
  await later.getByRole('region', { name: 'Уведомления браузера' }).getByRole('button', { name: 'Не сейчас' }).click();
  await later.reload();
  await expect(later.getByRole('listbox', { name: 'Чаты' }).getByRole('option').first()).toBeVisible();
  await expect(later.getByRole('region', { name: 'Уведомления браузера' })).toHaveCount(0);
});
