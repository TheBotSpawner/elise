"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import type { NativeModuleKey } from "@/core/modules/registry";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";

import { setModuleAction } from "./actions";

/** Turns a module on from its guard; the page then renders normally (server refresh). */
export function EnableModuleButton({ module, label }: { module: NativeModuleKey; label: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await setModuleAction(module, true);
          if (!r.ok) return void toast.error(errorText(t, r.error));
          toast.success(t.myEliseModules.enabledToast(t.capabilities[module]));
          router.refresh();
        })
      }
    >
      {label}
    </Button>
  );
}
