/**
 * Deterministic Postgres DDL generation. One op → one statement (create_table
 * additionally emits its indexes). No LLM, no parsing: the model is the
 * source of truth and SQL is a projection of it.
 *
 * Names are resolved from ids against the running snapshot at each point in
 * the sequence, so a rename earlier in a script changes the name later
 * statements use. Everything is emitted inside one transaction — the op
 * vocabulary contains no non-transactional DDL.
 */

import { apply } from "./apply";
import { findColumn, findConstraint, findIndex, type Column, type Constraint, type Index, type ReferentialAction, type Schema, type Table } from "./model";
import type { Op } from "./ops";
import { tag } from "./safety";

const q = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

const ACTION_SQL: Record<ReferentialAction, string> = {
  no_action: "NO ACTION",
  restrict: "RESTRICT",
  cascade: "CASCADE",
  set_null: "SET NULL",
  set_default: "SET DEFAULT",
};

function columnDef(c: Column): string {
  let def = `${q(c.name)} ${c.type}`;
  if (!c.nullable) def += " NOT NULL";
  if (c.default !== null) def += ` DEFAULT ${c.default}`;
  return def;
}

/** Column names for a list of column ids within one table. */
function cols(table: Table, columnIds: string[]): string {
  return columnIds
    .map((id) => {
      const c = table.columns.find((col) => col.id === id);
      return q(c?.name ?? id);
    })
    .join(", ");
}

function constraintDef(schema: Schema, table: Table, c: Constraint): string {
  switch (c.kind) {
    case "primary_key":
      return `CONSTRAINT ${q(c.name)} PRIMARY KEY (${cols(table, c.columns)})`;
    case "unique":
      return `CONSTRAINT ${q(c.name)} UNIQUE (${cols(table, c.columns)})`;
    case "check":
      return `CONSTRAINT ${q(c.name)} CHECK (${c.expression})`;
    case "foreign_key": {
      const target = schema.tables[c.references.table];
      const targetName = target?.name ?? c.references.table;
      const targetCols = target ? cols(target, c.references.columns) : c.references.columns.map(q).join(", ");
      return (
        `CONSTRAINT ${q(c.name)} FOREIGN KEY (${cols(table, c.columns)}) ` +
        `REFERENCES ${q(targetName)} (${targetCols}) ` +
        `ON DELETE ${ACTION_SQL[c.onDelete]} ON UPDATE ${ACTION_SQL[c.onUpdate]}`
      );
    }
  }
}

function indexSql(table: Table, x: Index): string {
  return `CREATE ${x.unique ? "UNIQUE " : ""}INDEX ${q(x.name)} ON ${q(table.name)} (${cols(table, x.columns)});`;
}

/**
 * Statements for one op, resolved against the schema state just before it.
 * Returns [] only for ops with no DDL footprint (there are none today).
 */
export function opToSql(op: Op, before: Schema): string[] {
  switch (op.kind) {
    case "create_table": {
      const t = op.table;
      const lines = [...t.columns.map(columnDef), ...t.constraints.map((c) => constraintDef(before, t, c))];
      const create = `CREATE TABLE ${q(t.name)} (\n  ${lines.join(",\n  ")}\n);`;
      return [create, ...t.indexes.map((x) => indexSql(t, x))];
    }
    case "drop_table": {
      const t = before.tables[op.tableId];
      return [`DROP TABLE ${q(t?.name ?? op.tableId)};`];
    }
    case "rename_table": {
      const t = before.tables[op.tableId];
      return [`ALTER TABLE ${q(t?.name ?? op.tableId)} RENAME TO ${q(op.name)};`];
    }
    case "add_column": {
      const t = before.tables[op.tableId];
      return [`ALTER TABLE ${q(t?.name ?? op.tableId)} ADD COLUMN ${columnDef(op.column)};`];
    }
    case "drop_column": {
      const f = findColumn(before, op.columnId);
      if (!f) return [`-- drop_column: unknown column ${op.columnId}`];
      return [`ALTER TABLE ${q(f.table.name)} DROP COLUMN ${q(f.column.name)};`];
    }
    case "rename_column": {
      const f = findColumn(before, op.columnId);
      if (!f) return [`-- rename_column: unknown column ${op.columnId}`];
      return [`ALTER TABLE ${q(f.table.name)} RENAME COLUMN ${q(f.column.name)} TO ${q(op.name)};`];
    }
    case "retype_column": {
      const f = findColumn(before, op.columnId);
      if (!f) return [`-- retype_column: unknown column ${op.columnId}`];
      return [`ALTER TABLE ${q(f.table.name)} ALTER COLUMN ${q(f.column.name)} TYPE ${op.type} USING ${q(f.column.name)}::${op.type};`];
    }
    case "set_nullable": {
      const f = findColumn(before, op.columnId);
      if (!f) return [`-- set_nullable: unknown column ${op.columnId}`];
      return [`ALTER TABLE ${q(f.table.name)} ALTER COLUMN ${q(f.column.name)} ${op.nullable ? "DROP" : "SET"} NOT NULL;`];
    }
    case "set_default": {
      const f = findColumn(before, op.columnId);
      if (!f) return [`-- set_default: unknown column ${op.columnId}`];
      return [
        op.default === null
          ? `ALTER TABLE ${q(f.table.name)} ALTER COLUMN ${q(f.column.name)} DROP DEFAULT;`
          : `ALTER TABLE ${q(f.table.name)} ALTER COLUMN ${q(f.column.name)} SET DEFAULT ${op.default};`,
      ];
    }
    case "add_constraint": {
      const t = before.tables[op.tableId];
      if (!t) return [`-- add_constraint: unknown table ${op.tableId}`];
      return [`ALTER TABLE ${q(t.name)} ADD ${constraintDef(before, t, op.constraint)};`];
    }
    case "drop_constraint": {
      const f = findConstraint(before, op.constraintId);
      if (!f) return [`-- drop_constraint: unknown constraint ${op.constraintId}`];
      return [`ALTER TABLE ${q(f.table.name)} DROP CONSTRAINT ${q(f.constraint.name)};`];
    }
    case "add_index": {
      const t = before.tables[op.tableId];
      if (!t) return [`-- add_index: unknown table ${op.tableId}`];
      return [indexSql(t, op.index)];
    }
    case "drop_index": {
      const f = findIndex(before, op.indexId);
      if (!f) return [`-- drop_index: unknown index ${op.indexId}`];
      return [`DROP INDEX ${q(f.index.name)};`];
    }
  }
}

