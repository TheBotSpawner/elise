import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/core/errors";
import { PREVIEW_TEXT, resolveProfile } from "@/core/voice/profiles";
import type { SpeechOutputProvider, SynthesisRequest } from "@/core/voice/providers";
import { formatForSpeech, numberWords } from "@/core/voice/speech-format";
import { SEGMENT, SentenceChunker } from "@/core/voice/speech-text";
import {
  ElevenLabsSpeechOutput,
  isDialogueModel,
  sanitizeForProvider,
} from "@/infrastructure/ai/elevenlabs/speech";
import { FailoverSpeechOutput } from "@/infrastructure/ai/failover-speech";

/**
 * Spoken output (ADR-030): natural units, spoken numbers, a provider behind an interface with
 * failover — ElevenLabs mocked (HTTP and WebSocket); no network.
 */

const stream = (bytes: number[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(bytes));
      c.close();
    },
  });

describe("speech segmenter", () => {
  const run = (deltas: string[]) => {
    const c = new SentenceChunker();
    return [...deltas.flatMap((d) => c.push(d)), ...c.flush()];
  };

  it("the first unit goes as soon as one sentence completes; later short sentences travel together", () => {
    const units = run([
      "Sí, encontré la reunión de hoy. ",
      "Es a las dos. Es con Ana. Te dejé ",
      "el detalle en pantalla. Avisame si querés mover algo.",
    ]);
    expect(units[0]).toBe("Sí, encontré la reunión de hoy.");
    expect(units[1]).toContain("Es a las dos. Es con Ana.");
    expect(units.length).toBeLessThanOrEqual(3);
  });

  it("never splits a word, a number, a time or after an abbreviation; ':' and ';' don't end a unit", () => {
    const units = run([
      "El Dr. García confirmó: la reunión es a las 14:30; ",
      "el presupuesto es de 23.500 pesos, con un 12.5 por ciento de ajuste. Listo.",
    ]);
    const joined = units.join(" ");
    expect(joined).toContain("Dr. García");
    expect(joined).toContain("14:30");
    expect(joined).toContain("23.500");
    expect(joined).toContain("12.5");
    for (const u of units) expect(u).not.toMatch(/^(García|30|500|5 )/);
  });

  it("a very long sentence is cut at a clause, and never mid-word", () => {
    const long = `${"Revisé las opciones disponibles con cuidado, ".repeat(8)}y la tercera es la mejor.`;
    const units = run([long]);
    expect(units.length).toBeGreaterThan(1);
    for (const u of units.slice(0, -1)) expect(u.length).toBeLessThanOrEqual(SEGMENT.max);
    expect(units.join(" ").replace(/\s+/g, " ")).toBe(long.replace(/\s+/g, " ").trim());
  });

  it("markdown and links never reach the voice", () => {
    expect(run(["**Listo.** Mirá [la fuente](https://x.example/a) [1]. "])).toEqual([
      "Listo. Mirá la fuente.",
    ]);
  });
});

describe("speech formatter", () => {
  it("says amounts, times and counts as words, without changing them", () => {
    expect(formatForSpeech("La más barata ronda los $23.500.", "es")).toBe(
      "La más barata ronda los veintitrés mil quinientos.",
    );
    expect(formatForSpeech("Cuesta US$ 1.200.", "es")).toBe("Cuesta mil doscientos dólares.");
    expect(formatForSpeech("Es a las 14:30.", "es")).toBe("Es a las dos y media de la tarde.");
    expect(formatForSpeech("Hay 1.250.000 habitantes.", "es")).toBe(
      "Hay un millón doscientos cincuenta mil habitantes.",
    );
    expect(formatForSpeech("It costs $23,500.", "en")).toBe(
      "It costs twenty-three thousand five hundred.",
    );
    expect(formatForSpeech("Subió 12%.", "es")).toBe("Subió 12 por ciento.");
  });

  it("number words are exact (Spanish agreement included)", () => {
    expect(numberWords(21_000, "es")).toBe("veintiún mil");
    expect(numberWords(100, "es")).toBe("cien");
    expect(numberWords(101, "es")).toBe("ciento uno");
    expect(numberWords(2_000_000, "es")).toBe("dos millones");
    expect(numberWords(1_000_000_000, "es")).toBeNull();
  });

  it("what it doesn't recognise stays exactly as written", () => {
    expect(formatForSpeech("Versión 2.1.3 del 22/09.", "es")).toBe("Versión 2.1.3 del 22/09.");
  });

  it("provider control syntax from the model is stripped (no injected tags)", () => {
    expect(sanitizeForProvider("Listo [laughs] <break time='3s'/> ya está.")).toBe(
      "Listo ya está.",
    );
  });
});

