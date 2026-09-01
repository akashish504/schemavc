import { handle } from "@/server/http";
import { branchDetail } from "@/server/services";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => branchDetail((await params).id));
}
