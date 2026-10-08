import { useState } from 'react';
import { NotificationCountType, type MatrixClient, type Room } from 'matrix-js-sdk';
import { EventType, RoomType } from '@konsilium/protocol';
import { avatarColor, caseCode, criticalWaitingFor, formatListTime, initials, parseCaseContext, preview, priorityLabel } from '../model.ts';
import { roomArchived, roomCriticals, toItem } from '../matrix.ts';
import { Icon } from './Icon.tsx';

const kindColor: Record<string, string> = { LIS: 'var(--color-kind-pathology)', RIS: 'var(--color-kind-radiology)', TMK: 'var(--color-kind-consilium)' };

export function RoomAvatar({ room, size = 'normal' }: { room: Room; size?: 'normal' | 'small' }) {
  const ctx = parseCaseContext(room.currentState.getStateEvents(EventType.CaseContext, '')?.getContent());
  if (ctx) {
    return (
      <div className={`avatar case ${size}`} style={{ background: kindColor[ctx.source] }}>
        {caseCode(ctx)}
      </div>
    );
  }
  if (room.getType() === RoomType.Case) {
    // Приглашение: контекста случая в приглашении нет, только тип комнаты.
    return <div className={`avatar case ${size}`} style={{ background: 'var(--color-kind-saved)' }}>СЛ</div>;
  }
  return (
    <div className={`avatar person ${size}`} style={{ background: avatarColor(room.roomId) }}>
      {initials(room.name)}
    </div>
  );
}

function lastShown(room: Room) {
  const events = room.getLiveTimeline().getEvents();
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.getType() === 'm.room.message' || e.getType() === EventType.RequestStatus) return e;
  }
  return undefined;
}

export function ChatList(props: {
  client: MatrixClient;
  rooms: Room[];
  selected: string | null;
  onSelect: (room: Room) => void;
  loading: boolean;
  emptyHint: string;
}) {
  const [query, setQuery] = useState('');
  const me = props.client.getUserId();
  const q = query.trim().toLowerCase();
  const rooms = q ? props.rooms.filter((r) => r.name.toLowerCase().includes(q)) : props.rooms;

  return (
    <aside className="list">
      <div className="list-search">
        <Icon name="search" size={18} />
        <input placeholder="Поиск: номер случая, название" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Поиск чатов" />
      </div>
      <ul className="rooms" role="listbox" aria-label="Чаты">
        {props.loading && <li className="rooms-hint">Загрузка…</li>}
        {!props.loading && rooms.length === 0 && <li className="rooms-hint">{q ? 'Ничего не найдено' : props.emptyHint}</li>}
        {rooms.map((room) => {
          const ctx = parseCaseContext(room.currentState.getStateEvents(EventType.CaseContext, '')?.getContent());
          const last = lastShown(room);
          const item = last ? toItem(last) : undefined;
          const senderName = item ? (room.getMember(item.sender)?.name ?? item.sender) : '';
          const invite = room.getMyMembership() === 'invite';
          const unread = room.getUnreadNotificationCount(NotificationCountType.Total);
          const prio = ctx?.priority ? priorityLabel[ctx.priority] : '';
          const critical = ctx && me ? criticalWaitingFor(roomCriticals(room), me).length : 0;
          return (
            <li
              key={room.roomId}
              role="option"
              aria-selected={props.selected === room.roomId}
              className={`room${props.selected === room.roomId ? ' selected' : ''}${critical ? ' has-critical' : ''}`}
              onClick={() => props.onSelect(room)}
            >
              <RoomAvatar room={room} />
              <div className="room-body">
                <div className="room-top">
                  <span className="room-name">{invite && room.name.startsWith('@') && room.getType() === RoomType.Case ? 'Чат случая' : room.name}</span>
                  <span className="room-time">{last ? formatListTime(last.getTs()) : ''}</span>
                </div>
                <div className="room-bottom">
                  <span className="room-preview">{invite ? 'Приглашение в чат случая' : preview(item, senderName, item?.sender === me)}</span>
                  {critical > 0 && (
                    <b className="badge badge-critical" title="Критическая находка ждёт вашего подтверждения">
                      !
                    </b>
                  )}
                  {roomArchived(room) ? <span className="chip archived">Архив</span> : prio && <span className={`chip ${ctx?.priority}`}>{prio}</span>}
                  {(unread > 0 || invite) && <b className="badge">{invite ? 'новый' : unread}</b>}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
