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
import { Direction, type MatrixClient } from 'matrix-js-sdk';
import { EventType, parsePrejoinState } from '@konsilium/protocol';
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
  // Консилиум: название, повестка и текущий случай — для строки списка и бейджей.
  [EventType.Consilium, ''],
  [EventType.ConsiliumCurrent, ''],
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

/**
 * Открытый чат: всё нужное состояние и лента. Типы перечислены явно, а не `['*', '*']`: подстановку типа поддерживает не
 * каждый сервер (Tuwunel 1.9 её молча игнорирует — docs/11-load-test.md, 7.4), а лишнего состояния приходит меньше.
 * Новый тип состояния, который читает клиент, нужно добавить и сюда.
 */
export const OPEN_ROOM: MSC3575RoomSubscription = {
  timeline_limit: 50,
  required_state: [
    ['m.room.create', ''],
    ['m.room.name', ''],
    ['m.room.avatar', ''],
    ['m.room.topic', ''],
    ['m.room.canonical_alias', ''],
    ['m.room.power_levels', ''],
    ['m.room.join_rules', ''],
    ['m.room.history_visibility', ''],
    ['m.room.encryption', ''],
    ['m.room.tombstone', ''],
    // Состав чатов случаев и консилиумов мал (3–10 человек) — участники целиком.
    ['m.room.member', '*'],
    [EventType.CaseContext, ''],
    [EventType.CaseRoles, ''],
    [EventType.CaseArchive, ''],
    [EventType.CriticalStatus, '*'],
    [EventType.Call, '*'],
    [EventType.Consilium, ''],
    [EventType.ConsiliumCurrent, ''],
  ],
};

/** Следующая граница окна списка (индекс последней комнаты) или `null`, если окно уже покрывает все комнаты. */
export function nextWindowEnd(currentEnd: number, count: number): number | null {
  const want = Math.min(count, MAX_ROOMS) - 1;
  if (want <= currentEnd) return null;
  return Math.min(want, currentEnd + WINDOW_STEP);
}

type StrippedEvent = { type: string; state_key?: string; content?: Record<string, unknown>; sender?: string };

/**
 * Приглашение, дополненное снимком состояния из самого события приглашения (`PREJOIN_STATE_KEY`): контекст случая, находки
 * и архив, которых сервер не положил в `invite_state` (Tuwunel). Присланное сервером не заменяется. Доверие то же, что
 * к `invite_state` Synapse: снимок пишет тот, кто приглашает, — в чатах случаев это может только сервис контекста.
 */
export function withPrejoinState<T extends StrippedEvent>(inviteState: T[], me: string | null): T[] {
  const mine = me ? inviteState.find((e) => e.type === 'm.room.member' && e.state_key === me) : undefined;
  if (!mine) return inviteState;
  const key = (e: { type: string; state_key?: string }) => JSON.stringify([e.type, e.state_key ?? '']);
  const have = new Set(inviteState.map(key));
  const add = parsePrejoinState(mine.content)
    .filter((e) => !have.has(key(e)))
    .map((e) => ({ ...e, sender: mine.sender }) as unknown as T);
  return add.length ? [...inviteState, ...add] : inviteState;
}

const sliding = new WeakMap<MatrixClient, SlidingSync>();

export type SyncMode = 'sliding' | 'classic';

/** Режим: `?sync=classic` или `"slidingSync": false` в config.json — принудительно обычная синхронизация. */
async function chooseMode(client: MatrixClient): Promise<SyncMode> {
  if (config.slidingSync === false || new URLSearchParams(location.search).get('sync') === 'classic') return 'classic';
  const supported = await client.doesServerSupportUnstableFeature(SSS_FEATURE).catch(() => false);
  return supported ? 'sliding' : 'classic';
}

type SlidingSyncInternals = {
  confirmedRoomSubscriptions: Set<string>;
  getExtensionRequest(isInitial: boolean): Promise<Record<string, unknown>>;
  resetup(): void;
};
type SlidingSyncRequest = Parameters<MatrixClient['slidingSync']>[0];

/**
 * Обход для серверов, которые после входа по приглашению в текущем соединении Sliding Sync присылают только событие
 * входа — без состояния и истории (Tuwunel 1.9 — docs/11-load-test.md, 7.4). Признаки, не зависящие от сервера: у
 * открытого чата, где пользователь участник, после ответа сервера нет даже прав (`m.room.power_levels` есть в любой
 * комнате, а в приглашении их нет) или история оборвана — нет начала комнаты и нечем догрузить. Тогда начинаем
 * соединение заново: штатный `resetup()` заново отправляет списки и подписки, а запрос уходит без `pos` и с начальными
 * настройками расширений — сервер присылает окно списка и подписки целиком. Историю короткой ленты чат догружает сам
 * (ChatView). На Synapse подписка приходит сразу, и обход не срабатывает.
 */
