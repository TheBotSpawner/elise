import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  dedupe,
  entityKey,
  imageGalleryPayload,
  isOnTopic,
  moreImagesUrl,
  visualResultSchema,
  type VisualResult,
} from "@/core/web/images";

/**
 * ADR-120: real images. What counts as the same subject (a model's exact name, a place's
 * context), deduplication, the gallery's validated payload, the Commons adapter against a fake
 * API, and the tool: no provider → words only; nothing verifiable → no gallery; otherwise one
 * labeled group per subject. Mocks only here; the providers were also checked live (ADR-120).
 */

vi.mock("server-only", () => ({}));

const img = (over: Partial<VisualResult> = {}): VisualResult =>
  visualResultSchema.parse({
    id: "1",
    provider: "wikimedia_commons",
    title: "Baby Beach, Aruba",
    thumbnailUrl: "https://upload.wikimedia.org/a/640px-x.jpg",
    sourcePageUrl: "https://commons.wikimedia.org/wiki/File:x.jpg",
    alt: "Baby Beach",
    ...over,
  });

describe("what's on topic", () => {
  it("a model name must match exactly: an RM4 mini is never the RM4C mini", () => {
    const rm4c = { name: "Broadlink RM4C Mini" };
    expect(isOnTopic(rm4c, "Broadlink RM4C mini universal remote")).toBe(true);
    expect(isOnTopic(rm4c, "Broadlink RM4 mini universal remote")).toBe(false);
  });

  it("a one-word place needs its context; a distinctive name doesn't", () => {
    const baby = { name: "Baby Beach", context: "Aruba" };
    expect(isOnTopic(baby, "View of Baby Beach, Aruba")).toBe(true);
    expect(isOnTopic(baby, "Baby Beach, Fiji")).toBe(false);
    const kenepa = { name: "Playa Kenepa Grandi", context: "Curaçao" };
    expect(isOnTopic(kenepa, "Grote Knip Kenepa Grandi beach (34933031995)")).toBe(true);
    expect(isOnTopic(kenepa, "Kenepa Chiki")).toBe(false);
  });

  it("the same photo twice is kept once", () => {
    expect(
      dedupe([
        img(),
        img(),
        img({ id: "2", title: "Baby Beach at sunset", sourcePageUrl: "https://x.org/2" }),
      ]),
    ).toHaveLength(2);
  });
});

describe("the gallery's payload", () => {
  it("only https images from a provider, never javascript: or http:", () => {
    expect(
      visualResultSchema.safeParse({ ...img(), thumbnailUrl: "javascript:alert(1)" }).success,
    ).toBe(false);
    expect(visualResultSchema.safeParse({ ...img(), sourcePageUrl: "http://x.org" }).success).toBe(
      false,
    );
    expect(
      imageGalleryPayload.safeParse({
        groups: [{ key: "baby-beach-aruba", name: "Baby Beach", images: [img()] }],
        moreUrl: moreImagesUrl([{ name: "Baby Beach", context: "Aruba" }]),
      }).success,
    ).toBe(true);
  });

  it("the outside image search is a public query link; keys are stable per subject", () => {
    expect(moreImagesUrl([{ name: "Kenepa Grandi", context: "Curaçao" }])).toBe(
      "https://www.google.com/search?tbm=isch&q=Kenepa%20Grandi%20Cura%C3%A7ao",
    );
    expect(entityKey({ name: "Baby Beach", context: "Aruba" })).toBe("baby-beach-aruba");
  });
});

