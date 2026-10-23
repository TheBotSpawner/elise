# Shopping prices, document cards, newest-first Canvas, voice language — report (ADR-116)

Date: 2026-10-23.

## 1. Mercado Libre prices (ADR-116)

### Phase 0: feasibility

Not run: this project has no `SERPAPI_API_KEY`, and no other authorized source with structured
prices exists in the code. Mercado Libre's API is still blocked (ADR-112).

**Nothing here claims that Mercado Libre prices are solved.** The live check is pending (§6).

### What was built (off by default)

| File | Change |
| --- | --- |
| `src/core/shopping/price-reference.ts` | `parseShoppingResults` (total ARS only; drops installments, USD, zero, packs, accessories), `listingKey` (item / `p:` / `up:` never equal), `attachPrices` (by identity only), `rankReferences`. |
| `src/infrastructure/shopping/google-shopping.ts` | SerpApi adapter: flag, key, timeout, 30-minute cache, 401/403/429 pauses, monthly budget, counts-only logging. |
| `src/core/tools/marketplace.ts` | `shopping.offers` attaches proven prices, adds reference sections, and keeps "solo ML" free of other stores. Voice instructions say the source and that prices may have changed. |
| `src/core/shopping/marketplace.ts` | `matchOffer` matches whole tokens (RM4 ≠ RM4C); `Offer.priceSource`. |
| `src/core/workspace/registry.ts` | `product_offers` gains `model`, `references` and `priceSource` (all optional: older Surfaces still validate). |
| `src/features/workspace/product-offers-view.tsx` | Redesigned card (see below). |
| `src/config/server-env.ts`, `.env.example` | The four new variables. |

### Before / after

**Before:**
- the title, then "Precio en la publicación" repeated on every card;
- "No es exactamente el modelo pedido" even when no model had been named;
- "RM4 Mini" matched an "RM4C Mini" title.

**After:**
- **Prices:** shown large as `AR$ …` with where and when they were checked, and only when
  proven for that listing.
- **Unpriced listings:** one line counting them.
- **"Not the model" flag:** only when an exact model was asked for.
- **Reference prices:** separate sections, one for "tienda: Mercado Libre" and one for other
  stores.
- **Images:** an image or a placeholder per offer.

**Matched-price percentage:** unknown until the live check, because it depends on whether
Google Shopping returns direct links to listings.

### When no price is shown
- A Google Shopping result with the same title but no link to the listing becomes a reference,
  not the listing's price.
- A result priced in installments, in dollars, as a pack or as an accessory is dropped.
- Without the key, or when SerpApi fails or the budget is used up, the listings show without a
  price and a note.

### Cost
- One search per product question, cached for 30 minutes.
- The free SerpApi plan has 250 searches a month; Starter is USD 25 for 1,000 (confirm on their
  pricing page).
- ELISE's own cap defaults to 200 a month per instance.

### Licences
- Mercado Libre: no reading of its pages, and its content is kept apart from other stores'
  (ADR-112).
- Google Shopping thumbnails stay off (`SHOPPING_GOOGLE_SHOPPING_IMAGES=false`) until the right
  to display them is confirmed.
- Check SerpApi's terms before enabling.

## 2. The documents card for one article

**Before:** asking for one article showed every match. Opening a result read live from Notion
said "Ese elemento ya no existe".

**After:**
- **Only what was cited.** When the answer is done, `citedKnowledge` keeps only the documents it
  cited (`[n]`).
- **One document:** an article card with an icon, the title, "Notion · Space", the passages it
  used (with their sections), and a primary **Abrir en Notion** button.
- **Several documents:** a list where each item opens in place (native `<details>`) to show
  what it says and its link. No navigation, so nothing breaks for live items.
- **Follow-ups:** the card's description includes the Notion link, so "pasame el link" works.

## 3. Newest widgets first

`composition.ts` `ordered()` now sorts by turn first (newest), then by priority, pinned and
newest. A new answer leads instead of landing at the bottom. Pinned and earlier Surfaces stay,
below it.

The airport map in the screenshot came from an earlier turn: Surfaces persist across turns by
design. It now sits below the newest answer and fades to "ambient" after two turns.

## 4. Portuguese reply with music playing

**Cause:** live voice (GPT-Live) hears the raw audio, including a song's lyrics, and answered in
the song's language.

**Fix:** the live prompt now says to follow the language the **person** speaks in, ignoring
background audio (music, TV, other people). Switching stays allowed when the person changes
language or asks. The chat rule says the same.

## 5. Tests

| File | Covers |
| --- | --- |
| `tests/unit/shopping/price-reference.test.ts` | RM4 ≠ RM4C; total ARS only; installments, USD, zero, packs and accessories dropped; images only when allowed and from Google's hosts; listing identity per kind; price only through the listing's own link; similar title never prices; tool with references and other stores apart; "solo ML"; 403/429 degrade; no model → no flag. |
| `tests/unit/structured-latest.test.ts` | Cited narrowing. |
| `tests/unit/canvas-composition.test.ts` | Newest turn leads. |

## 6. Pending steps that depend on the owner

1. **Create a SerpApi account** (serpapi.com) and copy its API key.
2. **Add the variables** in Vercel (Production) and in `.env.local`:
   - `SERPAPI_API_KEY=<key>`;
   - `SHOPPING_GOOGLE_SHOPPING_ENABLED=true`;
   - keep `SHOPPING_GOOGLE_SHOPPING_IMAGES=false`.
3. **Ask ELISE** "Buscame un Broadlink RM4C Mini en Mercado Libre" and check whether the listing
   cards show a price "consultado en Google Shopping".
   - If none do, Google isn't linking listings and only the references are useful. Decide
     whether that's worth the cost.
4. **Keep `MERCADOLIBRE_API_ENABLED=false`** until Mercado Libre approves the use in writing.