export interface MigrationScriptInput {
  ops: Op[];
  startSchema: Schema;
  /** header lines, e.g. the commit range and generation context */
  header?: string[];
}

export interface MigrationStatement {
  sql: string;
  safety: ReturnType<typeof tag>;
  opKind: Op["kind"];
}

/**
 * The ordered statements for an op list, each with its safety tag — the
 * shared source for both the rendered script and statement-by-statement
 * execution during deploy (which needs to report the exact failing statement).
 */
export function migrationStatements(ops: Op[], startSchema: Schema): MigrationStatement[] {
  const statements: MigrationStatement[] = [];
  let current = startSchema;
  for (const op of ops) {
    const safety = tag(op, current);
    for (const sql of opToSql(op, current)) statements.push({ sql, safety, opKind: op.kind });
    const next = apply(current, [op]);
    if (!next.ok) {
      // Callers only pass op lists that replay (commits and merge outputs do
      // by construction); surface rather than silently mis-name later statements.
      statements.push({ sql: `-- ERROR: op ${op.kind} does not apply (${next.error.message}); later names may be stale`, safety, opKind: op.kind });
    } else {
      current = next.schema;
    }
  }
  return statements;
}

/**
 * Full migration script: every op as ordered statements with safety
 * annotations, wrapped in a single transaction.
 */
export function migrationScript({ ops, startSchema, header = [] }: MigrationScriptInput): string {
  const lines: string[] = header.map((h) => `-- ${h}`);
  lines.push("BEGIN;");
  for (const statement of migrationStatements(ops, startSchema)) {
    if (statement.safety.level !== "additive") lines.push(`-- ${statement.safety.level.replace("_", " ")}: ${statement.safety.reason}`);
    lines.push(statement.sql);
  }
  lines.push("COMMIT;");
  return lines.join("\n") + "\n";
}

/**
 * Whole-schema export from an empty database: CREATE TABLE per table (FKs
 * split out so table order never matters), then FK constraints, then indexes.
 */
export function schemaToSql(schema: Schema): string {
  const tables = Object.values(schema.tables).sort((a, b) => a.name.localeCompare(b.name));
  const statements: string[] = [];
  for (const t of tables) {
    const inline = [
      ...t.columns.map(columnDef),
      ...t.constraints.filter((c) => c.kind !== "foreign_key").map((c) => constraintDef(schema, t, c)),
    ];
    statements.push(`CREATE TABLE ${q(t.name)} (\n  ${inline.join(",\n  ")}\n);`);
  }
  for (const t of tables) {
    for (const c of t.constraints.filter((c) => c.kind === "foreign_key")) {
      statements.push(`ALTER TABLE ${q(t.name)} ADD ${constraintDef(schema, t, c)};`);
    }
  }
  for (const t of tables) {
    for (const x of t.indexes) statements.push(indexSql(t, x));
  }
  return statements.join("\n\n") + "\n";
}
