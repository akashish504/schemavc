import { z } from "zod";
import { handle } from "@/server/http";
import { branchesOverview, createBranch } from "@/server/services";

export async function GET() {
  return handle(async () => branchesOverview());
}

const body = z.object({ name: z.string().trim().min(1).max(63) });

export async function POST(request: Request) {
  return handle(async (user) => {
    const { name } = body.parse(await request.json());
    return createBranch(name, user.id);
  });
}
