from secretary.transcript import SpeakerTrack, merge, silence_to_fill


def vosk(text: str, start: float, end: float) -> dict:
    words = text.split()
    step = (end - start) / len(words)
    return {"text": text, "result": [{"word": w, "start": start + i * step, "end": start + (i + 1) * step, "conf": 1.0} for i, w in enumerate(words)]}


def test_segments_are_attributed_and_ordered_by_time():
    a = SpeakerTrack("@smirnova:x", "Смирнова А. В.", offset=2.0)
    b = SpeakerTrack("@kolesnikov:x", "Колесников Д. А.", offset=5.0)
    a.add_result(vosk("рецепторы эстрогена положительные", 0.5, 3.0))
    b.add_result(vosk("предлагаю гормональную терапию", 1.0, 3.0))
    a.add_result(vosk("согласна", 6.0, 6.5))
    out = merge([a, b])
    assert [s["name"] for s in out] == ["Смирнова А. В.", "Колесников Д. А.", "Смирнова А. В."]
    assert [s["i"] for s in out] == [0, 1, 2]
    assert out[0]["start_ms"] == 2500 and out[1]["start_ms"] == 6000 and out[2]["end_ms"] == 8500
    assert all(isinstance(s["start_ms"], int) and isinstance(s["end_ms"], int) for s in out)


def test_empty_results_are_ignored():
    a = SpeakerTrack("@a:x", "A", offset=0)
    assert a.add_result({"text": "", "result": []}) is None
    assert a.add_result({"partial": "что-то"}) is None
    assert merge([a]) == []


def test_silence_fill_keeps_timeline_after_muted_microphone():
    rate = 16_000
    assert silence_to_fill(expected_bytes=rate, received_bytes=rate - 100, sample_rate=rate) == 0  # мелкий джиттер
    assert silence_to_fill(expected_bytes=rate * 2 * 3, received_bytes=rate * 2, sample_rate=rate) == rate * 2 * 2
    assert silence_to_fill(expected_bytes=rate * 2 * 100, received_bytes=0, sample_rate=rate, max_gap_s=30) == rate * 2 * 30
