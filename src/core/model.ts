/**
 * The schema model: the plain data structure the whole product versions.
 *
 * Identity rule: every entity carries a stable random `id`; all references
 * (constraint columns, index columns, FK targets) point at ids, never names.
 * A rename is "same id, different name" — this is what lets the merge engine
 * tell renames from drop+add with no heuristics.
 */

export type Id = string;

export interface Column {
  id: Id;
  name: string;
  type: string; // one of ALLOWED_TYPES families, possibly parameterised
  nullable: boolean;
  default: string | null; // opaque; passed through to DDL verbatim
}

export type Constraint =
  | { id: Id; name: string; kind: "primary_key"; columns: Id[] }
  | { id: Id; name: string; kind: "unique"; columns: Id[] }
  | { id: Id; name: string; kind: "check"; expression: string }
  | {
      id: Id;
      name: string;
      kind: "foreign_key";
      columns: Id[];
      references: { table: Id; columns: Id[] };
      onDelete: ReferentialAction;
      onUpdate: ReferentialAction;
    };

export type ReferentialAction = "no_action" | "restrict" | "cascade" | "set_null" | "set_default";

export interface Index {
  id: Id;
  name: string;
  columns: Id[];
  unique: boolean;
}

export interface Table {
  id: Id;
  name: string;
  columns: Column[];
  constraints: Constraint[];
  indexes: Index[];
}

export interface Schema {
  tables: Record<Id, Table>;
}

export const emptySchema = (): Schema => ({ tables: {} });

/**
 * Column types the editor offers and the exporter knows. The only string
 * parsing in the system lives here, because safety tagging needs to compare
 * varchar/numeric widths.
 */
export type TypeFamily =
  | "uuid"
  | "text"
  | "varchar"
  | "integer"
  | "bigint"
  | "numeric"
  | "boolean"
  | "date"
  | "timestamptz"
  | "jsonb";

export interface ParsedType {
  family: TypeFamily;
  params: number[]; // varchar: [n]; numeric: [p, s]; others: []
}

const SIMPLE_TYPES: ReadonlySet<string> = new Set([
  "uuid",
  "text",
  "integer",
  "bigint",
  "boolean",
  "date",
  "timestamptz",
  "jsonb",
]);

const VARCHAR_RE = /^varchar\((\d+)\)$/;
const NUMERIC_RE = /^numeric\((\d+),(\d+)\)$/;

export function parseType(type: string): ParsedType | null {
  if (SIMPLE_TYPES.has(type)) return { family: type as TypeFamily, params: [] };
  const v = VARCHAR_RE.exec(type);
  if (v) {
    const n = Number(v[1]);
    return n > 0 ? { family: "varchar", params: [n] } : null;
  }
  const num = NUMERIC_RE.exec(type);
  if (num) {
    const p = Number(num[1]);
    const s = Number(num[2]);
    return p > 0 && s >= 0 && s <= p ? { family: "numeric", params: [p, s] } : null;
  }
  return null;
}

export const isAllowedType = (type: string): boolean => parseType(type) !== null;

/** Lookup helpers. Return undefined rather than throwing; callers decide. */

export function findTable(schema: Schema, tableId: Id): Table | undefined {
  return schema.tables[tableId];
}

export function findColumn(schema: Schema, columnId: Id): { table: Table; column: Column } | undefined {
  for (const table of Object.values(schema.tables)) {
    const column = table.columns.find((c) => c.id === columnId);
    if (column) return { table, column };
  }
  return undefined;
}

export function findConstraint(schema: Schema, constraintId: Id): { table: Table; constraint: Constraint } | undefined {
  for (const table of Object.values(schema.tables)) {
    const constraint = table.constraints.find((c) => c.id === constraintId);
    if (constraint) return { table, constraint };
  }
  return undefined;
}

export function findIndex(schema: Schema, indexId: Id): { table: Table; index: Index } | undefined {
  for (const table of Object.values(schema.tables)) {
    const index = table.indexes.find((i) => i.id === indexId);
    if (index) return { table, index };
  }
  return undefined;
}

/** Every id present in the schema (tables and all contained entities). */
export function allIds(schema: Schema): Set<Id> {
  const ids = new Set<Id>();
  for (const table of Object.values(schema.tables)) {
    ids.add(table.id);
    for (const c of table.columns) ids.add(c.id);
    for (const c of table.constraints) ids.add(c.id);
    for (const i of table.indexes) ids.add(i.id);
  }
  return ids;
}

/** Ids contained in a single table (the table's own id included). */
export function tableIds(table: Table): Set<Id> {
  const ids = new Set<Id>([table.id]);
  for (const c of table.columns) ids.add(c.id);
  for (const c of table.constraints) ids.add(c.id);
  for (const i of table.indexes) ids.add(i.id);
  return ids;
}

export function deepCloneSchema(schema: Schema): Schema {
  return structuredClone(schema);
}
