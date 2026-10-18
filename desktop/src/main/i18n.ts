import { app } from "electron";

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
  quit: "Quit ELISE",
  crashed: "ELISE's interface stopped several times. Your data is safe.",
  retry: "Retry",
  restart: "Restart ELISE",
};

export const words = () => (app.getLocale().toLowerCase().startsWith("es") ? ES : EN);
