import type { MatrixClient, Room as MatrixRoom } from 'matrix-js-sdk';
import { CallState, EventType } from '@konsilium/protocol';
import { config } from './config.ts';
import { CcsError, type Session } from './matrix.ts';

export const CALL_ID = 'main';

export interface CallToken {
  url: string;
  token: string;
  room: string;
  /** ИИ-«Секретарь» включён политикой организации: срок готовности итогов. `null` — кнопки стенограммы нет. */
  secretary?: { eta_minutes: number } | null;
}

/** Токен LiveKit у сервиса контекста: он проверит, что пользователь — участник комнаты. */
export async function requestCallToken(s: Session, roomId: string): Promise<CallToken> {
  const res = await fetch(`${config.ccsUrl}/api/v1/calls/token`, {
    method: 'POST',
    headers: { authorization: `Bearer ${s.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ roomId, callId: CALL_ID }),
  });
  const json = (await res.json().catch(() => ({}))) as Partial<CallToken> & { error?: string };
  if (!res.ok) throw new CcsError(res.status, json.error ?? `Сервис контекста ответил ${res.status}`);
  return json as CallToken;
}

/** Включить или выключить стенограмму звонка (ИИ-«Секретарь»). */
export async function setSecretary(s: Session, roomId: string, action: 'start' | 'stop'): Promise<{ status: string; eta_minutes?: number }> {
  const res = await fetch(`${config.ccsUrl}/api/v1/calls/secretary`, {
    method: 'POST',
    headers: { authorization: `Bearer ${s.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ roomId, action }),
  });
  const json = (await res.json().catch(() => ({}))) as { status?: string; eta_minutes?: number; error?: string };
  if (!res.ok) throw new CcsError(res.status, json.error ?? `Сервис контекста ответил ${res.status}`);
  return json as { status: string; eta_minutes?: number };
}

/** Участник звонка — человек (Matrix ID); ИИ-агенты подключаются под служебными именами. */
export const isHuman = (identity: string) => identity.startsWith('@');

/** Идущий звонок в комнате — state-событие `ru.vendor.call` без `ended_at`. Звонки старше 12 часов считаем зависшими. */
export function activeCall(room: MatrixRoom): CallState | null {
  const parsed = CallState.safeParse(room.currentState.getStateEvents(EventType.Call, CALL_ID)?.getContent());
  if (!parsed.success || parsed.data.ended_at) return null;
  return Date.now() - Date.parse(parsed.data.started_at) < 12 * 3600_000 ? parsed.data : null;
}

/** Отметить начало звонка в комнате — участники увидят «Идёт звонок · Присоединиться». */
export async function markCallStarted(client: MatrixClient, room: MatrixRoom, kind: CallState['kind']) {
  if (activeCall(room)) return;
  const content: CallState = { call_id: CALL_ID, kind, started_by: client.getUserId()!, started_at: new Date().toISOString() };
  await client.sendStateEvent(room.roomId, EventType.Call as never, content as never, CALL_ID);
}

/** Отметить конец звонка — вызывает последний вышедший. */
export async function markCallEnded(client: MatrixClient, room: MatrixRoom) {
  const current = activeCall(room);
  if (!current) return;
  await client.sendStateEvent(room.roomId, EventType.Call as never, { ...current, ended_at: new Date().toISOString() } as never, CALL_ID);
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
