import { describe, expect, it } from "vitest";

import { gatherBrief } from "@/application/morning-brief-service";
import { briefCanvas } from "@/core/briefs/canvas";
import { assembleBrief } from "@/core/briefs/morning-brief";
import type { EmailMessage } from "@/core/capabilities/email";
import { scoreEmail, triageAccount, TRIAGE_MAX } from "@/core/capabilities/email-triage";
import { AppError } from "@/core/errors";
import { morningBriefConfigSchema } from "@/core/schedules/schedule";
import { surfacesFromOutcome } from "@/core/workspace/from-results";
import type { SurfacePayloads } from "@/core/workspace/registry";

import {
  binding,
  InMemoryEmailProvider,
  makeCtx,
  makePorts,
  NATIVE_BINDING,
} from "../../fixtures/core-fakes";

/** Email per account in the Morning Brief (ADR-067). */

const PERSONAL = "11111111-1111-4111-8111-111111111111";
const FIRBOT = "22222222-2222-4222-8222-222222222222";
const UTN = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-10-16T11:00:00Z");

function setup() {
  const personal = new InMemoryEmailProvider(PERSONAL, "Personal", "leo@gmail.com");
  const firbot = new InMemoryEmailProvider(FIRBOT, "Firbot", "leo@firbot.com");
  const utn = new InMemoryEmailProvider(UTN, "UTN", "leo@utn.edu.ar");
  const providers = new Map<string, unknown>([
    [PERSONAL, personal],
    [FIRBOT, firbot],
    [UTN, utn],
  ]);
  const bindings = [
    NATIVE_BINDING,
    binding({
      connectionId: PERSONAL,
      capability: "email",
      providerKey: "google",
      label: "Personal",
      accountLabel: "leo@gmail.com",
      isDefault: true,
    }),
    binding({
      connectionId: FIRBOT,
      capability: "email",
      providerKey: "google",
      label: "Firbot",
      accountLabel: "leo@firbot.com",
    }),
    binding({
      connectionId: UTN,
      capability: "email",
      providerKey: "microsoft",
      label: "UTN",
      accountLabel: "leo@utn.edu.ar",
    }),
  ];
  const { ports } = makePorts(bindings);
  ports.providers = {
    get: ((_c: string, b: { connectionId: string }) =>
      providers.get(b.connectionId)) as typeof ports.providers.get,
  };
  const ctx = makeCtx({ origin: "schedule", now: NOW });
  return { ports, ctx, personal, firbot, utn };
}

const config = morningBriefConfigSchema.parse({ blocks: ["email", "needs_reply"] });
const recent = "2026-10-16T09:00:00.000Z";

/** A newsletter, a promotion and a policy notice: never in the brief. */
function noise(p: InMemoryEmailProvider, prefix: string) {
  p.addMessage({
    id: `${prefix}n1`,
    threadId: `${prefix}tn1`,
    from: { email: "news@shop.com", name: "Shop" },
    subject: "20% OFF todo el fin de semana",
    category: "promotions",
    bulk: true,
    date: recent,
  });
  p.addMessage({
    id: `${prefix}n2`,
    threadId: `${prefix}tn2`,
    from: { email: "hello@email.trigger.dev", name: "Trigger.dev" },
    subject: "Update to our sub-processors",
    date: recent,
  });
}

describe("Email triage (deterministic)", () => {
  const base = (over: Partial<EmailMessage>): EmailMessage => {
    const p = new InMemoryEmailProvider(PERSONAL, "Personal", "leo@gmail.com");
    return p.addMessage({ id: "x", threadId: "tx", date: recent, ...over });
  };

  it("newsletters and promotions are noise; an unpaid invoice is not", () => {
    expect(
      scoreEmail({ message: base({ subject: "Newsletter semanal", bulk: true }) }, NOW).noise,
    ).toBe(true);
    const invoice = scoreEmail(
      {
        message: base({
          from: { email: "billing@hosting.com", name: "Hosting" },
          subject: "Factura pendiente: vence mañana",
          bulk: true,
        }),
      },
      NOW,
    );
    expect(invoice.noise).toBe(false);
    expect(invoice.paymentRelated).toBe(true);
    expect(invoice.deadlineRelated).toBe(true);
  });

  it("a security alert from an automated sender still counts", () => {
    const p = scoreEmail(
      {
        message: base({
          from: { email: "no-reply@accounts.google.com", name: "Google" },
          subject: "Alerta de seguridad: nuevo inicio de sesión",
        }),
      },
      NOW,
    );
    expect(p.noise).toBe(false);
    expect(p.securityRelated).toBe(true);
  });

  it("never pads: two relevant emails stay two; never more than the cap", () => {
    const p = new InMemoryEmailProvider(PERSONAL, "Personal", "leo@gmail.com");
    const relevant = [
      p.addMessage({ id: "a", threadId: "ta", subject: "Contrato: ¿lo firmás hoy?", date: recent }),
      p.addMessage({ id: "b", threadId: "tb", subject: "Factura impaga", date: recent }),
      p.addMessage({
        id: "c",
        threadId: "tc",
        subject: "Weekly digest",
        bulk: true,
        date: recent,
      }),
    ];
    expect(
      triageAccount(
        relevant.map((message) => ({ message })),
        NOW,
      ),
    ).toHaveLength(2);
    const many = Array.from({ length: 25 }, (_, i) =>
      p.addMessage({
        id: `u${i}`,
        threadId: `tu${i}`,
        from: { email: `client${i}@acme.com`, name: `Client ${i}` },
        subject: `Urgente: problema con el pedido ${String.fromCharCode(65 + i)}`,
        date: recent,
      }),
    );
    expect(
      triageAccount(
        many.map((message) => ({ message })),
        NOW,
      ).length,
    ).toBe(TRIAGE_MAX);
  });

  it("one row per thread, and a repeated notice is one row", () => {
    const p = new InMemoryEmailProvider(PERSONAL, "Personal", "leo@gmail.com");
    const alert = (id: string, thread: string) =>
      p.addMessage({
        id,
        threadId: thread,
        from: { email: "alerts@make.com", name: "Make" },
        subject: "Error on LL - Log Message",
        date: recent,
      });
    const out = triageAccount(
      [{ message: alert("1", "t1") }, { message: alert("2", "t1") }, { message: alert("3", "t2") }],
      NOW,
    );
    expect(out).toHaveLength(1);
  });
});

