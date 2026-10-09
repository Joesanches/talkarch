import { useEffect, useRef, useState } from 'react';
import { SyncState, type MatrixClient } from 'matrix-js-sdk';
import { themeCss } from '@konsilium/tokens/theme';
import { contextKey, type ChatContext, type Mode } from '@konsilium/embed/protocol';
import { CallPanel } from '../components/CallPanel.tsx';
import { ChatView } from '../components/ChatView.tsx';
import { Login } from '../components/Login.tsx';
import { isAllowedHostOrigin } from '../config.ts';
import { CcsError, clearSession, loadSession, openCase, saveSession, sessionFromToken, startClient, useClientUpdates, useSyncState, type Session } from '../matrix.ts';
import { caseUnread, sendKeyImage, sendSlideRoi } from '../media.ts';
import { focusRooms } from '../sync.ts';
import { bridgeFor, type Bridge } from './bridge.ts';

function applyTheme(accent?: string) {
  const style = document.getElementById('theme');
  if (!style) return;
  try {
    style.textContent = themeCss(accent ? `#${accent.replace(/^#/, '')}` : undefined);
  } catch {
    /* акцент с плохим контрастом — оставляем прежнюю тему */
  }
}

/**
 * Чат во фрейме РИС/ЛИС: /embed?mode=panel|launcher|headless&host=<origin хоста>&connector=…&caseId=…
 * Команды хоста — через Bridge (только разрешённый origin), события — обратно хосту.
 */
export function EmbedApp() {
  const params = new URLSearchParams(location.search);
  const mode = (['panel', 'launcher', 'headless'].includes(params.get('mode') ?? '') ? params.get('mode') : 'panel') as Mode;
  const hostOrigin = params.get('host') ?? '';
  const allowed = window.parent !== window && isAllowedHostOrigin(hostOrigin);
  const bridge = allowed ? bridgeFor(hostOrigin) : null;
  const caseId = params.get('caseId');
  const initial: ChatContext | null = caseId
    ? { caseId, ...(params.get('connector') ? { connector: params.get('connector')! } : {}), ...(params.get('system') ? { system: params.get('system') as ChatContext['system'] } : {}) }
    : null;
  const [session, setSession] = useState<Session | null>(loadSession);

  useEffect(() => {
    if (!bridge) return;
    // Вход в соседнем фрейме того же чата (панель и счётчики) — подхватываем сессию.
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'konsilium.session') setSession(loadSession());
    };
    window.addEventListener('storage', onStorage);
    const offTheme = bridge.on('theme.set', ({ accent }) => applyTheme(accent));
    const offToken = bridge.on('auth.token', async ({ accessToken }) => setSession(await sessionFromToken(accessToken)));
    bridge.send('ready', { mode, userId: session?.userId ?? null });
    if (!session) bridge.send('auth.required', {});
    return () => {
      window.removeEventListener('storage', onStorage);
      offTheme();
      offToken();
    };
  }, [bridge]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!bridge) {
    return <div className="embed-state">Встраивание чата с {hostOrigin || 'этой страницы'} не разрешено. Добавьте адрес в embedOrigins.</div>;
  }
  if (!session) {
    if (mode === 'headless') return null;
    return (
      <div className="embed">
        <Login
          sso="popup"
          onLogin={(s) => {
            saveSession(s);
            setSession(s);
          }}
        />
      </div>
    );
  }
  return (
    <EmbedSession
      key={session.accessToken}
      session={session}
      mode={mode}
      bridge={bridge}
      initial={initial}
      onUnauthorized={() => {
        clearSession();
        setSession(null);
        bridge.send('auth.required', {});
      }}
    />
  );
}

function EmbedSession(props: { session: Session; mode: Mode; bridge: Bridge; initial: ChatContext | null; onUnauthorized: () => void }) {
  const [client, setClient] = useState<MatrixClient | null>(null);
  useEffect(() => {
    const c = startClient(props.session);
    setClient(c);
    return () => {
      c.stopClient();
      c.removeAllListeners();
    };
  }, [props.session]);
  return client ? <EmbedInner {...props} client={client} /> : null;
}

