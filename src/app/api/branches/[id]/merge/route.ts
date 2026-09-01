import { z } from "zod";
import { handle } from "@/server/http";
import { resolutionSchema } from "@/server/opschema";
import { submitMerge } from "@/server/services";

const body = z.object({
  resolutions: z.array(resolutionSchema).max(100).default([]),
  expectedMainHead: z.string().min(1),
  acknowledgedAdvisories: z.array(z.string()).max(200).default([]),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async (user) => {
    const parsed = body.parse(await request.json());
    return submitMerge({
      branchId: (await params).id,
      userId: user.id,
      resolutions: parsed.resolutions,
      expectedMainHead: parsed.expectedMainHead,
      acknowledgedAdvisories: parsed.acknowledgedAdvisories,
    });
  });
}
