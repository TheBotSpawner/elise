import type { AuthFormState } from "@/features/auth/actions";

/**
 * The web's auth actions on Desktop (ADR-081/092). Signing in happens in the browser (PKCE,
 * ADR-084) and is never sent over RPC; signing out ends Desktop's own session (the
 * OS-encrypted one this app holds), not a browser cookie. Every "Cerrar sesión" in the shared
 * UI (top bar, bottom bar, Settings › Cuenta) lands here.
 */
export async function signOut(): Promise<void> {
  await window.eliseDesktop!.signOut();
}

const browserOnly = async (): Promise<AuthFormState> => ({
  error: "genericError", // never reached: Desktop has no in-app sign-in form
});
export const signInWithPassword = browserOnly;
export const signUpWithPassword = browserOnly;
export const sendMagicLink = browserOnly;
export async function signInWithGoogle(): Promise<void> {
  await window.eliseDesktop!.signIn();
}

export type { AuthFormState };
