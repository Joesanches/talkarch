import { describe, expect, it } from 'vitest';
import { PROTO, contextKey, envelope, isEnvelope } from '../src/protocol.ts';

describe('протокол встраивания', () => {
  it('конверт проходит проверку, чужие сообщения — нет', () => {
    const e = envelope('context.set', { connector: 'ris', caseId: 'A1' });
    expect(isEnvelope(e)).toBe(true);
    expect(e).toMatchObject({ proto: PROTO, v: 1, type: 'context.set' });
    expect(isEnvelope({ type: 'context.set' })).toBe(false);
    expect(isEnvelope({ ...e, v: 2 })).toBe(false);
    expect(isEnvelope(null)).toBe(false);
  });

  it('ответ ссылается на команду', () => {
    const cmd = envelope('room.open', {});
    expect(envelope('ack', {}, cmd.id).re).toBe(cmd.id);
    expect(envelope('ack', {}).id).not.toBe(cmd.id);
  });

  it('ключ контекста не зависит от регистра и пробелов номера', () => {
    expect(contextKey('ris', ' a26-118734 ')).toBe(contextKey('ris', 'A26-118734'));
  });
});
