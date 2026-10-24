# ADR-120: Real images with credits — Commons, optional Places photos, one gallery per subject

**Status:** Accepted (2026-10-24). Builds on ADR-015 (web), ADR-021 (media Surfaces) and
ADR-023 (Places API New).

## Context

The person asks to see things: "mostrame fotos de las playas de Aruba", "¿cómo es la playa
Kenepa Grandi?", "mostrame el Broadlink RM4C Mini". ELISE should answer, and show real photos of
exactly that subject, credited and linked to their source, while she keeps talking.

**What was checked:**
- **Web search (OpenAI hosted / Tavily):** it returns pages, not reusable image URLs. Inventing
  image URLs from snippets, scraping Google Images or its results page, and Google Custom Search
  JSON API (closed to new customers) are all out.
- **Places API (New)**, already used by ELISE for maps: Text Search with `photos` + Place Photos
  (New) gives Google's photos of the identified place, with author attributions. Verified live
  (Kenepa Grande, Curaçao: 10 photos). Billed per use:
  - Text Search: USD 0.035;
  - each photo: USD 0.007 (`src/config/pricing.ts`).
- **Openverse API:** openly licensed photos, no key, good metadata. Anonymous uncached searches
  took **10–17 s**, and one timed out (measured 2026-10-24). Too slow to answer with.
- **Wikimedia Commons API (MediaWiki):** freely licensed photos, no key, **0.4–1.5 s** per search,
  with author, license and file page. Covers places well. Has no photos of niche products
  (Broadlink RM4C: none — and none of another model shown instead).

## Decision

1. **Providers, by flag:**

   | Provider | Flag | Default | Note |
   | --- | --- | --- | --- |
   | Wikimedia Commons | `IMAGES_COMMONS_ENABLED` | on | Free |
   | Openverse | `IMAGES_OPENVERSE_ENABLED` | off | Free but slow |
   | Places photos (`kind: place` only) | `IMAGES_PLACES_ENABLED` | off | Billed |

   - Order: Places (when on and the subject is a place), then Commons, then Openverse. Each one
     only fills what the previous ones didn't.
   - The rate limit is 120 searches per workspace per day. Results are cached 30 minutes per
     subject.
2. **Contract:** `VisualResult` (`src/core/web/images.ts`), validated on the server:
   - https only;
   - provider, title, thumbnail, an image only where usable, source page, creator, license.

   The model never builds one.
3. **On topic:**
   - every distinctive word of the subject's name must be in the image's own text (title,
     description), so "RM4C" never matches "RM4";
   - a one-word place ("Baby Beach") also needs its context word ("Aruba").
   - Places photos belong to the place Google identified, shown with Google's name and address
     for it.
   - Duplicates are dropped.
4. **Tool `web.images`** (web group, no new capability):
   - one entity per subject, named exactly and placed;
   - `more: true` for "más fotos de la segunda".
   - Loaded by photo, travel and "cómo es / cómo se ve" words, or when a gallery is on screen.
   - Not loaded for arithmetic and the like.
   - The prompt says: only when seeing helps, never after "no me muestres imágenes", the answer
     first, and facts come from sources, not photo titles.
5. **Surface `image_gallery`:**
   - one labeled carousel per subject, never two places' photos mixed;
   - arrows, swipe, ←/→, counter, thumbnails; one photo shows alone;
   - a click opens a native modal (focus trapped, Escape) with the whole photo (object-contain),
     credit, license and "Ver fuente";
   - a public "Ver más imágenes en Google" search link, marked external;
   - images load lazily from their source with no referrer. There is no proxy, so there is no
     SSRF surface; the CSP already allows `https:` images.
   - A broken full image falls back to its thumbnail, then to a placeholder.
   - Keyed by its subjects: a new question makes a new gallery, and "más fotos" updates that
     subject's.
6. **Voice:** the gallery accompanies the answer. The tool tells the model not to read links,
   credits or licenses, and to say briefly what's shown. Images load in the browser while ELISE
   already speaks.

## Consequences

- Free by default and fast enough to talk over. Coverage is Commons' (strong for places,
  landmarks and nature; weak for products).
- Turning Places photos on improves place galleries at about USD 0.035 + 0.007 per photo per place,
  on the existing Maps key.
- Not implemented (documented):
  - Brave Image Search API, a paid plan to approve;
  - photos of a hotel's own listing;
  - a vision model describing photos.