describe("ElevenLabs adapter", () => {
  afterEach(() => vi.unstubAllGlobals());
  const voices = { elise: "voice-elise", "elise-alt": "voice-alt" };
  const settings = { stability: 0.55 };

  it("HTTP models stream PCM with the previous segment for continuous intonation", async () => {
    const fetch = vi.fn(async () => new Response(stream([1, 2, 3, 4])));
    vi.stubGlobal("fetch", fetch);
    const p = new ElevenLabsSpeechOutput("sk-secret", "eleven_flash_v2_5", voices, settings);
    const out = await p.synthesize({
      text: "Es a las dos.",
      language: "es",
      voice: "elise-alt",
      previousText: "Encontré la reunión.",
    });
    expect(new Uint8Array(await new Response(out).arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/text-to-speech/voice-alt/stream?output_format=pcm_24000");
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("sk-secret");
    expect(JSON.parse(init.body as string)).toMatchObject({
      model_id: "eleven_flash_v2_5",
      language_code: "es",
      previous_text: "Encontré la reunión.",
    });
  });

  it("v4 Turbo speaks through Text to Dialogue: register voice, send, flush, stream until final", async () => {
    const sent: unknown[] = [];
    class FakeSocket {
      static last: FakeSocket;
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      closed = false;
      constructor(readonly url: string) {
        FakeSocket.last = this;
        queueMicrotask(() => this.onopen?.());
      }
      send(data: string) {
        sent.push(JSON.parse(data));
        if (JSON.parse(data).flush)
          queueMicrotask(() => {
            this.onmessage?.({
              data: JSON.stringify({ audio: Buffer.from([5, 6]).toString("base64") }),
            });
            this.onmessage?.({
              data: JSON.stringify({ audio: Buffer.from([7, 8]).toString("base64") }),
            });
            this.onmessage?.({ data: JSON.stringify({ is_final: true }) });
          });
      }
      close() {
        this.closed = true;
      }
    }
    vi.stubGlobal("WebSocket", FakeSocket);
    const p = new ElevenLabsSpeechOutput("sk-secret", "eleven_v4_turbo", voices, settings);
    const out = await p.synthesize({
      text: "Hola [whispers] Leo.",
      language: "es",
      voice: "elise",
    });
    expect(new Uint8Array(await new Response(out).arrayBuffer())).toEqual(
      new Uint8Array([5, 6, 7, 8]),
    );
    expect(FakeSocket.last.url).toContain("text-to-dialogue/stream-input?model_id=eleven_v4_turbo");
    expect(sent).toEqual([
      { voices: ["voice-elise"], xi_api_key: "sk-secret", voice_settings: settings },
      { inputs: [{ text: "Hola Leo.", voice_id: "voice-elise" }] },
      { flush: true },
    ]);
    expect(FakeSocket.last.closed).toBe(true);
    expect(isDialogueModel("eleven_v4_turbo")).toBe(true);
    expect(isDialogueModel("eleven_flash_v2_5")).toBe(false);
  });

  it("a refused request is a typed error (never the provider's text)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad key for text 'secret'", { status: 401 })),
    );
    const p = new ElevenLabsSpeechOutput("k", "eleven_flash_v2_5", voices, settings);
    await expect(
      p.synthesize({ text: "Hola.", language: "es", voice: "elise" }),
    ).rejects.toMatchObject({
      code: "AI_NOT_CONFIGURED",
    });
  });
});

describe("failover", () => {
  const provider = (
    id: string,
    impl: (r: SynthesisRequest) => Promise<ReadableStream<Uint8Array>>,
  ) =>
    ({
      id,
      model: id,
      format: { encoding: "pcm_s16le", sampleRate: 24_000 },
      voices: [],
      synthesize: vi.fn(impl),
    }) as unknown as SpeechOutputProvider & { synthesize: ReturnType<typeof vi.fn> };

  it("a failed segment is spoken by the fallback once; the primary rests, then is tried again", async () => {
    let now = 0;
    const primary = provider("elevenlabs", async () => {
      throw new AppError("RATE_LIMITED", "busy");
    });
    const fallback = provider("openai", async () => stream([1]));
    const f = new FailoverSpeechOutput(
      primary,
      fallback,
      () => "marin",
      60_000,
      () => now,
    );
    await f.synthesize({ text: "Uno.", language: "es", voice: "elise" });
    expect(fallback.synthesize).toHaveBeenCalledWith(
      { text: "Uno.", language: "es", voice: "marin" },
      undefined,
    );
    await f.synthesize({ text: "Dos.", language: "es", voice: "elise" });
    expect(primary.synthesize).toHaveBeenCalledTimes(1);
    expect(f.id).toBe("openai");
    now = 61_000;
    await f.synthesize({ text: "Tres.", language: "es", voice: "elise" });
    expect(primary.synthesize).toHaveBeenCalledTimes(2);
  });

  it("a cancelled request (barge-in) is not a provider failure", async () => {
    const controller = new AbortController();
    controller.abort();
    const primary = provider("elevenlabs", async () => {
      throw new DOMException("aborted", "AbortError");
    });
    const fallback = provider("openai", async () => stream([1]));
    const f = new FailoverSpeechOutput(primary, fallback, () => "marin");
    await expect(
      f.synthesize({ text: "x", language: "es", voice: "elise" }, controller.signal),
    ).rejects.toThrow();
    expect(fallback.synthesize).not.toHaveBeenCalled();
  });
});

describe("voice profiles and key safety", () => {
  it("a stored voice maps to the active provider's default when it belongs to the other one", () => {
    expect(resolveProfile("marin", "elevenlabs", ["elise", "elise-alt"])).toBe("elise");
    expect(resolveProfile("elise-alt", "elevenlabs", ["elise", "elise-alt"])).toBe("elise-alt");
    expect(resolveProfile("elise", "openai", [])).toBe("marin");
    expect(PREVIEW_TEXT.es).not.toMatch(/\{|\$\{/);
  });

  it("the ElevenLabs key is only read in server-only modules, never in client code or NEXT_PUBLIC_", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(f)) files.push(p);
      }
    };
    walk("src");
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/NEXT_PUBLIC_ELEVEN/);
      if (/ELEVENLABS_API_KEY|xi_api_key|xi-api-key/.test(src)) {
        expect(src.startsWith('"use client"'), f).toBe(false);
        expect(src.includes('import "server-only"'), f).toBe(true);
      }
    }
  });
});
