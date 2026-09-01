import { handle } from "@/server/http";
import { commitDetail } from "@/server/services";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => commitDetail((await params).id));
}
