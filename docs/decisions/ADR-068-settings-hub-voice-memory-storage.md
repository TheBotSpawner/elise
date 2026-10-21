# ADR-068: Settings hub — simple Voice, Memory, Storage, Account, Usage and Billing

**Status:** Accepted (2026-10-16). Memory storage, context and learning superseded in part by ADR-107. Refines ADR-012 (self-control), ADR-014, ADR-017 and ADR-049
(voice), ADR-019 (entitlements, usage) and ADR-066 (responsive). No database migration:
everything new lives in existing tables and columns.

## Context

Settings had grown into one long column. It mixed profile, appearance, a long privacy text,
startup sound, location and six voice toggles: voice on, speak aloud, continuous, barge-in,
adaptive volume, and an editable wake phrase.

- It was hard to scan.
- It mixed account and device choices.
- It had no room for Memory, Storage, Usage or Billing.

## Decision: information architecture

**Routes.** One route per category:

- `/settings/{general,appearance,voice,memory,storage,shortcuts,account,usage,billing}`;
- `/settings/storage/{documents,images,attachments}` for drill-down.

Old links keep working (`/my-elise/shortcuts` → `/settings/shortcuts`). There is no Privacy
category: the privacy text left Settings. It will return as product or legal pages when those
exist.

**Registry.** `features/settings/registry.ts` holds the categories and the searchable settings
(section, anchor, label and hint keys). The desktop sidebar, the phone list and the search all
read it.

**Search.** Local and deterministic. Every word of the query must appear in the label, the
hint or the category. Accents and case are ignored. A result links to `/settings/<section>#<anchor>`,
and the row lights up through `:target`.

**Layout.**

| Screen | Layout |
| --- | --- |
| From `md` | Sticky sidebar (Back to ELISE, search, two groups: Personal, Account) beside content at max 760 px, inside a 1180 px frame. `/settings` shows General. |
| Phones | `/settings` is the category list. Each category is a full-width screen with Back. |

**Display.** Settings are grouped rows in cards: label, a one-line hint, the control on the
right. Longer explanations go behind an ⓘ (`InfoTip`), never in paragraphs under each toggle.

## Decision: scopes

| Scope | Settings |
| --- | --- |
| Account (`user_profiles` / `user_preferences`, RLS, audited) | Interface language, time zone, name, theme and accent, continuous conversation, voice language, voice, Memory on/off and facts, Mi ELISE modules |
| Device (browser storage, never synced) | Startup sound, adaptive voice delivery, location opt-in (the browser holds the permission), the on-device speech pack for "Elise" |
| Session | Nothing new |

## Decision: Voice

**Three choices.** Continuous conversation, voice language (Automático / Español / English,
separate from the interface language), and the voice (stable id, with a "Escuchar" preview). The
provider (ElevenLabs/OpenAI) is not shown.

**Defaults instead of settings.** `core/voice/preferences.ts → voicePreferences(row)` turns any
stored row into the model:

- the microphone is always offered and voice replies are spoken;
- barge-in is on;
- adaptive delivery stays a device default;
- `wakePhrase` is always `WAKE_PHRASE = "elise"`;
- on the web, `wakeEnabled = continuous`.

**Legacy rows.** A custom phrase or turned-off toggles read safely into this model. The old
columns stay; nothing is migrated. Saving continuous also writes `voice_wake_enabled` for older
clients.

**What "Elise" means on the web.** It only wakes a resting session in an open, visible tab, and
only where the browser can detect it on the device. The Voice page says so only when it is true
here, and offers the on-device speech pack when the browser needs it.

**Self-control.** `voice.update {continuous?, language?}` replaces `voice.setWakePhrase`. It
writes the same columns as the page (`updateVoiceSettings`). No tool can set another phrase.

**Onboarding.** A "voice" step after "uses" asks once: "Activar conversación continua" or
"Ahora no". The choice is saved with time and source (`user_preferences.voice.continuous_consent`).
Finishing the first onboarding without choosing leaves it off. Re-running the welcome never
changes it.

## Decision: native wake word (future, not built)

A native app may offer "Elise" with the app in the background, the screen locked or through
headphones, where the OS allows it legitimately.

- **On-device only.** Detection runs locally (an on-device keyword spotter). Audio reaches ELISE
  only after the phrase or an explicit tap. Nothing streams all the time.
