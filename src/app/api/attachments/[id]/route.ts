import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { attachmentImage } from "@/application/attachments-service";
import { getAuthContext } from "@/application/auth-context";

/**
 * A sent chat image, for its author only (ADR-060): the transcript's thumbnail and larger
 * preview, which survive reloads. Same-origin bytes, private cache; no signed storage URL ever
 * reaches the page.
 */
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/attachments/[id]">) {
  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return new NextResponse(null, { status: 404 });
  const auth = await getAuthContext();
  if (!auth) return new NextResponse(null, { status: 401 });
  const image = await attachmentImage(auth, id);
  if (!image) return new NextResponse(null, { status: 404 });
  return new NextResponse(Buffer.from(image.data), {
    headers: {
      "content-type": image.mimeType,
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
    },
  });
}
