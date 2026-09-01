import { z } from "zod";
import { handle } from "@/server/http";
import { markDeployed } from "@/server/services";

const body = z.object({ expectedHead: z.string().min(1) });

export async function POST(request: Request) {
  return handle(async (user) => {
    const { expectedHead } = body.parse(await request.json());
    return markDeployed(user.id, expectedHead);
  });
}
