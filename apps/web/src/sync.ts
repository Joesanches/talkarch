/**
 * Синхронизация клиента: Simplified Sliding Sync (MSC4186), если сервер его поддерживает, иначе — обычная.
 *
 * Почему (docs/11-load-test.md): обычная первая синхронизация пользователя с 200 комнатами — 6 с, а 240 клиентов,
 * начавших её разом, ждали около 2 минут. Sliding Sync отдаёт только окно списка — первые 20 комнат за 0,1–0,2 с.
 *
 * Как устроено:
 * - один список всех комнат по свежести; окно сначала 20 комнат (быстрый первый экран), затем расширяется
 *   по 100 до всех комнат (не больше 1000) — счётчики папок, «!» критических находок и бейджи РИС становятся полными;
 * - у комнат списка — только то, что нужно строке списка: тип, название, контекст случая, статусы находок,
 *   своё членство, последние события и их авторы;
 * - открытый чат (и чат идущего звонка) подписан на полное состояние и ленту — роли, звонок, участники.
 */
import { SlidingSync, SlidingSyncEvent, SlidingSyncState, type MSC3575List, type MSC3575RoomSubscription } from 'matrix-js-sdk/lib/sliding-sync';
import type { MatrixClient } from 'matrix-js-sdk';
import { EventType } from '@konsilium/protocol';
import { config } from './config.ts';

export const LIST = 'rooms';
export const FIRST_WINDOW = 20;
export const WINDOW_STEP = 100;
export const MAX_ROOMS = 1000;
const SSS_FEATURE = 'org.matrix.simplified_msc3575';

/** Состояние, нужное строке списка чатов (и счётчикам встраивания). */
export const LIST_REQUIRED_STATE: string[][] = [
  ['m.room.create', ''],
  ['m.room.name', ''],
  ['m.room.avatar', ''],
  [EventType.CaseContext, ''],
  // Архив: вернувшийся видит пометку в списке; из выведенных комнат клиент выходит насовсем (forget).
  [EventType.CaseArchive, ''],
  [EventType.CriticalStatus, '*'],
  [EventType.Call, '*'],
  ['m.room.member', '$ME'],
  // Авторы последних событий — для подписи «Смирнова: …» в списке.
  ['m.room.member', '$LAZY'],
];

export const LIST_PARAMS: MSC3575List = {
  ranges: [[0, FIRST_WINDOW - 1]],
  timeline_limit: 3,
  required_state: LIST_REQUIRED_STATE,
};

/** Открытый чат: всё состояние комнаты (их состав мал — 3–10 человек) и лента. */
export const OPEN_ROOM: MSC3575RoomSubscription = {
  timeline_limit: 50,
  required_state: [['*', '*']],
};

/** Следующая граница окна списка (индекс последней комнаты) или `null`, если окно уже покрывает все комнаты. */
export function nextWindowEnd(currentEnd: number, count: number): number | null {
  const want = Math.min(count, MAX_ROOMS) - 1;
  if (want <= currentEnd) return null;
  return Math.min(want, currentEnd + WINDOW_STEP);
}

const sliding = new WeakMap<MatrixClient, SlidingSync>();

export type SyncMode = 'sliding' | 'classic';

/** Режим: `?sync=classic` или `"slidingSync": false` в config.json — принудительно обычная синхронизация. */
async function chooseMode(client: MatrixClient): Promise<SyncMode> {
  if (config.slidingSync === false || new URLSearchParams(location.search).get('sync') === 'classic') return 'classic';
  const supported = await client.doesServerSupportUnstableFeature(SSS_FEATURE).catch(() => false);
  return supported ? 'sliding' : 'classic';
}

/** Запустить синхронизацию клиента в лучшем доступном режиме. */
export async function startSync(client: MatrixClient): Promise<SyncMode> {
  const mode = await chooseMode(client);
  if (mode === 'classic') {
    await client.startClient({ initialSyncLimit: 30, lazyLoadMembers: true });
    return mode;
  }
  const ss = new SlidingSync(client.baseUrl, new Map([[LIST, LIST_PARAMS]]), OPEN_ROOM, client, 30_000);
  let end = FIRST_WINDOW - 1;
  ss.on(SlidingSyncEvent.Lifecycle, (state) => {
    if (state !== SlidingSyncState.Complete) return;
    const next = nextWindowEnd(end, ss.getListData(LIST)?.joinedCount ?? 0);
    if (next === null) return;
    end = next;
    ss.setListRanges(LIST, [[0, end]]);
  });
  sliding.set(client, ss);
  await client.startClient({ slidingSync: ss, lazyLoadMembers: true });
  return mode;
}

/**
 * Комнаты, которые сейчас на экране (открытый чат, идущий звонок): для них — полное состояние и лента.
 * В обычной синхронизации всё и так приходит целиком — ничего делать не нужно.
 */
export function focusRooms(client: MatrixClient, roomIds: Array<string | null | undefined>) {
  const ss = sliding.get(client);
  if (!ss) return;
  const want = new Set(roomIds.filter((id): id is string => !!id));
  const have = ss.getRoomSubscriptions();
  if (want.size === have.size && [...want].every((id) => have.has(id))) return;
  ss.modifyRoomSubscriptions(want);
}
