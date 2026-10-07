import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import { Direction, EventStatus, type MatrixClient, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { EventType, MsgType, RoomType, type CaseContext, type CaseRolesContent } from '@konsilium/protocol';
import {
  ageLabel,
  formatDay,
  formatDue,
  formatTime,
  membershipKind,
  membershipText,
  type MembershipKind,
  parseCaseContext,
  parseNotification,
  priorityLabel,
  requestViews,
  roleLabel,
  stageLabel,
  stepLabel,
  systemLabel,
  type RequestView,
  type TimelineItem,
} from '../model.ts';
import { toItem } from '../matrix.ts';
import { RoomAvatar } from './ChatList.tsx';
import { Icon } from './Icon.tsx';

const sexLabel: Record<string, string> = { F: 'Ж', M: 'М' };

/** Карточка случая над лентой: данные из РИС/ЛИС, ФИО скрыто. */
function CaseBar({ ctx }: { ctx: CaseContext }) {
  const patient = [ctx.patient.masked, ctx.patient.sex ? sexLabel[ctx.patient.sex] : null, ctx.patient.age !== undefined ? ageLabel(ctx.patient.age) : null]
    .filter(Boolean)
    .join(', ');
  const prio = ctx.priority ? priorityLabel[ctx.priority] : '';
  const sys = systemLabel[ctx.source] ?? ctx.source;
  return (
    <div className="casebar" aria-label="Карточка случая">
      <div className="casebar-main">
        <div className="casebar-title">
          <span className="mono">{ctx.case_id}</span>
          <span>{ctx.title}</span>
        </div>
        <div className="casebar-meta">
          <span title="Пациент (маска)">{patient}</span>
          {ctx.stage && <span>Этап: {stageLabel(ctx.stage)}</span>}
          {ctx.due && <span>{formatDue(ctx.due)}</span>}
        </div>
      </div>
      <div className="casebar-side">
        {ctx.status && ctx.status !== 'open' && <span className="chip closed">{ctx.status === 'closed' ? 'Закрыт' : 'Отменён'}</span>}
        {prio && <span className={`chip ${ctx.priority}`}>{prio}</span>}
        {ctx.links?.record && (
          <a className="ghost" href={ctx.links.record} target="_blank" rel="noopener noreferrer">
            Карточка в {sys} <Icon name="external" size={14} />
          </a>
        )}
        {ctx.links?.viewer && (
          <a className="ghost" href={ctx.links.viewer} target="_blank" rel="noopener noreferrer">
            Вьюер <Icon name="external" size={14} />
          </a>
        )}
      </div>
    </div>
  );
}

function RequestCard({ view }: { view: RequestView }) {
  const steps = view.steps.length ? view.steps : ['accepted' as const];
  const current = view.status ? steps.indexOf(view.status) : -1;
  return (
    <div className="request" aria-label="Заявка">
      <div className="request-title">{view.body}</div>
      <div className="request-meta">
        {view.externalId ? <span className="mono">{view.externalId}</span> : <span>Отправляется в систему-источник…</span>}
        {view.status && <span className={`chip ${view.status === 'rejected' ? 'cito' : view.status === 'done' ? 'done' : 'progress'}`}>{stepLabel(view.status)}</span>}
      </div>
      {view.status !== 'rejected' && (
        <ol className="steps">
          {steps.map((s, i) => (
            <li key={s} className={i < current ? 'done' : i === current ? 'current' : ''}>
              {stepLabel(s)}
            </li>
          ))}
        </ol>
      )}
      {view.note && <div className="request-note">{view.note}</div>}
    </div>
  );
}

function Notice({ item }: { item: TimelineItem }) {
  const info = parseNotification(item.content);
  const text = info?.links.length ? String(item.content.body).split('\n')[0] : String(item.content.body ?? '');
  return (
    <div className={`notice ${info?.category ?? 'info'}`}>
      <div>{text}</div>
      {info?.links.length ? (
        <div className="notice-links">
          {info.links.map((l) => (
            <a key={l.url} className="ghost" href={l.url} target="_blank" rel="noopener noreferrer">
              {l.label} <Icon name="external" size={14} />
            </a>
          ))}
        </div>
      ) : null}
      <span className="meta">{formatTime(item.ts)}</span>
    </div>
  );
}

function Composer({ client, room }: { client: MatrixClient; room: Room }) {
  const [text, setText] = useState('');
  const invited = room.getMyMembership() === 'invite';

  async function send() {
    const body = text.trim();
    if (!body) return;
    setText('');
    await client.sendTextMessage(room.roomId, body).catch(() => setText(body));
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  if (invited) {
    return (
      <div className="composer">
        <button className="primary wide" onClick={() => void client.joinRoom(room.roomId)}>
          Войти в чат
        </button>
      </div>
    );
  }
  return (
    <div className="composer">
      <textarea rows={1} placeholder="Сообщение" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} aria-label="Сообщение" />
      <button className="send" onClick={() => void send()} disabled={!text.trim()} aria-label="Отправить">
        <Icon name="send" />
      </button>
    </div>
  );
}

export function ChatView({ client, room, onBack }: { client: MatrixClient; room: Room; onBack: () => void }) {
  const me = client.getUserId()!;
  const events: MatrixEvent[] = room.getLiveTimeline().getEvents();
  const items = events.map(toItem);
  const requests = requestViews(items);
  const ctx = room.getType() === RoomType.Case ? parseCaseContext(room.currentState.getStateEvents(EventType.CaseContext, '')?.getContent()) : null;
  const roles = (room.currentState.getStateEvents(EventType.CaseRoles, '')?.getContent() as CaseRolesContent | undefined)?.members ?? {};
  const name = (userId: string) => room.getMember(userId)?.name ?? userId;
  const members = room.getJoinedMemberCount() + room.getInvitedMemberCount();

  // Прокрутка: держимся низа, если пользователь не листает историю.
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastId = items.at(-1)?.eventId;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lastId, items.length]);

  // Отметка о прочтении последнего события.
  useEffect(() => {
    const last = events.at(-1);
    if (last && last.getId()?.startsWith('$') && room.getMyMembership() === 'join' && document.visibilityState === 'visible') {
      void client.sendReadReceipt(last).catch(() => undefined);
    }
  }, [lastId]); // eslint-disable-line react-hooks/exhaustive-deps

  const [loadingOlder, setLoadingOlder] = useState(false);
  const canLoadOlder = room.getLiveTimeline().getPaginationToken(Direction.Backward) !== null;
  async function loadOlder() {
    setLoadingOlder(true);
    stick.current = false;
    await client.scrollback(room, 30).catch(() => undefined);
    setLoadingOlder(false);
  }

  let lastDay = '';
  let prevSender = '';
  const rows: ReactElement[] = [];
  // Подряд идущие однотипные изменения состава склеиваются в одну строку.
  let group: { kind: MembershipKind; names: string[]; key: string } | null = null;
  const flush = () => {
    if (group) rows.push(<div key={group.key} className="system-line">{membershipText(group.kind, group.names)}</div>);
    group = null;
  };
  items.forEach((e, i) => {
    const day = formatDay(e.ts);
    if (day !== lastDay) {
      flush();
      lastDay = day;
      prevSender = '';
      rows.push(
        <div key={`d${i}`} className="day">
          <span>{day}</span>
        </div>,
      );
    }
    if (e.type === 'm.room.member') {
      // Сервис контекста — создатель комнаты; его вход и выход не показываем.
      const kind = membershipKind(e, room.getCreator() ?? undefined);
      if (!kind) return;
      if (group?.kind !== kind) {
        flush();
        group = { kind, names: [], key: e.eventId };
      }
      group.names.push(name(e.stateKey!));
      prevSender = '';
      return;
    }
    if (e.type !== 'm.room.message') return;
    flush();
    if (e.content.msgtype === 'm.notice') {
      rows.push(<Notice key={e.eventId} item={e} />);
      prevSender = '';
      return;
    }
    const mine = e.sender === me;
    const first = e.sender !== prevSender;
    prevSender = e.sender;
    const role = roles[e.sender]?.role;
    const pending = events[i]?.status === EventStatus.SENDING || events[i]?.status === EventStatus.QUEUED;
    const request = e.content.msgtype === MsgType.Request ? requests.get(e.eventId) : undefined;
    rows.push(
      <div key={e.eventId} className={`msg ${mine ? 'out' : 'in'}${first ? ' first' : ''}`}>
        <div className="bubble">
          {!mine && first && (
            <div className="sender">
              {name(e.sender)}
              {role && <span className="role"> · {roleLabel(role)}</span>}
            </div>
          )}
          {request ? <RequestCard view={request} /> : <div className="text">{String(e.content.body ?? '')}</div>}
          <span className="meta">{pending ? 'отправка…' : formatTime(e.ts)}</span>
        </div>
      </div>,
    );
  });
  flush();

  return (
    <>
      <header className="chat-header">
        <button className="back" onClick={onBack} aria-label="К списку чатов">
          ‹
        </button>
        <RoomAvatar room={room} size="small" />
        <div>
          <div className="chat-title">{room.name}</div>
          <div className="chat-subtitle">
            {ctx ? `Чат случая · ${systemLabel[ctx.source] ?? ctx.source} · ` : ''}
            {members} {members % 10 === 1 && members % 100 !== 11 ? 'участник' : members % 10 >= 2 && members % 10 <= 4 && (members % 100 < 12 || members % 100 > 14) ? 'участника' : 'участников'}
          </div>
        </div>
      </header>
      {ctx && <CaseBar ctx={ctx} />}
      <div
        className="timeline"
        ref={scroller}
        onScroll={(ev) => {
          const el = ev.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {canLoadOlder && (
          <button className="ghost older" onClick={() => void loadOlder()} disabled={loadingOlder}>
            {loadingOlder ? 'Загрузка…' : 'Показать раньше'}
          </button>
        )}
        {rows}
      </div>
      <Composer client={client} room={room} />
    </>
  );
}
