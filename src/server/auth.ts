/**
 * Email + password auth with a JWT in an httpOnly SameSite=Lax cookie.
 * 24h lifetime, no refresh token: re-login on expiry. Auth exists to
 * attribute commits, resolutions, and deployments to people — nothing more.
 */

import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { isProduction, jwtSecret } from "./env";

export const SESSION_COOKIE = "schemavc_session";
const SESSION_HOURS = 24;

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
}

export const hashPassword = (password: string): Promise<string> => bcrypt.hash(password, 10);

export const verifyPassword = (password: string, hash: string): Promise<boolean> => bcrypt.compare(password, hash);

export async function createSessionToken(user: SessionUser): Promise<string> {
  return new SignJWT({ email: user.email, displayName: user.displayName })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_HOURS}h`)
    .sign(jwtSecret());
}

export async function setSessionCookie(user: SessionUser): Promise<void> {
  const token = await createSessionToken(user);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction(),
    path: "/",
    maxAge: SESSION_HOURS * 3600,
  });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

/** The logged-in user, or null. Never throws. */
export async function sessionUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, jwtSecret());
    if (!payload.sub) return null;
    return {
      id: payload.sub,
      email: typeof payload.email === "string" ? payload.email : "",
      displayName: typeof payload.displayName === "string" ? payload.displayName : "unknown",
    };
  } catch {
    return null; // expired or tampered — treated as logged out
  }
}
