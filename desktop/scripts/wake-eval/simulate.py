"""
Wake word evaluation (ADR-108): runs the real model (vosk-model-small-es-0.42, the one shipped in
the installer) over the synthetic corpus under simulated conditions, and records what the
recognizer said and when — text and timing only, never audio — into
tests/fixtures/wake-eval-traces.json. The TypeScript decision logic that ships replays those
traces (tests/unit/voice/wake-eval.test.ts): one implementation of the rules, measured.

Conditions:
- distance: 0.5 m (speech at -22 dBFS), 1.5 m (-9.5 dB, reverb), 3 m (-15.6 dB, more reverb);
- background: quiet room (-58 dBFS noise), soft music (-40 dBFS), loud music (-30 dBFS),
  meeting babble (other voices at -34 dBFS);
- the detector's energy gate, as shipped before ADR-108 ("v1") and after ("v2").

Limits: synthetic voices; no microphone, no echo cancellation or automatic gain control (a real
microphone's AGC raises far voices, and its noise); music without vocals. Results are a proxy.

Usage (Python 3.10+, `pip install vosk numpy`), after generate_clips.py:
    python desktop/scripts/wake-eval/simulate.py
"""

import json
import math
import pathlib
import re
import tarfile
import wave

import numpy as np
from vosk import KaldiRecognizer, Model, SetLogLevel

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[2]
CLIPS = HERE / ".clips"
MODEL_TAR = ROOT / "desktop/assets/wake/vosk-model-small-es-0.42.tar.gz"
OUT = ROOT / "tests/fixtures/wake-eval-traces.json"
RATE = 16_000
FRAME = 2048  # 128 ms, as in the detector

# The energy gate (desktop/src/renderer/wake/vosk-detector.ts): v1 before ADR-108, v2 after.
GATES = {
    "v1": {"ratio": 3.0, "floor_min": 0.012, "lead": 4, "hangover": 10},
    "v2": {"ratio": 2.0, "floor_min": 0.0035, "lead": 4, "hangover": 10},
}
DISTANCES = {"d050": (0.0, 0.0), "d150": (-9.5, 0.35), "d300": (-15.6, 0.5)}
BACKGROUNDS = {"quiet": -58.0, "music_soft": -40.0, "music_loud": -30.0, "babble": -34.0}


def grammar() -> list:
    src = (ROOT / "src/core/voice/wake-detector.ts").read_text(encoding="utf8")
    block = src[src.index("const ES_COMPETITORS = [") : src.index("] as const;")]
    competitors = re.findall(r'"([^"]+)"', block)
    tokens = re.findall(r'tokens: \[([^\]]+)\]', src)[0]
    return re.findall(r'"([^"]+)"', tokens) + competitors + ["[unk]"]


def tokens() -> list:
    src = (ROOT / "src/core/voice/wake-detector.ts").read_text(encoding="utf8")
    return re.findall(r'"([^"]+)"', re.findall(r'tokens: \[([^\]]+)\]', src)[0])


def model() -> Model:
    target = CLIPS / "model"
    if not target.exists():
        with tarfile.open(MODEL_TAR) as t:
            t.extractall(target)
    inner = next(p for p in target.rglob("am") if p.is_dir()).parent
    return Model(str(inner))


def read(path: pathlib.Path) -> np.ndarray:
    with wave.open(str(path)) as w:
        x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float64) / 32768
        rate = w.getframerate()
    return resample(x, rate, RATE)


def lowpass(x: np.ndarray, cutoff: float, rate: int, taps: int = 101) -> np.ndarray:
    n = np.arange(taps) - (taps - 1) / 2
    h = np.sinc(2 * cutoff / rate * n) * np.hanning(taps)
    h /= h.sum()
    return np.convolve(x, h, mode="same")


def resample(x: np.ndarray, rate: int, target: int) -> np.ndarray:
    if rate == target:
        return x
    y = lowpass(x, 0.45 * min(rate, target), rate)
    t = np.arange(int(len(y) * target / rate)) * rate / target
    return np.interp(t, np.arange(len(y)), y)


