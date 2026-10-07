import { useEffect, useRef, useState } from 'react';
import { NotificationCountType, SyncState, type MatrixClient, type Room } from 'matrix-js-sdk';
import { FOLDERS, foldersOf, initials, avatarColor, type Folder } from '../model.ts';
import { CcsError, directRoomIds, openCase, startClient, useClientUpdates, useSyncState, type Session } from '../matrix.ts';
import { ChatList } from './ChatList.tsx';
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
  const [banner, setBanner] = useState<string | null>(null);
  const linkHandled = useRef(false);

  useEffect(() => {
    const link = deepLink();
    if (!ready || !link || linkHandled.current) return;
    linkHandled.current = true;
    setBanner(`Открываем случай ${link.caseId}…`);
    openCase(session, link.connector, link.caseId)
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
  const folderOf = (r: Room) => foldersOf({ roomType: r.getType(), isDirect: direct.has(r.roomId) });
  const unread = (r: Room) => (r.getMyMembership() === 'invite' ? 1 : r.getUnreadNotificationCount(NotificationCountType.Total));
  const counts = new Map<Folder, number>();
  for (const r of rooms) for (const f of folderOf(r)) counts.set(f, (counts.get(f) ?? 0) + unread(r));

  const current = selected ? client.getRoom(selected) : null;
  const me = client.getUser(session.userId);
  const myName = me?.displayName ?? session.userId;

  async function select(room: Room) {
    if (room.getMyMembership() === 'invite') await client.joinRoom(room.roomId).catch(() => undefined);
    setSelected(room.roomId);
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
        <button className="rail-item" onClick={onLogout} title="Выйти">
          <Icon name="logout" />
          <span>Выйти</span>
        </button>
      </nav>
      <ChatList
        client={client}
        rooms={rooms.filter((r) => folderOf(r).includes(folder))}
        selected={selected}
        onSelect={select}
        loading={!ready}
        emptyHint={folder === 'cases' ? 'Чаты случаев появятся, когда вы откроете случай в РИС или ЛИС' : 'Здесь пока пусто'}
      />
      <section className="chat">
        {banner && (
          <div className="banner" role="status">
            {banner}
            <button onClick={() => setBanner(null)} aria-label="Закрыть">×</button>
          </div>
        )}
        {current ? (
          <ChatView key={current.roomId} client={client} room={current} onBack={() => setSelected(null)} />
        ) : (
          <div className="chat-empty">
            <p>Выберите чат слева или откройте случай из РИС или ЛИС</p>
          </div>
        )}
      </section>
    </div>
  );
}
