import { app } from "electron";

import type { WakeControl, WakeReport } from "@/core/platform/platform";

/** The few words the main process shows itself (tray, notifications), in the OS language. */
const ES = {
  open: "Abrir ELISE",
  connected: "Conectado",
  cloudOffline: "Sin conexión a ELISE Cloud",
  home: (s: string) => `ELISE Home: ${s}`,
  homeReady: "Activo",
  homeOffline: "Sin conexión",
  homeStarting: "Iniciando…",
  checkUpdates: "Buscar actualizaciones",
  restartToUpdate: "Reiniciar para actualizar",
  settings: "Configuración",
  pauseListening: "Pausar escucha de “ELISE”",
  resumeListening: "Reanudar escucha de “ELISE”",
  enableListening: "Activar escucha de “ELISE”…",
  wake: (s: WakeReport, c: WakeControl): string =>
    c.suspended
      ? "○ Escucha detenida (pantalla bloqueada)"
      : c.paused || s === "paused"
        ? "○ Escucha en pausa"
        : s === "listening"
          ? "● Escuchando “ELISE”"
          : s === "in_conversation"
            ? "● En conversación"
            : s === "no_microphone" || s === "mic_denied"
              ? "○ Micrófono no disponible"
              : s === "model_failed"
                ? "○ Detector no disponible"
                : "○ Preparando escucha…",
  quit: "Salir de ELISE",
  crashed: "La interfaz de ELISE se detuvo varias veces. Tus datos están a salvo.",
  retry: "Reintentar",
  restart: "Reiniciar ELISE",
};
const EN: typeof ES = {
  open: "Open ELISE",
  connected: "Connected",
  cloudOffline: "Can't reach ELISE Cloud",
  home: (s: string) => `ELISE Home: ${s}`,
  homeReady: "Active",
  homeOffline: "Offline",
  homeStarting: "Starting…",
  checkUpdates: "Check for updates",
  restartToUpdate: "Restart to update",
  settings: "Settings",
  pauseListening: "Pause listening for “ELISE”",
  resumeListening: "Resume listening for “ELISE”",
  enableListening: "Turn on listening for “ELISE”…",
  wake: (s: WakeReport, c: WakeControl) =>
    c.suspended
      ? "○ Listening stopped (screen locked)"
      : c.paused || s === "paused"
        ? "○ Listening paused"
        : s === "listening"
          ? "● Listening for “ELISE”"
          : s === "in_conversation"
            ? "● In a conversation"
            : s === "no_microphone" || s === "mic_denied"
              ? "○ Microphone unavailable"
              : s === "model_failed"
                ? "○ Detector unavailable"
                : "○ Getting ready to listen…",
  quit: "Quit ELISE",
  crashed: "ELISE's interface stopped several times. Your data is safe.",
  retry: "Retry",
  restart: "Restart ELISE",
};

export const words = () => (app.getLocale().toLowerCase().startsWith("es") ? ES : EN);
