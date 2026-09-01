/** Column-type choices the editor offers, mirroring the core allowed list. */

export interface TypeChoice {
  family: string;
  label: string;
  params: "none" | "length" | "precision";
}

export const TYPE_CHOICES: TypeChoice[] = [
  { family: "uuid", label: "uuid", params: "none" },
  { family: "text", label: "text", params: "none" },
  { family: "varchar", label: "varchar(n)", params: "length" },
  { family: "integer", label: "integer", params: "none" },
  { family: "bigint", label: "bigint", params: "none" },
  { family: "numeric", label: "numeric(p,s)", params: "precision" },
  { family: "boolean", label: "boolean", params: "none" },
  { family: "date", label: "date", params: "none" },
  { family: "timestamptz", label: "timestamptz", params: "none" },
  { family: "jsonb", label: "jsonb", params: "none" },
];

export function buildType(family: string, length: string, precision: string, scale: string): string | null {
  const choice = TYPE_CHOICES.find((t) => t.family === family);
  if (!choice) return null;
  if (choice.params === "length") {
    const n = Number(length);
    return Number.isInteger(n) && n > 0 ? `varchar(${n})` : null;
  }
  if (choice.params === "precision") {
    const p = Number(precision);
    const s = Number(scale);
    return Number.isInteger(p) && p > 0 && Number.isInteger(s) && s >= 0 && s <= p ? `numeric(${p},${s})` : null;
  }
  return family;
}
