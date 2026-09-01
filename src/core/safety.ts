/**
 * Safety tagging: classify each op by its risk to row data on a non-empty
 * database. Row data itself is out of scope; risk to it is cheap, high-signal
 * surface. One classification reused by the compare view, advisory conflict
 * detection, and deploy preflight.
 */

import { findColumn, parseType, type Schema } from "./model";
import type { Op } from "./ops";

export type SafetyLevel = "additive" | "needs_care" | "destructive";

export interface SafetyTag {
  level: SafetyLevel;
  reason?: string; // present for needs_care and destructive
}

/**
 * `before` is the schema state just before the op applies — needed to detect
 * narrowing retypes and not-null-without-default.
 */
export function tag(op: Op, before: Schema): SafetyTag {
  switch (op.kind) {
    case "create_table":
    case "rename_table":
    case "rename_column":
    case "add_index":
      // Renames are metadata-only; a new table or (non-unique) index cannot
      // fail on existing rows. Unique indexes are the exception below.
      if (op.kind === "add_index" && op.index.unique)
        return { level: "needs_care", reason: "unique index creation fails if existing rows contain duplicates" };
      return { level: "additive" };

    case "add_column": {
      if (!op.column.nullable && op.column.default === null)
        return { level: "needs_care", reason: "NOT NULL with no default — fails if the table has existing rows" };
      return { level: "additive" };
    }

    case "set_nullable":
      return op.nullable
        ? { level: "additive" }
        : { level: "needs_care", reason: "fails if existing rows contain NULLs — backfill first" };

    case "set_default":
      return { level: "additive" };

    case "retype_column": {
      const found = findColumn(before, op.columnId);
      const from = found ? parseType(found.column.type) : null;
      const to = parseType(op.type);
      if (!from || !to) return { level: "needs_care", reason: "type change on existing rows" };
      if (from.family === to.family) {
        if (from.family === "varchar" && to.params[0] < from.params[0])
          return { level: "needs_care", reason: `narrowing varchar(${from.params[0]}) → varchar(${to.params[0]}) fails on longer values` };
        if (from.family === "numeric" && (to.params[0] < from.params[0] || to.params[1] < from.params[1]))
          return { level: "needs_care", reason: "narrowing numeric precision/scale can fail or round existing values" };
        return { level: "additive" }; // widening within the same family
      }
      if (from.family === "integer" && to.family === "bigint")
        return { level: "additive" }; // safe widening
      if (from.family === "varchar" && to.family === "text")
        return { level: "additive" }; // widening to unbounded
      return {
        level: "needs_care",
        reason: `cross-family retype ${found?.column.type} → ${op.type} needs a USING cast and can fail on existing values`,
      };
    }

    case "add_constraint": {
      switch (op.constraint.kind) {
        case "primary_key":
          return { level: "needs_care", reason: "fails if existing rows contain NULLs or duplicates in the key columns" };
        case "unique":
          return { level: "needs_care", reason: "fails if existing rows contain duplicates" };
        case "check":
          return { level: "needs_care", reason: "fails if existing rows violate the expression" };
        case "foreign_key":
          return { level: "needs_care", reason: "fails if existing rows reference missing target rows" };
      }
      break;
    }

    case "drop_column":
      return { level: "destructive", reason: "column data is lost" };
    case "drop_table":
      return { level: "destructive", reason: "table and all its data are lost" };
    case "drop_constraint":
      return { level: "destructive", reason: "the guarantee this constraint enforced is lost" };
    case "drop_index":
      return { level: "destructive", reason: "queries relying on this index may slow down" };
  }
  // Unreachable; every branch above returns.
  return { level: "needs_care" };
}
