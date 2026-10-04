# ADR-033: The Calendar Surface: calendar data looks like a calendar

**Status:** Accepted (2026-10-03). Extends ADR-021 (Live Canvas), ADR-027/028 (representation),
ADR-029/031 (Surface lifecycle, working set).

## Root cause of the ambiguous calendar

The calendar read (`calendar.listEvents`) was correct. The problem was presentation.

- A list of several events became a generic `result` Surface.
- Its card was headed `Agenda · {day of display.from}`, the day the range starts (usually
  today).
- Under that heading it listed every event with its time only.

So "esta semana", asked on a Saturday, read as "SÁB 3 OCT: 10:00 Weekly Meeting, 20:00 Teatro,
Todo el día Cumpleaños", even though those events fell on Wednesday and Friday. The inline
transcript card had the same bug.

## Decision

**One first-class Surface type, `calendar`.**

- The payload holds the dataset:
  - the loaded range (local dates);
  - the user's timezone;
  - the events, with provenance: calendar id and name, account, and provider event id. Unsafe
    links are dropped.
- It also holds the presentation:
  - `view`: day, week, month, year or agenda;
  - `anchor`: the date the view shows;
  - `hidden`: calendars filtered out;
  - `free`: windows to emphasize.
- All placement maths is pure and lives in `core/workspace/calendar.ts`:
  - which day and minute each event falls on;
  - all-day handling, where dates never shift by timezone;
  - events crossing midnight are clipped per day;
  - an event ending at 00:00 belongs to the day before;
  - DST is handled through `toLocalDateTime`;
  - overlap columns, all-day lanes, the month grid, year density and Agenda groups.

**Initial view.** The Representation Planner (`chooseView`) chooses from the requested range and
the event count:

| Requested range | View |
| --- | --- |
| 1 day | Day |
| up to 7 days | Week |
| a whole month | Month |
| 8–21 days ("próximos") | Agenda |
| up to ~6 weeks | Agenda, or Month when dense (more than 25 events) |
| longer | Agenda, or Month when dense (more than 40) |
| 200 days or more | Year |

- An explicit request wins.
- A single match from a long range (a "cuándo tengo X" search) stays an event card.
- Milestones and deadlines from documents still use the timeline (`ui.timeline`). Calendar is
  only for the user's own scheduled events.

**Views.**

- **Day and Week** are time grids:
  - an all-day strip on top, where multi-day events are spanning bars in lanes;
  - events at their real times and durations;
  - overlaps share the width side by side;
  - a red "now" line on today, in the user's timezone and hidden from screen readers;
  - free windows from availability as dashed accent bands;
  - busy-only blocks hatched;
  - days outside the loaded range hatched and dimmed;
  - the grid opens scrolled to the first event, or 08:00;
  - compact hours for dense weeks, taller hours in Focus.
- **Month** is a Monday-first grid:
  - up to 3 events per cell, then "+N más";
  - all-day events as filled chips;
  - a day or "+N más" opens that Day.
- **Year** shows 12 compact months, each a 7-column heatmap of events per day. A month opens
  Month.
- **Agenda** shows each event once, under its own date heading:
  - "Todo el día" for all-day events;
  - start → end for multi-day events.
- **Event detail** opens in the Surface without leaving the Canvas. It shows:
  - title, when, calendar · account, location, guests and description;
  - Join and Open in Calendar links.

  Edit, move and delete stay in chat and voice, through the existing tools and approvals.

**Phones.**

- Day is full width.
- Week becomes a strip of 7 days (with dots) plus the selected day's schedule.
- Month becomes a compact grid with dots.
- Year and Agenda keep their layouts.
- The view switcher takes the full width.

**One calendar on the Canvas.**

- Every calendar read (any range or calendar filter) has the dataset `calendar`. A new range
  replaces the visible calendar in place (same handle and position). Only a text search is
  its own dataset.
- The Surface's own controls send a `calendar` op (`calendarViewAction` / `calendarViewOp`):
  view switcher, previous/today/next and the Calendarios filter.
