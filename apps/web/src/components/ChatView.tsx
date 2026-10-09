import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import { Direction, EventStatus, type MatrixClient, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { EventType, MsgType, RoomType, parseStructured, type CaseContext, type CaseRolesContent, type KeyImage, type SlideRoi, type TranscriptSegment } from '@konsilium/protocol';
import type { LinkOpen } from '@konsilium/embed/protocol';
import {
  firstUnreadIndex,
  typingText,
  attachmentProblem,
  formatSize,
  quoteText,
  replyTarget,
  stripReplyFallback,
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
import { closeArchived, roomArchived, roomCriticals, toItem, unreadCount } from '../matrix.ts';
import { downloadMedia, maxUploadBytes, sendAttachment, useAuthedMedia } from '../media.ts';
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

function CaseBar({ ctx, onOpenLink, client, roomId, archived }: { ctx: CaseContext; onOpenLink: OpenLink; client: MatrixClient; roomId: string; archived: boolean }) {
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
        {archived && <span className="chip archived">Архив</span>}
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

/**
 * Препарат из ЛИС: миниатюра области, стекло, блок, окраска, увеличение. «Открыть во вьюере» — во встроенном режиме
 * решает ЛИС (своё окно цифровой патологии), иначе — по ссылке вьюера, если она есть.
 */
function SlideRoiCard({ client, msg, onOpenLink, embedded }: { client: MatrixClient; msg: SlideRoi; onOpenLink: OpenLink; embedded: boolean }) {
  const s = msg[MsgType.SlideRoi];
  const src = useAuthedMedia(client, s.thumbnail, { w: 320, h: 320 });
  const title = `Стекло ${s.slide_id}${s.block ? ` · блок ${s.block}` : ''}`;
  const meta = [s.stain, `×${s.magnification}`, s.region ? 'область' : 'всё стекло'].join(' · ');
  const canOpen = embedded || !!s.link;
  return (
    <div className="slide-roi" aria-label="Препарат">
      <div className="slide-roi-thumb">{src ? <img src={src} alt={title} /> : <span className="meta">Препарат</span>}</div>
      <div className="slide-roi-body">
        <div className="slide-roi-title">{title}</div>
        <div className="meta">{meta}</div>
        {msg.body && !msg.body.startsWith('Стекло ') && <div className="slide-roi-caption">{msg.body}</div>}
        {canOpen && (
          <button
            className="ghost"
            onClick={() =>
              onOpenLink(
                embedded || !s.link
                  ? { kind: 'slide', slideId: s.slide_id, stain: s.stain, magnification: s.magnification, region: s.region ?? { x: 0, y: 0, w: 1, h: 1, level: 0 } }
                  : { kind: 'url', url: s.link.url },
              )
            }
          >
            Открыть во вьюере
          </button>
        )}
      </div>
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

/**
 * Архивный чат вместо поля ввода: только чтение. «Убрать из списка» — выйти и забыть комнату; история остаётся
 * в архиве, вернуться можно из папки «Архив» (иначе сервис сам выведет пользователя через сутки).
 */
function ArchivedBar({ client, room, onClosed, canClose }: { client: MatrixClient; room: Room; onClosed: () => void; canClose: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="composer archived-bar" role="status">
      <Icon name="archive" size={18} />
      <span>Случай в архиве — чат только для чтения</span>
      {canClose && room.getMyMembership() === 'join' && (
        <button
          className="ghost"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void closeArchived(client, room.roomId).then(onClosed, () => setBusy(false));
          }}
        >
          Убрать из списка
        </button>
      )}
    </div>
  );
}

/** Загрузка вложения в ленте над полем ввода. */
export interface Upload {
  id: number;
  name: string;
  pct: number;
  error?: string;
}

function Composer({
  client,
  room,
  requests,
  criticalRoles,
  reply,
  onCancelReply,
  onFiles,
  uploads,
  onDismissUpload,
}: {
  client: MatrixClient;
  room: Room;
  requests: boolean;
  criticalRoles: Map<string, string[]> | null;
  /** Ответ на сообщение: автор и текст цитаты. */
  reply: { eventId: string; sender: string; name: string; text: string } | null;
  onCancelReply: () => void;
  onFiles: (files: File[]) => void;
  uploads: Upload[];
  onDismissUpload: (id: number) => void;
}) {
  const [text, setText] = useState('');
  const [form, setForm] = useState<'request' | 'critical' | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const invited = room.getMyMembership() === 'invite';
  useEffect(() => {
    if (reply) input.current?.focus();
  }, [reply]);

  // «Печатает…» для собеседников: не чаще раза в 4 с, пока есть текст; стёр текст или отправил — перестал.
  const typingSent = useRef(0);
  function typing(on: boolean) {
    const now = Date.now();
    if (on && now - typingSent.current < 4000) return;
    if (!on && !typingSent.current) return;
    typingSent.current = on ? now : 0;
    void client.sendTyping(room.roomId, on, on ? 6000 : 0).catch(() => undefined);
  }

  async function send() {
    const body = text.trim();
    if (!body) return;
    setText('');
    typing(false);
    const target = reply;
    onCancelReply();
    // Ответ: ссылка на исходное сообщение и упоминание его автора (уведомление), без цитаты в тексте (Matrix 1.13).
    const content = {
      msgtype: 'm.text',
      body,
      ...(target ? { 'm.relates_to': { 'm.in_reply_to': { event_id: target.eventId } } } : {}),
      ...(target && target.sender !== client.getUserId() ? { 'm.mentions': { user_ids: [target.sender] } } : {}),
    };
    await client.sendMessage(room.roomId, content as never).catch(() => setText(body));
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
    if (e.key === 'Escape' && reply) onCancelReply();
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
      {uploads.length > 0 && (
        <ul className="uploads" aria-label="Загрузка файлов">
          {uploads.map((u) => (
            <li key={u.id} className={u.error ? 'error' : ''}>
              <Icon name="attach" size={16} />
              <span className="upload-name">{u.name}</span>
              {u.error ? <span role="alert">{u.error}</span> : <span className="meta">{u.pct}%</span>}
              {u.error && (
                <button className="link" onClick={() => onDismissUpload(u.id)} aria-label="Скрыть">
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {reply && (
        <div className="reply-bar" aria-label="Ответ на сообщение">
          <div className="quote">
            <b>
              <Icon name="reply" size={14} />
              {reply.name}
            </b>
            <span>{reply.text}</span>
          </div>
          <button className="link" onClick={onCancelReply} aria-label="Отменить ответ">
            ×
          </button>
        </div>
      )}
      <div className="composer">
        <button className="icon-btn" onClick={() => fileInput.current?.click()} aria-label="Прикрепить файл" title="Прикрепить файл">
          <Icon name="attach" />
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          aria-label="Файлы для отправки"
          onChange={(e) => {
            onFiles([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
        <textarea
          ref={input}
          id="composer-input"
          rows={1}
          placeholder={reply ? 'Ответ' : 'Сообщение'}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            typing(!!e.target.value.trim());
          }}
          onBlur={() => typing(false)}
          onKeyDown={onKey}
          onPaste={(e) => {
            // Снимок экрана из буфера обмена — вложением.
            const files = [...e.clipboardData.files];
            if (files.length) {
              e.preventDefault();
              onFiles(files);
            }
          }}
          aria-label="Сообщение"
        />
        <button className="send" onClick={() => void send()} disabled={!text.trim()} aria-label="Отправить">
          <Icon name="send" />
        </button>
      </div>
    </div>
  );
}

/** Цитата в пузыре ответа: автор и начало исходного сообщения; нажатие — к исходному сообщению. */
function Quote({ name, text, onJump }: { name: string; text: string; onJump: () => void }) {
  return (
    <button className="quote" onClick={onJump} title="К исходному сообщению">
      <b>
        <Icon name="reply" size={14} />
        {name}
      </b>
      <span>{text}</span>
    </button>
  );
}

interface MediaContent {
  body?: string;
  filename?: string;
  url?: string;
  info?: { mimetype?: string; size?: number; w?: number; h?: number };
}

/** Изображение: миниатюра от сервера; нажатие — исходный файл во весь экран. */
function ImageAttachment({ client, content }: { client: MatrixClient; content: MediaContent }) {
  const [open, setOpen] = useState(false);
  const thumb = useAuthedMedia(client, content.url, { w: 640, h: 480 });
  const name = content.filename ?? content.body ?? 'изображение';
  const ratio = content.info?.w && content.info?.h ? `${content.info.w} / ${content.info.h}` : '4 / 3';
  return (
    <>
      <button className="image-attachment" style={{ aspectRatio: ratio }} onClick={() => setOpen(true)} aria-label={`Изображение ${name}`}>
        {thumb ? <img src={thumb} alt={name} /> : <span className="meta">Загрузка…</span>}
      </button>
      {open && <Lightbox client={client} content={content} name={name} onClose={() => setOpen(false)} />}
    </>
  );
}

function Lightbox({ client, content, name, onClose }: { client: MatrixClient; content: MediaContent; name: string; onClose: () => void }) {
  const full = useAuthedMedia(client, content.url, null);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="lightbox" role="dialog" aria-label={name} onClick={onClose}>
      {full ? <img src={full} alt={name} /> : <span>Загрузка…</span>}
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span>{name}</span>
        {content.url && (
          <button className="ghost" onClick={() => void downloadMedia(client, content.url!, name)}>
            Скачать
          </button>
        )}
        <button className="ghost" onClick={onClose}>
          Закрыть
        </button>
      </div>
    </div>
  );
}

/** Файл: имя, размер, «Скачать». */
function FileAttachment({ client, content }: { client: MatrixClient; content: MediaContent }) {
  const [error, setError] = useState<string | null>(null);
  const name = content.filename ?? content.body ?? 'файл';
  return (
    <div className="file-attachment" aria-label={`Файл ${name}`}>
      <Icon name="file" />
      <div>
        <div className="file-name">{name}</div>
        <div className="meta">
          {content.info?.size !== undefined ? formatSize(content.info.size) : ''}
          {error && <span className="reveal-error"> {error}</span>}
        </div>
      </div>
      {content.url && (
        <button className="ghost" onClick={() => downloadMedia(client, content.url!, name).catch((e: Error) => setError(e.message))}>
          Скачать
        </button>
      )}
    </div>
  );
}

export function ChatView({
  client,
  room,
  onBack,
  onClosed = onBack,
  inCall,
  onCall,
  embedded = false,
  onOpenLink = openInNewTab,
  focusEventId = null,
  active = true,
  compact = false,
  onMinimize,
  fullUrl,
}: {
  client: MatrixClient;
  room: Room;
  onBack: () => void;
  /** Чат на экране. Свёрнутый (окно launcher во встроенном режиме) не отмечает сообщения прочитанными. */
  active?: boolean;
  /** Узкое окно поверх страницы хоста: без карточки случая — хост её уже показывает. */
  compact?: boolean;
  /** Кнопка «Свернуть» в заголовке (launcher). */
  onMinimize?: () => void;
  /** Кнопка «Открыть в полном окне» — адрес чата в отдельном клиенте. */
  fullUrl?: string;
  /** Показать это сообщение (результат поиска): прокрутить к нему и подсветить. */
  focusEventId?: string | null;
  /** Архивный чат убран из списка. */
  onClosed?: () => void;
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
  // Архивный чат — только чтение: ни сообщений, ни отметок, ни звонков (сервер тоже не примет).
  const archived = roomArchived(room);
  const joined = room.getMyMembership() === 'join';
  const writable = joined && !archived;
  const call = activeCall(room);

  // Разделитель «Непрочитанные сообщения»: отметка о прочтении запоминается каждый раз, когда чат появляется на экране
  // (до того, как он отметит новые сообщения прочитанными), и не двигается, пока он открыт.
  const readMark = () => ({ readUpTo: room.getEventReadUpTo(me), unread: unreadCount(room) });
  const [mark, setMark] = useState<{ readUpTo: string | null; unread: number } | null>(() => (active ? readMark() : null));
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) setMark(readMark());
    wasActive.current = active;
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  const unreadAt = mark ? firstUnreadIndex(items, me, mark.readUpTo, mark.unread) : null;

  const typingNow = typingText(
    room
      .getMembers()
      .filter((m) => m.typing && m.userId !== me)
      .map((m) => m.name),
  );

  // Ответы: исходные сообщения, которых нет в загруженной ленте, запрашиваются у сервера.
  const byId = new Map(items.map((e) => [e.eventId, e]));
  const [fetched, setFetched] = useState<Map<string, TimelineItem | null>>(new Map());
  const missing = [...new Set(items.map((e) => replyTarget(e.content)).filter((id): id is string => !!id && !byId.has(id) && !fetched.has(id)))];
  useEffect(() => {
    for (const id of missing) {
      setFetched((m) => new Map(m).set(id, null));
      client
        .fetchRoomEvent(room.roomId, id)
        .then((raw) =>
          setFetched((m) =>
            new Map(m).set(id, { eventId: id, type: raw.type ?? '', sender: raw.sender ?? '', ts: raw.origin_server_ts ?? 0, content: (raw.content ?? {}) as Record<string, unknown> }),
          ),
        )
        .catch(() => undefined);
    }
  }, [missing.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const original = (id: string) => byId.get(id) ?? fetched.get(id) ?? undefined;

  const [replyTo, setReplyTo] = useState<string | null>(null);
  const replyItem = replyTo ? original(replyTo) : undefined;
  const reply = replyTo && replyItem ? { eventId: replyTo, sender: replyItem.sender, name: name(replyItem.sender), text: quoteText(replyItem) } : null;

  // Вложения: проверка, загрузка с прогрессом, отправка. Ошибки остаются в списке, пока их не скроют.
  const [uploads, setUploads] = useState<Upload[]>([]);
  const uploadSeq = useRef(0);
  async function attach(files: File[]) {
    const limit = await maxUploadBytes(client);
    const target = replyTo;
    if (files.length) setReplyTo(null);
    for (const file of files) {
      const id = ++uploadSeq.current;
      const problem = attachmentProblem(file, limit);
      setUploads((u) => [...u, { id, name: file.name, pct: 0, ...(problem ? { error: problem } : {}) }]);
      if (problem) continue;
      try {
        await sendAttachment(client, room.roomId, file, {
          replyTo: target,
          onProgress: (pct) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, pct } : x))),
        });
        setUploads((u) => u.filter((x) => x.id !== id));
      } catch (e) {
        setUploads((u) => u.map((x) => (x.id === id ? { ...x, error: `«${file.name}» не отправлен: ${(e as Error).message}` } : x)));
      }
    }
  }

  // Переход к сообщению (цитата, результат поиска): если его нет в ленте — догружаем историю.
  const [highlight, setHighlight] = useState<string | null>(null);
  async function jumpTo(eventId: string) {
    stick.current = false;
    for (let i = 0; i < 10 && !document.getElementById(`ev-${eventId}`); i++) {
      if (room.getLiveTimeline().getPaginationToken(Direction.Backward) === null) break;
      await client.scrollback(room, 50).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 100));
    }
    const el = document.getElementById(`ev-${eventId}`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    setHighlight(eventId);
    setTimeout(() => setHighlight((h) => (h === eventId ? null : h)), 2500);
  }
  useEffect(() => {
    if (focusEventId) void jumpTo(focusEventId);
  }, [focusEventId]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (active && last && last.getId()?.startsWith('$') && room.getMyMembership() === 'join' && document.visibilityState === 'visible') {
      void client.sendReadReceipt(last).catch(() => undefined);
    }
  }, [lastId, active]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (i === unreadAt) {
      flush();
      prevSender = '';
      rows.push(
        <div key="unread" className="unread-divider" role="separator">
          <span>Непрочитанные сообщения</span>
        </div>,
      );
    }
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
      e.content.msgtype === MsgType.SlideRoi ||
      e.content.msgtype === MsgType.Critical ||
      ((e.content.msgtype === MsgType.Transcript || e.content.msgtype === MsgType.Report) && fromService(e))
        ? parseStructured(e.content)
        : null;
    const criticalMsg = structured?.msgtype === MsgType.Critical ? structured : null;
    const keyImage = structured?.msgtype === MsgType.KeyImage ? structured : null;
    const slide = structured?.msgtype === MsgType.SlideRoi ? structured : null;
    const transcript = structured?.msgtype === MsgType.Transcript ? structured : null;
    const draft = structured?.msgtype === MsgType.Report && structured[MsgType.Report].kind === 'consilium_protocol' ? structured : null;
    const replyId = replyTarget(e.content);
    const quoted = replyId ? original(replyId) : undefined;
    const media = e.content.msgtype === 'm.image' || e.content.msgtype === 'm.file' ? (e.content as MediaContent) : null;
    rows.push(
      <div key={e.eventId} id={`ev-${e.eventId}`} className={`msg ${mine ? 'out' : 'in'}${first ? ' first' : ''}${highlight === e.eventId ? ' highlight' : ''}`}>
        <div className={`bubble${transcript || draft || criticalMsg ? ' wide' : ''}`}>
          {!mine && first && (
            <div className="sender">
              {name(e.sender)}
              {role && <span className="role"> · {roleLabel(role)}</span>}
            </div>
          )}
          {replyId && <Quote name={quoted ? name(quoted.sender) : 'Сообщение'} text={quoteText(quoted)} onJump={() => void jumpTo(replyId)} />}
          {request ? (
            <RequestCard view={request} />
          ) : keyImage ? (
            <KeyImageCard client={client} msg={keyImage} onOpenLink={onOpenLink} />
          ) : slide ? (
            <SlideRoiCard client={client} msg={slide} onOpenLink={onOpenLink} embedded={embedded} />
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
              canDecide={writable}
              name={name}
            />
          ) : media && e.content.msgtype === 'm.image' ? (
            <ImageAttachment client={client} content={media} />
          ) : media ? (
            <FileAttachment client={client} content={media} />
          ) : (
            <div className="text">{replyId ? stripReplyFallback(String(e.content.body ?? '')) : String(e.content.body ?? '')}</div>
          )}
          <span className="meta">{pending ? 'отправка…' : formatTime(e.ts)}</span>
          {(reactions.get(e.eventId)?.length ?? 0) > 0 && (
            <div className="reactions">
              {reactions.get(e.eventId)!.map((r) => (
                <button
                  key={r.key}
                  className={`reaction ${r.key}${r.mine ? ' mine' : ''}`}
                  onClick={() => react(e.eventId, r.key)}
                  disabled={!writable}
                  aria-pressed={!!r.mine}
                  title={r.mine ? 'Снять отметку' : 'Отметить'}
                >
                  {r.label} <b>{r.count}</b>
                </button>
              ))}
            </div>
          )}
        </div>
        {!pending && writable && (
          <div className="msg-actions">
            <button className="reaction-toggle" aria-label="Ответить" title="Ответить" onClick={() => setReplyTo(e.eventId)}>
              <Icon name="reply" size={16} />
            </button>
            <ReactionPicker onPick={(key) => react(e.eventId, key)} />
          </div>
        )}
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
        {/* Узкое окно поверх ЛИС: «Чат случая», под ним номер — название случая хост уже показывает. */}
        <div className="chat-heading">
          <div className="chat-title">{compact && ctx ? 'Чат случая' : room.name}</div>
          <div className="chat-subtitle">
            {ctx && compact ? <span className="mono">{ctx.case_id}</span> : null}
            {ctx ? (compact ? ' · ' : `Чат случая · ${systemLabel[ctx.source] ?? ctx.source} · `) : ''}
            {members} {members % 10 === 1 && members % 100 !== 11 ? 'участник' : members % 10 >= 2 && members % 10 <= 4 && (members % 100 < 12 || members % 100 > 14) ? 'участника' : 'участников'}
          </div>
        </div>
        {(writable || onMinimize || fullUrl) && (
          <div className="chat-actions">
            {writable && !compact && (
              <button className="icon-btn" onClick={() => onCall(false)} aria-label="Аудиозвонок" title="Аудиозвонок" disabled={inCall}>
                <Icon name="phone" />
              </button>
            )}
            {writable && !compact && (
              <button className="icon-btn" onClick={() => onCall(true)} aria-label="Видеозвонок" title="Видеозвонок" disabled={inCall}>
                <Icon name="video" />
              </button>
            )}
            {fullUrl && (
              <button className="icon-btn" onClick={() => window.open(fullUrl, '_blank', 'noopener')} aria-label="Открыть в полном окне" title="Открыть в полном окне">
                <Icon name="external" />
              </button>
            )}
            {onMinimize && (
              <button className="icon-btn" onClick={onMinimize} aria-label="Свернуть чат" title="Свернуть чат">
                <Icon name="close" />
              </button>
            )}
          </div>
        )}
      </header>
      {ctx && !compact && <CaseBar ctx={ctx} onOpenLink={onOpenLink} client={client} roomId={room.roomId} archived={archived} />}
      {writable && <CriticalBar client={client} roomId={room.roomId} waiting={waiting} />}
      {call && !inCall && writable && (
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
        // Файлы можно перетащить в ленту.
        onDragOver={(ev) => {
          if (writable && ev.dataTransfer.types.includes('Files')) ev.preventDefault();
        }}
        onDrop={(ev) => {
          if (!writable || !ev.dataTransfer.files.length) return;
          ev.preventDefault();
          void attach([...ev.dataTransfer.files]);
        }}
      >
        {canLoadOlder && (
          <button className="ghost older" onClick={() => void loadOlder()} disabled={loadingOlder}>
            {loadingOlder ? 'Загрузка…' : 'Показать раньше'}
          </button>
        )}
        {rows}
      </div>
      {typingNow && (
        <div className="typing" aria-live="polite">
          {typingNow}
        </div>
      )}
      {archived ? (
        // Встроенный чат привязан к случаю РИС/ЛИС — убирать его из списка там незачем.
        <ArchivedBar client={client} room={room} onClosed={onClosed} canClose={!embedded} />
      ) : (
        <Composer
          client={client}
          room={room}
          requests={ctx?.source === 'LIS'}
          criticalRoles={criticalRoles}
          reply={reply}
          onCancelReply={() => setReplyTo(null)}
          onFiles={(files) => void attach(files)}
          uploads={uploads}
          onDismissUpload={(id) => setUploads((u) => u.filter((x) => x.id !== id))}
        />
      )}
    </>
  );
}
