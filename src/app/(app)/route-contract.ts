import type { AuthContext } from "@/application/auth-context";

/**
 * One screen = a loader + a view (ADR-092). The loader runs on the server (the web page, and
 * ELISE Cloud for Desktop's local renderer); it may call next/navigation's redirect() or
 * notFound(). The view renders on either platform from the loader's props alone, so it imports
 * nothing server-only (Desktop's build fails if it does).
 */
export type RouteSearch = Record<string, string | string[] | undefined>;

export interface RouteInput {
  params: Record<string, string>;
  search: RouteSearch;
}

export type RouteLoader<P> = (auth: AuthContext, input: RouteInput) => Promise<P>;

/** A first query value, or undefined. */
export const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
