import { describe, expect, it } from 'vitest';
import { CaseContext, MsgType, caseKey, parseStructured, requestFallbackBody } from '../src/index.ts';

describe('caseKey', () => {
  it('нормализует регистр номера и пробелы', () => {
    expect(caseKey({ connector: 'lis', caseId: ' г26-04512 ' })).toBe('lis:Г26-04512');
    expect(caseKey({ connector: 'lis', caseId: 'Г26-04512' })).toBe('lis:Г26-04512');
  });

  it('различает подключения', () => {
    expect(caseKey({ connector: 'ris', caseId: 'X1' })).not.toBe(caseKey({ connector: 'ris-gkb2', caseId: 'X1' }));
  });

  it('отклоняет пустой номер и недопустимый идентификатор подключения', () => {
    expect(() => caseKey({ connector: 'ris', caseId: '  ' })).toThrow();
    expect(() => caseKey({ connector: 'РИС', caseId: 'X1' })).toThrow();
  });
});

describe('CaseContext', () => {
  const base = {
    source: 'LIS',
    connector: 'lis',
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

  it('стенограмма: время фрагментов — целые миллисекунды (в событиях Matrix дробные числа запрещены)', () => {
    const transcript = (start_ms: number) => ({
      msgtype: MsgType.Transcript,
      body: 'Стенограмма',
      [MsgType.Transcript]: {
        call_id: 'main',
        started_at: '2026-10-08T07:05:00Z',
        ended_at: '2026-10-08T07:17:00Z',
        segments: [{ i: 0, speaker: '@a:x', name: 'А', start_ms, end_ms: 9000, text: 'текст' }],
        asr: { engine: 'vosk', profile: 'cpu' },
      },
    });
    const ok = parseStructured(transcript(6500));
    expect(ok?.msgtype === MsgType.Transcript && ok[MsgType.Transcript].truncated).toBe(false);
    expect(parseStructured(transcript(6.5))).toBeNull();
  });

  it('черновик протокола: разделы по умолчанию пустые, случай может отсутствовать', () => {
    const msg = parseStructured({
      msgtype: MsgType.Report,
      body: 'ЧЕРНОВИК',
      [MsgType.Report]: {
        kind: 'consilium_protocol',
        status: 'draft',
        generated_by: 'template',
        meeting: { date: '08.10.2026', start: '10:05', end: '10:17', form: 'remote' },
        participants: [],
        case: null,
        sections: { decision: [{ text: 'Контроль через 3 месяца', refs: [2] }] },
      },
    });
    expect(msg?.msgtype === MsgType.Report && msg[MsgType.Report].sections.purpose).toEqual([]);
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
