import { handle } from "@/server/http";

export async function GET() {
  return handle(async (user) => ({ user }));
}
