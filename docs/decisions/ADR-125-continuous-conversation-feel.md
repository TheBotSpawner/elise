# ADR-125: Continuous conversation that feels like one

**Status:** Accepted (2026-10-28). Adjusts ADR-017 (continuous voice), ADR-034/ADR-104
(acknowledgements and progress) and ADR-036 (the tail) for the legacy voice runtime.

## Context

With continuous conversation on, the owner found it didn't feel like a conversation:

- **Too many fillers.** Every request got "Un segundo.", then an acknowledgement, then up to
  three progress lines, one every 3.5 s of silence.
- **Searches couldn't be interrupted.** The mic listened only for the 4 s after a request, then
  only once ELISE spoke again; changing the request meant saying "Elise".
- **Answers often couldn't be interrupted either.** The barge-in detector calibrated the leak of
  her own voice from the worst frame of its first 0.6 s. Echo cancellation leaks most in exactly
  those instants, so the bar ended up above any voice.
- **The mic stayed open 30 s** of silence before resting; the owner wants 8 s.

## Decision

For continuous conversation only (the standard mode is unchanged):

1. **Fewer fillers.** No instant "Un segundo." on every request. At most one progress line, after
   6 s of silence. Acknowledgements tied to a real lookup stay.
2. **Listening through the work.** The mic listens for the whole time ELISE works on a request.
   Speech in the first 4 s continues the request (ADR-036); speech later cancels it and is a new
   request.
3. **Barge-in calibration** uses the median leak of the calibration window, not the maximum
   (for both modes).
4. **Rest after 8 s.** After her reply, 8 s without speech closes the mic. The session then waits
   for "Elise" or a tap. An automatically detected whisper ends with it; a requested one stays.
5. **ELISE explains the mode** when asked: the 8 s window, interrupting at any time, and turning it
   on or off by voice or in Ajustes › Voz.

## Not decided here

GPT-Live (ADR-026) gives natural turn-taking and interruption (≈0.5 s), but costs about 7–8×
per turn. Using it for continuous conversation is the owner's call; it stays behind
`VOICE_RUNTIME`.

## Consequences

- Noise or a TV during a long search can now cancel it in continuous mode. The detector needs a
  quarter second of real voice, and the user can say it again.
- The median calibration hasn't been measured with real speakers. If her own voice starts
  interrupting her, `echoFactor` is the knob to turn.
