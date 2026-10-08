"""Сессия «Секретаря»: агент в звонке LiveKit слушает каждую дорожку и собирает стенограмму."""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timezone

import aiohttp
from livekit import rtc

from .asr import VoskStream
from .transcript import SpeakerTrack, merge, silence_to_fill

log = logging.getLogger("secretary.session")

SAMPLE_RATE = 16_000
# Звук уходит в распознавание кусками по 0,2 с: кадры WebRTC по 10 мс — слишком частые запросы к серверу Vosk.
CHUNK_BYTES = SAMPLE_RATE * 2 // 5
EMPTY_ROOM_GRACE_S = 15
MAX_SESSION_S = 4 * 3600


def iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat().replace("+00:00", "Z")


@dataclass
class SessionConfig:
    session_id: str
    livekit_url: str
    token: str
    asr_url: str
    callback_url: str
    callback_token: str


class Session:
    def __init__(self, cfg: SessionConfig):
        self.cfg = cfg
        self.room = rtc.Room()
        self.started = time.time()
        self.stop_requested = asyncio.Event()
        self.tracks: list[SpeakerTrack] = []
        self.participants: dict[str, str] = {}
        self._consumers: list[asyncio.Task] = []
        self._streams: list[VoskStream] = []
        self._finished = asyncio.Event()

    def stop(self) -> None:
        self.stop_requested.set()

    async def run(self) -> None:
        @self.room.on("track_subscribed")
        def _on_track(track: rtc.Track, _pub: rtc.RemoteTrackPublication, participant: rtc.RemoteParticipant):
            if track.kind == rtc.TrackKind.KIND_AUDIO and participant.identity.startswith("@"):
                self._consumers.append(asyncio.create_task(self._consume(track, participant)))

        @self.room.on("participant_connected")
        def _on_join(p: rtc.RemoteParticipant):
            if p.identity.startswith("@"):
                self.participants[p.identity] = p.name or p.identity

        try:
            await self.room.connect(self.cfg.livekit_url, self.cfg.token, options=rtc.RoomOptions(auto_subscribe=True))
            for p in self.room.remote_participants.values():
                if p.identity.startswith("@"):
                    self.participants[p.identity] = p.name or p.identity
            log.info("Сессия %s: в звонке, участников %d", self.cfg.session_id, len(self.participants))
            await self._wait_until_done()
        except Exception:  # noqa: BLE001
            log.exception("Сессия %s: ошибка", self.cfg.session_id)
        finally:
            await self._finish()

    def _humans(self) -> int:
        return sum(1 for p in self.room.remote_participants.values() if p.identity.startswith("@"))

    async def _wait_until_done(self) -> None:
        """До кнопки «Стоп», конца звонка (никого из людей 15 с) или предельной длительности."""
        empty_since: float | None = None
        while not self.stop_requested.is_set():
            if time.time() - self.started > MAX_SESSION_S:
                return
            if self._humans() == 0:
                empty_since = empty_since or time.time()
                if time.time() - empty_since > EMPTY_ROOM_GRACE_S:
                    return
            else:
                empty_since = None
            try:
                await asyncio.wait_for(self.stop_requested.wait(), timeout=1)
            except TimeoutError:
                pass

    async def _consume(self, track: rtc.Track, participant: rtc.RemoteParticipant) -> None:
        name = participant.name or participant.identity
        self.participants[participant.identity] = name
        speaker = SpeakerTrack(identity=participant.identity, name=name, offset=round(time.time() - self.started, 2))
        self.tracks.append(speaker)
        vosk = VoskStream(self.cfg.asr_url, SAMPLE_RATE, lambda r: self._on_result(speaker, r))
        await vosk.open()
        self._streams.append(vosk)
        stream = rtc.AudioStream(track, sample_rate=SAMPLE_RATE, num_channels=1)
        track_start = time.time()
        sent = 0
        buf = bytearray()
        try:
            async for event in stream:
                pcm = event.frame.data.tobytes()
                # Пока микрофон был выключен, кадры не шли — дописываем тишину, чтобы время не «уехало».
                gap = silence_to_fill(int((time.time() - track_start) * SAMPLE_RATE * 2) - len(pcm), sent + len(buf), SAMPLE_RATE)
                buf += b"\x00" * gap + pcm
                if len(buf) >= CHUNK_BYTES:
                    await vosk.feed(bytes(buf))
                    sent += len(buf)
                    buf.clear()
                if self.stop_requested.is_set():
                    break
            if buf:
                await vosk.feed(bytes(buf))
        except asyncio.CancelledError:
            pass
        except Exception:  # noqa: BLE001
            log.exception("Дорожка %s: ошибка распознавания", participant.identity)
        finally:
            await stream.aclose()

    def _on_result(self, speaker: SpeakerTrack, result: dict) -> None:
        seg = speaker.add_result(result)
        if seg:
            log.info("%.1f %s: %s", seg.start, seg.name, seg.text)

    async def _finish(self) -> None:
        if self._finished.is_set():
            return
        self._finished.set()
        ended = time.time()
        self.stop_requested.set()
        # Дорожки дочитывают текущий кусок звука сами; кто молчит (кадров нет) — снимаем.
        _done, pending = await asyncio.wait(self._consumers, timeout=2) if self._consumers else (set(), set())
        for task in pending:
            task.cancel()
        await asyncio.gather(*self._consumers, return_exceptions=True)
        # Досчитываем хвосты: финальные результаты по каждой дорожке.
        await asyncio.gather(*(s.close() for s in self._streams), return_exceptions=True)
        await self.room.disconnect()
        payload = {
            "session_id": self.cfg.session_id,
            "started_at": iso(self.started),
            "ended_at": iso(ended),
            "participants": [{"identity": i, "name": n} for i, n in self.participants.items()],
            "segments": merge(self.tracks),
            "asr": {"engine": "vosk"},
        }
        await post_result(self.cfg.callback_url, self.cfg.callback_token, payload)


async def post_result(url: str, token: str, payload: dict, attempts: int = 5) -> None:
    """Отдать результат сервису контекста; при недоступности — повторы с паузой."""
    async with aiohttp.ClientSession() as http:
        for attempt in range(1, attempts + 1):
            try:
                async with http.post(url, json=payload, headers={"authorization": f"Bearer {token}"}, timeout=aiohttp.ClientTimeout(total=30)) as r:
                    if r.status < 300:
                        log.info("Результат %s передан, фраз %d", payload["session_id"], len(payload["segments"]))
                        return
                    if r.status < 500:
                        # Повтор не поможет: сервис отверг результат (неизвестная сессия, неверный формат).
                        log.error("Результат %s отклонён: %s %s", payload["session_id"], r.status, (await r.text())[:500])
                        return
                    log.warning("Сервис контекста ответил %s", r.status)
            except Exception as e:  # noqa: BLE001
                log.warning("Результат не передан (попытка %d): %s", attempt, e)
            await asyncio.sleep(min(2**attempt, 30))
    log.error("Результат сессии %s потерян после %d попыток", payload["session_id"], attempts)