def db(v: float) -> float:
    return 10 ** (v / 20)


def active_rms(x: np.ndarray) -> float:
    frames = x[: len(x) // 320 * 320].reshape(-1, 320)
    r = np.sqrt((frames**2).mean(axis=1))
    loud = r[r > r.max() * 0.1]
    return float(np.sqrt((loud**2).mean())) if len(loud) else 1e-6


def reverb(x: np.ndarray, rt60: float, rng: np.random.Generator) -> np.ndarray:
    if rt60 <= 0:
        return x
    n = int(rt60 * RATE)
    t = np.arange(n) / RATE
    tail = rng.standard_normal(n) * np.exp(-6.9 * t / rt60)
    tail[: int(0.005 * RATE)] = 0
    tail *= 0.35 / math.sqrt((tail**2).sum())
    ir = np.zeros(n)
    ir[0] = 1.0
    ir += tail
    spec = np.fft.rfft(x, len(x) + n) * np.fft.rfft(ir, len(x) + n)
    return np.fft.irfft(spec)[: len(x)]


def pink(n: int, rng: np.random.Generator) -> np.ndarray:
    white = rng.standard_normal(n)
    f = np.fft.rfft(white)
    f /= np.sqrt(np.maximum(np.arange(len(f)), 1))
    y = np.fft.irfft(f, n)
    return y / np.sqrt((y**2).mean())


def music(n: int, rng: np.random.Generator) -> np.ndarray:
    """Synthetic music without vocals: chords, bass, kick and hi-hat at 110 bpm."""
    t = np.arange(n) / RATE
    beat = 60 / 110
    chords = [(220, 277.2, 329.6), (196, 246.9, 293.7), (174.6, 220, 261.6), (196, 246.9, 311.1)]
    y = np.zeros(n)
    for i in range(int(n / RATE / (beat * 4)) + 1):
        a, b = int(i * beat * 4 * RATE), int((i + 1) * beat * 4 * RATE)
        seg = t[a:b] - t[a] if a < n else None
        if seg is None or not len(seg):
            break
        for f in chords[i % 4]:
            for h, g in ((1, 1), (2, 0.4), (3, 0.2)):
                y[a : a + len(seg)] += g * np.sin(2 * np.pi * f * h * seg)
        y[a : a + len(seg)] += 0.8 * np.sin(2 * np.pi * chords[i % 4][0] / 2 * seg)
    for k in range(int(n / RATE / beat) + 1):
        s = int(k * beat * RATE)
        if s >= n:
            break
        m = min(n - s, int(0.12 * RATE))
        env = np.exp(-np.arange(m) / (0.03 * RATE))
        y[s : s + m] += 3 * env * np.sin(2 * np.pi * 55 * np.arange(m) / RATE)
        h = min(n - s, int(0.04 * RATE))
        y[s : s + h] += 0.6 * rng.standard_normal(h) * np.exp(-np.arange(h) / (0.01 * RATE))
    return y / np.sqrt((y**2).mean())


def babble(n: int, negatives: list, rng: np.random.Generator) -> np.ndarray:
    y = np.zeros(n)
    for _ in range(3):
        at = 0
        while at < n:
            c = negatives[rng.integers(len(negatives))]
            m = min(len(c), n - at)
            y[at : at + m] += c[:m] / active_rms(c)
            at += m + int(rng.integers(0, RATE // 2))
    return y / max(np.sqrt((y**2).mean()), 1e-9)


def scene(speech: np.ndarray, distance: str, background: str, rng, negatives) -> tuple:
    gain_db, rt60 = DISTANCES[distance]
    s = speech / active_rms(speech) * db(-22 + gain_db)
    s = reverb(s, rt60, rng)
    lead, tail = int(2.0 * RATE), int(1.5 * RATE)
    n = lead + len(s) + tail
    room = pink(n, rng) * db(-58)
    if background.startswith("music"):
        room += music(n, rng) * db(BACKGROUNDS[background])
    elif background == "babble":
        room += babble(n, negatives, rng) * db(BACKGROUNDS[background])
    x = room.copy()
    x[lead : lead + len(s)] += s
    return np.clip(x, -1, 1), lead / RATE


def run(rec_factory, x: np.ndarray, gate: dict) -> list:
    """The detector's gate in front of the recognizer, frame by frame; recognizer events out."""
    rec = rec_factory()
    events, floor, open_left, last_partial, fed = [], 0.004, 0, "", set()
    frames = [x[i : i + FRAME] for i in range(0, len(x) - FRAME + 1, FRAME)]

    def feed(i: int):
        nonlocal last_partial
        if i in fed:
            return
        fed.add(i)
        pcm = (np.clip(frames[i], -1, 1) * 32767).astype(np.int16).tobytes()
        if rec.AcceptWaveform(pcm):
            r = json.loads(rec.Result())
            if r.get("text"):
                events.append({"f": i, "type": "final", "text": r["text"], "words": [
                    {k: round(w[k], 3) if k != "word" else w[k] for k in ("word", "conf", "start", "end")}
                    for w in r.get("result", [])
                ]})
            last_partial = ""
        else:
            p = json.loads(rec.PartialResult()).get("partial", "")
            if p and p != last_partial:
                events.append({"f": i, "type": "partial", "text": p})
            last_partial = p

    for i, f in enumerate(frames):
        rms = float(np.sqrt((f**2).mean()))
        floor = floor * 0.95 + min(rms, 0.05) * 0.05
        if rms > max(floor * gate["ratio"], gate["floor_min"]):
            if open_left == 0:
                for j in range(max(0, i - gate["lead"]), i):
                    feed(j)
            open_left = gate["hangover"]
        elif open_left > 0:
            open_left -= 1
        if open_left > 0:
            feed(i)
    r = json.loads(rec.FinalResult())
    if r.get("text"):
        events.append({"f": len(frames), "type": "final", "text": r["text"], "words": [
            {k: round(w[k], 3) if k != "word" else w[k] for k in ("word", "conf", "start", "end")}
            for w in r.get("result", [])
        ]})
    return events, len(fed), len(frames)


def main() -> None:
    SetLogLevel(-1)
    rng = np.random.default_rng(108)
    manifest = json.loads((CLIPS / "manifest.json").read_text(encoding="utf8"))
    m = model()
    g = json.dumps(grammar(), ensure_ascii=False)

    def factory():
        r = KaldiRecognizer(m, RATE, g)
        r.SetWords(True)
        return r

    audio = {c["file"]: read(CLIPS / c["file"]) for c in manifest}
    negatives = [audio[c["file"]] for c in manifest if c["kind"] == "neg"]
    traces = []
    for c in manifest:
        x0 = audio[c["file"]]
        conditions = (
            [(d, b) for d in DISTANCES for b in ("quiet", "music_soft", "music_loud", "babble")]
            if c["kind"] == "pos"
            else [(d, b) for d in ("d050", "d150") for b in ("quiet", "music_soft")]
        )
        for d, b in conditions:
            x, onset = scene(x0, d, b, rng, negatives)
            for name, gate in GATES.items():
                events, fed, total = run(factory, x, gate)
                traces.append({
                    "clip": c["file"].removesuffix(".wav"),
                    "kind": c["kind"],
                    "phrase": c["name"],
                    "distance": d,
                    "background": b,
                    "gate": name,
                    "speechAt": round(onset, 3),
                    "seconds": round(len(x) / RATE, 3),
                    "fedFrames": fed,
                    "frames": total,
                    "events": events,
                })
        print(c["file"], flush=True)
    OUT.write_text(json.dumps({"tokens": tokens(), "frameMs": FRAME * 1000 // RATE, "traces": traces},
                              ensure_ascii=False), encoding="utf8")
    print(f"{len(traces)} traces -> {OUT}")


if __name__ == "__main__":
    main()
