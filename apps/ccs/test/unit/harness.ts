import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { createHostMock, type HostMock } from '@konsilium/host-mock';
import type { Config } from '../../src/config.ts';
import { ConnectorRegistry } from '../../src/connectors.ts';
import { createService } from '../../src/index.ts';
import type { LlmClient } from '../../src/secretary.ts';
import { FakeMatrix } from './fakeMatrix.ts';

export const SERVER = 'konsilium.test';
export const HS_TOKEN = 'hs-token-for-tests-0001';
export const TOKENS = { lis: 'test-lis-token-0123456789', ris: 'test-ris-token-0123456789', lisCallback: 'test-lis-callback-0123456789' };
export const mx = (lp: string) => `@${lp}:${SERVER}`;
export const LIS_CASE = 'Г26-04512';
export const RIS_CASE = 'A26-118734';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const silent = { info() {}, warn() {}, error() {} };

export const testConfig: Config = {
  host: '127.0.0.1',
  port: 0,
  hsUrl: 'http://hs.invalid',
  serverName: SERVER,
  asToken: 'as-token-for-tests-0001',
  hsToken: HS_TOKEN,
  botUserId: mx('ccs'),
  asId: 'konsilium-ccs',
  aliasSecret: 'alias-secret-for-tests',
  connectorsFile: '-',
  chatWebUrl: 'https://chat.clinic.local',
  livekit: { url: 'ws://lk', apiKey: 'devkey', apiSecret: 'secret-secret-secret-secret-1234' },
  ai: { profile: 'off', secretaryUrl: null, secretaryToken: '', callbackUrl: 'http://ccs.test', asrUrl: null, llm: null },
};

export interface Harness {
  matrix: FakeMatrix;
  mock: HostMock;
  app: FastifyInstance;
  service: ReturnType<typeof createService>;
  open(user: string, body: Record<string, unknown>): Promise<LightMyRequestResponse>;
  /** Отправить события от имени подключения. */
  events(connector: 'lis' | 'ris', body: unknown, token?: string): Promise<LightMyRequestResponse>;
  /** Доставить событие Matrix в сервис, как это делает Synapse. */
  transaction(txnId: string, events: unknown[]): Promise<LightMyRequestResponse>;
  close(): Promise<void>;
}

/**
 * Стенд: поддельный Synapse в памяти, сервис контекста и песочница РИС/ЛИС на случайном порту.
 * ЛИС — подключение уровня 2 (с обратными вызовами), РИС — уровня 1 (только события).
 */
export async function setup(opts: { stepMs?: number; pushCases?: boolean; ai?: Partial<Config['ai']>; llm?: LlmClient | null } = {}): Promise<Harness> {
  const matrix = new FakeMatrix(mx('ccs'), SERVER);
  for (const u of ['smirnova', 'ershova', 'kolesnikov', 'gusev', 'outsider', 'orlov', 'belova', 'petrov']) matrix.tokens.set(`tok-${u}`, mx(u));

  let app: FastifyInstance | undefined;
  const mock = createHostMock({
    connectors: [
      { id: 'lis', token: TOKENS.lis, callbackToken: TOKENS.lisCallback },
      { id: 'ris', token: TOKENS.ris },
    ],
    stepMs: opts.stepMs ?? 0,
    deliver: async (c, events) => {
      const r = await app!.inject({
        method: 'POST',
        url: '/integration/v1/events',
        headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/cloudevents-batch+json' },
        payload: JSON.stringify(events),
      });
      return { status: r.statusCode, body: r.json() };
    },
  });
  await mock.app.listen({ host: '127.0.0.1', port: 0 });
  const port = (mock.app.server.address() as AddressInfo).port;

  const connectors = ConnectorRegistry.parse({
    connectors: [
      {
        id: 'lis',
        kind: 'LIS',
        org: 'clinic',
        title: 'ЛИС патоморфологии',
        token_sha256: sha256(TOKENS.lis),
        callbacks: { url: `http://127.0.0.1:${port}/lis`, token: TOKENS.lisCallback, timeout_ms: 2000 },
      },
      { id: 'ris', kind: 'RIS', org: 'clinic', title: 'РИС', token_sha256: sha256(TOKENS.ris) },
    ],
  });
  const config: Config = { ...testConfig, ai: { ...testConfig.ai, ...opts.ai } };
  const service = createService(config, { matrix, connectors, logger: false, log: silent, llm: opts.llm ?? null });
  app = service.app;
  if (opts.pushCases ?? true) await mock.pushCases();

  return {
    matrix,
    mock,
    app,
    service,
    open: (user, body) =>
      app.inject({ method: 'POST', url: '/api/v1/cases/open', headers: { authorization: `Bearer tok-${user}` }, payload: body }),
    events: (connector, body, token = TOKENS[connector]) =>
      app.inject({ method: 'POST', url: '/integration/v1/events', headers: { authorization: `Bearer ${token}` }, payload: body as object }),
    transaction: (txnId, events) =>
      app.inject({ method: 'PUT', url: `/_matrix/app/v1/transactions/${txnId}`, headers: { authorization: `Bearer ${HS_TOKEN}` }, payload: { events } }),
    close: async () => {
      await mock.app.close();
      await app.close();
    },
  };
}

export async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>, timeoutMs = 2000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error('Не дождались результата');
    await new Promise((r) => setTimeout(r, 10));
  }
}
