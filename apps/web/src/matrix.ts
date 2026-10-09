import { useEffect, useReducer, useState } from 'react';
import {
  ClientEvent,
  RoomEvent,
  RoomMemberEvent,
  RoomStateEvent,
  SyncState,
  createClient,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import { ARCHIVE_KICK_REASON, ArchivedCase, EventType } from '@konsilium/protocol';
import { config } from './config.ts';
import { startSync } from './sync.ts';
import { criticalStatuses, isArchivedState, type TimelineItem } from './model.ts';

export interface Session {
  baseUrl: string;
  userId: string;
  accessToken: string;
  deviceId: string;
}

// PoC: сессия в localStorage. В продукте — вход через Keycloak (OIDC) и токены в памяти/IndexedDB с обновлением.
const KEY = 'konsilium.session';

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function saveSession(s: Session) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* приватный режим — сессия живёт до перезагрузки */
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ничего */
  }
}

export interface LoginOptions {
  password: boolean;
  /** Поставщики единого входа (Keycloak организации и т. п.). */
  sso: Array<{ id: string; name: string }>;
}

/** Какие способы входа предлагает сервер: единый вход и/или пароль. */
export async function loginOptions(): Promise<LoginOptions> {
  const { flows } = await createClient({ baseUrl: config.hsUrl }).loginFlows();
  const sso = flows.find((f) => f.type === 'm.login.sso') as { identity_providers?: Array<{ id: string; name: string }> } | undefined;
  return { password: flows.some((f) => f.type === 'm.login.password'), sso: sso?.identity_providers ?? [] };
}

/** Адрес входа через поставщика: после него сервер вернёт пользователя на `redirectUrl` с одноразовым `loginToken`. */
export function ssoLoginUrl(redirectUrl: string, idpId: string): string {
  return createClient({ baseUrl: config.hsUrl }).getSsoLoginUrl(redirectUrl, 'sso', idpId);
}

const tokenLogins = new Map<string, Promise<Session>>();

/**
 * Обменять одноразовый `loginToken` единого входа на сессию. Повторный вызов с тем же токеном (строгий режим React
 * вызывает эффекты дважды) получает тот же результат, а не ошибку «токен уже использован».
 */
export function loginWithToken(token: string): Promise<Session> {
  let p = tokenLogins.get(token);
  if (!p) {
    p = createClient({ baseUrl: config.hsUrl })
      .loginRequest({ type: 'm.login.token', token, initial_device_display_name: 'Консилиум · веб' })
      .then((r) => ({ baseUrl: config.hsUrl, userId: r.user_id, accessToken: r.access_token, deviceId: r.device_id }));
    tokenLogins.set(token, p);
  }
  return p;
}

/** Сообщение всплывающего окна единого входа фрейму, который его открыл. */
export const SSO_MESSAGE = 'konsilium-sso';

export async function login(username: string, password: string): Promise<Session> {
  const tmp = createClient({ baseUrl: config.hsUrl });
  const r = await tmp.loginRequest({
    type: 'm.login.password',
    identifier: { type: 'm.id.user', user: username.trim() },
    password,
    initial_device_display_name: 'Консилиум · веб',
  });
  return { baseUrl: config.hsUrl, userId: r.user_id, accessToken: r.access_token, deviceId: r.device_id };
}

export function startClient(s: Session): MatrixClient {
  const client = createClient({ baseUrl: s.baseUrl, userId: s.userId, accessToken: s.accessToken, deviceId: s.deviceId });
  // Simplified Sliding Sync, если сервер его поддерживает (sync.ts); иначе — обычная синхронизация.
  void startSync(client).catch((err) => console.error('Синхронизация не запустилась', err));
  client.on(ClientEvent.Sync, () => forgetArchived(client));
  return client;
}

/**
 * Непрочитанные сообщения — считаются на клиенте: Simplified Sliding Sync в Synapse отдаёт notification_count = 0
 * («уведомления правильно считает только клиент»). Чужие сообщения после моей отметки о прочтении или моего сообщения.
 * Считается по загруженной ленте (в списке — последние события комнаты), поэтому число — не меньше настоящего.
 */
