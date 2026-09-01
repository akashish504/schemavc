import { z } from "zod";
import { handle } from "@/server/http";
import { deployStatus, deployToTarget } from "@/server/services";

export async function GET() {
  return handle(async () => deployStatus());
}

const body = z.object({ expectedHead: z.string().min(1) });

export async function POST(request: Request) {
  return handle(async (user) => {
    const { expectedHead } = body.parse(await request.json());
    return deployToTarget(user.id, expectedHead);
  });
}
