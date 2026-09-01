import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hashPassword, setSessionCookie } from "@/server/auth";
import { conflict } from "@/server/errors";
import { handlePublic } from "@/server/http";
import { createUser, findUserByEmail } from "@/server/store";

const body = z.object({
  email: z.string().email().max(200),
  password: z.string().min(8, "password must be at least 8 characters").max(200),
  displayName: z.string().trim().min(1).max(60),
});

export async function POST(request: Request) {
  return handlePublic(async () => {
    const { email, password, displayName } = body.parse(await request.json());
    const normalized = email.toLowerCase().trim();
    if (await findUserByEmail(normalized)) throw conflict("email_taken", "an account with this email already exists — log in instead");
    const user = { id: randomUUID(), email: normalized, displayName };
    await createUser({ ...user, passwordHash: await hashPassword(password) });
    await setSessionCookie(user);
    return { user };
  });
}
