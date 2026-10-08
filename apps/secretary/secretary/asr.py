"""Потоковое распознавание через сервер Vosk (WebSocket, протокол vosk-server)."""
from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Callable

import websockets

log = logging.getLogger("secretary.asr")

# vosk-server сравнивает признак конца потока со строкой буквально — с пробелом перед двоеточием.
EOF_MESSAGE = '{"eof" : 1}'


class VoskStream:
    """Один поток распознавания на дорожку участника. Финальные фразы — в on_result."""

    def __init__(self, url: str, sample_rate: int, on_result: Callable[[dict], None]):
        self.url = url
        self.sample_rate = sample_rate
        self.on_result = on_result
        self._ws = None
        self._lock = asyncio.Lock()

    async def open(self) -> None:
        self._ws = await websockets.connect(self.url, max_size=None, open_timeout=30)
        await self._ws.send(json.dumps({"config": {"sample_rate": self.sample_rate, "words": 1}}))

    async def feed(self, pcm: bytes) -> None:
        # Сервер отвечает на каждый кусок звука (частичный или финальный результат).
        async with self._lock:
            await self._ws.send(pcm)
            self._handle(json.loads(await self._ws.recv()))

    async def close(self) -> None:
        if not self._ws:
            return
        async with self._lock:
            try:
                await self._ws.send(EOF_MESSAGE)
                self._handle(json.loads(await asyncio.wait_for(self._ws.recv(), timeout=120)))
            except Exception as e:  # noqa: BLE001 — финал не должен ронять сессию
                log.warning("Финальный результат не получен: %s", e)
            finally:
                await self._ws.close()
                self._ws = None

    def _handle(self, msg: dict) -> None:
        if msg.get("text") and msg.get("result"):
            self.on_result(msg)
