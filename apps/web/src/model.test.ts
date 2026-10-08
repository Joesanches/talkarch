import { describe, expect, it } from 'vitest';
import { EventType, MsgType, RoomType } from '@konsilium/protocol';
import { avatarColor, caseCode, foldersOf, formatDay, initials, preview, requestViews, type TimelineItem } from './model.ts';

const item = (eventId: string, type: string, content: Record<string, unknown>, sender = '@smirnova:konsilium.test'): TimelineItem => ({
  eventId,
  type,
  sender,
  ts: 0,
  content,
});

describe('foldersOf', () => {
  it('раскладывает комнаты по папкам', () => {
    expect(foldersOf({ roomType: RoomType.Case, isDirect: false })).toEqual(['all', 'cases']);
    expect(foldersOf({ isDirect: true })).toEqual(['all', 'direct']);
    expect(foldersOf({ roomType: RoomType.Channel, isDirect: false })).toEqual(['all', 'channels']);
  });
});

describe('requestViews', () => {
  it('берёт последний статус заявки и шаги', () => {
    const items = [
      item('$r', 'm.room.message', { msgtype: MsgType.Request, body: 'Запрос ИГХ', [MsgType.Request]: { kind: 'ihc', items: ['ER'] } }),
      item('$s1', EventType.RequestStatus, { 'm.relates_to': { rel_type: 'm.reference', event_id: '$r' }, status: 'accepted', steps: ['accepted', 'staining', 'done'], external_id: 'ИГХ-1' }, '@ccs:x'),
      item('$s2', EventType.RequestStatus, { 'm.relates_to': { rel_type: 'm.reference', event_id: '$r' }, status: 'staining', steps: ['accepted', 'staining', 'done'], external_id: 'ИГХ-1' }, '@ccs:x'),
      item('$orphan', EventType.RequestStatus, { 'm.relates_to': { event_id: '$none' }, status: 'done' }, '@ccs:x'),
    ];
    const v = requestViews(items).get('$r')!;
    expect(v).toMatchObject({ kind: 'ihc', status: 'staining', externalId: 'ИГХ-1', steps: ['accepted', 'staining', 'done'] });
    expect(requestViews(items).size).toBe(1);
  });
});

describe('подписи', () => {
  it('код случая на аватаре', () => {
    expect(caseCode({ source: 'RIS', title: 'КТ-ангиопульмонография' })).toBe('КТ');
    expect(caseCode({ source: 'LIS', title: 'Биопсия', stage: 'ihc' })).toBe('ИГХ');
    expect(caseCode({ source: 'LIS', title: 'Биопсия' })).toBe('ГИСТ');
  });

  it('инициалы и стабильный цвет аватара', () => {
    expect(initials('Смирнова А. В.')).toBe('СА');
    expect(initials('@ershova')).toBe('E');
    expect(avatarColor('@a:x')).toBe(avatarColor('@a:x'));
  });

  it('превью последнего сообщения', () => {
    expect(preview(item('$1', 'm.room.message', { msgtype: 'm.text', body: 'Посмотрите блок 1А\nи 2Б' }), 'Смирнова А. В.', false)).toBe('Смирнова: Посмотрите блок 1А');
    expect(preview(item('$1', 'm.room.message', { msgtype: 'm.text', body: 'Да' }), 'x', true)).toBe('Вы: Да');
    expect(preview(item('$2', EventType.RequestStatus, { status: 'done', external_id: 'ИГХ-7' }), 'x', false)).toBe('Заявка ИГХ-7: готово');
  });

  it('день в ленте', () => {
    const now = new Date('2026-10-07T12:00:00+03:00').getTime();
    expect(formatDay(now - 3600_000, now)).toBe('Сегодня');
    expect(formatDay(now - 86_400_000, now)).toBe('Вчера');
  });
});

describe('ageLabel и membershipLine', () => {
  it('склоняет возраст', async () => {
    const { ageLabel } = await import('./model.ts');
    expect([1, 2, 5, 11, 12, 21, 54, 61, 67, 111, 112].map(ageLabel)).toEqual([
      '1 год', '2 года', '5 лет', '11 лет', '12 лет', '21 год', '54 года', '61 год', '67 лет', '111 лет', '112 лет',
    ]);
  });

  it('описывает изменения состава, скрывая сервисного пользователя', async () => {
    const { membershipKind, membershipText } = await import('./model.ts');
    const m = (sender: string, stateKey: string, membership: string) => ({ ...item('$m', 'm.room.member', { membership }, sender), stateKey });
    expect(membershipKind(m('@ccs:x', '@petrov:x', 'invite'), '@ccs:x')).toBe('invite');
    expect(membershipKind(m('@ccs:x', '@petrov:x', 'leave'), '@ccs:x')).toBe('revoked');
    expect(membershipKind(m('@petrov:x', '@petrov:x', 'leave'), '@ccs:x')).toBe('leave');
    expect(membershipKind(m('@ccs:x', '@ccs:x', 'join'), '@ccs:x')).toBeNull();
    expect(membershipText('invite', ['Смирнова А. В.', 'Ершова Т. Н.', 'Смирнова А. В.'])).toBe('Приглашение в чат: Смирнова А. В., Ершова Т. Н.');
  });
});

describe('reactionSummaries', () => {
  it('считает отметивших, порядок — как в наборе статусов, моя отметка снимаема', async () => {
    const { reactionSummaries } = await import('./model.ts');
    const r = (id: string, sender: string, target: string, key: string) => item(id, 'm.reaction', { 'm.relates_to': { rel_type: 'm.annotation', event_id: target, key } }, sender);
    const items = [
      r('$1', '@a:x', '$m', 'вопрос'),
      r('$2', '@b:x', '$m', 'принято'),
      r('$3', '@me:x', '$m', 'принято'),
      r('$4', '@me:x', '$m', 'принято'), // повтор той же отметки не удваивает счёт
      item('$5', 'm.reaction', {}, '@c:x'), // снятая (redacted) реакция без отношения
    ];
    expect(reactionSummaries(items, '@me:x').get('$m')).toEqual([
      { key: 'принято', label: 'Принято', count: 2, mine: '$4' },
      { key: 'вопрос', label: 'Вопрос', count: 1, mine: null },
    ]);
  });
});
