/**
 * invert(op, before) — compensating ops for the "keep your change" merge
 * resolution: reverse one of main's ops using the schema state just before
 * that op applied in main's history.
 *
 * Total over all 13 op kinds. Returns null only when the op cannot be
 * inverted because its target is missing from `before` (which would mean the
 * caller passed the wrong snapshot — treated as an internal error upstream).
 */

import { findColumn, findConstraint, findIndex, type Schema } from "./model";
import type { Op } from "./ops";

export function invert(op: Op, before: Schema): Op[] | null {
  switch (op.kind) {
    case "create_table":
      return [{ kind: "drop_table", tableId: op.table.id }];

    case "drop_table": {
      const t = before.tables[op.tableId];
      return t ? [{ kind: "create_table", table: structuredClone(t) }] : null;
    }

    case "rename_table": {
      const t = before.tables[op.tableId];
      return t ? [{ kind: "rename_table", tableId: op.tableId, name: t.name }] : null;
    }

    case "add_column":
      return [{ kind: "drop_column", columnId: op.column.id }];

    case "drop_column": {
      const found = findColumn(before, op.columnId);
      return found
        ? [{ kind: "add_column", tableId: found.table.id, column: structuredClone(found.column) }]
        : null;
    }

    case "rename_column": {
      const found = findColumn(before, op.columnId);
      return found ? [{ kind: "rename_column", columnId: op.columnId, name: found.column.name }] : null;
    }

    case "retype_column": {
      const found = findColumn(before, op.columnId);
      return found ? [{ kind: "retype_column", columnId: op.columnId, type: found.column.type }] : null;
    }

    case "set_nullable": {
      const found = findColumn(before, op.columnId);
      return found ? [{ kind: "set_nullable", columnId: op.columnId, nullable: found.column.nullable }] : null;
    }

    case "set_default": {
      const found = findColumn(before, op.columnId);
      return found ? [{ kind: "set_default", columnId: op.columnId, default: found.column.default }] : null;
    }

    case "add_constraint":
      return [{ kind: "drop_constraint", constraintId: op.constraint.id }];

    case "drop_constraint": {
      const found = findConstraint(before, op.constraintId);
      return found
        ? [{ kind: "add_constraint", tableId: found.table.id, constraint: structuredClone(found.constraint) }]
        : null;
    }

    case "add_index":
      return [{ kind: "drop_index", indexId: op.index.id }];

    case "drop_index": {
      const found = findIndex(before, op.indexId);
      return found ? [{ kind: "add_index", tableId: found.table.id, index: structuredClone(found.index) }] : null;
    }
  }
}
