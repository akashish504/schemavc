/**
 * Id generation. Called where ops are authored (the UI / seed scripts), never
 * inside core engine functions — ids arrive in op payloads, which keeps the
 * engine deterministic.
 */

const HEX = "0123456789abcdef";

export function newId(): string {
  let id = "";
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  for (const b of bytes) id += HEX[b >> 4] + HEX[b & 0xf];
  return id;
}

export const ID_RE = /^[0-9a-f]{8}$/;

export const isValidId = (id: unknown): id is string => typeof id === "string" && ID_RE.test(id);
