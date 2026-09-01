import { z } from "zod";
import { setSessionCookie, verifyPassword } from "@/server/auth";
import { ServiceError } from "@/server/errors";
import { handlePublic } from "@/server/http";
import { findUserByEmail } from "@/server/store";

const body = z.object({ email: z.string().email(), password: z.string().min(1) });

export async function POST(request: Request) {
  return handlePublic(async () => {
    const { email, password } = body.parse(await request.json());
    const row = await findUserByEmail(email.toLowerCase().trim());
    const valid = row && (await verifyPassword(password, row.password_hash));
    if (!valid) throw new ServiceError(401, "bad_credentials", "email or password is incorrect");
    const user = { id: row.id, email: row.email, displayName: row.display_name };
    await setSessionCookie(user);
    return { user };
  });
}
