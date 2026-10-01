# ADR-015: Web Search + Research

**Status:** Accepted (2026-10-01)

## Context

ELISE understands the user's private world: Calendar, Email, Tasks, Knowledge, Recall,
Structured, Finance. It also needs the current external world: news, current documentation,
prices, companies, comparisons. Web evidence has to stay distinct from Knowledge (the user's
sources), Recall (past interactions) and structured providers (private live data), and its
provenance must stay visible.

## Decisions

1. **A provider-independent `web_search` capability.** It is internal: server-provided, with
   no user connection. The model-facing tools are:
   - `web.search`: a quick fact, reading at most 2 pages;
   - `web.searchNews`: recent news, grouped into events;
   - `web.open`: a URL the user gives, or one result (this is the "getPage" operation);
   - `web.research`: bounded multi-question research;
   - `web.saveToKnowledge`: an explicit, recorded write, only when the user asks.

   No vendor tool names (`tavily.search`, `google.search`) exist. The Core knows
   `WebSearchProvider` and `WebCapability`, never the vendor.
2. **Providers** (APIs verified 2026-09-30):
   - **Default: OpenAI hosted web search.** The Responses API with the `web_search` tool. It
     works with the existing OpenAI key. `gpt-4.1-mini` answers in about 5 s; the reasoning
     models took about 14 s, and `minimal` reasoning isn't allowed with web search.

     A small model lists the pages it found, one cited line each. **The results are the
     search's own `url_citation` annotations** (URL and title), never URLs the model writes,
     so a result can't be invented. A first version asked for JSON instead; on news, the
     model wrote real-looking URLs that weren't among the consulted sources.

     Domain restriction uses `site:` in the query, because `gpt-4.1-mini` rejects
     `filters.allowed_domains`. Tracking parameters (`utm_source=openai`) are stripped.
   - **Optional: Tavily** (`POST /search`, topic `general|news`, `time_range`), used when
     `TAVILY_API_KEY` is set. It's faster and built for agents, and is the recommended
     production option. `WEB_SEARCH_PROVIDER` forces one or the other.

   Local places and product search are left for future dedicated providers
   (`LocalSearchProvider`) behind the same boundary.
3. **ELISE reads pages itself.** A server-side fetcher extracts readable content: the article
   or main content, without navigation, scripts, cookie banners, headers, footers or forms.
   It keeps the title, site, publication or update date, and final URL.

   Passages relevant to the question are selected; whole pages never go to the model. Search
   snippets are labelled as weaker evidence (`untrustedSnippet`) than inspected passages
   (`untrustedPassages`).
4. **SSRF protection (mandatory).**
   - Only `http:`/`https:` URLs, with no credentials and only standard ports. Localhost,
     `.local`, `.internal`, cloud metadata hosts, and private or reserved IP literals are
     blocked, including the hex form of IPv4-mapped IPv6.
   - **Every address the hostname resolves to is checked inside the socket's own DNS lookup**,
     so the validated address is the one connected to, with no DNS-rebinding window.
   - Redirects are followed manually (at most 4) and re-validated.
   - Pages are capped at 9 s and 1.5 MB, and only HTML or text is accepted.
   - No cookies or auth headers are sent.
5. **Pipeline and limits** (`WEB_LIMITS`, one place). It runs search → candidates → dedupe
   (normalized URL) → quality ranking → read the best → passages → synthesis with citations.
   - **Quick search** reads 2 pages.
   - **Research** takes 2–4 subquestions planned by the model in the tool call. They run in
     parallel, reading 2 pages each and at most 8 in total. A subquestion with no results
     gets one plainer retry. The whole run has a 45 s limit.
   - The model can't loop: each research call is bounded, and runtime step limits still
     apply.
6. **Source quality without a whitelist.** Ranking signals:
   - first-party sites (the query names the site);
   - documentation hosts;
   - recency for news;
   - at most two results per site.

   The model is told to prefer authoritative sources, distinguish community experience from
   fact, and surface disagreements.
7. **News.** Results are filtered by recency and anything older than the requested window is
   dropped. Titles sharing enough words are grouped into one event, so one story from several
   outlets is shown once.
8. **Citations.**
   - Every web-based claim cites a markdown link using the exact URL from the tool output.
     The model never invents URLs or cites unused sources.
   - Dates are given for current facts.
   - Weak evidence is said to be weak.
   - Mixed answers keep provenance apart ("Your documentation says…" / "Current Notion
     documentation says…"; "what was said before" / "what changed since").
9. **Web content is untrusted data.** It is wrapped and labelled in tool output, and the
   guidance says it can't instruct ELISE, change rules or ask for tools. Reading a page
   executes nothing. Regression tests cover pages that try exactly that.
10. **Surfaces.** The new types are `web_results`, `web_source`, `web_news` and
    `web_research`. Research shows progress per subquestion while it runs (loading, then
    ready).

    Links are validated (`https:`/internal only). Expanding a source re-reads it through the
    same fetcher. Comparisons use the existing `summary` Surface through `ui.present`.
11. **Meeting Prep.** If a participant's organization domain is external (not free mail and
    not the user's own), one public `web.search` about the company runs after the private
    sources. Its Surface has the lowest priority, so public context never crowds out private
    context, and it reaches the brief labelled as public.
12. **Morning Brief News.** The "News (your topics)" block is opt-in and uses only the topics
    the user types (up to 4). It looks at the last day, never repeats a story across topics,
    and keeps at most 2 items per topic and 5 in total, each with its sources. With no
    topics, it warns instead of producing generic news.
13. **Caching and cost.**
    - Cache: per instance and per workspace. Search results for 10 min, news for 5 min,
      pages for 30 min. The retrieval time is always kept. There is no crawler or index.
    - Usage: counted per workspace per day in `web_usage` (server-only increments). The caps
      are 300 searches and 600 page reads.
    - Logs carry only metrics (`web.searched`, `web.fetched`, `web.usage` with tokens and
      search calls or credits), never queries or page text.
14. **Persistence.** Web results belong to the interaction, so Recall covers them. They are
    never saved to Knowledge unless the user asks. A saved page becomes a Markdown document
    in the chosen Space, with its URL and retrieval date, ingested like an upload.

## Consequences

- Web works with no new credentials. Tavily can be switched in with one environment
  variable.
- OpenAI search adds about 5 s per query, and research runs queries in parallel. Tavily
  would lower that.
- The cache and usage counters are approximations per instance and per day. A shared cache
  and per-run cost reports come later.
