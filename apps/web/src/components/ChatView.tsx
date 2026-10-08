import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import { Direction, EventStatus, type MatrixClient, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { EventType, MsgType, RoomType, parseStructured, type CaseContext, type CaseRolesContent, type KeyImage, type TranscriptSegment } from '@konsilium/protocol';
import type { LinkOpen } from '@konsilium/embed/protocol';
import {
  ageLabel,
  formatDay,
  formatDue,
  formatTime,
  membershipKind,
  reactionSummaries,
  reportDecisions,
  REACTIONS,
  CRITICAL_REPORTER_ROLES,
  criticalWaitingFor,
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
import { activeCall, formatDuration } from '../call.ts';
import { config } from '../config.ts';
import { roomCriticals, toItem } from '../matrix.ts';
import { useAuthedMedia } from '../media.ts';
import { ProtocolDraftCard, TranscriptCard } from './AiCards.tsx';
import { CriticalBar, CriticalCard, CriticalForm } from './Critical.tsx';
import { RoomAvatar } from './ChatList.tsx';
import { RequestForm } from './RequestForm.tsx';
import { Icon } from './Icon.tsx';

const sexLabel: Record<string, string> = { F: 'Ж', M: 'М' };

/** Карточка случая над лентой: данные из РИС/ЛИС, ФИО скрыто. */
/** Ссылки: в отдельном клиенте — новая вкладка; во встроенном — событие link.open, решает хост. */
export type OpenLink = (link: LinkOpen) => void;
export const openInNewTab: OpenLink = (link) => {
  if ('url' in link) window.open(link.url, '_blank', 'noopener,noreferrer');
};

interface PatientDetails {
  display_name: string;
  birth_date?: string;
  mrn?: string;
}

/**
 * «Показать данные пациента»: сервис контекста спрашивает систему-источник (она проверяет права и пишет журнал).
 * Данные живут только в памяти этого компонента и скрываются через минуту.
 */
function PatientReveal({ client, roomId }: { client: MatrixClient; roomId: string }) {
  const [patient, setPatient] = useState<PatientDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!patient) return;
    const t = setTimeout(() => setPatient(null), 60_000);
    return () => clearTimeout(t);
  }, [patient]);

  async function reveal() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${config.ccsUrl}/api/v1/cases/patient`, {
        method: 'POST',
        headers: { authorization: `Bearer ${client.getAccessToken()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ roomId, reason: 'просмотр в чате случая' }),
        cache: 'no-store',
      });
      if (res.status === 501) throw new Error('Для этой системы раскрытие недоступно — откройте карточку в ней');
      if (res.status === 403) throw new Error('Нет доступа к данным пациента');
      if (!res.ok) throw new Error('Система-источник недоступна');
      setPatient(((await res.json()) as { patient: PatientDetails }).patient);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (patient) {
    const born = patient.birth_date ? new Date(patient.birth_date).toLocaleDateString('ru-RU') : null;
    return (
      <span className="patient-revealed" aria-live="polite">
        <b>{patient.display_name}</b>
        {born && <span>, {born}</span>}
        {patient.mrn && <span> · карта {patient.mrn}</span>}
        <button className="link" onClick={() => setPatient(null)}>
          Скрыть
        </button>
      </span>
    );
  }
  return (
    <>
      <button className="link" onClick={() => void reveal()} disabled={busy} title="Запрос записывается в журнал системы-источника">
        {busy ? 'Запрос…' : 'Показать'}
      </button>
      {error && <span className="reveal-error">{error}</span>}
    </>
  );
}

