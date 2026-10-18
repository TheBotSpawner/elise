import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@/app/globals.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app";

// The web's fonts and system theme, before first paint (ADR-081: same look, local assets).
const root = document.documentElement;
root.style.setProperty("--font-geist-sans", '"Geist Variable", system-ui, sans-serif');
root.style.setProperty("--font-geist-mono", '"Geist Mono Variable", ui-monospace, monospace');
root.dataset.theme ??= "system";
root.classList.toggle("dark", window.matchMedia("(prefers-color-scheme: dark)").matches);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
