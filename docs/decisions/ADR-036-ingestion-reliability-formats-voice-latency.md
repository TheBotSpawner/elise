# ADR-036: Knowledge ingestion reliability, multi-format documents, voice turn latency

**Status:** Accepted (2026-10-04). Extends ADR-035 (extraction), ADR-034 (voice
acknowledgements) and ADR-017 (turn taking). Migration `20261010000029_knowledge_reliability.sql`.

## Why the Notion source sat in "Preparando fuente…"

This was traced in the database for the real case: the Firbot Marketing Space, Notion source
"Empresas +6".

**What the database showed:**

- Every sync run and every ingestion since 2026-10-03 20:58 was handed to Trigger.dev and got a
  real run id (`run_06gg…`).
- **None ever started:** `started_at` was null on all of them.
- That covers both Notion sources, Drive sources, and the four `.md` uploads that stayed
  "En espera".

**Root cause:** the runtime. The instance that dispatched the jobs has a `TRIGGER_SECRET_KEY`, but
no worker executes ELISE's tasks in that Trigger.dev environment. Either the tasks are not
deployed there (`npx trigger.dev deploy` is manual), or it is a dev key with no
`npm run trigger:dev` running.

The documents were never the problem: Markdown parsing never ran. The same files and the same
Notion source were indexed end to end once a runtime executed them.

**Why ELISE hid it instead of saying so:**

1. A dispatched-but-never-started sync was only noticed after 10 minutes (sync runs) or 30
   minutes (documents), and only when someone opened the page.
2. Each periodic tick queued a new sync into the same dead runtime. A source already marked
   "needs attention" then showed "Preparando fuente…" again.
3. Retry was ignored while a dead queued run existed ("already syncing").
4. Nothing told operators that the runtime itself wasn't taking work.

## Decision: an explicit lifecycle with a watchdog

**State machine** (`core/knowledge/source-state.ts`):

- Documents move `queued → reading → extracting → ocr → indexing → ready`, plus `unchanged`,
  `needs_attention` and `failed`.
- The legal edges are written as a table (`canMove`). Ingestion moves only through `move()`, so
  an illegal step fails the version instead of corrupting it.
- Retry is the only way back to `queued`.

**Source states:** `preparing`, `retrying`, `syncing`, `up_to_date`, `needs_attention`.

- A new attempt after a failure shows **Reintentando**, never "Preparando" again.

**Phases** shown under a working source: **En cola**, **Descubriendo archivos**, **Leyendo
fuente**, **Extrayendo contenido**, **Reconociendo texto**, **Indexando**.

- They are derived from the sync run, then from the furthest phase any of its documents is in.

**Lease and heartbeat:**

- Workers write `heartbeat_at` at every phase, every OCR batch, and every 25 items of a sync.
- Started work whose heartbeat is older than 8 minutes died.
- Whatever the heartbeat says, a sync past 25 minutes or a document past 40 minutes is over its
  lease. A task attempt is capped at 10 minutes.

**Watchdog** (`recoverStale`, idempotent, every update guarded by the state it leaves):

- A sync queued for more than 5 minutes never started: `BACKGROUND_STALLED`.
- A queued document is failed only when nothing in the workspace showed life for 10 minutes,
  meaning the runtime isn't executing jobs. A long queue that is moving is left alone (up to 6
  hours).
- Never-started work is logged as an error, `knowledge.runtime_not_starting`, with sample
  runtime ids, so operators see the runtime problem itself.

**Where the watchdog runs:**

1. Every page view of a Space. A Space with work in flight refreshes every 20 s, so "stalled"
   shows on time even when no row changes.
2. The scheduled dispatcher.
3. Before every manual retry.

**Backoff:** a failed or stalled source's next automatic sync waits 15, 30, 60 … minutes, up to
24 hours. Consecutive failures are counted from its runs.

**Retry dispatches real work:**

- A queued sync that hasn't started within 60 s is cancelled (`SUPERSEDED`) and a new one is
  dispatched.
- A double click within that minute hits the one-active-run index ("already syncing").
- A running sync is never duplicated.

**Fast path:**

- Text uploads up to 2 MB (TXT, MD, CSV, HTML) are indexed in the upload request itself.
- On any error they fall back to the background runtime, so the fast path can only make
  things faster.
- Uploaded notes and Markdown no longer depend on a healthy runtime.

**Development runtime:** the inline runtime now runs 4 jobs at a time. A 240-page Notion sync
opened 240 concurrent provider requests before this change.

**Already true, kept:**

