import { describe, expect, it } from 'vitest';
import { CaseSnapshot, CloudEvent, IntegrationEventType, NotificationPosted, UserRef, eventDataSchemas } from '../src/integration.ts';

const snapshot = {
  case_id: 'Г26-04512',
  version: 3,
  title: 'Биопсия молочной железы, слева',
  patient: { ref: 'pseudo:7f3c9a1e', masked: 'Н*** О. В.', age: 54, sex: 'F' },
  participants: [{ user: { login: 'smirnova' }, role: 'pathologist' }],
  updated_at: '2026-10-07T09:12:00+03:00',
};

describe('UserRef', () => {
  it('требует хотя бы один идентификатор', () => {
    expect(UserRef.safeParse({ display_name: 'Смирнова А. В.' }).success).toBe(false);
    expect(UserRef.safeParse({ employee_id: '000123' }).success).toBe(true);
  });
});

describe('CaseSnapshot', () => {
  it('подставляет значения по умолчанию', () => {
    const s = CaseSnapshot.parse(snapshot);
    expect(s.status).toBe('open');
    expect(s.participants[0]?.role).toBe('pathologist');
  });

  it('не пропускает полное ФИО пациента', () => {
    const bad = { ...snapshot, patient: { ...snapshot.patient, full_name: 'Иванова Ольга' } };
    expect(CaseSnapshot.safeParse(bad).success).toBe(false);
  });

  it('проверяет Study Instance UID', () => {
    expect(CaseSnapshot.safeParse({ ...snapshot, study_instance_uid: '1.2.643.5.1' }).success).toBe(true);
    expect(CaseSnapshot.safeParse({ ...snapshot, study_instance_uid: '1.2.x' }).success).toBe(false);
  });
});

describe('CloudEvent', () => {
  it('принимает конверт CloudEvents 1.0 с расширениями', () => {
    const e = CloudEvent.parse({ specversion: '1.0', id: 'e1', source: 'lis', type: IntegrationEventType.CaseUpserted, data: snapshot, traceparent: '00-abc' });
    expect(eventDataSchemas[IntegrationEventType.CaseUpserted].parse(e.data).version).toBe(3);
  });

  it('отклоняет другую версию CloudEvents', () => {
    expect(CloudEvent.safeParse({ specversion: '0.3', id: 'e1', source: 'lis', type: 'x' }).success).toBe(false);
  });
});

describe('NotificationPosted', () => {
  it('по умолчанию не создаёт чат', () => {
    expect(NotificationPosted.parse({ case_id: 'X', text: 'Готово' })).toMatchObject({ ensure_chat: false, category: 'info', links: [] });
  });
});
