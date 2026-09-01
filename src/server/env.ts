/**
 * Environment access, centralised. Two database URLs from day one:
 * the app's own state store (required) and the optional deploy target.
 * They are never the same connection object.
 */

export function appDatabaseUrl(): string {
  const url = process.env.APP_DATABASE_URL;
  if (!url) throw new Error("APP_DATABASE_URL is not set — see README for setup");
  return url;
}

/** Optional; when set at startup it seeds the single deploy target row. */
export const targetDatabaseUrl = (): string | null => process.env.TARGET_DATABASE_URL ?? null;

export function jwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") throw new Error("JWT_SECRET is required in production");
    return new TextEncoder().encode("dev-only-secret-do-not-use-in-production");
  }
  return new TextEncoder().encode(secret);
}

export const isProduction = (): boolean => process.env.NODE_ENV === "production";
