import { expect, test, type Page } from '@playwright/test';
import { DEV_PASSWORD } from '@konsilium/host-mock/users';

const SSS = '/_matrix/client/unstable/org.matrix.simplified_msc3575/sync';

async function login(page: Page, path = '/') {
  const requests: string[] = [];
  page.on('request', (r) => requests.push(new URL(r.url()).pathname));
  await page.goto(path);
  await page.getByLabel('Логин').fill('smirnova');
  await page.getByLabel('Пароль').fill(DEV_PASSWORD);
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByRole('option').first()).toBeVisible();
  return { requests, firstScreenMs: Date.now() - t0 };
}

test('клиент синхронизируется через Simplified Sliding Sync; окно списка расширяется до всех чатов', async ({ page }) => {
  const { requests, firstScreenMs } = await login(page);
  test.info().annotations.push({ type: 'Первый экран списка', description: `${firstScreenMs} мс` });
  expect(requests.some((p) => p === SSS)).toBe(true);
  expect(requests.some((p) => p === '/_matrix/client/v3/sync')).toBe(false);

  // Окно растёт фоном: в списке оказываются все чаты, а не первые 20.
  const total = await page.evaluate(async () => {
    const s = JSON.parse(localStorage.getItem('konsilium.session')!) as { baseUrl: string; accessToken: string };
    const r = await fetch(`${s.baseUrl}/_matrix/client/v3/joined_rooms`, { headers: { authorization: `Bearer ${s.accessToken}` } });
    return ((await r.json()) as { joined_rooms: string[] }).joined_rooms.length;
  });
  test.skip(total <= 20, 'у пользователя не больше 20 чатов — расширять окно нечего');
  await expect.poll(async () => page.getByRole('option').count(), { timeout: 20_000 }).toBeGreaterThan(20);
});

test('запасной режим: ?sync=classic — обычная синхронизация', async ({ page }) => {
  const { requests } = await login(page, '/?sync=classic');
  expect(requests.some((p) => p === '/_matrix/client/v3/sync')).toBe(true);
  expect(requests.some((p) => p === SSS)).toBe(false);
});
