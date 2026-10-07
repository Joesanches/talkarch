import { useEffect, useReducer, useRef, useState } from 'react';
import { ConnectionState, Room, RoomEvent, Track, type Participant, type Track as LkTrack } from 'livekit-client';
import type { MatrixClient, Room as MatrixRoom } from 'matrix-js-sdk';
import { RoomType } from '@konsilium/protocol';
import { formatDuration, markCallEnded, markCallStarted, requestCallToken } from '../call.ts';
import type { Session } from '../matrix.ts';
import { avatarColor, initials } from '../model.ts';
import { Icon } from './Icon.tsx';

function Media({ track, kind, mirrored }: { track: LkTrack; kind: 'video' | 'audio'; mirrored?: boolean }) {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);
  return kind === 'video' ? <video ref={ref} autoPlay playsInline muted className={mirrored ? 'mirrored' : undefined} /> : <audio ref={ref} autoPlay />;
}

function Tile({ p, local, screen }: { p: Participant; local: boolean; screen?: boolean }) {
  const pub = p.getTrackPublication(screen ? Track.Source.ScreenShare : Track.Source.Camera);
  const name = p.name || p.identity;
  const video = pub?.track && !pub.isMuted ? pub.track : null;
  return (
    <div className={`tile${p.isSpeaking && !screen ? ' speaking' : ''}${screen ? ' screen' : ''}`} data-identity={p.identity}>
      {video ? (
        <Media track={video} kind="video" mirrored={local && !screen} />
      ) : (
        <div className="avatar person" style={{ background: avatarColor(p.identity) }}>
          {initials(name)}
        </div>
      )}
      <div className="tile-name">
        {!screen && !p.isMicrophoneEnabled && <Icon name="mic-off" size={14} />}
        {screen ? `Экран: ${name}` : local ? `${name} (вы)` : name}
      </div>
    </div>
  );
}

/**
 * Звонок в комнате через LiveKit. Токен выдаёт сервис контекста только участникам комнаты.
 * Свёрнутый звонок остаётся подключённым — полосой над чатом.
 */
