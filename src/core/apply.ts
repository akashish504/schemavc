/**
 * apply(schema, ops) — the single authoritative way a schema changes.
 *
 * Structurally validates each op against the running schema and applies it.
 * Pure: never mutates the input. Rejects with the index of the offending op
 * so the UI can highlight the bad row in the pending tray.
 *
 * apply enforces *structural* soundness (ids exist, no collisions, names free,
 * types allowed). Whole-schema consistency (dangling refs, PK nullability,
 * duplicate names introduced by merging) is the validator's job.
 */

import {
  allIds,
  deepCloneSchema,
  findColumn,
  findConstraint,
  findIndex,
  isAllowedType,
  type Id,
  type Schema,
  type Table,
} from "./model";
import { isValidId } from "./ids";
import type { Op } from "./ops";

export interface ApplyError {
  opIndex: number;
  code:
    | "unknown_table"
    | "unknown_column"
    | "unknown_constraint"
    | "unknown_index"
    | "duplicate_id"
    | "invalid_id"
    | "duplicate_table_name"
    | "duplicate_column_name"
    | "duplicate_object_name"
    | "invalid_type"
    | "invalid_name"
    | "noop_change";
  message: string;
}

export type ApplyResult = { ok: true; schema: Schema } | { ok: false; error: ApplyError };

const NAME_RE = /^[a-z_][a-z0-9_]*$/;
const MAX_NAME = 63; // Postgres identifier limit

const badName = (name: string): boolean =>
  typeof name !== "string" || name.length === 0 || name.length > MAX_NAME || !NAME_RE.test(name);

export interface ApplyOptions {
  /**
   * Skip name-collision checks (ids are still enforced). Used only when
   * applying a merge candidate, where concurrent adds may collide on names —
   * the validator then reports the duplicates as semantic conflicts instead
   * of apply refusing to produce the schema at all.
   */
  allowNameCollisions?: boolean;
}

export function apply(schema: Schema, ops: Op[], options: ApplyOptions = {}): ApplyResult {
  let current = deepCloneSchema(schema);
  for (let i = 0; i < ops.length; i++) {
    const result = applyOne(current, ops[i], i, options);
    if (!result.ok) return result;
    current = result.schema;
  }
  return { ok: true, schema: current };
}

function fail(opIndex: number, code: ApplyError["code"], message: string): ApplyResult {
  return { ok: false, error: { opIndex, code, message } };
}

