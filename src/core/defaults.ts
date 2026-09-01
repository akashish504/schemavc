/**
 * Defaults and check expressions are opaque SQL passed through verbatim —
 * except for one targeted lint. A bare word like `US` is (almost) never valid
 * as a default: Postgres reads it as a column reference and rejects it, but
 * only when the migration finally runs against a real database. Catching the
 * obvious case early — with the quoted form the user almost certainly meant —
 * turns a deploy-time failure into an inline suggestion.
 *
 * Deliberately conservative: anything with parentheses (function calls),
 * quotes, or a leading digit is trusted as-is.
 */

const ALLOWED_BARE = new Set([
  "true",
  "false",
  "null",
  "current_timestamp",
  "current_date",
  "current_time",
  "localtimestamp",
  "localtime",
]);

/**
 * If `value` looks like a bare word the user meant as a string literal,
 * returns the quoted form to suggest; otherwise null (the value is fine).
 */
export function bareWordDefaultSuggestion(value: string): string | null {
  const v = value.trim();
  if (v === "" || v.includes("'") || v.includes("(")) return null;
  if (/^-?[\d.]/.test(v)) return null; // numeric literal
  if (ALLOWED_BARE.has(v.toLowerCase())) return null;
  if (/^[A-Za-z_][A-Za-z0-9_ .,-]*$/.test(v)) return `'${v.replaceAll("'", "''")}'`;
  return null;
}