export function unreadCount(room: Room): number {
  const me = room.myUserId;
  const events = room.getLiveTimeline().getEvents();
  let n = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    const id = e.getId();
    if (e.getSender() === me || (id && room.hasUserReadEvent(me, id))) break;
    if (e.getType() === 'm.room.message' && !e.isRedacted()) n++;
  }
  return n;
}

/** Чат случая в архиве: только чтение. Состояние пишет только сервис контекста (уровень 100). */
export const roomArchived = (room: Room) => isArchivedState(room.currentState.getStateEvents(EventType.CaseArchive, '')?.getContent());

/**
 * Сервис вывел пользователя из архивного чата (а не он вышел сам). Признак архива — состояние комнаты или причина
 * вывода: не каждый сервер присылает изменение состояния перед выводом (Tuwunel — docs/11-load-test.md, 7.4).
 */
export function removedToArchive(room: Room, me: string | null): boolean {
  if (!me || room.getMyMembership() !== 'leave') return false;
  const member = room.currentState.getStateEvents('m.room.member', me);
  const by = member?.getSender();
  if (!by || by === me) return false;
  return roomArchived(room) || member?.getContent().reason === ARCHIVE_KICK_REASON;
}

const forgetting = new WeakMap<MatrixClient, Set<string>>();

/**
 * Забыть архивные чаты, из которых сервис вывел пользователя. Иначе Sliding Sync продолжает отдавать их в списке
 * (выведенный — не то же, что вышедший сам), и у врача за годы копятся тысячи комнат. Вернуться можно из папки «Архив».
 *
 * Комната удаляется и из памяти клиента: если она вернётся (случай снова открыт, возврат из архива), сервер пришлёт
 * её заново целиком.
 */
export function forgetArchived(client: MatrixClient) {
  const me = client.getUserId();
  const done = forgetting.get(client) ?? new Set<string>();
  forgetting.set(client, done);
  for (const room of client.getRooms()) {
    if (done.has(room.roomId) || !removedToArchive(room, me)) continue;
    done.add(room.roomId);
    void client.forget(room.roomId, true).catch(() => done.delete(room.roomId));
  }
}

/** Убрать вернувшийся архивный чат из списка: выйти и забыть (история остаётся в архиве). */
export async function closeArchived(client: MatrixClient, roomId: string) {
  await client.leave(roomId);
  await client.forget(roomId, true);
}

/**
 * Перерисовка при любых изменениях в клиенте — не чаще раза в 50 мс.
 * Таймер, а не requestAnimationFrame: в невидимом фрейме (счётчики для РИС) браузер rAF не вызывает.
 */
export function useClientUpdates(client: MatrixClient): number {
  const [version, bump] = useReducer((v: number) => v + 1, 0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (!timer) timer = setTimeout(() => {
        timer = null;
        bump();
      }, 50);
    };
    const events = [ClientEvent.Sync, ClientEvent.Room, ClientEvent.DeleteRoom] as const;
    const roomEvents = [RoomEvent.Timeline, RoomEvent.Name, RoomEvent.MyMembership, RoomEvent.Receipt, RoomEvent.LocalEchoUpdated] as const;
    for (const e of events) client.on(e, schedule);
    for (const e of roomEvents) client.on(e, schedule);
    client.on(RoomStateEvent.Events, schedule);
    // «Печатает…» — уведомления о наборе от других участников.
    client.on(RoomMemberEvent.Typing, schedule);
    return () => {
      if (timer) clearTimeout(timer);
      for (const e of events) client.off(e, schedule);
      for (const e of roomEvents) client.off(e, schedule);
      client.off(RoomStateEvent.Events, schedule);
      client.off(RoomMemberEvent.Typing, schedule);
    };
  }, [client]);
  return version;
}

export function useSyncState(client: MatrixClient): SyncState | null {
  const [state, setState] = useState<SyncState | null>(client.getSyncState());
  useEffect(() => {
    const on = (s: SyncState) => setState(s);
    client.on(ClientEvent.Sync, on);
    return () => {
      client.off(ClientEvent.Sync, on);
    };
  }, [client]);
  return state;
}

export const toItem = (e: MatrixEvent): TimelineItem => ({
  eventId: e.getId() ?? e.getTxnId() ?? '',
  type: e.getType(),
  sender: e.getSender() ?? '',
  ts: e.getTs(),
  content: e.getContent(),
  stateKey: e.getStateKey(),
});

