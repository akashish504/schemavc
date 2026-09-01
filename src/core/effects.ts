/**
 * effects(op, schema) — which entity ids an op writes, deletes, and reads.
 *
 * This single declaration drives both conflict detection (write/write,
 * delete-vs-anything) and dependency ordering (create before read, read
 * before delete). A new op type only needs an entry here to participate in
 * merge and ordering.
 *
 * `schema` is the state just before the op applies — needed because
 * drop_table's delete set is every id the table contains at that moment.
 */

import { findColumn, findConstraint, findIndex, tableIds, type Id, type Schema } from "./model";
import { apply } from "./apply";
import type { Constraint, Index } from "./model";
import type { Op } from "./ops";

export interface Effects {
  writes: Id[];
  deletes: Id[];
  reads: Id[];
}

const constraintReads = (c: Constraint): Id[] => {
  switch (c.kind) {
    case "check":
      return [];
    case "primary_key":
    case "unique":
      return [...c.columns];
    case "foreign_key":
      return [...c.columns, c.references.table, ...c.references.columns];
  }
};

const indexReads = (x: Index): Id[] => [...x.columns];

export function effects(op: Op, schema: Schema): Effects {
  switch (op.kind) {
    case "create_table": {
      const t = op.table;
      const writes = [t.id, ...t.columns.map((c) => c.id), ...t.constraints.map((c) => c.id), ...t.indexes.map((x) => x.id)];
      const own = new Set(writes);
      // An FK in the created table may reference another table: that is a read.
      const reads = t.constraints.flatMap(constraintReads).filter((id) => !own.has(id));
      return { writes, deletes: [], reads };
    }
    case "drop_table": {
      const t = schema.tables[op.tableId];
      return { writes: [], deletes: t ? [...tableIds(t)] : [op.tableId], reads: [] };
    }
    case "rename_table":
      return { writes: [op.tableId], deletes: [], reads: [] };
    case "add_column":
      return { writes: [op.column.id], deletes: [], reads: [op.tableId] };
    case "drop_column":
      return { writes: [], deletes: [op.columnId], reads: [] };
    case "rename_column":
    case "retype_column":
    case "set_nullable":
    case "set_default":
      return { writes: [op.columnId], deletes: [], reads: [] };
    case "add_constraint":
      return { writes: [op.constraint.id], deletes: [], reads: [op.tableId, ...constraintReads(op.constraint)] };
    case "drop_constraint": {
      const found = findConstraint(schema, op.constraintId);
      // Dropping still "writes" nothing else, but it reads nothing either;
      // the constraint id itself is the deleted entity.
      void found;
      return { writes: [], deletes: [op.constraintId], reads: [] };
    }
    case "add_index":
      return { writes: [op.index.id], deletes: [], reads: [op.tableId, ...indexReads(op.index)] };
    case "drop_index":
      return { writes: [], deletes: [op.indexId], reads: [] };
  }
}

/**
 * Replay one side's ops from a starting snapshot, computing each op's effect
 * sets against the schema as it stood when that op applied. Also returns the
 * schema state just before each op, which invert() needs.
 */
export function replayWithEffects(
  start: Schema,
  ops: Op[]
): { ok: true; perOp: { effects: Effects; before: Schema }[]; end: Schema } | { ok: false; opIndex: number } {
  let current = start;
  const perOp: { effects: Effects; before: Schema }[] = [];
  for (let i = 0; i < ops.length; i++) {
    perOp.push({ effects: effects(ops[i], current), before: current });
    const result = apply(current, [ops[i]]);
    if (!result.ok) return { ok: false, opIndex: i };
    current = result.schema;
  }
  return { ok: true, perOp, end: current };
}

/**
 * Ids an op is "about", for grouping and advisory checks: the table it
 * touches, resolved against the given schema.
 */
export function touchedTableId(op: Op, schema: Schema): Id | undefined {
  switch (op.kind) {
    case "create_table":
      return op.table.id;
    case "drop_table":
    case "rename_table":
    case "add_column":
    case "add_constraint":
    case "add_index":
      return op.tableId;
    case "drop_column":
    case "rename_column":
    case "retype_column":
    case "set_nullable":
    case "set_default":
      return findColumn(schema, op.columnId)?.table.id;
    case "drop_constraint":
      return findConstraint(schema, op.constraintId)?.table.id;
    case "drop_index":
      return findIndex(schema, op.indexId)?.table.id;
  }
}