describe("Morning Brief: one Communication Surface per account (ADR-067)", () => {
  it("three accounts → three groups, each with its alias and provider, ranked", async () => {
    const { ports, ctx, personal, firbot, utn } = setup();
    for (const [p, prefix] of [
      [personal, "p"],
      [firbot, "f"],
      [utn, "u"],
    ] as const)
      noise(p, prefix);
    personal.addMessage({
      id: "p1",
      threadId: "pt1",
      from: { email: "billing@host.com", name: "Host" },
      subject: "Tu factura vence mañana",
      date: recent,
    });
    firbot.addMessage({
      id: "f1",
      threadId: "ft1",
      from: { email: "ana@client.com", name: "Ana" },
      subject: "¿Podés confirmar la propuesta hoy?",
      snippet: "¿Lo vemos?",
      date: recent,
    });
    firbot.addMessage({
      id: "f2",
      threadId: "ft2",
      from: { email: "pedro@client.com", name: "Pedro" },
      subject: "Gracias por la reunión",
      date: "2026-10-15T09:00:00.000Z",
    });
    utn.addMessage({
      id: "u1",
      threadId: "ut1",
      from: { email: "prof@utn.edu.ar", name: "Profesor" },
      subject: "Cambio de aula para la clase del jueves",
      date: recent,
    });

    const { data } = await gatherBrief(ports, ctx, config);
    const groups = data.email!.triage;
    expect(groups.map((g) => [g.account.label, g.account.providerKey]).sort()).toEqual([
      ["Firbot", "google"],
      ["Personal", "google"],
      ["UTN", "microsoft"],
    ]);
    // Noise never fills a widget.
    const subjects = data.email!.messages.map((m) => m.subject);
    expect(subjects).not.toContain("20% OFF todo el fin de semana");
    expect(subjects).not.toContain("Update to our sub-processors");
    // Within an account: the reply that's waiting comes first, flagged.
    const firbotGroup = groups.find((g) => g.account.label === "Firbot")!;
    expect(firbotGroup.items[0]).toMatchObject({ status: "needs_reply" });
    expect(["high", "medium"]).toContain(firbotGroup.items[0]!.level);
    // The payment is in, and prioritized.
    const personalGroup = groups.find((g) => g.account.label === "Personal")!;
    expect(personalGroup.items[0]).toMatchObject({ status: "needs_reply" });
    expect(personalGroup.items[0]!.reasons).toContain("payment");

    // The persisted brief keeps provenance per account, never tokens.
    const brief = assembleBrief(data);
    expect(brief.communication?.map((c) => c.account.alias).sort()).toEqual([
      "Firbot",
      "Personal",
      "UTN",
    ]);
    expect(brief.communication?.find((c) => c.account.alias === "UTN")).toMatchObject({
      type: "communication",
      account: { connectionId: UTN, provider: "microsoft", email: "leo@utn.edu.ar" },
    });

    // The Canvas: one Surface per account, each refreshing only its account.
    const read = { block: "email", tool: "email.triage", args: { limit: 10 } };
    const items = briefCanvas(brief, [
      {
        ...read,
        display: { kind: "email_list", messages: data.email!.messages, triage: groups },
      },
    ]);
    expect(items.map((i) => i.args.destination).sort()).toEqual([
      "leo@firbot.com",
      "leo@gmail.com",
      "leo@utn.edu.ar",
    ]);
    const surfaces = items.flatMap((i) =>
      surfacesFromOutcome(i.tool, { status: "succeeded", display: i.display }, { key: i.callId }),
    );
    expect(surfaces).toHaveLength(3);
    const utnSurface = surfaces.find((s) => s.title === "UTN")!;
    expect((utnSurface.payload as SurfacePayloads["email_list"]).mailbox).toEqual({
      label: "UTN",
      providerKey: "microsoft",
      address: "leo@utn.edu.ar",
    });
  });

  it("an account with nothing relevant gets no Surface", async () => {
    const { ports, ctx, personal, firbot } = setup();
    noise(personal, "p");
    firbot.addMessage({
      id: "f1",
      threadId: "ft1",
      subject: "¿Cerramos el contrato hoy?",
      date: recent,
    });
    const { data } = await gatherBrief(ports, ctx, config);
    expect(data.email!.triage.map((g) => g.account.label)).toEqual(["Firbot"]);
    expect(assembleBrief(data).communication).toHaveLength(1);
  });

  it("one account failing never hides the others, and is named", async () => {
    const { ports, ctx, personal, firbot } = setup();
    personal.failReads = new AppError("AUTH_EXPIRED", "reconnect");
    firbot.addMessage({
      id: "f1",
      threadId: "ft1",
      subject: "¿Confirmás la reunión de hoy?",
      date: recent,
    });
    const { data } = await gatherBrief(ports, ctx, config);
    expect(data.email!.triage.map((g) => g.account.label)).toEqual(["Firbot"]);
    expect(data.warnings).toContainEqual({
      block: "email",
      code: "AUTH_EXPIRED",
      account: "Personal",
    });
  });
});