export function installFreshConnectionFallback(client: MatrixClient, ss: SlidingSync) {
  const internals = ss as unknown as SlidingSyncInternals;
  let fresh = false;
  let lastReset = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const attempts = new Map<string, number>();
  const send = client.slidingSync.bind(client);
  client.slidingSync = (async (req: SlidingSyncRequest, proxyBaseUrl?: string, signal?: AbortSignal) => {
    if (fresh) {
      fresh = false;
      const { pos: _pos, ...rest } = req as SlidingSyncRequest & { pos?: string };
      req = { ...rest, extensions: await internals.getExtensionRequest(true) } as SlidingSyncRequest;
    }
    return send(req, proxyBaseUrl, signal);
  }) as MatrixClient['slidingSync'];

  const check = () => {
    timer = null;
    if (fresh) return;
    const missing = [...ss.getRoomSubscriptions()].filter((id) => {
      const room = client.getRoom(id);
      if (!room || !internals.confirmedRoomSubscriptions.has(id) || room.getMyMembership() !== 'join' || (attempts.get(id) ?? 0) >= 3) return false;
      const live = room.getLiveTimeline();
      // Нет состояния — или история оборвана: в ленте нет начала комнаты, а догрузить её нечем (нет токена).
      const noState = !room.currentState.getStateEvents('m.room.power_levels', '');
      const lostHistory = !live.getEvents().some((e) => e.getType() === 'm.room.create') && live.getPaginationToken(Direction.Backward) === null;
      return noState || lostHistory;
    });
    if (!missing.length) return;
    // Не чаще раза в секунду: несколько комнат подряд не должны рвать соединение каждую.
    const wait = lastReset + 1000 - Date.now();
    if (wait > 0) {
      timer ??= setTimeout(check, wait);
      return;
    }
    for (const id of missing) attempts.set(id, (attempts.get(id) ?? 0) + 1);
    lastReset = Date.now();
    fresh = true;
    internals.resetup();
  };
  ss.on(SlidingSyncEvent.Lifecycle, (state) => {
    if (state === SlidingSyncState.Complete) check();
  });
}

/**
 * Своё соединение Sliding Sync (`conn_id`) у каждой вкладки и фрейма с одним входом: панель чата и счётчик бейджей во
 * встраивании, две вкладки мессенджера. Иначе циклы синхронизации одного устройства сбивают друг другу позицию
 * (Tuwunel отвечает 400 — docs/11-load-test.md, 7.4). Номер — наименьший свободный (Web Locks): соединений на сервере
 * столько, сколько вкладок открыто одновременно, а не сколько раз страницу перезагружали.
 */
async function connectionSlot(): Promise<{ connId: string; release: () => void }> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) return { connId: 'web', release: () => {} };
  for (let i = 0; i < 32; i++) {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const got = await new Promise<boolean>((resolve) => {
      void locks.request(`konsilium.sync.${i}`, { ifAvailable: true }, async (lock) => {
        resolve(!!lock);
        if (lock) await held;
      });
    });
    if (got) return { connId: `web-${i}`, release };
  }
  return { connId: `web-${Date.now().toString(36)}`, release: () => {} };
}

/** Запустить синхронизацию клиента в лучшем доступном режиме. */
export async function startSync(client: MatrixClient): Promise<SyncMode> {
  // Клиент могут остановить, пока выбирается режим (React в режиме разработки монтирует компонент дважды), — тогда не
  // запускаем: иначе два цикла синхронизации одного устройства делят соединение Sliding Sync, и у Tuwunel данные новых
  // комнат достаются остановленному клиенту.
  let stopped = false;
  let release = () => {};
  const stop = client.stopClient.bind(client);
  client.stopClient = () => {
    stopped = true;
    release();
    stop();
  };
  const mode = await chooseMode(client);
  if (stopped) return mode;
  if (mode === 'classic') {
    await client.startClient({ initialSyncLimit: 30, lazyLoadMembers: true });
    return mode;
  }
  const slot = await connectionSlot();
  release = slot.release;
  if (stopped) {
    release();
    return mode;
  }
  const send = client.slidingSync.bind(client);
  client.slidingSync = ((req: SlidingSyncRequest, ...rest: [string?, AbortSignal?]) =>
    send({ ...req, conn_id: slot.connId } as SlidingSyncRequest, ...rest)) as MatrixClient['slidingSync'];
  const ss = new SlidingSync(client.baseUrl, new Map([[LIST, LIST_PARAMS]]), OPEN_ROOM, client, 30_000);
  let end = FIRST_WINDOW - 1;
  ss.on(SlidingSyncEvent.Lifecycle, (state) => {
    if (state !== SlidingSyncState.Complete) return;
    const next = nextWindowEnd(end, ss.getListData(LIST)?.joinedCount ?? 0);
    if (next === null) return;
    end = next;
    ss.setListRanges(LIST, [[0, end]]);
  });
  // Комната, которой клиент не знает, пришла как продолжение, — а matrix-js-sdk отбрасывает продолжение для неизвестной
  // комнаты. Так бывает с приглашением в комнату, которую клиент «забыл» (архив, затем случай снова открыт), и у Tuwunel
  // после входа (docs/11-load-test.md, 7.4). Для клиента комната новая — помечаем данные первыми, до обработчика SDK
  // (он подписан позже, в startClient). Неполное состояние после этого восполняет новое соединение (ниже).
  // Приглашение дополняем снимком состояния из него самого (withPrejoinState).
  ss.on(SlidingSyncEvent.RoomData, (roomId, data) => {
    if (!data.initial && !client.getRoom(roomId)) data.initial = true;
    if (data.invite_state) data.invite_state = withPrejoinState(data.invite_state, client.getUserId());
  });
  installFreshConnectionFallback(client, ss);
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
