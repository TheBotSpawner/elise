"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { createClient } from "@/infrastructure/supabase/client";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";

import { prepareFileImportAction } from "./actions";

/** CSV / Excel import: upload to the private bucket, then the mapping wizard. */
export function useFinanceUpload() {
  const { t } = useI18n();
  const router = useRouter();
  const [uploading, setUploading] = useState(false);
  async function upload(f: File) {
    setUploading(true);
    try {
      const prepared = await prepareFileImportAction({ name: f.name, size: f.size, type: f.type });
      if (!prepared.ok) {
        toast.error(errorText(t, prepared.error));
        return;
      }
      const { error } = await createClient()
        .storage.from("finance-imports")
        .uploadToSignedUrl(prepared.value.path, prepared.value.token, f, {
          contentType: f.type || "application/octet-stream",
        });
      if (error) {
        toast.error(t.errors.codes.INTERNAL_ERROR);
        return;
      }
      router.push(`/my-elise/finance/import/${prepared.value.importId}`);
    } finally {
      setUploading(false);
    }
  }
  return { upload, uploading };
}
