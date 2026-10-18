import { AppError } from "@/core/errors";

/**
 * Server Actions from Desktop (ADR-081): the build replaces each "use server" export with a call
 * here, which ELISE Cloud runs as that same action (its own auth and validation). FormData of
 * text fields travels as pairs; files never go this way. A redirect() inside the action
 * navigates locally, or opens the system browser for external URLs (OAuth connections).
 */
function encode(arg: unknown): unknown {
  if (typeof FormData !== "undefined" && arg instanceof FormData) {
    const pairs: [string, string][] = [];
    arg.forEach((v, k) => {
      if (typeof v !== "string") throw new AppError("VALIDATION_ERROR", "Files can't be sent here");
      pairs.push([k, v]);
    });
    return { __formData: pairs };
  }
  return arg;
}

export class CloudUnavailableError extends AppError {
  constructor() {
    super("PROVIDER_UNAVAILABLE", "ELISE Cloud isn't reachable right now.", { recovery: "retry" });
  }
}

export async function callAction(module: string, fn: string, args: unknown[]): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch("/api/desktop/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ module, fn, args: args.map(encode) }),
    });
  } catch {
    throw new CloudUnavailableError();
  }
  const body = (await res.json().catch(() => null)) as {
    value?: unknown;
    redirect?: string;
    error?: { code?: string; message?: string };
  } | null;
  if (res.status === 503 && body?.error?.code === "CLOUD_UNAVAILABLE")
    throw new CloudUnavailableError();
  if (!res.ok || !body) throw new Error(body?.error?.message ?? "Request failed");
  if (body.redirect) {
    const url = new URL(body.redirect, window.location.href);
    if (url.origin === window.location.origin) {
      window.history.pushState(null, "", url.pathname + url.search);
      window.dispatchEvent(new PopStateEvent("popstate"));
    } else void window.eliseDesktop?.openExternal(url.href);
    return undefined;
  }
  return body.value;
}
