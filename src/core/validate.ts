/**
 * The post-merge validator: whole-schema consistency checks.
 *
 * apply() guarantees each op is structurally sound in sequence; this catches
 * the *emergent* problems that only exist once independently-valid changes
 * are combined (two branches each adding a column named "status", an FK whose
 * target table the other branch dropped, a PK over a column made nullable).
 *
 * Runs after every commit, after auto-merge, after each conflict resolution,
 * and in the whole-store invariant test. Never bypassed.
 */

import { isAllowedType, type Id, type Schema } from "./model";

export interface Violation {
  code:
    | "duplicate_table_name"
    | "duplicate_column_name"
    | "duplicate_object_name"
    | "fk_target_table_missing"
    | "fk_target_column_missing"
    | "fk_arity_mismatch"
    | "referenced_column_missing"
    | "pk_column_nullable"
    | "multiple_primary_keys"
    | "invalid_type"
    | "empty_table"
    | "empty_column_list";
  entityIds: Id[];
  message: string;
}

export function validate(schema: Schema): Violation[] {
  const violations: Violation[] = [];
  const v = (code: Violation["code"], entityIds: Id[], message: string) =>
    violations.push({ code, entityIds, message });

  const tables = Object.values(schema.tables);

  // 1. table names unique across the schema
  const tableByName = new Map<string, Id[]>();
  for (const t of tables) tableByName.set(t.name, [...(tableByName.get(t.name) ?? []), t.id]);
  for (const [name, ids] of tableByName) {
    if (ids.length > 1) v("duplicate_table_name", ids, `${ids.length} tables are named "${name}"`);
  }

  // 3. constraint + index names unique across the schema (Postgres namespace)
  const objByName = new Map<string, Id[]>();
  for (const t of tables) {
    for (const c of t.constraints) objByName.set(c.name, [...(objByName.get(c.name) ?? []), c.id]);
    for (const x of t.indexes) objByName.set(x.name, [...(objByName.get(x.name) ?? []), x.id]);
  }
  for (const [name, ids] of objByName) {
    if (ids.length > 1) v("duplicate_object_name", ids, `${ids.length} indexes/constraints are named "${name}"`);
  }

  for (const t of tables) {
    const colById = new Map(t.columns.map((c) => [c.id, c]));

    // 2. column names unique per table
    const colByName = new Map<string, Id[]>();
    for (const c of t.columns) colByName.set(c.name, [...(colByName.get(c.name) ?? []), c.id]);
    for (const [name, ids] of colByName) {
      if (ids.length > 1)
        v("duplicate_column_name", [t.id, ...ids], `table "${t.name}" has ${ids.length} columns named "${name}"`);
    }

    // 9a. no zero-column tables
    if (t.columns.length === 0) v("empty_table", [t.id], `table "${t.name}" has no columns`);

    // 8. every type on the allowed list
    for (const c of t.columns) {
      if (!isAllowedType(c.type))
        v("invalid_type", [t.id, c.id], `column "${t.name}.${c.name}" has unsupported type "${c.type}"`);
    }

    // 5 + 9b. referenced columns exist and lists are non-empty
    const checkColumnRefs = (entityId: Id, entityName: string, what: string, columnIds: Id[]) => {
      if (columnIds.length === 0) v("empty_column_list", [t.id, entityId], `${what} "${entityName}" has no columns`);
      for (const id of columnIds) {
        if (!colById.has(id))
          v("referenced_column_missing", [t.id, entityId, id], `${what} "${entityName}" references a column that no longer exists in "${t.name}"`);
      }
    };

    let pkCount = 0;
    for (const c of t.constraints) {
      switch (c.kind) {
        case "primary_key": {
          pkCount++;
          checkColumnRefs(c.id, c.name, "primary key", c.columns);
          // 6. PK columns must be NOT NULL
          for (const id of c.columns) {
            const col = colById.get(id);
            if (col && col.nullable)
              v("pk_column_nullable", [t.id, c.id, id], `primary key column "${t.name}.${col.name}" is nullable`);
          }
          break;
        }
        case "unique":
          checkColumnRefs(c.id, c.name, "unique constraint", c.columns);
          break;
        case "check":
          break;
        case "foreign_key": {
          checkColumnRefs(c.id, c.name, "foreign key", c.columns);
          // 4. FK target table and columns exist, arity matches
          const target = schema.tables[c.references.table];
          if (!target) {
            v("fk_target_table_missing", [t.id, c.id, c.references.table], `foreign key "${c.name}" points at a table that no longer exists`);
          } else {
            const targetCols = new Set(target.columns.map((col) => col.id));
            if (c.references.columns.length === 0)
              v("empty_column_list", [t.id, c.id], `foreign key "${c.name}" references no columns`);
            for (const id of c.references.columns) {
              if (!targetCols.has(id))
                v("fk_target_column_missing", [t.id, c.id, target.id, id], `foreign key "${c.name}" references a column that no longer exists in "${target.name}"`);
            }
            if (c.columns.length !== c.references.columns.length && c.columns.length > 0 && c.references.columns.length > 0)
              v("fk_arity_mismatch", [t.id, c.id], `foreign key "${c.name}" has ${c.columns.length} local column(s) but references ${c.references.columns.length}`);
          }
          break;
        }
      }
    }

    // 7. at most one primary key per table
    if (pkCount > 1) v("multiple_primary_keys", [t.id], `table "${t.name}" has ${pkCount} primary keys`);

    for (const x of t.indexes) checkColumnRefs(x.id, x.name, "index", x.columns);
  }

  return violations;
}
