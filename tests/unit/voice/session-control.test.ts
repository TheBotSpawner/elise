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
    "Callate",
    "ELISE, no escuches",
    "Apagate",
    "No molestes",
    "No me escuches",
    "Eso es todo, gracias",
  ])("%s → stop", (text) => expect(sessionCommand(text)).toBe("stop"));

  it.each([
    "Desactivá la activación por voz",
    "ELISE, desactivá la palabra de activación",
    "No vuelvas a escuchar hasta que te active",
    "Dejá de escuchar hasta que te lo diga",
    "Apagá la escucha de ELISE",
    "ELISE, desactivá el modo escucha",
    "Desactivá la escucha",
    "Desactivá Escucha Activa",
    "Pasá a modo manual",
  ])("%s → disable_wake", (text) => expect(sessionCommand(text)).toBe("disable_wake"));

  it.each([
    "ELISE, activá la escucha",
    "Activá escucha activa",
    "Volvé a activar el modo escucha",
    "Prendé la activación por voz",
  ])("%s → enable_wake", (text) => expect(sessionCommand(text)).toBe("enable_wake"));

  it.each([
    "Elise, decime mi resumen del día",
    "Elise, traeme mi resumen del día",
    "Elise, resumen del día",
    "Elise, a ver mi resumen del día",
    "A ver el resumen de hoy",
    "Dame el resumen de hoy",
    "Leeme mi resumen del día, porfa",
    "Quiero escuchar el resumen del día",
    "Morning Brief",
    "¿Me decís el resumen del día?",
  ])("%s → daily_summary", (text) => expect(sessionCommand(text)).toBe("daily_summary"));

  it.each([
    "programá el resumen del día todos los días a las 7",
    "agregá las noticias al resumen del día",
  ])("%s → not the daily summary (goes to ELISE)", (text) =>
    expect(sessionCommand(text)).not.toBe("daily_summary"),
  );

  it.each(["apagá la tele", "callate un segundo que te explico algo largo", "no molestes a Juan"])(
    "%s → not a session command",
    (text) => expect(sessionCommand(text)).toBeNull(),
  );

  it.each([
    "ELISE, mostrate",
    "Elise, abrite.",
    "Elis, aparecé por favor",
    "Mostrame la app",
    "Abrí ELISE",
    "ELISE, vení",
    "mostrame.",
    "Elise, mostrá",
  ])("%s → show (ADR-104)", (text) => expect(sessionCommand(text)).toBe("show"));

  it.each([
    "Mostrame mis tareas",
    "Abrí el correo de Juan",
    "Mostrame la pantalla del calendario de mañana",
  ])("%s → not a show command (a real request)", (text) => expect(sessionCommand(text)).toBeNull());

  it.each([
    ["ELISE, subí el volumen", "volume_up"],
    ["Elise, subile un poco el volumen", "volume_up"],
    ["más volumen", "volume_up"],
    ["turn the volume up", "volume_up"],
    ["ELISE, bajá el volumen", "volume_down"],
    ["Bajale un poco el sonido, por favor", "volume_down"],
    ["menos volumen", "volume_down"],
  ])("%s → %s (ADR-106)", (text, command) => expect(sessionCommand(text)).toBe(command));

  it.each([
    "Subí el volumen de la tele del living",
    "Bajá la música",
    "Bajá el volumen de Spotify al 20%",
  ])("%s → not the computer's volume (a device or the music)", (text) =>
    expect(sessionCommand(text)).toBeNull(),
  );

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
