/**
 * Сверка контрактов OpenAPI с кодом: примеры проходят схемы, все пути реализованы.
 * Если тест упал — расходятся документация для других команд и реализация.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { z } from 'zod';
import {
  AccessCheckRequest,
  AccessCheckResponse,
  CaseSnapshot,
  ChatInfo,
  CloudEvent,
  ConsiliumProtocolRequest,
  ConsiliumProtocolResponse,
  CreateRequestRequest,
  CreateRequestResponse,
  CriticalFindingEvent,
  CriticalFindingsResponse,
  EventsResponse,
  PatientRevealRequest,
  PatientRevealResponse,
  eventDataSchemas,
  type IntegrationEventType,
} from '@konsilium/protocol/integration';
import { setup, type Harness } from './harness.ts';

type Spec = {
  paths: Record<string, Record<string, unknown>>;
  components: { examples: Record<string, { value: unknown }> };
};
const load = (name: string) => parse(readFileSync(resolve(import.meta.dirname, '../../openapi', name), 'utf8')) as Spec;
const integration = load('integration-v1.yaml');
const callbacks = load('host-callbacks-v1.yaml');

/** Событие проходит и конверт CloudEvents, и схему данных своего типа. */
function checkEvent(e: unknown) {
  const env = CloudEvent.parse(e);
  const schema = eventDataSchemas[env.type as IntegrationEventType];
  expect(schema, `тип ${env.type}`).toBeDefined();
  schema.parse(env.data);
}

const integrationExamples: Record<string, (v: unknown) => void> = {
  ConnectorInfo: (v) => expect(v).toMatchObject({ id: expect.any(String), level: expect.any(Number) }),
  CaseUpserted: checkEvent,
  RequestStatusChanged: checkEvent,
  NotificationPosted: checkEvent,
  CriticalRaised: checkEvent,
  ConsiliumUpserted: checkEvent,
  CriticalFindingsResponse: (v) => CriticalFindingsResponse.parse(v),
  Batch: (v) => (v as unknown[]).forEach(checkEvent),
  EventsResponse: (v) => EventsResponse.parse(v),
  ChatInfo: (v) => ChatInfo.parse(v),
  ChatInfoNone: (v) => ChatInfo.parse(v),
};

const callbackExamples: Record<string, z.ZodTypeAny> = {
  CaseSnapshot,
  AccessCheckRequest,
  AccessCheckResponse,
  CreateRequestRequest,
  CreateRequestResponse,
  PatientRevealRequest,
  PatientRevealResponse,
  CriticalFindingEvent,
  ConsiliumProtocolRequest,
  ConsiliumProtocolResponse,
};

const methods = ['get', 'put', 'post', 'delete', 'patch'] as const;
const operations = (spec: Spec) =>
  Object.entries(spec.paths).flatMap(([path, item]) =>
    methods.filter((m) => m in item).map((m) => ({ method: m.toUpperCase() as Uppercase<(typeof methods)[number]>, path: path.replace(/\{(\w+)\}/g, ':$1') })),
  );

describe('OpenAPI: примеры соответствуют схемам кода', () => {
  it('integration-v1.yaml', () => {
    expect(Object.keys(integration.components.examples).sort()).toEqual(Object.keys(integrationExamples).sort());
    for (const [name, check] of Object.entries(integrationExamples)) check(integration.components.examples[name]!.value);
  });

  it('host-callbacks-v1.yaml', () => {
    expect(Object.keys(callbacks.components.examples).sort()).toEqual(Object.keys(callbackExamples).sort());
    for (const [name, schema] of Object.entries(callbackExamples)) schema.parse(callbacks.components.examples[name]!.value);
  });
});

describe('OpenAPI: все пути реализованы', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await setup({ pushCases: false });
    await h.app.ready();
  });
  afterAll(async () => {
    await h.close();
  });

  it('сервис контекста реализует integration-v1.yaml', () => {
    for (const op of operations(integration)) {
      expect(h.app.hasRoute({ method: op.method, url: `/integration/v1${op.path}` }), `${op.method} ${op.path}`).toBe(true);
    }
  });

  it('песочница РИС/ЛИС реализует host-callbacks-v1.yaml', () => {
    for (const op of operations(callbacks)) {
      expect(h.mock.app.hasRoute({ method: op.method, url: `/:connector${op.path}` }), `${op.method} ${op.path}`).toBe(true);
    }
  });
});