function CaseBar({ ctx, onOpenLink, client, roomId }: { ctx: CaseContext; onOpenLink: OpenLink; client: MatrixClient; roomId: string }) {
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
          <span title="Пациент (маска)">
            {patient} <PatientReveal key={roomId} client={client} roomId={roomId} />
          </span>
          {ctx.stage && <span>Этап: {stageLabel(ctx.stage)}</span>}
          {ctx.due && <span>{formatDue(ctx.due)}</span>}
        </div>
      </div>
      <div className="casebar-side">
        {ctx.status && ctx.status !== 'open' && <span className="chip closed">{ctx.status === 'closed' ? 'Закрыт' : 'Отменён'}</span>}
        {prio && <span className={`chip ${ctx.priority}`}>{prio}</span>}
        {ctx.links?.record && (
          <a
            className="ghost"
            href={ctx.links.record}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => {
              e.preventDefault();
              onOpenLink({ kind: 'record', url: ctx.links!.record! });
            }}
          >
            Карточка в {sys} <Icon name="external" size={14} />
          </a>
        )}
        {ctx.links?.viewer && (
          <a
            className="ghost"
            href={ctx.links.viewer}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => {
              e.preventDefault();
              onOpenLink({ kind: 'url', url: ctx.links!.viewer! });
            }}
          >
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

/** Ключевой снимок из вьюера: миниатюра, параметры, «Открыть во вьюере» (тот же кадр и окно). */
function KeyImageCard({ client, msg, onOpenLink }: { client: MatrixClient; msg: KeyImage; onOpenLink: OpenLink }) {
  const k = msg[MsgType.KeyImage];
  const src = useAuthedMedia(client, k.thumbnail);
  const meta = [`Серия …${k.series_uid.slice(-6)}`, `кадр ${k.frame}`, k.presentation ? `Ш/У ${k.presentation.ww}/${k.presentation.wc}` : null].filter(Boolean).join(' · ');
  return (
    <div className="key-image" aria-label="Ключевой снимок">
      <div className="key-image-thumb">{src ? <img src={src} alt={msg.body} /> : <span className="meta">Снимок</span>}</div>
      <div className="key-image-caption">{msg.body}</div>
      <div className="meta">{meta}</div>
      <button
        className="ghost"
        onClick={() =>
          onOpenLink(
            k.link
              ? { kind: 'url', url: k.link.url }
              : { kind: 'dicom', studyUid: k.study_uid, seriesUid: k.series_uid, sopUid: k.sop_uid, frame: k.frame, ...(k.presentation ? { presentation: k.presentation } : {}) },
          )
        }
      >
        Открыть во вьюере
      </button>
    </div>
  );
}

/** Кнопка «Отметить» у сообщения: пять реакций-статусов. */
function ReactionPicker({ onPick }: { onPick: (key: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="reaction-picker">
      <button className="reaction-toggle" aria-label="Отметить сообщение" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="check" size={16} />
      </button>
      {open && (
        <div className="reaction-menu" role="menu" onMouseLeave={() => setOpen(false)}>
          {REACTIONS.map((r) => (
            <button
              key={r.key}
              role="menuitem"
              className={`reaction ${r.key}`}
              onClick={() => {
                onPick(r.key);
                setOpen(false);
              }}
            >
              {r.label}
            </button>
          ))}
        </div>
      )}
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

function Composer({ client, room, requests, criticalRoles }: { client: MatrixClient; room: Room; requests: boolean; criticalRoles: Map<string, string[]> | null }) {
  const [text, setText] = useState('');
  const [form, setForm] = useState<'request' | 'critical' | null>(null);
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
    <div className="composer-wrap">
      {form === 'request' && <RequestForm client={client} roomId={room.roomId} onDone={() => setForm(null)} />}
      {form === 'critical' && criticalRoles && <CriticalForm client={client} roomId={room.roomId} roles={criticalRoles} onDone={() => setForm(null)} />}
      {!form && (requests || criticalRoles) && (
        <div className="quick-actions">
          {requests && (
            <button className="ghost" onClick={() => setForm('request')}>
              + Заявка в ЛИС
            </button>
          )}
          {criticalRoles && (
            <button className="ghost danger" onClick={() => setForm('critical')}>
              ! Критическая находка
            </button>
          )}
        </div>
      )}
    <div className="composer">
      <textarea id="composer-input" rows={1} placeholder="Сообщение" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} aria-label="Сообщение" />
      <button className="send" onClick={() => void send()} disabled={!text.trim()} aria-label="Отправить">
        <Icon name="send" />
      </button>
    </div>
    </div>
  );
}

export function ChatView({
  client,
  room,
  onBack,
  inCall,
  onCall,
  embedded = false,
  onOpenLink = openInNewTab,
}: {
  client: MatrixClient;
  room: Room;
  onBack: () => void;
  /** Встроен в РИС/ЛИС: без кнопки «назад», ссылки отдаются хосту. */
  embedded?: boolean;
  onOpenLink?: OpenLink;
  /** Пользователь уже в звонке этой комнаты. */
  inCall: boolean;
  onCall: (video: boolean) => void;
}) {
  const me = client.getUserId()!;
  const events: MatrixEvent[] = room.getLiveTimeline().getEvents();
  const items = events.map(toItem);
  const requests = requestViews(items);
  const reactions = reactionSummaries(items, me);
  const decisions = reportDecisions(items);
  // Стенограммы и черновики публикует только сервис (создатель комнаты): такие же сообщения от участников — обычный текст.
  const service = room.getCreator();
  const fromService = (e: { sender: string }) => !!service && e.sender === service;
  const transcripts = new Map<string, Map<number, TranscriptSegment>>();
  for (const e of items) {
    if (e.type !== 'm.room.message' || e.content.msgtype !== MsgType.Transcript || !fromService(e)) continue;
    const t = parseStructured(e.content);
    if (t?.msgtype === MsgType.Transcript) transcripts.set(e.eventId, new Map(t[MsgType.Transcript].segments.map((s) => [s.i, s])));
  }
  const react = (eventId: string, key: string) => {
    const mine = reactions.get(eventId)?.find((r) => r.key === key)?.mine;
    if (mine) void client.redactEvent(room.roomId, mine).catch(() => undefined);
    else void client.sendEvent(room.roomId, 'm.reaction' as never, { 'm.relates_to': { rel_type: 'm.annotation', event_id: eventId, key } } as never).catch(() => undefined);
  };
  const ctx = room.getType() === RoomType.Case ? parseCaseContext(room.currentState.getStateEvents(EventType.CaseContext, '')?.getContent()) : null;
  const roles = (room.currentState.getStateEvents(EventType.CaseRoles, '')?.getContent() as CaseRolesContent | undefined)?.members ?? {};
  const criticals = ctx ? roomCriticals(room) : new Map();
  const waiting = criticalWaitingFor(criticals, me).map((id) => {
    const content = room.findEventById(id)?.getContent();
    const parsed = content ? parseStructured(content) : null;
    return { eventId: id, finding: parsed?.msgtype === MsgType.Critical ? parsed[MsgType.Critical].finding : 'Откройте карточку в ленте', status: criticals.get(id)! };
  });
  // Кнопка «Критическая находка» — врачам-диагностам; адресаты — роли случая, кроме своей.
  const criticalRoles = (() => {
    if (!ctx || !CRITICAL_REPORTER_ROLES.has(roles[me]?.role ?? '')) return null;
    const byRole = new Map<string, string[]>();
    for (const [userId, a] of Object.entries(roles)) if (userId !== me) byRole.set(a.role, [...(byRole.get(a.role) ?? []), userId]);
    return byRole.size ? byRole : null;
  })();
  const name = (userId: string) => room.getMember(userId)?.name ?? userId;
  const members = room.getJoinedMemberCount() + room.getInvitedMemberCount();
  const joined = room.getMyMembership() === 'join';
  const call = activeCall(room);

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
    if (e.type === EventType.Call) {
      flush();
      prevSender = '';
      const startedAt = Date.parse(String(e.content.started_at ?? ''));
      const endedAt = Date.parse(String(e.content.ended_at ?? ''));
      const text = e.content.ended_at
        ? `Звонок завершён${Number.isFinite(startedAt) && Number.isFinite(endedAt) ? ` · ${formatDuration(endedAt - startedAt)}` : ''}`
        : `Звонок начат: ${name(String(e.content.started_by ?? e.sender))}`;
      rows.push(<div key={e.eventId} className="system-line">{text}</div>);
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
    const structured =
      e.content.msgtype === MsgType.KeyImage ||
      e.content.msgtype === MsgType.Critical ||
      ((e.content.msgtype === MsgType.Transcript || e.content.msgtype === MsgType.Report) && fromService(e))
        ? parseStructured(e.content)
        : null;
    const criticalMsg = structured?.msgtype === MsgType.Critical ? structured : null;
    const keyImage = structured?.msgtype === MsgType.KeyImage ? structured : null;
    const transcript = structured?.msgtype === MsgType.Transcript ? structured : null;
    const draft = structured?.msgtype === MsgType.Report && structured[MsgType.Report].kind === 'consilium_protocol' ? structured : null;
    rows.push(
      <div key={e.eventId} className={`msg ${mine ? 'out' : 'in'}${first ? ' first' : ''}`}>
        <div className={`bubble${transcript || draft || criticalMsg ? ' wide' : ''}`}>
          {!mine && first && (
            <div className="sender">
              {name(e.sender)}
              {role && <span className="role"> · {roleLabel(role)}</span>}
            </div>
          )}
          {request ? (
            <RequestCard view={request} />
          ) : keyImage ? (
            <KeyImageCard client={client} msg={keyImage} onOpenLink={onOpenLink} />
          ) : criticalMsg ? (
            <CriticalCard client={client} roomId={room.roomId} eventId={e.eventId} msg={criticalMsg} sender={e.sender} status={criticals.get(e.eventId)} me={me} name={name} />
          ) : transcript ? (
            <TranscriptCard msg={transcript} />
          ) : draft ? (
            <ProtocolDraftCard
              client={client}
              roomId={room.roomId}
              eventId={e.eventId}
              msg={draft}
              segments={transcripts.get(draft[MsgType.Report].transcript_event_id ?? '') ?? new Map()}
              decision={decisions.get(e.eventId)}
              canDecide={joined}
              name={name}
            />
          ) : (
            <div className="text">{String(e.content.body ?? '')}</div>
          )}
          <span className="meta">{pending ? 'отправка…' : formatTime(e.ts)}</span>
          {(reactions.get(e.eventId)?.length ?? 0) > 0 && (
            <div className="reactions">
              {reactions.get(e.eventId)!.map((r) => (
                <button key={r.key} className={`reaction ${r.key}${r.mine ? ' mine' : ''}`} onClick={() => react(e.eventId, r.key)} aria-pressed={!!r.mine} title={r.mine ? 'Снять отметку' : 'Отметить'}>
                  {r.label} <b>{r.count}</b>
                </button>
              ))}
            </div>
          )}
        </div>
        {!pending && joined && <ReactionPicker onPick={(key) => react(e.eventId, key)} />}
      </div>,
    );
  });
  flush();

  return (
    <>
      <header className="chat-header">
        {!embedded && (
          <button className="back" onClick={onBack} aria-label="К списку чатов">
            ‹
          </button>
        )}
        <RoomAvatar room={room} size="small" />
        <div>
          <div className="chat-title">{room.name}</div>
          <div className="chat-subtitle">
            {ctx ? `Чат случая · ${systemLabel[ctx.source] ?? ctx.source} · ` : ''}
            {members} {members % 10 === 1 && members % 100 !== 11 ? 'участник' : members % 10 >= 2 && members % 10 <= 4 && (members % 100 < 12 || members % 100 > 14) ? 'участника' : 'участников'}
          </div>
        </div>
        {joined && (
          <div className="chat-actions">
            <button className="icon-btn" onClick={() => onCall(false)} aria-label="Аудиозвонок" title="Аудиозвонок" disabled={inCall}>
              <Icon name="phone" />
            </button>
            <button className="icon-btn" onClick={() => onCall(true)} aria-label="Видеозвонок" title="Видеозвонок" disabled={inCall}>
              <Icon name="video" />
            </button>
          </div>
        )}
      </header>
      {ctx && <CaseBar ctx={ctx} onOpenLink={onOpenLink} client={client} roomId={room.roomId} />}
      {joined && <CriticalBar client={client} roomId={room.roomId} waiting={waiting} />}
      {call && !inCall && joined && (
        <div className="call-banner" role="status">
          <span className="callbar-dot" />
          <span>
            Идёт звонок · начат {formatTime(Date.parse(call.started_at))}, {name(call.started_by)}
            {call.transcription && ' · ведётся стенограмма (ИИ)'}
          </span>
          <button className="primary" onClick={() => onCall(false)}>
            Присоединиться
          </button>
        </div>
      )}
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
      <Composer client={client} room={room} requests={ctx?.source === 'LIS'} criticalRoles={criticalRoles} />
    </>
  );
}