function EmbedInner({ client, session, mode, bridge, initial, onUnauthorized }: Parameters<typeof EmbedSession>[0] & { client: MatrixClient }) {
  useClientUpdates(client);
  const sync = useSyncState(client);
  const ready = sync === SyncState.Prepared || sync === SyncState.Syncing || sync === SyncState.Catchup;
  if (import.meta.env.DEV) (window as unknown as { __mx: MatrixClient }).__mx = client;
  const [context, setContext] = useState<ChatContext | null>(initial);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [watch, setWatch] = useState<Set<string> | null>(null);
  const [call, setCall] = useState<{ video: boolean } | null>(null);
  const [callMinimized, setCallMinimized] = useState(false);
  // Окно launcher открыто? До первой команды хоста — свёрнуто (так SDK его и создаёт).
  const [visible, setVisible] = useState(mode !== 'launcher');
  useEffect(() => bridge.on('view.visible', ({ visible: v }) => setVisible(v)), [bridge]);

  useEffect(() => bridge.on('context.set', (ctx) => setContext(ctx)), [bridge]);
  useEffect(
    () => bridge.on('unread.watch', ({ contexts }) => setWatch(new Set(contexts.filter((c) => c.connector).map((c) => contextKey(c.connector!, c.caseId))))),
    [bridge],
  );
  useEffect(() => bridge.on('room.open', () => document.getElementById('composer-input')?.focus()), [bridge]);
  useEffect(
    () =>
      bridge.on('compose.attach', async (att) => {
        if (!roomId) throw new Error('Чат случая ещё не открыт');
        if (att.kind === 'slide_roi') await sendSlideRoi(client, roomId, att);
        else await sendKeyImage(client, roomId, att);
      }),
    [bridge, client, roomId],
  );

  // Открыть чат случая при смене контекста (не для счётчиков).
  useEffect(() => {
    if (!ready || !context || mode === 'headless') return;
    let cancelled = false;
    setRoomId(null);
    setCall(null);
    setStatus(`Открываем чат ${context.caseId}…`);
    openCase(session, context)
      .then(async (r) => {
        if (r.membership !== 'join') await client.joinRoom(r.roomId);
        if (cancelled) return;
        setRoomId(r.roomId);
        setStatus(null);
        bridge.send('context.opened', { connector: r.connector, caseId: r.caseId, roomId: r.roomId });
      })
      .catch((e: Error) => {
        if (cancelled) return;
        if (e instanceof CcsError && e.status === 401) return onUnauthorized();
        setStatus(e instanceof CcsError && e.status === 403 ? 'Нет доступа к случаю в системе-источнике' : e instanceof CcsError && e.status === 404 ? 'Случай не найден в системе-источнике' : `Не удалось открыть чат: ${e.message}`);
      });
    return () => {
      cancelled = true;
    };
  }, [ready, context?.connector, context?.system, context?.caseId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Счётчики непрочитанного для бейджей хоста: по отслеживаемым контекстам или по открытому чату.
  const all = ready ? caseUnread(client) : [];
  const byContext = watch ? all.filter((i) => watch.has(contextKey(i.connector, i.caseId))).map(({ roomId: _r, ...i }) => i) : [];
  const total = watch ? byContext.reduce((s, i) => s + i.unread + (i.invited ? 1 : 0), 0) : (all.find((i) => i.roomId === roomId)?.unread ?? 0);
  const snapshot = JSON.stringify({ total, byContext });
  const lastSent = useRef('');
  useEffect(() => {
    if (!ready || snapshot === lastSent.current) return;
    lastSent.current = snapshot;
    bridge.send('unread.changed', { total, byContext });
  });

  useEffect(() => focusRooms(client, [roomId]), [client, roomId]);

  if (mode === 'headless') return null;
  const room = roomId ? client.getRoom(roomId) : null;
  return (
    <div className="embed">
      <section className="chat">
        {call && room && (
          <CallPanel
            client={client}
            session={session}
            room={room}
            video={call.video}
            minimized={callMinimized}
            onMinimize={setCallMinimized}
            onLeave={() => setCall(null)}
          />
        )}
        {room ? (
          <ChatView
            client={client}
            room={room}
            embedded
            onBack={() => undefined}
            onOpenLink={(link) => bridge.send('link.open', link)}
            active={visible}
            {...(mode === 'launcher'
              ? {
                  compact: true,
                  onMinimize: () => bridge.send('view.minimize', {}),
                  fullUrl: context?.connector ? `${location.origin}/c/${encodeURIComponent(context.connector)}/${encodeURIComponent(context.caseId)}` : undefined,
                }
              : {})}
            inCall={!!call}
            onCall={(video) => {
              setCall({ video });
              setCallMinimized(false);
            }}
          />
        ) : (
          <div className="embed-state">{status ?? (context ? 'Загрузка…' : 'Откройте исследование, чтобы обсудить его в чате')}</div>
        )}
      </section>
    </div>
  );
}
