import { useEffect, useRef, useState } from 'react';
import { NotificationCountType, RoomEvent, SyncState, type MatrixClient, type Room } from 'matrix-js-sdk';
import type { ArchivedCase } from '@konsilium/protocol';
import { FOLDERS, criticalWaitingFor, foldersOf, initials, avatarColor, type Folder } from '../model.ts';
import { CcsError, directRoomIds, openCase, removedToArchive, roomCriticals, startClient, useClientUpdates, useSyncState, type Session } from '../matrix.ts';
import { focusRooms } from '../sync.ts';
import { ArchiveList } from './ArchiveList.tsx';
import { ChatList } from './ChatList.tsx';
import { CallPanel } from './CallPanel.tsx';
import { ChatView } from './ChatView.tsx';
import { Icon } from './Icon.tsx';

export function Messenger({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [client, setClient] = useState<MatrixClient | null>(null);
  useEffect(() => {
    const c = startClient(session);
    setClient(c);
    return () => {
      c.stopClient();
      c.removeAllListeners();
    };
  }, [session]);
  if (!client) return null;
  return <Shell client={client} session={session} onLogout={onLogout} />;
}

/** Ссылка из РИС/ЛИС: /c/{подключение}/{номер случая}. */
function deepLink(): { connector: string; caseId: string } | null {
  const m = location.pathname.match(/^\/c\/([^/]+)\/([^/]+)\/?$/);
  return m ? { connector: decodeURIComponent(m[1]!), caseId: decodeURIComponent(m[2]!) } : null;
}

function Shell({ client, session, onLogout }: { client: MatrixClient; session: Session; onLogout: () => void }) {
  useClientUpdates(client);
  const sync = useSyncState(client);
  const ready = sync === SyncState.Prepared || sync === SyncState.Syncing || sync === SyncState.Catchup;
  const [folder, setFolder] = useState<Folder>('all');
  const [selected, setSelected] = useState<string | null>(null);
  // Звонок живёт на уровне оболочки: можно переключаться между чатами, не разрывая связь.
  const [call, setCall] = useState<{ roomId: string; video: boolean } | null>(null);
  const [callMinimized, setCallMinimized] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const linkHandled = useRef(false);

  useEffect(() => {
    const link = deepLink();
    if (!ready || !link || linkHandled.current) return;
    linkHandled.current = true;
    setBanner(`Открываем случай ${link.caseId}…`);
    openCase(session, link)
      .then(async ({ roomId, membership }) => {
        if (membership !== 'join') await client.joinRoom(roomId);
        setSelected(roomId);
        setBanner(null);
        history.replaceState(null, '', '/');
      })
      .catch((e: Error) =>
        setBanner(e instanceof CcsError && e.status === 403 ? 'Нет доступа к случаю в системе-источнике' : `Не удалось открыть случай: ${e.message}`),
      );
  }, [ready, client, session]);

  const direct = directRoomIds(client);
  const rooms = client
    .getVisibleRooms()
    .filter((r) => ['join', 'invite'].includes(r.getMyMembership()))
    .sort((a, b) => b.getLastActiveTimestamp() - a.getLastActiveTimestamp());
  // Чаты, где критическая находка ждёт моего подтверждения, — наверху списка.
  // Приглашённые эскалацией видят статус из приглашения (room_prejoin_state).
  const waits = (r: Room) => (criticalWaitingFor(roomCriticals(r), session.userId).length > 0 ? 1 : 0);
  rooms.sort((a, b) => waits(b) - waits(a));
  const folderOf = (r: Room) => foldersOf({ roomType: r.getType(), isDirect: direct.has(r.roomId) });
  const unread = (r: Room) => (r.getMyMembership() === 'invite' ? 1 : r.getUnreadNotificationCount(NotificationCountType.Total));
  const counts = new Map<Folder, number>();
  for (const r of rooms) for (const f of folderOf(r)) counts.set(f, (counts.get(f) ?? 0) + unread(r));

  // Открытый чат и чат идущего звонка — с полным состоянием и лентой (Sliding Sync).
  useEffect(() => focusRooms(client, [selected, call?.roomId]), [client, selected, call?.roomId]);
  const current = selected ? client.getRoom(selected) : null;
  // Открытый чат перенесён в архив (сервис вывел участников) — закрываем его и подсказываем, где искать.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  useEffect(() => {
    const onMembership = (room: Room) => {
      if (room.roomId !== selectedRef.current || !removedToArchive(room, session.userId)) return;
      setSelected(null);
      setBanner('Чат перенесён в архив — открыть его можно из папки «Архив»');
    };
    client.on(RoomEvent.MyMembership, onMembership);
    return () => {
      client.off(RoomEvent.MyMembership, onMembership);
    };
  }, [client, session.userId]);
  const me = client.getUser(session.userId);
  const myName = me?.displayName ?? session.userId;

  async function select(room: Room) {
    if (room.getMyMembership() === 'invite') await client.joinRoom(room.roomId).catch(() => undefined);
    setSelected(room.roomId);
  }

  /** Вернуться в архивный чат: сервис контекста проверяет права и приглашает, чат открывается только для чтения. */
  async function openArchived(c: ArchivedCase) {
    const room = client.getRoom(c.room_id);
    if (room?.getMyMembership() === 'join') return setSelected(room.roomId);
    setBanner(`Открываем архивный случай ${c.case_id}…`);
    try {
      const r = await openCase(session, { connector: c.connector, caseId: c.case_id });
      if (r.membership !== 'join') await client.joinRoom(r.roomId);
      setSelected(r.roomId);
      setBanner(null);
    } catch (e) {
      setBanner(e instanceof CcsError && e.status === 403 ? 'Нет доступа к случаю в системе-источнике' : `Не удалось открыть случай: ${(e as Error).message}`);
    }
  }

  return (
    <div className="app">
      <nav className="rail" aria-label="Папки">
        {FOLDERS.map((f) => (
          <button key={f.id} className={`rail-item${folder === f.id ? ' active' : ''}`} onClick={() => setFolder(f.id)} aria-pressed={folder === f.id}>
            <Icon name={f.id} />
            <span>{f.label}</span>
            {(counts.get(f.id) ?? 0) > 0 && <b className="badge">{counts.get(f.id)}</b>}
          </button>
        ))}
        <div className="rail-spacer" />
        <div className="avatar person small" style={{ background: avatarColor(session.userId) }} title={myName}>
          {initials(myName)}
        </div>
        <button
          className="rail-item"
          // Токен отзывается на сервере, а не только забывается браузером. Сессия в Keycloak остаётся (единый вход).
          onClick={() => void client.logout(true).catch(() => undefined).finally(onLogout)}
          title="Выйти"
        >
          <Icon name="logout" />
          <span>Выйти</span>
        </button>
      </nav>
      {folder === 'archive' ? (
        <ArchiveList session={session} selected={selected} onOpen={(c) => void openArchived(c)} />
      ) : (
        <ChatList
          client={client}
          rooms={rooms.filter((r) => folderOf(r).includes(folder))}
          selected={selected}
          onSelect={select}
          loading={!ready}
          emptyHint={folder === 'cases' ? 'Чаты случаев появятся, когда вы откроете случай в РИС или ЛИС' : 'Здесь пока пусто'}
        />
      )}
      <section className="chat">
        {call && client.getRoom(call.roomId) && (
          <CallPanel
            key={`${call.roomId}-${call.video}`}
            client={client}
            session={session}
            room={client.getRoom(call.roomId)!}
            video={call.video}
            minimized={callMinimized || selected !== call.roomId}
            onMinimize={(min) => {
              setCallMinimized(min);
              if (!min) setSelected(call.roomId);
            }}
            onLeave={() => setCall(null)}
          />
        )}
        {banner && (
          <div className="banner" role="status">
            {banner}
            <button onClick={() => setBanner(null)} aria-label="Закрыть">×</button>
          </div>
        )}
        {current ? (
          <ChatView
            key={current.roomId}
            client={client}
            room={current}
            onBack={() => setSelected(null)}
            onClosed={() => setSelected(null)}
            inCall={call?.roomId === current.roomId}
            onCall={(video) => {
              setCall({ roomId: current.roomId, video });
              setCallMinimized(false);
            }}
          />
        ) : (
          <div className="chat-empty">
            <p>{selected ? 'Загрузка чата…' : 'Выберите чат слева или откройте случай из РИС или ЛИС'}</p>
          </div>
        )}
      </section>
    </div>
  );
}
