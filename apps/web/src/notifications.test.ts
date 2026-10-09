import { describe, expect, it } from 'vitest';
import { EventType, MsgType, type CriticalStatusContent } from '@konsilium/protocol';
import { GENERIC, criticalNotices, noticeText, timelineNotice } from './notifications.ts';
import type { TimelineItem } from './model.ts';

const me = '@kolesnikov:konsilium.test';
const other = '@smirnova:konsilium.test';
const opened = Date.parse('2026-10-09T10:00:00Z');
const at = (sec: number) => opened + sec * 1000;
const item = (type: string, content: Record<string, unknown>, ts = at(10), sender = other): TimelineItem => ({ eventId: '$e', type, sender, ts, content });

describe('уведомления браузера: события ленты', () => {
  it('чужое новое сообщение — да; своё, служебное, старое и находка из ленты — нет', () => {
    expect(timelineNotice(item('m.room.message', { msgtype: 'm.text', body: 'Блок 1А готов' }), me, opened, at(11))).toBe('message');
    expect(timelineNotice(item('m.room.message', { msgtype: 'm.text', body: 'моё' }, at(10), me), me, opened, at(11))).toBeNull();
    expect(timelineNotice(item('m.room.message', { msgtype: 'm.notice', body: 'Заявка: готово' }), me, opened, at(11))).toBeNull();
    // Сообщения до открытия вкладки приходят с первой синхронизацией — не уведомляем.
    expect(timelineNotice(item('m.room.message', { msgtype: 'm.text', body: 'до открытия' }, at(-5)), me, opened, at(11))).toBeNull();
    expect(timelineNotice(item('m.room.message', { msgtype: 'm.text', body: 'спали' }, at(10)), me, opened, at(10 + 600))).toBeNull();
    // Находка — по статусу: он есть и у приглашённого эскалацией, а сообщения в ленте у него нет.
    expect(timelineNotice(item('m.room.message', { msgtype: MsgType.Critical, body: 'КН' }), me, opened, at(11))).toBeNull();
    expect(timelineNotice(item(EventType.Call, { call_id: 'main' }), me, opened, at(11))).toBeNull();
  });

  it('вызов — пока он актуален', () => {
    const invite = item(EventType.CallInvite, { call_id: 'main', kind: 'direct', lifetime: 60_000 });
    expect(timelineNotice(invite, me, opened, at(30))).toBe('call');
    expect(timelineNotice(invite, me, opened, at(80))).toBeNull();
    expect(timelineNotice(item(EventType.CallInvite, { call_id: 'main' }), me, opened, at(11))).toBeNull();
  });
});

describe('уведомления браузера: критические находки', () => {
  const status = (extra: Partial<CriticalStatusContent>): CriticalStatusContent => ({
    status: 'pending',
    raised_at: new Date(at(5)).toISOString(),
    deadline_at: new Date(at(605)).toISOString(),
    recipients: [me],
    reported_by: other,
    escalations: [],
    ...extra,
  });

  it('адресат — с отправки; подключённый эскалацией — с эскалации; висевшие до открытия и подтверждённые — нет', () => {
    const statuses = new Map<string, CriticalStatusContent>([
      ['$new', status({})],
      ['$old', status({ raised_at: new Date(at(-900)).toISOString() })],
      ['$done', status({ status: 'acknowledged' })],
      ['$notmine', status({ recipients: [other] })],
      ['$escalated', status({ raised_at: new Date(at(-900)).toISOString(), escalations: [{ at: new Date(at(20)).toISOString(), action: 'notify', target: 'head', users: [me] }] })],
    ]);
    expect(criticalNotices(statuses, me, opened).sort()).toEqual(['$escalated', '$new']);
  });
});

describe('текст уведомления', () => {
  it('по умолчанию — без названия чата, отправителя и текста', () => {
    const ctx = { roomName: 'Г26-04512 · Биопсия', line: 'Смирнова: Блок 1А готов', caller: 'Смирнова А. В.' };
    expect(noticeText('message', 'none', ctx)).toEqual({ title: 'Консилиум', body: GENERIC.message });
    expect(noticeText('critical', 'none', ctx)).toEqual({ title: 'Консилиум', body: 'Критическая находка — требуется подтверждение' });
    expect(noticeText('call', 'none', ctx)).toEqual({ title: 'Консилиум', body: 'Входящий звонок' });
    expect(noticeText('message', 'full', ctx)).toEqual({ title: 'Г26-04512 · Биопсия', body: 'Смирнова: Блок 1А готов' });
    expect(noticeText('call', 'full', ctx)).toEqual({ title: 'Г26-04512 · Биопсия', body: 'Входящий звонок: Смирнова А. В.' });
  });
});