- That op is presentation only when the needed days are loaded. For example, Week → Agenda of
  the same week reads nothing.
- Otherwise it runs one range read and updates the Surface's payload and query in place. It
  never reads once per event.
- The client applies the change optimistically.
- Chat and voice follow-ups use `ui.show` with `as` (day/week/month/year/agenda), `date` and
  `calendars` (names). It goes through the same `navigate` and reads missing days via
  `env.invoke`.

**Mutations.**

- Calendar writes already reconcile Surfaces whose query is a calendar read (ADR-029). On
  refresh, the calendar keeps its view, date and filter (`keepPresentation`).
- A created or moved event already present in the refreshed calendar marks that calendar as the
  last change, highlighting the event. No extra card is added.
- A deleted event disappears from it.
- `calendar.findAvailability` over days a calendar already shows emphasizes free windows there
  (Day view of that date) instead of adding a second calendar.

**Accessibility.**

- Every event is a button whose label states its own day and time: "Weekly Meeting, miércoles,
  30 de septiembre, 10:00 a 10:30", plus " · Trabajo" when several calendars are shown.
- Calendars are told apart by a mark and by name (in labels, the Agenda, the filter and the
  detail), never by color alone.

## Future path (not built)

- Clicking empty time could prefill a "create event at …" prompt.
- Dragging a block could call `calendar.updateEvent` through the same approval path. The grid
  already has minute-accurate positions to support this.
- Resizing events and per-calendar colors from the provider are not built.

## Range state (2026-10-04): view is presentation, events are data

**Root cause of Week → Year → Week losing the week.**

- Year read `calendar.listEvents` with the tool's **default limit of 50**. The provider returned
  the year's first 50 events (January–February).
- That truncated result **replaced** the Surface's events and its `range` became the whole year.
- Back on Week, the week counted as loaded, so nothing was read, and the grid was empty.

So the cause was a range-cache failure: a truncated read was recorded as complete coverage, and
the read replaced the data instead of merging into it. It was not a race. A real race was found
afterwards (see "Races" below).

**Data state** (payload):

- `events`: detailed events, deduplicated by provider event id, which already names the account,
  calendar and event.
- `loaded`: day ranges that were read completely. A read that hit its limit (`complete: false`
  on `event_list`) is never counted.
- `scope`: `all`, or one calendar id. This is the fingerprint: data loaded for one calendar
  never satisfies "all".
- `summary`: per-day counts for one year, kept apart for the Year view. It never replaces
  events.

**Presentation state:** `view`, one `anchor` shared by every view, `range` (the Agenda window),
`hidden` and `seq`.

**One path.** A click and "Ponelo en vista anual" (`ui.show`) both call `changeCalendar`:

1. `navigate` decides the presentation.
2. Only days not covered are read, in one range read at limit 250 (`CALENDAR_READ_LIMIT`).
3. `mergeFetched` merges the read:
   - inside a complete read's range, the read is authoritative (gone there means deleted);
   - outside it, everything known is kept;
   - a truncated read only adds.
4. The step `settle(current)` is applied to the state as it is right before writing.

**Races.**

- Presentation changes are numbered (`nextSeq`, by arrival). A late answer still enriches the
  data but never changes the view (`presentationNewer`).
- On the client, a per-Surface request generation keeps a stale response from replacing a newer
  choice.
- A failed read keeps everything known, and those days show as "loading", never as "no events".

**Mutations.** The Surface's refresh query covers everything loaded (`refreshRange`). A write
re-reads that range once and merges it. Week, Month and the Year summary converge.

**Bounded.** At most 200 events are kept, the nearest to the anchor. Coverage shrinks to match,
so trimmed days are read again instead of looking empty. The summary holds at most 366 day
counts.

**Limitation.** Next.js runs a client's server actions one at a time, so rapid switching
persists in order. Measured: about 5.6 s for Year → Month → Week, while the screen updates
instantly. The load→save step on the server is not atomic, and is marked `ponytail:`.
