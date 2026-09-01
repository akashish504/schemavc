/**
 * Route-handler plumbing: bootstrap, auth guard, and error mapping.
 * Every error leaves as structured JSON — the UI never sees a bare 500 page.
 */

import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { sessionUser, type SessionUser } from "./auth";
import { ensureBootstrapped } from "./db";
import { ServiceError } from "./errors";

type Handler = (user: SessionUser) => Promise<unknown>;
type PublicHandler = () => Promise<unknown>;

function errorResponse(error: unknown): NextResponse {
  if (error instanceof ServiceError) {
    return NextResponse.json({ code: error.code, message: error.message, details: error.details ?? null }, { status: error.status });
  }
  if (error instanceof ZodError) {
    return NextResponse.json(
      { code: "bad_request", message: "request body failed validation", details: error.issues.slice(0, 5) },
      { status: 400 }
    );
  }
  console.error("[api] unhandled error:", error);
  return NextResponse.json({ code: "internal", message: "something went wrong on our side — try again" }, { status: 500 });
}

/** Authenticated handler: 401 JSON when there is no valid session. */
export async function handle(fn: Handler): Promise<NextResponse> {
  try {
    await ensureBootstrapped();
    const user = await sessionUser();
    if (!user) return NextResponse.json({ code: "unauthenticated", message: "log in to continue" }, { status: 401 });
    return NextResponse.json(await fn(user));
  } catch (error) {
    return errorResponse(error);
  }
}

/** Unauthenticated handler (signup / login). */
export async function handlePublic(fn: PublicHandler): Promise<NextResponse> {
  try {
    await ensureBootstrapped();
    return NextResponse.json(await fn());
  } catch (error) {
    return errorResponse(error);
  }
}