export const timelineItems = (room: Room): TimelineItem[] => room.getLiveTimeline().getEvents().map(toItem);

/** Личный чат: комната есть в m.direct. */
export function directRoomIds(client: MatrixClient): Set<string> {
  const content = (client.getAccountData('m.direct' as never)?.getContent() ?? {}) as Record<string, string[]>;
  return new Set(Object.values(content).flat());
}

export class CcsError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Открыть чат случая через сервис контекста: проверка прав в РИС/ЛИС, комната, приглашение. */
export async function openCase(
  s: Session,
  ctx: { connector?: string; system?: string; caseId: string },
): Promise<{ roomId: string; membership: string; connector: string; caseId: string; archived: boolean }> {
  const res = await fetch(`${config.ccsUrl}/api/v1/cases/open`, {
    method: 'POST',
    headers: { authorization: `Bearer ${s.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(ctx.connector ? { connector: ctx.connector, caseId: ctx.caseId } : { system: ctx.system, caseId: ctx.caseId }),
  });
  const json = (await res.json().catch(() => ({}))) as { roomId?: string; membership?: string; connector?: string; caseId?: string; archived?: boolean; error?: string };
  if (!res.ok) throw new CcsError(res.status, json.error ?? `Сервис контекста ответил ${res.status}`);
  return { roomId: json.roomId!, membership: json.membership!, connector: json.connector!, caseId: json.caseId!, archived: json.archived ?? false };
}

/** Папка «Архив»: архивные случаи, в чатах которых пользователь участвовал (по данным сервиса контекста). */
export async function fetchArchive(s: Session, q: string, signal?: AbortSignal): Promise<ArchivedCase[]> {
  const url = new URL(`${config.ccsUrl}/api/v1/archive`);
  if (q.trim()) url.searchParams.set('q', q.trim());
  const res = await fetch(url, { headers: { authorization: `Bearer ${s.accessToken}` }, cache: 'no-store', ...(signal ? { signal } : {}) });
  const json = (await res.json().catch(() => ({}))) as { cases?: unknown[]; error?: string };
  if (!res.ok) throw new CcsError(res.status, json.error ?? `Сервис контекста ответил ${res.status}`);
  return (json.cases ?? []).flatMap((c) => {
    const r = ArchivedCase.safeParse(c);
    return r.success ? [r.data] : [];
  });
}

/** Сессия по токену, который передал хост (режим встраивания auth: token). */
export async function sessionFromToken(accessToken: string): Promise<Session> {
  const r = await createClient({ baseUrl: config.hsUrl, accessToken }).whoami();
  return { baseUrl: config.hsUrl, userId: r.user_id, accessToken, deviceId: r.device_id ?? '' };
}

export interface MessageHit {
  roomId: string;
  eventId: string;
  sender: string;
  ts: number;
  body: string;
}

/**
 * Поиск по сообщениям во всех чатах пользователя — на сервере (полнотекстовый индекс PostgreSQL в Synapse).
 * Чаты случаев не шифруются сквозным шифрованием как раз ради поиска и аудита (docs/07-security-compliance.md).
 */
export async function searchMessages(client: MatrixClient, term: string): Promise<{ hits: MessageHit[]; count: number; highlights: string[] }> {
  const r = await client.search({
    body: { search_categories: { room_events: { search_term: term, order_by: 'recent' as never, filter: { limit: 20 } } } },
  });
  const ev = r.search_categories.room_events;
  const hits = (ev?.results ?? []).flatMap(({ result }) => {
    const body = result.content?.body;
    if (!result.room_id || !result.event_id || typeof body !== 'string') return [];
    return [{ roomId: result.room_id, eventId: result.event_id, sender: result.sender ?? '', ts: result.origin_server_ts ?? 0, body }];
  });
  return { hits, count: ev?.count ?? hits.length, highlights: ev?.highlights ?? [] };
}

/** Статусы критических находок комнаты: state-события сервиса контекста. */
export function roomCriticals(room: Room) {
  const events = (room.currentState.getStateEvents(EventType.CriticalStatus) as MatrixEvent[] | null) ?? [];
  return criticalStatuses(
    events.map((e) => ({ stateKey: e.getStateKey() ?? '', sender: e.getSender() ?? '', content: e.getContent() })),
    room.getCreator(),
  );
}
