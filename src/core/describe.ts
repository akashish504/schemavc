/**
 * Human descriptions of ops, resolved against the schema state just before
 * the op applies (so drops and renames can name what they touched).
 * Used by the compare view's change list and the conflict card templates.
 */

import { findColumn, findConstraint, findIndex, type Schema } from "./model";
import type { Op } from "./ops";

/** e.g. `add column orders.note text null`, `rename column user_id → account_id` */
export function describeOp(op: Op, before: Schema): string {
  switch (op.kind) {
    case "create_table":
      return `create table ${op.table.name} (${op.table.columns.length} column${op.table.columns.length === 1 ? "" : "s"})`;
    case "drop_table":
      return `drop table ${before.tables[op.tableId]?.name ?? op.tableId}`;
    case "rename_table":
      return `rename table ${before.tables[op.tableId]?.name ?? op.tableId} → ${op.name}`;
    case "add_column": {
      const table = before.tables[op.tableId]?.name ?? op.tableId;
      const c = op.column;
      const bits = [c.type, c.nullable ? "null" : "not null"];
      if (c.default !== null) bits.push(`default ${c.default}`);
      return `add column ${table}.${c.name} ${bits.join(" ")}`;
    }
    case "drop_column": {
      const f = findColumn(before, op.columnId);
      return `drop column ${f ? `${f.table.name}.${f.column.name}` : op.columnId}`;
    }
    case "rename_column": {
      const f = findColumn(before, op.columnId);
      return `rename column ${f ? `${f.table.name}.${f.column.name}` : op.columnId} → ${op.name}`;
    }
    case "retype_column": {
      const f = findColumn(before, op.columnId);
      return f
        ? `retype column ${f.table.name}.${f.column.name} ${f.column.type} → ${op.type}`
        : `retype column ${op.columnId} → ${op.type}`;
    }
    case "set_nullable": {
      const f = findColumn(before, op.columnId);
      const target = f ? `${f.table.name}.${f.column.name}` : op.columnId;
      return op.nullable ? `allow null on ${target}` : `set ${target} not null`;
    }
    case "set_default": {
      const f = findColumn(before, op.columnId);
      const target = f ? `${f.table.name}.${f.column.name}` : op.columnId;
      return op.default === null ? `drop default on ${target}` : `set default ${op.default} on ${target}`;
    }
    case "add_constraint": {
      const table = before.tables[op.tableId];
      const tableName = table?.name ?? op.tableId;
      const c = op.constraint;
      switch (c.kind) {
        case "primary_key":
          return `add primary key ${c.name} on ${tableName} (${columnNames(before, op.tableId, c.columns)})`;
        case "unique":
          return `add unique constraint ${c.name} on ${tableName} (${columnNames(before, op.tableId, c.columns)})`;
        case "check":
          return `add check constraint ${c.name} on ${tableName}: ${c.expression}`;
        case "foreign_key": {
          const target = before.tables[c.references.table];
          const targetName = target?.name ?? c.references.table;
          return `add foreign key ${tableName}.${columnNames(before, op.tableId, c.columns)} → ${targetName}.${columnNames(before, c.references.table, c.references.columns)}`;
        }
      }
      break;
    }
    case "drop_constraint": {
      const f = findConstraint(before, op.constraintId);
      return `drop ${f ? `${f.constraint.kind.replace("_", " ")} constraint ${f.constraint.name} on ${f.table.name}` : `constraint ${op.constraintId}`}`;
    }
    case "add_index": {
      const table = before.tables[op.tableId]?.name ?? op.tableId;
      return `add ${op.index.unique ? "unique " : ""}index ${op.index.name} on ${table} (${columnNames(before, op.tableId, op.index.columns)})`;
    }
    case "drop_index": {
      const f = findIndex(before, op.indexId);
      return `drop index ${f ? `${f.index.name} on ${f.table.name}` : op.indexId}`;
    }
  }
  return "schema change";
}

function columnNames(schema: Schema, tableId: string, columnIds: string[]): string {
  const table = schema.tables[tableId];
  return columnIds
    .map((id) => {
      const inTable = table?.columns.find((c) => c.id === id);
      return inTable?.name ?? findColumn(schema, id)?.column.name ?? id;
    })
    .join(", ");
}