describe("Wikimedia Commons adapter", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("keeps on-topic photos with author, license and page; scales thumbnails safely", async () => {
    const { commonsImages } = await import("@/infrastructure/web/wikimedia-commons");
    const info = (title: string, width: number, extra: object = {}) => ({
      thumburl: `https://upload.wikimedia.org/thumb/${title}/1280px-${title}`,
      descriptionurl: `https://commons.wikimedia.org/wiki/File:${title}`,
      width,
      height: 800,
      mime: "image/jpeg",
      extmetadata: {
        Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Ginelly">Ginelly.Q</a>' },
        LicenseShortName: { value: "CC BY 4.0" },
        LicenseUrl: { value: "https://creativecommons.org/licenses/by/4.0" },
        ...extra,
      },
    });
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          query: {
            pages: {
              "1": {
                pageid: 1,
                index: 2,
                title: "File:Baby Beach, Aruba 02.jpg",
                imageinfo: [info("b2.jpg", 4000)],
              },
              "2": {
                pageid: 2,
                index: 1,
                title: "File:Baby Beach, Aruba 01.jpg",
                imageinfo: [info("b1.jpg", 500)],
              },
              "3": {
                pageid: 3,
                index: 3,
                title: "File:Baby Beach, Fiji.jpg",
                imageinfo: [info("f.jpg", 4000)],
              },
            },
          },
        }),
      ),
    );
    const out = await commonsImages(
      { name: "Baby Beach", context: "Aruba", kind: "place" },
      { count: 4, page: 1 },
    );
    expect(out.map((i) => i.title)).toEqual(["Baby Beach, Aruba 01", "Baby Beach, Aruba 02"]);
    expect(out[0]).toMatchObject({
      provider: "wikimedia_commons",
      creator: "Ginelly.Q",
      license: "CC BY 4.0",
      sourcePageUrl: "https://commons.wikimedia.org/wiki/File:b1.jpg",
      // 500 px wide: no 960 px thumbnail exists — the scaled 1280 URL (the original) is used.
      thumbnailUrl: "https://upload.wikimedia.org/thumb/b1.jpg/1280px-b1.jpg",
    });
    expect(out[1]!.thumbnailUrl).toBe("https://upload.wikimedia.org/thumb/b2.jpg/960px-b2.jpg");
    const asked = new URL(String(vi.mocked(fetch).mock.calls[0]![0]));
    expect(asked.searchParams.get("gsrsearch")).toBe("baby beach aruba filetype:bitmap");
  });

  it("a 429 is reported as such (never retried in a loop)", async () => {
    const { commonsImages } = await import("@/infrastructure/web/wikimedia-commons");
    vi.mocked(fetch).mockResolvedValue(new Response("", { status: 429 }));
    await expect(
      commonsImages(
        { name: "Eagle Beach", context: "Aruba", kind: "place" },
        { count: 2, page: 1 },
      ),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("web.images", () => {
  const env = (images?: unknown) =>
    ({
      ctx: { locale: "es", now: new Date(), timezone: "UTC" },
      binding: null,
      providers: { get: () => ({ images }) },
    }) as never;

  it("without an image provider: words only, no gallery", async () => {
    const { imagesTool } = await import("@/core/tools/web");
    const out = await imagesTool.run(
      { entities: [{ name: "Baby Beach", context: "Aruba" }] },
      env(),
    );
    expect(out.display).toBeUndefined();
    expect(out.output).toMatchObject({ found: false });
  });

  it("nothing verifiable: no gallery, never a substitute", async () => {
    const { imagesTool } = await import("@/core/tools/web");
    const images = vi.fn(async () => ({
      groups: [],
      missing: ["Broadlink RM4C Mini"],
      moreUrl: "https://www.google.com/search?tbm=isch&q=x",
      providers: [],
    }));
    const out = await imagesTool.run(
      { entities: [{ name: "Broadlink RM4C Mini", kind: "product" }] },
      env(images),
    );
    expect(out.display).toBeUndefined();
    expect(out.output).toMatchObject({ found: false, missing: ["Broadlink RM4C Mini"] });
  });

  it("three beaches: one labeled group each, 2 photos each; 'más fotos' keys that subject", async () => {
    const { imagesTool } = await import("@/core/tools/web");
    const images = vi.fn(async (req: { entities: { name: string }[]; count: number }) => ({
      groups: req.entities.map((e) => ({
        key: entityKey(e),
        name: e.name,
        context: "Aruba",
        mapsUrl: null,
        images: [img({ id: e.name, title: e.name })],
      })),
      missing: [],
      moreUrl: "https://www.google.com/search?tbm=isch&q=x",
      providers: ["wikimedia_commons"],
    }));
    const three = ["Eagle Beach", "Baby Beach", "Palm Beach"].map((name) => ({
      name,
      context: "Aruba",
      kind: "place",
    }));
    const out = await imagesTool.run({ entities: three }, env(images));
    expect(images.mock.calls[0]![0].count).toBe(2);
    expect(out.display).toMatchObject({ kind: "image_gallery", key: null });
    const more = await imagesTool.run({ entities: [three[1]], more: true }, env(images));
    expect(more.display).toMatchObject({ kind: "image_gallery", key: "baby-beach-aruba" });
  });
});

describe("when images are offered at all", () => {
  it("photo and travel requests load the image tool; arithmetic doesn't", async () => {
    const { selectTools } = await import("@/core/agents/tool-selection");
    const all = [{ name: "web.images" }, { name: "tasks.list" }] as never[];
    const has = (message: string) =>
      selectTools(all, { message }).tools.some(
        (t) => (t as { name: string }).name === "web.images",
      );
    expect(has("ELISE, mostrame fotos de la playa Kenepa Grandi en Curaçao")).toBe(true);
    expect(has("¿Cómo es el Broadlink RM4C Mini?")).toBe(true);
    expect(has("Me voy a Curaçao 4 días, ¿qué lugares visitar? Armame el itinerario")).toBe(true);
    expect(has("¿Cuánto es 7×8?")).toBe(false);
  });
});

describe("the tool is allowed to run", () => {
  it("web.images is a registered read of the web capability", async () => {
    const { getOperation } = await import("@/core/capabilities/registry");
    const { imagesTool } = await import("@/core/tools/web");
    expect(getOperation("web_search", imagesTool.operation)).toBeDefined();
  });
});

describe("variety", () => {
  it("one photo per author first", async () => {
    const { diversify } = await import("@/core/web/images");
    const a = (id: string, creator: string) =>
      img({ id, title: id, creator, sourcePageUrl: `https://x.org/${id}` });
    expect(
      diversify([a("1", "Serge"), a("2", "Serge"), a("3", "Ginelly")]).map((i) => i.id),
    ).toEqual(["1", "3", "2"]);
  });
});

describe("'investigá' / 'buscá en internet'", () => {
  it("is recognised and loads the web tools", async () => {
    const { selectTools, wantsWebSearch } = await import("@/core/agents/tool-selection");
    for (const m of [
      "Investigá cuándo sale el iPhone 18",
      "buscá en internet si abre el museo mañana",
      "Elise, buscalo en la web: ¿quién ganó ayer?",
      "averiguá el horario del banco",
    ])
      expect(wantsWebSearch(m), m).toBe(true);
    expect(wantsWebSearch("¿qué es la domótica?")).toBe(false);
    const all = [{ name: "web.search" }] as never[];
    expect(selectTools(all, { message: "averiguá el horario del banco" }).tools).toHaveLength(1);
  });
});
