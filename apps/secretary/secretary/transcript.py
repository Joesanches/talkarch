"""Сборка стенограммы из результатов распознавания. Без сети — проверяется модульными тестами."""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Segment:
    speaker: str
    name: str
    start: float
    end: float
    text: str


@dataclass
class SpeakerTrack:
    """Дорожка одного участника: смещение её начала от начала сессии и распознанные фразы."""

    identity: str
    name: str
    offset: float
    segments: list[Segment] = field(default_factory=list)

    def add_result(self, result: dict) -> Segment | None:
        """Финальный результат Vosk: {"text": "...", "result": [{"word", "start", "end", "conf"}]}."""
        text = (result.get("text") or "").strip()
        words = result.get("result") or []
        if not text or not words:
            return None
        seg = Segment(
            speaker=self.identity,
            name=self.name,
            start=round(self.offset + float(words[0]["start"]), 2),
            end=round(self.offset + float(words[-1]["end"]), 2),
            text=text,
        )
        self.segments.append(seg)
        return seg


def merge(tracks: list[SpeakerTrack]) -> list[dict]:
    """
    Все фразы по времени, с номерами — на них ссылается черновик протокола.
    Время — целые миллисекунды: в событиях Matrix (канонический JSON) дробные числа запрещены.
    """
    segments = sorted((s for t in tracks for s in t.segments), key=lambda s: (s.start, s.speaker))
    return [
        {"i": i, "speaker": s.speaker, "name": s.name, "start_ms": round(s.start * 1000), "end_ms": round(s.end * 1000), "text": s.text}
        for i, s in enumerate(segments)
    ]


def silence_to_fill(expected_bytes: int, received_bytes: int, sample_rate: int, max_gap_s: float = 30.0) -> int:
    """
    Сколько байт тишины дописать, чтобы время в потоке распознавания совпадало с реальным:
    пока микрофон выключен, кадры не приходят, а метки времени Vosk считаются по поданному звуку.
    """
    gap = expected_bytes - received_bytes
    min_gap = sample_rate * 2 // 2  # полсекунды 16-битного звука
    if gap < min_gap:
        return 0
    return min(gap, int(sample_rate * 2 * max_gap_s)) // 2 * 2
