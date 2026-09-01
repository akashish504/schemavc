import { clearSessionCookie } from "@/server/auth";
import { handlePublic } from "@/server/http";

export async function POST() {
  return handlePublic(async () => {
    await clearSessionCookie();
    return { ok: true };
  });
}
