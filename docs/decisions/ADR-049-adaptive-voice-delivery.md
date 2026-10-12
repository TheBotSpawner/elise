# ADR-049: Adaptive voice delivery (whisper mode)

**Status:** Accepted (2026-10-12). Extends ADR-014 (voice), ADR-017 (turn taking), ADR-030
(spoken output), ADR-034 (acknowledgements) and ADR-042 §J (music ducking). No migration.

## Context

When the user speaks quietly or whispers (a library, a commute, late at night), ELISE should
lower her own delivery, and whisper back when that is clearly what is happening. The
transcript can't tell: "ELISE, qué reuniones tengo mañana" reads the same whispered or not.
The decision has to come from the audio, without adding latency, without another model call,
and without sending audio anywhere new.

## Decision

### 1. Delivery is its own state

`VoiceDelivery = normal | quiet | whisper` (`core/voice/delivery.ts`). It is separate from the
interaction phase: `VoiceState.delivery` sits next to `phase`, so "speaking" can be whispered.
The phase machine is unchanged.

### 2. Detected from the user's audio, while they speak

`VoiceDeliveryDetector` is the capability interface: `frame(pcm, rate, noiseFloor)` while the
user speaks, and `analyze(baseline)` when the turn ends. `PcmDeliveryDetector` is the web
implementation. It is plain math on raw PCM with no browser APIs, so a native app or a small
model can replace it.

Every 50 ms tick in `user_speaking`, the controller passes the microphone's latest ~43 ms
(`Microphone.pcm()`, the analyser buffer, reused). Each frame gives:

| Feature | How | Why |
| --- | --- | --- |
| RMS | full rate | the user's level, relative to their own baseline |
| periodicity | max normalized autocorrelation, 70–400 Hz pitch lags, ~16 kHz | voiced speech ~0.8+; a whisper has no vocal-fold vibration |
| spectral flatness | 512-point FFT, 200–5000 Hz | breathiness (secondary) |

Only frames above `2.5 × noise floor` count as speech. A turn keeps three numbers per frame,
never audio. Fewer than 8 speech frames (~0.4 s) is "no evidence".

**Classification** (`classifyDelivery`):

- `unvoiced` = how far the voiced-frame ratio is below normal (1 at ≤ 12 % voiced, 0 at ≥ 40 %).
- `whisper = unvoiced × (0.75 + 0.25 × max(breathy, quietness))`.
  - ≥ 0.72 → **whisper**.
  - ≥ 0.45 → **quiet**: ambiguous evidence is quiet, never whisper.
- Voiced but much quieter than the user's own baseline (≤ 0.3× fully, 0.7× not at all) →
  **quiet, level-only**.

**Volume alone never whispers.** The decision rests on unvoicing, which Chrome's AGC can't
fake. Volume alone can't *start* a quiet delivery either: a far microphone is voiced and quiet,
and lowering ELISE when the user is far away would be backwards. Level-only quiet can only
*sustain* a quieter delivery that is already on.

### 3. Personal session baseline

`DeliverySession` keeps the user's normal level as an exponential moving average (α 0.3) of
their **clearly normal** turns only, so quiet turns never drag it down. It lives for one voice
session and is dropped at `end()`. Nothing about the user's voice is persisted.

### 4. Hysteresis

- A whisper (or quiet) holds for **30 s** (`holdMs`), counted from the end of ELISE's reply. It can only end while she listens: a reply never changes voice halfway through (found in real Chrome: a 40 s reply outlived a window counted from the user's turn). Each new quiet or whispered turn
  refreshes it, so the user doesn't have to whisper every sentence.
- A clearly normal turn (confidence ≥ 0.6) returns to normal at once. A weak "normal" neither
  exits nor refreshes.
- When the window runs out, the tick returns delivery to normal, and the indicator goes with it.

### 5. Explicit requests win

`deliveryCommand(text)` reads the *intent* from the words. Examples: "susurrame", "estoy en
una biblioteca", "hablá bajito", "no hables tan fuerte", "podés hablar normal", "ya podés
hablar fuerte", and the English equivalents.

