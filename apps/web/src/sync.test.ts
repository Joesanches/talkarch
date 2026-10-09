import { describe, expect, it } from 'vitest';
import { EventType, PREJOIN_STATE_KEY } from '@konsilium/protocol';
import { FIRST_WINDOW, LIST_REQUIRED_STATE, MAX_ROOMS, OPEN_ROOM, nextWindowEnd, withPrejoinState } from './sync.ts';

describe('окно списка Sliding Sync', () => {
  it('сначала 20 комнат, затем шагами по 100 до всех комнат', () => {
    let end = FIRST_WINDOW - 1;
    const steps: number[] = [];
    for (let next = nextWindowEnd(end, 257); next !== null; next = nextWindowEnd(end, 257)) steps.push((end = next));
    expect(steps).toEqual([119, 219, 256]);
  });

  it('комнат меньше окна — расширять нечего; больше предела — останавливаемся на нём', () => {
    expect(nextWindowEnd(FIRST_WINDOW - 1, 7)).toBeNull();
    expect(nextWindowEnd(FIRST_WINDOW - 1, 0)).toBeNull();
    let end = FIRST_WINDOW - 1;
    for (let next = nextWindowEnd(end, 5000); next !== null; next = nextWindowEnd(end, 5000)) end = next;
    expect(end).toBe(MAX_ROOMS - 1);
  });
});

describe('открытый чат', () => {
  it('состояние перечислено по типам: подстановку типа `*` поддерживает не каждый сервер', () => {
    expect(OPEN_ROOM.required_state?.some(([type]) => type === '*')).toBe(false);
    // Всё, что нужно строке списка, есть и у открытого чата (участники — целиком).
    const open = new Set(OPEN_ROOM.required_state?.map(([type]) => type));
    for (const [type] of LIST_REQUIRED_STATE) expect(open.has(type!)).toBe(true);
    for (const type of [EventType.CaseRoles, 'm.room.power_levels', 'm.room.encryption']) expect(open.has(type)).toBe(true);
  });
});

describe('приглашение со снимком состояния', () => {
  const me = '@orlov:konsilium.test';
  const bot = '@ccs:konsilium.test';
  const context = { type: EventType.CaseContext, state_key: '', content: { case_id: 'A26-118735' } };
  const invite = (content: Record<string, unknown>, stateKey = me) => ({ type: 'm.room.member', state_key: stateKey, sender: bot, content: { membership: 'invite', ...content } });

  it('дополняет приглашение контекстом случая из своего события приглашения — от имени пригласившего', () => {
    const state = [{ type: 'm.room.create', state_key: '', sender: bot, content: { type: 'ru.vendor.case' } }, invite({ [PREJOIN_STATE_KEY]: [context] })];
    expect(withPrejoinState(state, me)).toEqual([...state, { ...context, sender: bot }]);
  });

  it('присланное сервером не заменяет; чужие типы и чужие приглашения не берёт', () => {
    const server = { ...context, sender: bot, content: { case_id: 'с сервера' } };
    const spoof = { type: 'm.room.power_levels', state_key: '', content: { users_default: 100 } };
    const state = [server, invite({ [PREJOIN_STATE_KEY]: [context, spoof] })];
    expect(withPrejoinState(state, me)).toEqual(state);
    const other = [invite({ [PREJOIN_STATE_KEY]: [context] }, '@melnikova:konsilium.test')];
    expect(withPrejoinState(other, me)).toEqual(other);
    expect(withPrejoinState([invite({ [PREJOIN_STATE_KEY]: 'не массив' })], me)).toHaveLength(1);
  });
});
