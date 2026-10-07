import { describe, expect, it } from 'vitest';
import { CaseContext, MsgType, caseKey, parseStructured, requestFallbackBody } from '../src/index.ts';

describe('caseKey', () => {
  it('нормализует регистр номера и организации', () => {
    expect(caseKey({ org: 'Clinic', system: 'LIS', caseId: ' г26-04512 ' })).toBe('clinic:LIS:Г26-04512');
    expect(caseKey({ org: 'clinic', system: 'LIS', caseId: 'Г26-04512' })).toBe('clinic:LIS:Г26-04512');
  });

  it('различает системы', () => {
    expect(caseKey({ org: 'c', system: 'RIS', caseId: 'X1' })).not.toBe(caseKey({ org: 'c', system: 'LIS', caseId: 'X1' }));
  });

  it('отклоняет пустой номер', () => {
    expect(() => caseKey({ org: 'c', system: 'RIS', caseId: '  ' })).toThrow();
  });
});

describe('CaseContext', () => {
  const base = {
    source: 'LIS',
    case_id: 'Г26-04512',
    title: 'Биопсия молочной железы, слева',
    patient: { ref: 'pseudo:7f3c9a1e', masked: 'Н*** О. В.', age: 54, sex: 'F' },
    sync: { version: 1, updated_at: '2026-10-06T11:02:13+03:00' },
  };

  it('принимает корректный контекст', () => {
    expect(CaseContext.parse(base).case_id).toBe('Г26-04512');
  });

  it('не пропускает лишние поля пациента (например, полное ФИО)', () => {
    expect(() => CaseContext.parse({ ...base, patient: { ...base.patient, full_name: 'Иванова Ольга' } })).toThrow();
  });
});

describe('parseStructured', () => {
  it('разбирает заявку и подставляет значения по умолчанию', () => {
    const msg = parseStructured({
      msgtype: MsgType.Request,
      body: 'Запрос ИГХ',
      [MsgType.Request]: { kind: 'ihc', block: '1А', items: ['ER', 'PR', 'HER2/neu', 'Ki-67'] },
    });
    expect(msg?.msgtype).toBe(MsgType.Request);
    if (msg?.msgtype === MsgType.Request) {
      expect(msg[MsgType.Request].priority).toBe('routine');
    }
  });

  it('возвращает null для обычного текста и для битых данных', () => {
    expect(parseStructured({ msgtype: 'm.text', body: 'привет' })).toBeNull();
    expect(parseStructured({ msgtype: MsgType.Request, body: 'x', [MsgType.Request]: { kind: 'unknown' } })).toBeNull();
  });
});

describe('requestFallbackBody', () => {
  it('формирует понятный текст для любых клиентов', () => {
    expect(
      requestFallbackBody({ kind: 'ihc', block: '1А', items: ['ER', 'PR'], priority: 'urgent' }),
    ).toBe('Запрос ИГХ: блок 1А — ER, PR (срочно)');
  });
});
