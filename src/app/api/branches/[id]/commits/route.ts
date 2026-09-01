import { z } from "zod";
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
    const parsed = body.parse(await request.json());
    return createCommit({
      branchId: (await params).id,
      userId: user.id,
      message: parsed.message,
      ops: parsed.ops,
      expectedHead: parsed.expectedHead,
    });
  });
}
