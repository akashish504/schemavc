/**
 * The 13 operation types — the unit of change for the whole product.
 * Primary keys are a constraint kind, so add/drop PK reuses the constraint ops.
 */

import type { Column, Constraint, Id, Index, Table } from "./model";

export type Op =
  | { kind: "create_table"; table: Table }
  | { kind: "drop_table"; tableId: Id }
  | { kind: "rename_table"; tableId: Id; name: string }
  | { kind: "add_column"; tableId: Id; column: Column }
  | { kind: "drop_column"; columnId: Id }
  | { kind: "rename_column"; columnId: Id; name: string }
  | { kind: "retype_column"; columnId: Id; type: string }
  | { kind: "set_nullable"; columnId: Id; nullable: boolean }
  | { kind: "set_default"; columnId: Id; default: string | null }
  | { kind: "add_constraint"; tableId: Id; constraint: Constraint }
  | { kind: "drop_constraint"; constraintId: Id }
  | { kind: "add_index"; tableId: Id; index: Index }
  | { kind: "drop_index"; indexId: Id };

export type OpKind = Op["kind"];

/** An op annotated with where it came from, for conflict cards and history. */
export interface AttributedOp {
  op: Op;
  commitId: string;
  author: string; // display name
  message: string;
  at: string; // ISO timestamp
}
