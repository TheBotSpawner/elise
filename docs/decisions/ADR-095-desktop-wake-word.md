# ADR-095: "ELISE" wake word on Desktop, in the background

**Status:** Accepted (2026-10-19). Extends ADR-017 §7 (wake phrase) and ADR-081 (Desktop). §4's navigation to Inicio is
superseded by ADR-096 (a wake on another page stays there).

## Context

The person works in any app (VS Code, Chrome, a game) and says "ELISE, ¿qué tengo mañana?".
ELISE should answer out loud without opening, focusing or raising its window, with the window
hidden, minimized or in the tray, and keep the conversation for later.

What existed:

- **The web's wake phrase.** It uses the browser's Web Speech API. It is not available in
  Electron, it runs only while a session sleeps in a visible tab, and its availability is tied
  to "continuous conversation".
- **The voice session (legacy pipeline).** Voice capture with VAD, then cloud STT, the agent and
  TTS. It lives on Inicio and goes to sleep when the page is hidden. GPT-Live has no wake path.
- **Desktop's window.** It hides to the tray when `keepInBackground` is on, so the renderer stays
  alive. Started at login (`--background`), it created no window at all.

### Engines evaluated (official sources, 2026-10-19)

| Engine | What was tested | Result on "ELISE" (Rioplatense) | Code license | Model license | Commercial path |
|---|---|---|---|---|---|
| **Picovoice Porcupine** | Docs only: needs an AccessKey from a Picovoice Console account, and the custom keyword is trained there | Not measured: no account, and creating one is the person's decision | Apache-2.0 SDKs | Picovoice terms (per AccessKey) | Free plan for development. Commercial pricing isn't published: **quote required**. The key must not be shipped as a shared secret inside the app |
| **openWakeWord** | README | Not usable: "currently only supports English" | Apache-2.0 | Pretrained models **CC BY-NC-SA 4.0** (non-commercial) | A custom model needs a full training pipeline (TTS data, Python) |
| **sherpa-onnx KWS** | Pretrained model list | No Spanish model (only zh/en) | Apache-2.0 | Not stated per model | — |
| **Vosk (Kaldi), small Spanish model, grammar-restricted** | Measured: native (Python) and the WASM worker inside the packaged app, on a labeled set (see below) | **86–94 % detection in quiet, 0 false accepts** on the negative set | Apache-2.0 (vosk-browser, vosk-api) | **Apache-2.0** (vosk-model-small-es-0.42, 39.8 MB) | No per-device fees; redistribution allowed with attribution |

**Measurement set.** 120 clips of synthetic speech (OpenAI TTS, six voices, Rioplatense
instructions):

- positives: "ELISE" alone and in phrases;
- negatives: "Elisa…", "Eli se fue…", "Elías", "Elena", "felices", everyday speech;
- conditions: quiet, plus pink-ish noise at 20 dB and 10 dB SNR.

The set is synthetic: it is a proxy, and real voices must still be tested by hand.

**Results.**

- **A two-entry grammar ("elise" or anything) fails:** 100 % detection but **83 % false
  accepts**, because the decoder is forced to choose.
- **Free decoding** with the small model's language model never outputs "elise": 0 % detection.
- **The word plus ~250 competitor words** (frequent Spanish words and near-sounding names):

  | Runtime | Quiet | 20 dB | 10 dB | False accepts | Other |
  |---|---|---|---|---|---|
  | Native | 94 % | 86 % | 72 % | 0/84, and 0 in 4.7 min of continuous non-wake speech | — |
  | WASM inside the packaged app | 31/36 (86 %) | — | — | 0/84 | real-time factor 0.12 on speech |

  Misses are voices where "ELISE" sounded like "Elisa" or "Eli". Those stay competitors,
  because accepting them would chime and upload unrelated sentences.
- **Said the English way ("Elís", no final e).** The first real test (a person with a
  Bluetooth headset) showed that the Spanish "E-li-se" was always heard and "Elís" was not.
  The model's vocabulary has "elis", so the grammar now accepts both spellings. Native runtime,
  quiet / 20 dB:

  | Clips | Before | After |
  |---|---|---|
  | "ELISE" (36) | 34 / 32 | 36 / 36 |
  | "Elís" (24) | 21 / 17 | 23 / 23 |
  | False accepts (84) | 0 / 0 | 0 / 0 |

## Decision

1. **Engine: Vosk, small Spanish model, word + competitors grammar**, running locally in a
   WebAssembly worker. The model ships inside the installer:
   - `desktop/scripts/fetch-wake-model.mjs` downloads it before packaging, checks a pinned
     SHA-256 and repacks it;
   - it is never fetched at runtime and never committed to git.

   The word, its token, its competitors, its model file and its license are data
   (`WAKE_MODELS`, `src/core/voice/wake-detector.ts`). A new brand is a new entry and model.
   The `WakeDetector` contract is portable to a Home Hub (Linux ARM). Porcupine stays a drop-in
   option behind the same contract if a licensed key is ever provisioned.