- The request overrides detection for **10 minutes**.
- It works even with adaptive mode off, and needs no Settings change.
- The model's voice guidance says that volume is already handled: it confirms briefly and
  never says it can't whisper.

### 6. Trusted provider directives (security)

The model never chooses delivery. The order is fixed:

1. Model text.
2. `sanitizeForProvider` strips every `[tag]` and `<tag>` the model wrote (unchanged).
3. The speech formatter.
4. `withDelivery` adds ELISE's own directive.
5. ElevenLabs.

- The client sends `delivery` as an enum. The server validates it with zod and never accepts
  free text as a directive.
- **ElevenLabs** (`eleven_v4_turbo`, Text to Dialogue): `[whispering]` for whisper, `[softly]`
  for quiet, before the text of **every** segment. Each segment is an independent request, so
  every segment carries its tag. `previous` and `previousText` continuity is kept.
- Models without audio tags (`eleven_flash_*`) would read the tag aloud, so they get playback
  gain only.
- **OpenAI** (failover provider): a style line is appended to `instructions`.
- The tag never reaches the transcript or the screen. Usage counts the tag's characters.

Docs checked 2026-10-12: [audio tags](https://elevenlabs.io/docs/help-center/product/core-capabilities/text-to-speech/how-do-audio-tags-work-with-eleven-v3-and-v4),
[best practices](https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices).
v4 follows `[whispers]` and `[whispering]` even on voices never trained to whisper.

### 7. Playback gain

`SpeechPlayer` sends every source through its own `GainNode`, set by `playbackGain(mode,
userVolume)`:

| Mode | Gain |
| --- | --- |
| normal | 1.0 |
| quiet | 0.7 |
| whisper | 0.45 |

- The gain moves with a 50 ms time constant and never touches the device volume.
- The analyser comes after the gain, so barge-in compares against what really plays.
- ELISE has no per-user voice volume setting today, so `userVolume` is 1. The multiplier is
  ready for one.

### 8. The first acknowledgement matches

- Delivery is decided in `beginTurn`, before the predicted acknowledgement.
- The acknowledgement prepared at the pause (ADR-036) is fetched with a provisional delivery
  (`previewDelivery` on a `clone()` of the session).
- Prepared lines are keyed by delivery, so a normal "Lo busco." is never played for a whisper.
- The server's acknowledgement cache key includes delivery.
- The first time a session goes quiet or whispered, `/api/voice/speak/warm` is called with
  that delivery, once.

### 9. Music

`duckedVolume(current, supports, delivery)` ducks to 35 % (normal), 25 % (quiet) or 15 %
(whisper), with a floor of 5. ELISE never raises her own volume to compete. The restore is the
unchanged ADR-042 mechanism, exact.

### 10. UI and setting

- **UI:** a small mono pill ("Susurro" or "Voz baja") next to the microphone in the presence dock while delivery isn't normal.
  No modal, no dashboard.
- **Setting:** Settings › Voice › "Adaptar mi volumen de voz" (default on). It is a
  **per-device** preference (`localStorage elise.voice.adaptive`), like music ducking. A
  profile column would need a migration applied before the code ships.
- **Off:** normal delivery unless asked.

### 11. Telemetry (numbers only)

`deliveryMode` (0/1/2), `deliveryConfidence` (0–10), `deliveryExplicit`, `deliveryAnalysisMs`
go into voice timings. The trace `delivery` event logs mode, source and bucket. No audio and no
features are logged.

## Microphone pipeline and AGC (observed)

Capture is `getUserMedia({ echoCancellation, noiseSuppression, autoGainControl: true })`. A
`MediaStreamSource` feeds an `AnalyserNode` (fft 2048), and `MediaRecorder` (webm/opus)
records for STT.

- All three browser processors stay **on**. Turning them off would hurt STT and barge-in, and
  there is no evidence that justifies it.
- Chrome's AGC raises quiet input toward a target level, so a whisper can arrive as loud as
  normal speech. That is why loudness is only a supporting signal.
- Noise suppression may also attenuate the breath noise that a whisper consists of. This is
  **not yet measured on a real microphone**: see Pending.

## Calibration (2026-10-12, offline, the real detector)

**Corpus:**

- 27 Spanish utterances: 3 sentences × 3 voices × "normal", "quiet" and "whisper" styles, from
  the configured OpenAI TTS.
- 9 **LPC pseudo-whispers**: the normal recordings with the glottal excitation replaced by
  noise, at 0.35× level. This is the standard way to make true unvoiced whispers from real
  speech.

**Finding:** the TTS "whisper" style is fully voiced (86 % voiced frames), so it isn't a whisper
at all. The detector correctly calls it normal.

**Conditions:**

- clean;
- far (0.18×, reverb);
- loud noise;
- a background talker;
- worst-case AGC (every turn normalized to the same loudness).

| | clean | far | noise | babble | AGC |
| --- | --- | --- | --- | --- | --- |
| voiced speech (normal + soft, 54/cond.) → whisper | **0** | **0** | **0** | **0** | **0** |
| far normal speech → *starts* quiet | — | 0 (level-only) | — | — | — |
| pseudo-whisper → whisper | 9/9 | 7/9 | 2/9 (7 no evidence) | 1/9 (5 quiet/normal) | 5/9 (4 quiet) |

- **False positives:** none in 270 voiced turns.
- **False negatives:** in loud noise, whispers fall under the speech gate ("no evidence", so
  delivery doesn't change). A loud nearby talker makes frames voiced.
- Under AGC, about half of the whispers are only "quiet": still lower, and safe.
- **Analysis cost after the turn:** < 1 ms (`deliveryAnalysisMs`). Feature extraction runs per
  tick while the user is speaking.

## Real Chrome validation (2026-10-12)

`e2e/voice-delivery-validation.spec.ts` ran in real Chrome with real STT, model and speech (the OpenAI failover, because ElevenLabs was out of quota). The microphone was a Web Audio stream, so AGC and NS were not in the path.

- **9/9 turns decided as expected:** normal, normal, whisper, whisper, quiet (kept the whisper), normal (back up at once), "susurrame" (explicit), normal-sounding speech (stayed whispered), "ya podés hablar normal".
- Every speech request of a whispered turn went out with `delivery: whisper`, the first acknowledgement included.
- The pill showed and cleared on time. The tag never appeared on screen.
- Post-turn analysis took 0–1 ms. The model answered the explicit request with "Dale, te hablo bajito."
- **Found and fixed:** a 40 s whispered reply switched its last segment to normal, because the hold window was counted from the user's turn. It now counts from the end of the reply and can only end while ELISE listens. A unit test covers it.

## Not done / pending

- **Real ElevenLabs listening test.** The account returned `1008 quota_exceeded` on every
  request on 2026-10-12. This blocked:
  - choosing between `[whispering]`, `[whispers]` and `[whispering softly]` by ear;
  - choosing the quiet tag (`[softly]` is unverified);
  - measuring first-audio latency with a tag.

  While the quota is out, production speech falls back to OpenAI (ADR-030 failover), which
  honours delivery through its instructions.
- **Real-microphone calibration.** Real normal, quiet and whispered speech, plus far and
  noisy rooms, on Chrome with AGC and NS on. The thresholds in `DELIVERY` are the knobs.
- **Barge-in over a whispered reply in real Chrome.** The unit test passes (same detector, same cut). In e2e, talking over a normal reply cut it. One short whispered reply (3.3 s) ended before the barge-in fired: barge-in took about 2.4 s to fire even on a normal reply. The run that talks over a long whispered reply was stopped before it finished. `voice-delivery-validation` has that case ready.
- **GPT-Live runtime** (`VOICE_RUNTIME=live`): the live model speaks with its own voice and
  this ADR doesn't reach it. Legacy is the default runtime.

## Consequences

- Detection adds no network call and no measurable post-turn latency, and keeps no audio.
- The model can't make ELISE whisper, laugh or shout. Only the runtime's enum reaches the
  provider.
- A native app can provide its own `VoiceDeliveryDetector`, for example with raw, pre-AGC
  audio, and the rest stays the same.
