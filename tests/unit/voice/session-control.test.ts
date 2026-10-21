import { describe, expect, it } from "vitest";

import { sessionCommand } from "@/core/voice/session-control";

describe("sessionCommand (ADR-102)", () => {
  it.each([
    "ELISE, dejá de escuchar.",
    "Dejá de escuchar",
    "deja de escucharme",
    "Basta de escuchar, por favor.",
    "Pará de escuchar",
    "ELISE, silencio.",
    "Silencio",
    "Cortá la conversación.",
    "Terminá la conversación, gracias",
    "basta",
    "che, pará de escuchar ya",
    "No me escuches más",
    "Stop listening",
  ])("%s → stop", (text) => expect(sessionCommand(text)).toBe("stop"));

  it.each([
    "Desactivá la activación por voz",
    "ELISE, desactivá la palabra de activación",
    "No vuelvas a escuchar hasta que te active",
    "Dejá de escuchar hasta que te lo diga",
    "Apagá la escucha de ELISE",
  ])("%s → disable_wake", (text) => expect(sessionCommand(text)).toBe("disable_wake"));

  it.each([
    "ELISE, mostrate",
    "Elise, abrite.",
    "Elis, aparecé por favor",
    "Mostrame la app",
    "Abrí ELISE",
    "ELISE, vení",
  ])("%s → show (ADR-104)", (text) => expect(sessionCommand(text)).toBe("show"));

  it.each([
    "Mostrame mis tareas",
    "Abrí el correo de Juan",
    "Mostrame la pantalla del calendario de mañana",
  ])("%s → not a show command (a real request)", (text) => expect(sessionCommand(text)).toBeNull());

  it.each([
    "Anotá la frase 'dejá de escuchar'",
    "¿Por qué dejás de escuchar cuando hablo?",
    "Mandale a Juan: basta de escuchar música fuerte",
    "Poné silencio en el celular a las 10",
    "Para mañana tengo reunión",
    "Cortá la conversación con Pedro en Slack",
    "",
  ])("%s → nothing", (text) => expect(sessionCommand(text)).toBeNull());
});