2. **Where it runs.** In the app's own renderer, which keeps running with the window hidden.
   That is where Chromium gives the microphone, echo cancellation and device handling, and where
   the existing voice session lives. Reusing it avoids a second audio stack.
   - The recognizer runs in a worker served as its own file (`/vosk-worker.js`).
   - Its Emscripten bindings need `eval`, so that one response gets a CSP allowing eval inside
     the worker only. A worker has no DOM, cookies or session. The page's CSP stays strict.
   - The package's page code is not used: a 60-line client talks the worker's message protocol.
3. **Hand-off, not a second session.**
   - The detector (`desktop/src/renderer/wake/`) keeps up to 8 s of audio in memory only.
   - On the word, it plays a short chime (configurable) and captures from the word's own start
     (word times from the recognizer) to the end of what followed.
   - It sends that capture to the **existing** transcription endpoint. It hands over only if the
     transcript starts with the wake phrase (`matchWake`), which is a second check that drops
     mid-sentence mentions.
   - The words after it go to the one voice session as its turn (`requestDeviceWake` →
     `VoiceController.deviceWake`).
   - The session starts resting if none existed. When the room is still being calibrated, the
     words wait for it instead of being lost (bug fixed in `wakeUp`).
   - The session tells the device its phase. The detector stops listening while ELISE speaks
     or listens, which also prevents self-activation.
   - The detector keeps its microphone open through the conversation and hears nothing
     (`hold`). Releasing and reopening it around every conversation made Bluetooth headsets
     switch in and out of "call" mode, and they beep when they do.
4. **Never invasive.**
   - Nothing shows, focuses or raises the window: no `show()`, `focus()`, overlay or toast. If
     the session isn't on Inicio, the renderer navigates there inside the window.
   - Only "abrí ELISE", "mostrame esto en pantalla" (`asksToShow`) calls `showApp`.
   - Started at login with the setting on, the window is created hidden. It is not maximized,
     because `maximize()` would show it.
   - With background voice on, the window's background throttling is off.
   - The main process logs every show and focus, so this can be verified.
5. **The person's control.**
   - `wakeWord` is off by default and is turned on only after an informed-consent dialog. An
     update never turns it on.
   - Settings › ELISE Desktop has the toggle, the real status, a pause button and the chime
     toggle.
   - The tray shows the listening status and "Pausar / Reanudar escucha".
   - A locked screen or sleep releases the microphone; it comes back on unlock or resume.
   - During a background voice conversation (ELISE listening to the person or answering), her
     Orb shows in the bottom-right corner of the screen. It never shows while she only waits
     for "ELISE".
     - It is its own tiny window: it never takes focus or clicks.
     - It pops in when the conversation starts and follows it: listening, the person speaking,
       thinking, answering. The renderer reports only that state (`reportVoiceOrb`), never
       words.
     - Its size is 7.5 % of the screen's height (80–140 px), with the margins scaled to match.
     - Its page (`renderer/orb.html`) draws the real Orb renderer, and nothing else: no
       preload, no bridge.
     - It hides while ELISE's own window is in use.
     - A tap on it ends the conversation. Its page reports the tap as an in-page navigation to
       `#end`, so it still needs no bridge.
     - The orb's window is kept loaded and hidden while "ELISE" is on, so it appears the moment
       a conversation starts. While the words after "ELISE" are transcribed it already counts
       as a conversation.
     - A setting turns it off (`wakeOrb`, on by default).
   - A missing or denied microphone, or a failed model, shows the real state and retries every
     30 s.
   - "Salir" ends the process.
6. **Cost.**
   - Detection is local: no audio and no tokens before the word.
   - After the word: one STT call for the capture, then the usual turn (agent and TTS). No
     realtime connection stays open; Desktop uses the legacy pipeline while background voice is
     on.
   - The recognizer decodes only when the room has something like speech (energy gate, 0.5 s
     lead, 1.3 s hangover). Measured in a quiet room: about 3 % of one core in total.

## Consequences

- The installer grows by about 40 MB (the model) plus a 4.3 MB worker file.
- Detection on real voices still has to be confirmed by hand (synthetic set). Known misses:
  "ELISE" said like "Elisa" or "Eli".
- Latency from the end of speech to the first audio is about 4–8 s. Most of it is the cloud STT
  of the capture. Faster STT is the next lever.
- If the session is on another ELISE page in a visible window, a wake navigates it to Inicio.
- Output device selection and a mic picker aren't in v1: the system default is used.
- Offline, the detector keeps listening and a wake plays an error tone. Answers need ELISE
  Cloud.
