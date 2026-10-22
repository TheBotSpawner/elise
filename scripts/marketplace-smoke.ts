/**
 * ADR-112 live smoke of the no-API path: ELISE's own web search provider (from .env.local),
 * restricted to mercadolibre.com.ar, then the same filtering shopping.offers applies (official
 * domain, item pages only, no price). It never opens a Mercado Libre page. Usage:
 *   npx --yes tsx@4.19.2 --conditions=react-server --env-file=.env.local --tsconfig tsconfig.json scripts/marketplace-smoke.ts "Broadlink RM4 Mini" "RM4 Mini"
 */
import {
  conditionOf,
  LISTING_ID,
  MARKETPLACE_SITES,
  marketplaceSearchUrl,
  matchOffer,
  safeMarketplaceUrl,
  searchWords,
} from "../src/core/shopping/marketplace";
import { OpenAIWebSearch } from "../src/infrastructure/web/search-providers";

async function main() {
  const [query = "Broadlink RM4 Mini", model] = process.argv.slice(2);
  const site = MARKETPLACE_SITES.AR;
  const provider = new OpenAIWebSearch(
    process.env.OPENAI_API_KEY!,
    process.env.OPENAI_WEB_SEARCH_MODEL ?? "gpt-4.1-mini",
  );
  const started = Date.now();
  const results = await provider.search({
    query: searchWords(query),
    kind: "web",
    recency: null,
    limit: 8,
    language: "es",
    domains: [site.host],
  });
  const offers = results.flatMap((r) => {
    const url = safeMarketplaceUrl(r.url, site);
    if (!url || !LISTING_ID.test(url)) return [];
    return [
      {
        title: r.title,
        url,
        match: matchOffer(model ?? null, r.title),
        condition: conditionOf(r.title),
      },
    ];
  });
  console.log(
    JSON.stringify(
      {
        at: new Date().toISOString(),
        latencyMs: Date.now() - started,
        results: results.length,
        resultDomains: [...new Set(results.map((r) => r.domain))],
        resultUrls: results.map((r) => r.url),
        itemPages: offers,
        searchLink: marketplaceSearchUrl(query, site),
      },
      null,
      2,
    ),
  );
}

void main();
