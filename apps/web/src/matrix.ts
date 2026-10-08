import { useEffect, useReducer, useState } from 'react';
import {
  ClientEvent,
  RoomEvent,
  RoomStateEvent,
  SyncState,
  createClient,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import { EventType } from '@konsilium/protocol';
import { config } from './config.ts';
import { startSync } from './sync.ts';
import { criticalStatuses, type TimelineItem } from './model.ts';

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
  return client;
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
    return () => {
      if (timer) clearTimeout(timer);
      for (const e of events) client.off(e, schedule);
      for (const e of roomEvents) client.off(e, schedule);
      client.off(RoomStateEvent.Events, schedule);
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
): Promise<{ roomId: string; membership: string; connector: string; caseId: string }> {
  const res = await fetch(`${config.ccsUrl}/api/v1/cases/open`, {
    method: 'POST',
    headers: { authorization: `Bearer ${s.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(ctx.connector ? { connector: ctx.connector, caseId: ctx.caseId } : { system: ctx.system, caseId: ctx.caseId }),
  });
  const json = (await res.json().catch(() => ({}))) as { roomId?: string; membership?: string; connector?: string; caseId?: string; error?: string };
  if (!res.ok) throw new CcsError(res.status, json.error ?? `Сервис контекста ответил ${res.status}`);
  return { roomId: json.roomId!, membership: json.membership!, connector: json.connector!, caseId: json.caseId! };
}

/** Сессия по токену, который передал хост (режим встраивания auth: token). */
export async function sessionFromToken(accessToken: string): Promise<Session> {
  const r = await createClient({ baseUrl: config.hsUrl, accessToken }).whoami();
  return { baseUrl: config.hsUrl, userId: r.user_id, accessToken, deviceId: r.device_id ?? '' };
}

/** Статусы критических находок комнаты: state-события сервиса контекста. */
export function roomCriticals(room: Room) {
  const events = (room.currentState.getStateEvents(EventType.CriticalStatus) as MatrixEvent[] | null) ?? [];
  return criticalStatuses(
    events.map((e) => ({ stateKey: e.getStateKey() ?? '', sender: e.getSender() ?? '', content: e.getContent() })),
    room.getCreator(),
  );
}
