import { useEffect, useReducer, useRef, useState } from 'react';
import { ConnectionState, Room, RoomEvent, Track, type Participant, type Track as LkTrack } from 'livekit-client';
import type { MatrixClient, Room as MatrixRoom } from 'matrix-js-sdk';
import { EventType, RoomType } from '@konsilium/protocol';
import { activeCall, formatDuration, isHuman, markCallEnded, markCallStarted, requestCallToken, setSecretary } from '../call.ts';
import type { Session } from '../matrix.ts';
import { avatarColor, initials, isConsiliumLead, parseConsilium, parseConsiliumCurrent } from '../model.ts';
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
  const [secretary, setSecretaryAvail] = useState<{ eta_minutes: number } | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  // Стенограмму можно включить, только когда звонок уже отмечен в комнате: иначе отметка начала звонка (без признака
  // стенограммы) могла лечь поверх состояния, которое записал сервис, и индикатор пропадал при идущей записи.
  const [callMarked, setCallMarked] = useState(false);
  const [aiNote, setAiNote] = useState<string | null>(null);
  // После «Остановить» агент дочитывает звук и отдаёт итоги — до снятия индикатора кнопка неактивна.
  const [aiStopping, setAiStopping] = useState(false);

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
        // Стенограмма — в чатах случаев и на консилиумах: итоги публикует сервис, он в этих комнатах есть.
        const clinical = room.getType() === RoomType.Case || room.getType() === RoomType.Consilium;
        setSecretaryAvail(clinical ? (t.secretary ?? null) : null);
        await lkRoom.connect(t.url, t.token);
        if (!alive) return void lkRoom.disconnect();
        setStartedAt(Date.now());
        const kind = clinical ? 'consilium' : 'direct';
        void markCallStarted(client, room, kind)
          .catch(() => undefined)
          .finally(() => alive && setCallMarked(true));
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
    // Последний вышедший человек закрывает звонок в комнате (ИИ-агент не в счёт — он выйдет сам).
    if (lk && ![...lk.remoteParticipants.values()].some((p) => isHuman(p.identity))) await markCallEnded(client, room).catch(() => undefined);
    await lk?.disconnect();
    props.onLeave();
  }

  const local = lk?.localParticipant;
  // Плитки — только люди; ИИ-«Секретарь» виден индикатором стенограммы.
  const participants: Participant[] = lk && local ? [local, ...[...lk.remoteParticipants.values()].filter((p) => isHuman(p.identity))] : [];
  const transcription = activeCall(room)?.transcription;
  // Индикатор — и по состоянию комнаты, и по факту: ИИ-агент подключён к звонку (токены агентам выдаёт только сервис).
  const agentListening = [...(lk?.remoteParticipants.values() ?? [])].some((p) => !isHuman(p.identity));
  const recording = !!transcription || agentListening;
  useEffect(() => {
    if (!transcription) setAiStopping(false);
  }, [transcription]);

  async function toggleTranscript() {
    setAiBusy(true);
    setError(null);
    try {
      const r = await setSecretary(session, room.roomId, transcription ? 'stop' : 'start');
      setAiStopping(r.status !== 'started');
      setAiNote(
        r.status === 'started'
          ? null
          : `Стенограмма остановлена. Стенограмма и черновик протокола появятся в чате${secretary ? ` примерно через ${secretary.eta_minutes} мин` : ''}.`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAiBusy(false);
    }
  }
  const transcriptBadge = recording && (
    <span className="rec" role="status" title="Речь участников распознаётся в контуре организации">
      Стенограмма (ИИ)
    </span>
  );
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
        {transcriptBadge}
        <button className="ghost" onClick={() => props.onMinimize(false)}>Вернуться</button>
        <button className="ghost danger" onClick={() => void leave()}>Завершить</button>
        {audio}
      </div>
    );
  }

  // Консилиум: текущий случай повестки прямо в звонке — ведущие переключают его, не сворачивая видео.
  const consilium = room.getType() === RoomType.Consilium ? parseConsilium(room.currentState.getStateEvents(EventType.Consilium, '')?.getContent()) : null;
  const current = consilium ? parseConsiliumCurrent(room.currentState.getStateEvents(EventType.ConsiliumCurrent, '')?.getContent(), consilium.agenda.length) : 0;
  const item = consilium?.agenda[current];
  const lead = isConsiliumLead(consilium, client.getUserId() ?? '');
  const memberName = (id: string) => room.getMember(id)?.name ?? id;

  return (
    <div className="call" role="region" aria-label="Звонок">
      <div className="call-top">
        <div>
          <div className="call-title">{room.name}</div>
          <div className="call-status">
            {status} · {participants.length} {participants.length === 1 ? 'участник' : participants.length < 5 ? 'участника' : 'участников'}
            {transcriptBadge}
          </div>
        </div>
        <button className="call-icon" onClick={() => props.onMinimize(true)} aria-label="Свернуть звонок" title="Свернуть">
          <Icon name="minimize" />
        </button>
      </div>
      {consilium && item && (
        <div className="call-agenda" role="group" aria-label="Текущий случай">
          <span className="agenda-num">
            {current + 1}/{consilium.agenda.length}
          </span>
          <span className="mono">{item.case_id}</span>
          <span>
            {item.patient.masked}
            {item.patient.age !== undefined ? `, ${item.patient.age}` : ''} · {item.title}
          </span>
          {item.presenter && <span className="muted">докл. {memberName(item.presenter)}</span>}
          {lead && current < consilium.agenda.length - 1 && (
            <button
              className="ghost"
              onClick={() => void client.sendStateEvent(room.roomId, EventType.ConsiliumCurrent as never, { index: current + 1 } as never, '').catch(() => undefined)}
            >
              <Icon name="next" size={16} /> Следующий случай
            </button>
          )}
        </div>
      )}
      {error && <div className="call-error" role="alert">{error}</div>}
      {aiNote && (
        <div className="call-note" role="status">
          {aiNote}
        </div>
      )}
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
        {(secretary || transcription) && (
          <button
            className={`call-btn${transcription ? ' on' : ''}`}
            onClick={() => void toggleTranscript()}
            disabled={aiBusy || aiStopping || (!transcription && !callMarked)}
            aria-pressed={!!transcription}
            aria-label={transcription ? 'Остановить стенограмму' : 'Включить стенограмму (ИИ)'}
            title={transcription ? 'Остановить стенограмму' : `Стенограмма и черновик протокола (ИИ-«Секретарь»)${secretary ? `, итоги ~${secretary.eta_minutes} мин после звонка` : ''}`}
          >
            <Icon name="transcript" />
          </button>
        )}
        <button className="call-btn hangup" onClick={() => void leave()} aria-label="Выйти из звонка">
          <Icon name="hangup" />
        </button>
      </div>
      {audio}
    </div>
  );
}
