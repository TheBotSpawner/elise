"""
Wake word evaluation corpus (ADR-108): synthetic Rioplatense speech from OpenAI TTS, cached in
desktop/scripts/wake-eval/.clips (ignored by git). Synthetic voices are a proxy: real voices,
rooms and microphones must still be checked by hand (docs/engineering/31-desktop-wake-and-audio.md).

Usage (from the repo root, once; about 70 short clips, a few US cents):
    python desktop/scripts/wake-eval/generate_clips.py

The key is read from OPENAI_API_KEY or .env.local and never printed.
"""

import json
import os
import pathlib
import struct
import sys
import urllib.request
import wave

ROOT = pathlib.Path(__file__).resolve().parents[3]
OUT = pathlib.Path(__file__).resolve().parent / ".clips"
VOICES = ["alloy", "ash", "coral", "echo", "sage", "shimmer"]
STYLE = (
    "Hablá en español rioplatense (Buenos Aires), natural, a volumen de conversación normal, "
    "como alguien que le habla a una asistente desde el escritorio."
)

# Positives: the word alone, with a pause, in one breath with a request, and said the English way.
POSITIVES = [
    ("alone", "Elise."),
    ("pause", "Elise... poné música tranquila."),
    ("breath", "Elise, ¿qué tengo hoy?"),
    ("breath2", "Elise, ¿cómo voy hasta el centro?"),
    ("english", "Elís, ¿cómo está el clima?"),
]
# Negatives: names and words that sound alike, the name inside a sentence, and meeting talk.
NEGATIVES = [
    ("elisa", "Elisa me dijo que la reunión se pasa para el jueves."),
    ("eli", "Eli se fue temprano porque tenía turno con el médico."),
    ("felices", "Felices fiestas a todos, nos vemos el año que viene."),
    ("elias", "Elías llega mañana a la mañana con los papeles."),
    ("elena", "Elena, ¿podés compartir la pantalla un segundo?"),
    ("midname", "Le dije a Elise que revise el informe antes del viernes."),
    ("meeting1", "Bueno, arrancamos. El primer tema es el presupuesto del trimestre."),
    ("meeting2", "Yo creo que tenemos que priorizar el cliente nuevo antes que lo otro."),
    ("meeting3", "¿Alguien tiene los números de ventas de la semana pasada?"),
    ("meeting4", "Perfecto, entonces quedamos así y lo revisamos el lunes."),
    ("meeting5", "Esperá que no te escucho bien, se te corta un poco el audio."),
    ("meeting6", "Eliminá esa diapositiva, está repetida con la anterior."),
    ("meeting7", "Es lisa y llanamente un problema de comunicación entre equipos."),
    ("meeting8", "El ise de la planilla no coincide con lo que mandaron."),
]
NEG_VOICES = ["alloy", "coral", "echo", "shimmer"]


def api_key() -> str:
    key = os.environ.get("OPENAI_API_KEY")
    if key:
        return key
    env = ROOT / ".env.local"
    if env.exists():
        for line in env.read_text(encoding="utf8").splitlines():
            if line.startswith("OPENAI_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"')
    sys.exit("OPENAI_API_KEY not set (env or .env.local)")


def tts(text: str, voice: str, key: str) -> bytes:
    body = json.dumps(
        {
            "model": "gpt-4o-mini-tts",
            "voice": voice,
            "input": text,
            "instructions": STYLE,
            "response_format": "pcm",
        }
    ).encode()
    req = urllib.request.Request(
        "https://api.openai.com/v1/audio/speech",
        data=body,
        headers={"authorization": f"Bearer {key}", "content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()  # 24 kHz mono 16-bit PCM


def save(path: pathlib.Path, pcm: bytes) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(pcm)


def main() -> None:
    key = api_key()
    OUT.mkdir(exist_ok=True)
    jobs = [("pos", n, t, v) for n, t in POSITIVES for v in VOICES] + [
        ("neg", n, t, v) for n, t in NEGATIVES for v in NEG_VOICES
    ]
    made = 0
    for kind, name, text, voice in jobs:
        path = OUT / f"{kind}-{name}-{voice}.wav"
        if path.exists():
            continue
        save(path, tts(text, voice, key))
        made += 1
    manifest = [
        {"file": f"{k}-{n}-{v}.wav", "kind": k, "name": n, "voice": v, "text": t}
        for k, n, t, v in jobs
    ]
    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf8")
    print(f"clips: {len(jobs)} ({made} new) in {OUT}")


if __name__ == "__main__":
    main()