/** Mutates `schema` in place; apply() owns the clone. */
function applyOne(schema: Schema, op: Op, i: number, options: ApplyOptions = {}): ApplyResult {
  const existingIds = allIds(schema);
  const lenientNames = options.allowNameCollisions === true;

  const checkNewIds = (ids: Id[]): ApplyResult | null => {
    const seen = new Set<Id>();
    for (const id of ids) {
      if (!isValidId(id)) return fail(i, "invalid_id", `invalid id "${id}"`);
      if (existingIds.has(id)) return fail(i, "duplicate_id", `id "${id}" already exists in the schema`);
      if (seen.has(id)) return fail(i, "duplicate_id", `id "${id}" used twice in the same op`);
      seen.add(id);
    }
    return null;
  };

  const checkName = (name: string, what: string): ApplyResult | null =>
    badName(name)
      ? fail(i, "invalid_name", `invalid ${what} name "${name}": use lowercase letters, digits and _, max ${MAX_NAME} chars`)
      : null;

  const tableNames = () => new Set(Object.values(schema.tables).map((t) => t.name));
  /** Constraint and index names share a namespace across the schema in Postgres. */
  const objectNames = () => {
    const names = new Set<string>();
    for (const t of Object.values(schema.tables)) {
      for (const c of t.constraints) names.add(c.name);
      for (const idx of t.indexes) names.add(idx.name);
    }
    return names;
  };

  switch (op.kind) {
    case "create_table": {
      const t = op.table;
      const idErr = checkNewIds([
        t.id,
        ...t.columns.map((c) => c.id),
        ...t.constraints.map((c) => c.id),
        ...t.indexes.map((x) => x.id),
      ]);
      if (idErr) return idErr;
      const nameErr = checkName(t.name, "table");
      if (nameErr) return nameErr;
      if (!lenientNames && tableNames().has(t.name)) return fail(i, "duplicate_table_name", `a table named "${t.name}" already exists`);
      const colNames = new Set<string>();
      for (const c of t.columns) {
        const err = checkName(c.name, "column");
        if (err) return err;
        if (colNames.has(c.name)) return fail(i, "duplicate_column_name", `column "${c.name}" appears twice`);
        colNames.add(c.name);
        if (!isAllowedType(c.type)) return fail(i, "invalid_type", `type "${c.type}" is not supported`);
      }
      const objNames = objectNames();
      for (const o of [...t.constraints, ...t.indexes]) {
        const err = checkName(o.name, "object");
        if (err) return err;
        if (!lenientNames && objNames.has(o.name)) return fail(i, "duplicate_object_name", `an index or constraint named "${o.name}" already exists`);
        objNames.add(o.name);
      }
      schema.tables[t.id] = structuredClone(t);
      return { ok: true, schema };
    }

    case "drop_table": {
      if (!schema.tables[op.tableId]) return fail(i, "unknown_table", `no table with id ${op.tableId}`);
      delete schema.tables[op.tableId];
      return { ok: true, schema };
    }

    case "rename_table": {
      const t = schema.tables[op.tableId];
      if (!t) return fail(i, "unknown_table", `no table with id ${op.tableId}`);
      const nameErr = checkName(op.name, "table");
      if (nameErr) return nameErr;
      if (t.name === op.name) return fail(i, "noop_change", `table is already named "${op.name}"`);
      if (!lenientNames && tableNames().has(op.name)) return fail(i, "duplicate_table_name", `a table named "${op.name}" already exists`);
      t.name = op.name;
      return { ok: true, schema };
    }

    case "add_column": {
      const t = schema.tables[op.tableId];
      if (!t) return fail(i, "unknown_table", `no table with id ${op.tableId}`);
      const idErr = checkNewIds([op.column.id]);
      if (idErr) return idErr;
      const nameErr = checkName(op.column.name, "column");
      if (nameErr) return nameErr;
      if (!lenientNames && t.columns.some((c) => c.name === op.column.name))
        return fail(i, "duplicate_column_name", `table "${t.name}" already has a column named "${op.column.name}"`);
      if (!isAllowedType(op.column.type)) return fail(i, "invalid_type", `type "${op.column.type}" is not supported`);
      t.columns.push(structuredClone(op.column));
      return { ok: true, schema };
    }

    case "drop_column": {
      const found = findColumn(schema, op.columnId);
      if (!found) return fail(i, "unknown_column", `no column with id ${op.columnId}`);
      found.table.columns = found.table.columns.filter((c) => c.id !== op.columnId);
      return { ok: true, schema };
    }

    case "rename_column": {
      const found = findColumn(schema, op.columnId);
      if (!found) return fail(i, "unknown_column", `no column with id ${op.columnId}`);
      const nameErr = checkName(op.name, "column");
      if (nameErr) return nameErr;
      if (found.column.name === op.name) return fail(i, "noop_change", `column is already named "${op.name}"`);
      if (!lenientNames && found.table.columns.some((c) => c.name === op.name))
        return fail(i, "duplicate_column_name", `table "${found.table.name}" already has a column named "${op.name}"`);
      found.column.name = op.name;
      return { ok: true, schema };
    }

    case "retype_column": {
      const found = findColumn(schema, op.columnId);
      if (!found) return fail(i, "unknown_column", `no column with id ${op.columnId}`);
      if (!isAllowedType(op.type)) return fail(i, "invalid_type", `type "${op.type}" is not supported`);
      if (found.column.type === op.type) return fail(i, "noop_change", `column is already of type "${op.type}"`);
      found.column.type = op.type;
      return { ok: true, schema };
    }

    case "set_nullable": {
      const found = findColumn(schema, op.columnId);
      if (!found) return fail(i, "unknown_column", `no column with id ${op.columnId}`);
      if (found.column.nullable === op.nullable) return fail(i, "noop_change", `nullable is already ${op.nullable}`);
      found.column.nullable = op.nullable;
      return { ok: true, schema };
    }

    case "set_default": {
      const found = findColumn(schema, op.columnId);
      if (!found) return fail(i, "unknown_column", `no column with id ${op.columnId}`);
      if (found.column.default === op.default) return fail(i, "noop_change", "default is unchanged");
      found.column.default = op.default;
      return { ok: true, schema };
    }

    case "add_constraint": {
      const t = schema.tables[op.tableId];
      if (!t) return fail(i, "unknown_table", `no table with id ${op.tableId}`);
      const idErr = checkNewIds([op.constraint.id]);
      if (idErr) return idErr;
      const nameErr = checkName(op.constraint.name, "constraint");
      if (nameErr) return nameErr;
      if (!lenientNames && objectNames().has(op.constraint.name))
        return fail(i, "duplicate_object_name", `an index or constraint named "${op.constraint.name}" already exists`);
      t.constraints.push(structuredClone(op.constraint));
      return { ok: true, schema };
    }

    case "drop_constraint": {
      const found = findConstraint(schema, op.constraintId);
      if (!found) return fail(i, "unknown_constraint", `no constraint with id ${op.constraintId}`);
      found.table.constraints = found.table.constraints.filter((c) => c.id !== op.constraintId);
      return { ok: true, schema };
    }

    case "add_index": {
      const t = schema.tables[op.tableId];
      if (!t) return fail(i, "unknown_table", `no table with id ${op.tableId}`);
      const idErr = checkNewIds([op.index.id]);
      if (idErr) return idErr;
      const nameErr = checkName(op.index.name, "index");
      if (nameErr) return nameErr;
      if (!lenientNames && objectNames().has(op.index.name))
        return fail(i, "duplicate_object_name", `an index or constraint named "${op.index.name}" already exists`);
      t.indexes.push(structuredClone(op.index));
      return { ok: true, schema };
    }

    case "drop_index": {
      const found = findIndex(schema, op.indexId);
      if (!found) return fail(i, "unknown_index", `no index with id ${op.indexId}`);
      found.table.indexes = found.table.indexes.filter((x) => x.id !== op.indexId);
      return { ok: true, schema };
    }
  }
}

/** The table an op targets, for grouping in the compare view. */
export function opTable(schema: Schema, op: Op): Table | undefined {
  switch (op.kind) {
    case "create_table":
      return op.table;
    case "drop_table":
    case "rename_table":
    case "add_column":
    case "add_constraint":
    case "add_index":
      return schema.tables[op.tableId];
    case "drop_column":
    case "rename_column":
    case "retype_column":
    case "set_nullable":
    case "set_default":
      return findColumn(schema, op.columnId)?.table;
    case "drop_constraint":
      return findConstraint(schema, op.constraintId)?.table;
    case "drop_index":
      return findIndex(schema, op.indexId)?.table;
  }
}