- The initial sync is dispatched at connect.
- A listing failure (including Notion auth) closes the run as "needs attention" with its code
  and a Reconnect action.
- An empty source is ready, not stuck.

## Decision: one extractor registry

`infrastructure/knowledge/parsers.ts` defines `EXTRACTORS`: each `DocumentExtractor` declares its
MIME types, extensions, a magic-byte check (`matches`) and its parser. The same list drives:

- upload validation;
- the upload pickers (`UPLOAD_ACCEPT`, kept equal by a test);
- Drive sync;
- the Knowledge bucket;
- chat attachments.

| Format | How it's read | Provenance kept |
| --- | --- | --- |
| PDF | native text per page, OCR for scanned pages (ADR-035) | page |
| DOCX | mammoth → semantic HTML: headings, lists, tables | heading path |
| Markdown | headings, fenced code kept whole; front matter dropped | heading path |
| TXT | UTF-8 (with or without BOM), UTF-16 (BOM), Windows-1252 fallback | — |
| CSV / TSV | delimiter detected, each row with its column names | — |
| HTML | scripts, styles, nav, header, footer, aside, forms removed; headings kept | heading path |
| XLSX | every sheet, each row with its column names and its cell (`[Clientes!A12]`) | sheet + row |
| PPTX | one section per slide in order, title, body and speaker notes | slide number |
| Images | OCR (uploads only; Drive photo folders are not synced) | — |

**Unsupported or mismatched files:**

- Unknown types and bytes that don't match their claim become "needs attention" with a reason
  (`unsupported`, `mismatch`, `corrupt`, `no_text`).
- Any real text counts, so a two-line note is a document. The old 40-character floor is gone.

**Spreadsheets:** Knowledge reads at most 5,000 rows per sheet. Analysis of whole tables is still
Structured's job.

**Dependencies:** `fflate` moves from devDependencies to dependencies. It was already installed
through `read-excel-file`, and it unzips PPTX. No new package.

## Decision: voice turn latency (legacy pipeline)

This applies to the default runtime, `VOICE_RUNTIME=legacy`: on-device turn detection, then STT,
the model, and TTS.

**Adaptive end of turn:**

- The provisional transcript is now taken at a 450 ms pause (it was 600 ms). Its verdict sets
  the silence that ends the turn:
  - 700 ms when it is a complete phrase: sentence punctuation, two or more words, and not ending
    on a connector;
  - 2.4 s when it sounds unfinished. A trailing period the recognizer adds to a cut phrase
    ("…y.") is ignored for this check;
  - 1.1 s when there is no verdict yet.

**Acknowledgement prepared at the pause:**

- If the provisional transcript is clearly a lookup, the acknowledgement line is chosen and its
  audio fetched right then (`PlayerPort.prepare`). It plays the moment the turn ends.
- Preparation only. Nothing is said or sent, and actions are never predicted.
- No extra model call: the predictor is the same word-based `predictIntent`.

**Premature-close recovery:**

- For 4 s after a turn is sent, while ELISE works and before any answer is spoken, the mic keeps
  listening. The state's `tail` flag makes the indicator say so.
- A quarter second of real voice in that window means the user hadn't finished. The request in
  flight is cancelled, and the next utterance is sent as `<first part> <rest>`, one whole
  request.
- A cough doesn't trigger it. If the continuation can't be transcribed, the original request is
  sent again, never lost.
- Talking over the acknowledgement within the same window also continues the turn. After the
  answer started, it is a new turn, as before.

**Acknowledgement cache:**

- The server key is `version|provider|model|voice|language|line`.
- Bumping `ACK_CACHE_VERSION` drops every cached line.
- Lines prepared on the client are used once.

**Telemetry**, from `voice.turn_timing`, numbers only:

| Stage | Measured from → to |
| --- | --- |
| `turn_detection_ms` | last voiced frame → turn ended |
| `stt_finalization_ms` | turn ended → final transcript |
| `ack_selection_ms` | final transcript → acknowledgement chosen |
| `tts_first_audio_ms` | acknowledgement chosen → first audio |
| `perceived_ms` | last voiced frame → first audio |

Each turn also records `endVerdict` (which rule ended it) and `continuation`.

**Results:** see "Measured" below.

## Not built

- An in-app operator banner for "the runtime isn't executing jobs". Today it is the error log
  and the source's message.
- A production fallback to inline execution. Serverless instances can't run work after the
  response, so Trigger.dev stays required in production.
- Server-side cancellation of tools already running when a cut turn is cancelled. This is the
  same semantics as "Detener".
