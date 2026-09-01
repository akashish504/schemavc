import { z } from "zod";
import { handle } from "@/server/http";
import { resolutionSchema } from "@/server/opschema";
import { compareWithMain } from "@/server/services";

const body = z.object({ resolutions: z.array(resolutionSchema).max(100).default([]) });

/** Dry-run merge. POST because resolutions ride in the body; nothing is written. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { resolutions } = body.parse(await request.json().catch(() => ({})));
    return compareWithMain((await params).id, resolutions);
  });
}
