import { handle } from "@/server/http";
import { seedTemplate } from "@/server/seed";

export async function POST() {
  return handle(async (user) => seedTemplate(user.id));
}
