import { z } from "zod";
import { MAIN_BRANCH_ID } from "@/server/db";
import { ServiceError } from "@/server/errors";
import { handle } from "@/server/http";
import { opsSchema } from "@/server/opschema";
import { createCommit } from "@/server/services";

const body = z.object({
  message: z.string(),
  ops: opsSchema,
  expectedHead: z.string().min(1),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async (user) => {
    const branchId = (await params).id;
    if (branchId === MAIN_BRANCH_ID)
      throw new ServiceError(403, "main_protected", "main only changes through merges — create a branch, commit there, and merge back");
    const parsed = body.parse(await request.json());
    return createCommit({
      branchId,
      userId: user.id,
      message: parsed.message,
      ops: parsed.ops,
      expectedHead: parsed.expectedHead,
    });
  });
}
