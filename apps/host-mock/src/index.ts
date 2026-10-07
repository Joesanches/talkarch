import { createHostMock } from './mock.ts';

/**
 * Запуск песочницы: обратные вызовы на HOST_MOCK_PORT и отправка снимков случаев в сервис контекста.
 * Все значения по умолчанию — для окружения разработчика (apps/ccs/fixtures/connectors.json).
 */
const env = process.env;
const port = Number(env.HOST_MOCK_PORT ?? 8090);
const mock = createHostMock({
  ccsUrl: env.CCS_URL ?? 'http://localhost:8080',
  stepMs: Number(env.STEP_MS ?? 3000),
  logger: true,
  connectors: [
    { id: 'lis', token: env.LIS_TOKEN ?? 'dev-only-lis-token-0123456789abcdef', callbackToken: env.LIS_CALLBACK_TOKEN ?? 'dev-only-lis-callback-token-0123456789' },
    { id: 'ris', token: env.RIS_TOKEN ?? 'dev-only-ris-token-0123456789abcdef' },
  ],
});

await mock.app.listen({ host: env.HOST_MOCK_HOST ?? '127.0.0.1', port });

// Сервис контекста может стартовать позже — повторяем отправку, пока не ответит.
for (let attempt = 1; attempt <= 30; attempt++) {
  try {
    const results = await mock.pushCases();
    for (const [connector, r] of Object.entries(results)) {
      mock.app.log.info({ connector, status: r.status, results: r.body?.results }, 'Снимки случаев отправлены');
    }
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 2000));
  }
}
