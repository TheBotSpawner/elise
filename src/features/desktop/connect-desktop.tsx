"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n/client";

import { approveDesktopConnect } from "./actions";

/** "Conectar ELISE Desktop": one explicit approval, then back to the app (ADR-081). */
export function ConnectDesktop({
  request,
  email,
}: {
  request: { challenge: string; state: string; installation: string };
  email: string | null;
}) {
  const { t } = useI18n();
  const c = t.desktop.connect;
  const [pending, start] = useTransition();
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const approve = () =>
    start(async () => {
      setError(null);
      const r = await approveDesktopConnect(request);
      if (!r.ok) return setError(r.error.message);
      setDone(r.redirect);
      window.location.href = r.redirect;
    });

  return (
    <section className="flex w-full max-w-sm flex-col items-center gap-4 text-center">
      <h1 className="text-[24px] font-light tracking-[-0.02em]">{c.title}</h1>
      {done ? (
        <>
          <p className="text-[14.5px] text-muted">{c.done}</p>
          <a href={done} className="text-[13.5px] text-accent-text hover:underline">
            {c.openAgain}
          </a>
        </>
      ) : (
        <>
          <p className="text-[14.5px] text-muted">{c.body(email ?? "")}</p>
          <Button size="lg" onClick={approve} disabled={pending}>
            {c.approve}
          </Button>
          <p className="text-[12.5px] text-faint">{c.notYou}</p>
          {error && (
            <p role="alert" className="text-[13px] text-danger-text">
              {error}
            </p>
          )}
        </>
      )}
    </section>
  );
}