- **Three separate facts.** Product preference, OS permission and device capability.
  `VoiceDeviceCapabilities {platform, microphone, backgroundWake}` models them;
  `webVoiceCapabilities` always reports `backgroundWake: "unsupported"`.
- **iOS.** Background listening by a third-party app is restricted. Viable paths are
  foreground and lock-screen sessions through the audio session, plus Siri/App Intents
  ("Hey Siri, ask Elise…"). A true always-on custom wake word is not generally available.
- **Android.** A foreground service with a microphone type and a persistent notification can run
  an on-device spotter. It costs battery and needs explicit consent.

## Decision: Memory

Memory is a few stable facts about the person — preferences, routines, usual names, formats. It
is not Recall (what was said), not Knowledge (their documents), not Methods (how to do a task),
and not "embed every chat". General Knowledge stays the explicit sources and Methods the user
saved. The two never share storage.

- **Model** (`core/memory/model.ts`): `MemoryFact {id, key, value, confidence: stated|inferred,
  sources (conversation ids), status: active|superseded, createdAt, updatedAt, lastConfirmedAt}`.
  - Saying it again confirms the fact and adds the source.
  - A *stated* change supersedes the old value, which is kept as history.
  - An *inference* never overwrites what the person said.
  - Secrets (passwords, keys, card numbers) are refused.
  - At most 100 facts.
- **Storage:** `user_preferences` keys `memory.enabled` (default on) and `memory.facts`. They
  are per person under RLS, with no new table.
- **Prune on read:** a deleted conversation's id leaves every fact. An inference with no evidence
  left is forgotten. What the person said or wrote stays until they remove it.
- **Writes:**
  - The model calls `memory.remember` (key, value, `stated`) with the conversation as source,
    `memory.list` and `memory.forget`. These are capability `settings`, write operations,
    audited.
  - Memory off → nothing is read or added.
  - People edit, forget, add and clear facts in Settings › Memoria.
- **Use:** active facts go into the turn's dynamic context only when Memory is on, labeled as
  editable in Settings.

Not done: automatic extraction from past conversations. Memory grows from what the person asks
ELISE to keep, or adds.

## Decision: Storage

**What counts:** only bytes ELISE keeps, read from metadata rows written at upload time.

- Every `knowledge_versions` row with a `storage_path` (uploads and saved web pages, every kept
  version).
- `chat_attachments` that are ready or sent.

**What doesn't:**

- Drive, Notion and Sheets have no stored original, so they never count.
- Finance import files are deleted when the import finishes or is cancelled.

**Categories:** Documents (Knowledge, non-image), Images (Knowledge and chat), Chat attachments.
Each is listed with size, where it is used and date, sortable by size or date, and searchable.

**Delete:** Knowledge uploads can be deleted (`deleteItem`: the file, its versions and what was
learned). Chat attachments go with their conversation. A non-upload item is refused.

**No quota:** "1,57 GB usados", never "of 20 GB". The bar shows composition, not a limit. Sums
come from indexed rows through RLS; no bucket scan, no stored aggregate to drift.

## Decision: Account, Usage, Billing

- **Cuenta:**
  - Shown: name, email, sign-in providers from Supabase Auth identities, "ver la bienvenida
    otra vez", sign out.
  - Not built yet: security, devices, data export, deleting the account. One line says so; there
    are no buttons.
- **Uso:** this month (calendar month in the person's time zone), from existing rows.
  - Conversations started.
  - Messages sent.
  - Voice: seconds of dictated audio (`usage_events` transcription) plus live sessions;
    spoken replies don't count.
  - Completed scheduled runs.
  - Stored bytes.

  A value that can't be read shows "—", never 0. No limits, credits or costs: there are no plans
  (`entitlements` stays MVP).
- **Facturación:** an honest state. ELISE doesn't need a paid plan in this version; plans and
  billing will appear there. No Stripe SDK, prices, cards or invoices.

## Consequences

- Settings stays small per screen and grows by adding a registry entry and a route.
- Users who had turned voice output or barge-in off now get the defaults.
- A custom wake phrase becomes "Elise".
- The device's adaptive-delivery preference is kept but no longer shown. "Susurrame" / "hablá
  normal" still change it.
- Memory has no background learner yet. The tool descriptions keep it to durable, non-sensitive
  facts.
