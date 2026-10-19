# ADR-087: Several Ámbitos per movement; click to edit

**Status:** Accepted (2026-10-18). Extends ADR-052 (Ámbitos) and ADR-083 (Finance v3).

## Decision

- **Model:** `finance_transactions.book_ids uuid[]` (migration 053) holds every Ámbito of a
  movement. `book_id` stays as the first one, so imports, combine/uncombine, budgets and older
  clients keep working. A trigger keeps the two in step: set `book_ids` → `book_id` follows; set
  only `book_id` (a single-Ámbito client) → `book_ids = [book_id]`; the FK clearing a deleted Ámbito
  removes just that one. Ids are de-duplicated, order kept, and checked against the workspace.
  Ámbitos are archived by people; on a system delete, every movement keeps its other Ámbitos.
- **Meaning:** Ámbitos work like tags. A movement in Personal and Firbot appears under each one,
  and counts toward each Ámbito's budgets. "Todos los ámbitos" counts it once. "Sin clasificar"
  means no Ámbito.
- **Combining** requires the same set of Ámbitos, in any order.
- **Tools:** `finance.createTransaction` and `finance.updateTransaction` take `books` (names,
  up to 5) next to `book`. Update replaces the set (`[]` = Sin clasificar).
- **Graceful rollout:** the provider probes `book_ids`. Without migration 053 one Ámbito still
  works; asking for several says ELISE needs an update.
- **UI:** "Ámbito" in Editar movimiento is a group of toggle chips (none = Sin clasificar). Rows
  read "Personal + Firbot". Clicking an editable movement opens Editar movimiento directly. A
  connected sheet's rows (read-only) still open the detail, which says where to edit them.
  "Duplicar" moved to the movement's menu (right-click).

## Also in this batch (same migration 053)

- **Default account:** `finance_settings.default_account_id` (same workspace, active; deleted or
  archived → none). A movement recorded without an account or payment method (chat, or a new
  movement in the form) goes there, bringing its currency and default Ámbito. Transfers never get
  it. Set it in Cuentas ("Cuenta por defecto") or by chat (`finance.updateAccount` `default`).
- **Combining** no longer needs approval: it is reversible (undo restores the sources) and the
  model only combines when asked. Movements without an account combine when none has one. The
  check runs before anything is written, so a refusal comes back as a reason at once.
- **Approvals:** when an approval goes through but the action then fails, the card says so and
  stops offering "Aprobar" (before, a second tap hit "venció o ya fue resuelta").
- **Chat records:** the description gets a leading capital (`normalizeEntityTitle`: "iPhone" and
  "make.com" are kept). With no category named, the model picks an existing one. Failing that,
  the tool uses the single existing category the description names ("regalo Cande" → Regalos).
- **Selecting:** Shift+click selects the range from the last movement marked. "Seleccionar
  todo" selects every editable movement the filters match in the period, not only the 100 on
  screen (server-side, up to 2,000).
- **Adding:** the floating add button also shows on desktop, as a round "+".