export function CallPanel(props: {
  client: MatrixClient;
  session: Session;
  room: MatrixRoom;
  video: boolean;
  minimized: boolean;
  onMinimize: (min: boolean) => void;
  onLeave: () => void;
}) {
  const { client, session, room, video } = props;
  const [lk, setLk] = useState<Room | null>(null);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const lkRoom = new Room({ adaptiveStream: true, dynacast: true });
    let alive = true;
    setLk(lkRoom);
    const events = [
      RoomEvent.ParticipantConnected,
      RoomEvent.ParticipantDisconnected,
      RoomEvent.TrackSubscribed,
      RoomEvent.TrackUnsubscribed,
      RoomEvent.TrackMuted,
      RoomEvent.TrackUnmuted,
      RoomEvent.LocalTrackPublished,
      RoomEvent.LocalTrackUnpublished,
      RoomEvent.ActiveSpeakersChanged,
      RoomEvent.ConnectionStateChanged,
    ] as const;
    for (const e of events) lkRoom.on(e, bump);
    (async () => {
      try {
        const t = await requestCallToken(session, room.roomId);
        if (!alive) return;
        await lkRoom.connect(t.url, t.token);
        if (!alive) return void lkRoom.disconnect();
        setStartedAt(Date.now());
        const kind = room.getType() === RoomType.Case ? 'consilium' : 'direct';
        void markCallStarted(client, room, kind).catch(() => undefined);
        await lkRoom.localParticipant.setMicrophoneEnabled(true).catch(() => setError('Нет доступа к микрофону — вас не слышно'));
        if (video) await lkRoom.localParticipant.setCameraEnabled(true).catch(() => setError('Нет доступа к камере'));
      } catch (e) {
        if (alive) setError(`Не удалось подключиться к звонку: ${(e as Error).message}`);
      }
    })();
    return () => {
      alive = false;
      for (const e of events) lkRoom.off(e, bump);
      void lkRoom.disconnect();
    };
  }, [client, session, room, video]);

  async function leave() {
    // Последний вышедший закрывает звонок в комнате.
    if (lk && lk.remoteParticipants.size === 0) await markCallEnded(client, room).catch(() => undefined);
    await lk?.disconnect();
    props.onLeave();
  }

  const local = lk?.localParticipant;
  const participants: Participant[] = lk && local ? [local, ...lk.remoteParticipants.values()] : [];
  const screen = participants.find((p) => {
    const pub = p.getTrackPublication(Track.Source.ScreenShare);
    return pub?.track && !pub.isMuted;
  });
  const state = lk?.state;
  const status =
    state === ConnectionState.Connected && startedAt
      ? formatDuration(now - startedAt)
      : state === ConnectionState.Reconnecting || state === ConnectionState.SignalReconnecting
        ? 'Восстанавливаем связь…'
        : state === ConnectionState.Disconnected && startedAt
          ? 'Связь потеряна'
          : 'Подключение…';

  const toggle = async (what: 'mic' | 'cam' | 'screen') => {
    if (!local) return;
    try {
      if (what === 'mic') await local.setMicrophoneEnabled(!local.isMicrophoneEnabled);
      if (what === 'cam') await local.setCameraEnabled(!local.isCameraEnabled);
      if (what === 'screen') await local.setScreenShareEnabled(!local.isScreenShareEnabled);
    } catch {
      if (what !== 'screen') setError(what === 'mic' ? 'Нет доступа к микрофону' : 'Нет доступа к камере');
    }
    bump();
  };

  const audio = [...(lk?.remoteParticipants.values() ?? [])].flatMap((p) =>
    [Track.Source.Microphone, Track.Source.ScreenShareAudio].flatMap((src) => {
      const t = p.getTrackPublication(src)?.track;
      return t ? [<Media key={`${p.identity}-${src}`} track={t} kind="audio" />] : [];
    }),
  );

  if (props.minimized) {
    return (
      <div className="callbar" role="region" aria-label="Идущий звонок">
        <span className="callbar-dot" />
        <span className="callbar-title">Звонок · {room.name}</span>
        <span className="callbar-status">{status} · {participants.length} уч.</span>
        <button className="ghost" onClick={() => props.onMinimize(false)}>Вернуться</button>
        <button className="ghost danger" onClick={() => void leave()}>Завершить</button>
        {audio}
      </div>
    );
  }

  return (
    <div className="call" role="region" aria-label="Звонок">
      <div className="call-top">
        <div>
          <div className="call-title">{room.name}</div>
          <div className="call-status">
            {status} · {participants.length} {participants.length === 1 ? 'участник' : participants.length < 5 ? 'участника' : 'участников'}
          </div>
        </div>
        <button className="call-icon" onClick={() => props.onMinimize(true)} aria-label="Свернуть звонок" title="Свернуть">
          <Icon name="minimize" />
        </button>
      </div>
      {error && <div className="call-error" role="alert">{error}</div>}
      <div className={`call-stage${screen ? ' with-screen' : ''}`}>
        {screen && <Tile p={screen} local={screen === local} screen />}
        <div className={`call-grid n${Math.min(participants.length, 9)}`}>
          {participants.map((p) => (
            <Tile key={p.identity} p={p} local={p === local} />
          ))}
        </div>
      </div>
      <div className="call-controls">
        <button className={`call-btn${local?.isMicrophoneEnabled ? '' : ' off'}`} onClick={() => void toggle('mic')} aria-label={local?.isMicrophoneEnabled ? 'Выключить микрофон' : 'Включить микрофон'}>
          <Icon name={local?.isMicrophoneEnabled ? 'mic' : 'mic-off'} />
        </button>
        <button className={`call-btn${local?.isCameraEnabled ? '' : ' off'}`} onClick={() => void toggle('cam')} aria-label={local?.isCameraEnabled ? 'Выключить камеру' : 'Включить камеру'}>
          <Icon name={local?.isCameraEnabled ? 'video' : 'video-off'} />
        </button>
        <button className={`call-btn${local?.isScreenShareEnabled ? ' on' : ''}`} onClick={() => void toggle('screen')} aria-label="Показать экран">
          <Icon name="screen" />
        </button>
        <button className="call-btn hangup" onClick={() => void leave()} aria-label="Выйти из звонка">
          <Icon name="hangup" />
        </button>
      </div>
      {audio}
    </div>
  );
}
